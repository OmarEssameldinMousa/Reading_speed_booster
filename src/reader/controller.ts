// Everything that happens while reading, outside React: cursor moves, the event log, sessions,
// section quizzes, reread/slow-paragraph detection, thought probes and the pacer.

import { db, patchSettings, type Book, type MoveKind, type ProbeState, type QuestionRec, type ReadEvent, type Settings } from '../db/db';
import type { ChapterModel } from '../pdf/types';
import { sectionIndexAt, sectionRange, sentenceAt, wordsText } from '../pdf/stream';
import { paragraphAt, type WordLayout } from '../pdf/words';
import { keyTerms } from '../text/keyterms';
import { aiAvailable } from '../ai/router';
import { clarify as askClarify, fallbackGrade, gradeAnswers, locateQuote, makeQuiz, type Grade } from '../ai/prompts';
import { moveTo, readTo, timesRead, type CursorState } from './cursor';
import { median, rangeStats, recentWpm, totals, wpm } from './metrics';
import type { Marks } from './marks';
import type { ClarifyView, QuizView } from './panels';

export interface Flag {
  word: number; // paragraph start
  end: number;
  reason: 'rereads' | 'slow';
  reads: number;
}

export interface UiHooks {
  changed: () => void; // cursor/stats changed
  quiz: (section: number) => void; // a section ended: open its quiz
  flag: (f: Flag) => void; // offer an explanation
  probe: () => void; // ask where the mind was
  toast: (msg: string) => void;
}

type PreparedQuiz = Pick<QuizView, 'questions' | 'provider' | 'offline'>;

export class ReaderController {
  events: ReadEvent[] = []; // this session
  private queue: ReadEvent[] = [];
  private sessionP: Promise<number> | null = null;
  private saveTimer = 0;
  private flushTimer = 0;
  private prefetches = new Map<number, Promise<PreparedQuiz>>();
  private flagged = new Set<number>();
  private paceSamples: number[] = []; // ms per word of recent moves
  private activeMs = 0;
  private nextProbeAt: number;
  private pacerTimer = 0;
  pacing = false;
  paused = false; // a quiz or probe is open
  sessionQuizzed: number[] = [];
  scores: number[] = []; // comprehension per answered question, this session
  lastProbe: { state: ProbeState; t: number } | null = null;

  constructor(
    public book: Book,
    public chapter: number,
    public model: ChapterModel,
    public layout: WordLayout,
    public cursor: CursorState,
    public marks: Marks,
    public quizzed: Set<number>,
    public settings: Settings,
    private ui: UiHooks,
  ) {
    this.nextProbeAt = this.probeGap();
    this.flushTimer = window.setInterval(() => void this.flush(), 5000);
  }

  get n() {
    return this.model.stream.words.length;
  }
  get idleMs() {
    return this.settings.idleSec * 1000;
  }

  // ---------- moves ----------

  next() {
    this.move('next', this.cursor.pos + 1);
  }
  line() {
    const p = this.cursor.pos;
    if (p < this.n) this.move('line', this.layout.lineEnd[p] + 1);
  }
  back() {
    this.move('back', this.cursor.pos - 1);
  }
  lineBack() {
    let w = this.cursor.pos - 1;
    while (w > 0 && this.layout.line[w - 1] === this.layout.line[w]) w--;
    this.move('back', Math.max(0, w));
  }
  jump(w: number) {
    this.move('jump', w);
  }

  move(kind: MoveKind, to: number) {
    if (this.paused) return;
    const reading = kind === 'next' || kind === 'line' || kind === 'pacer';
    const m = reading ? readTo(this.cursor, to) : moveTo(this.cursor, to);
    if (m.from === m.to) return;
    const prev = this.events[this.events.length - 1];
    const e: ReadEvent = { sessionId: 0, bookId: this.book.id!, chapter: this.chapter, t: Date.now(), kind, ...m };
    this.events.push(e);
    this.queue.push(e);
    if (prev) {
      const dt = e.t - prev.t;
      if (dt <= this.idleMs) {
        this.activeMs += dt;
        if (reading) this.paceSamples.push(dt / (m.to - m.from));
        if (this.paceSamples.length > 400) this.paceSamples.splice(0, 100);
      }
    }
    void this.ensureSession();
    this.marks.refresh(Math.min(m.from, m.to), Math.max(m.from, m.to));
    this.marks.setCursor(this.cursor.pos);
    this.scheduleSave();
    if (reading) this.afterRead(m.from, m.to);
    this.ui.changed();
  }

  private afterRead(from: number, to: number) {
    const s = this.model.stream;
    const st = this.settings;

    // Prefetch the quiz once you're 70% through a section, so it's ready when you finish.
    const cur = sectionIndexAt(s, Math.max(0, to - 1));
    const [ca, cb] = sectionRange(s, cur);
    if (!this.quizzed.has(cur) && cb - ca >= st.minSectionWords && to - ca >= 0.7 * (cb - ca)) void this.prepareQuiz(cur).catch(() => {});

    // Section finished?
    for (let i = 0; i < s.sections.length; i++) {
      const [a, b] = sectionRange(s, i);
      if (from < b && to >= b && !this.quizzed.has(i)) {
        if (b - a < st.minSectionWords) {
          this.quizzed.add(i);
          continue;
        }
        this.paused = true;
        this.stopPacer(true);
        this.ui.quiz(i);
        return;
      }
    }

    // A sentence read N times → offer to explain its paragraph.
    const last = to - 1;
    const [sa, sb] = sentenceAt(s, last);
    if (last === sb - 1) {
      const reads = timesRead(this.cursor.counts, sa, sb);
      const [pa, pb] = paragraphAt(s, last);
      if (reads >= st.rereadThreshold && !this.flagged.has(pa)) {
        this.flagged.add(pa);
        this.marks.flag(pa, pb, true);
        this.ui.flag({ word: pa, end: pb, reason: 'rereads', reads });
      }
    }

    // Left a paragraph much slower than your usual pace → offer to explain it.
    const [pa, pb] = paragraphAt(s, from);
    if (to >= pb && pb - pa >= 15 && !this.flagged.has(pa) && this.paceSamples.length >= 60) {
      const r = rangeStats(this.events, this.idleMs, pa, pb);
      const words = (r.wpm * r.activeMs) / 60000;
      const per = words > 0 ? r.activeMs / words : 0;
      const base = median(this.paceSamples);
      if (base > 0 && per > st.dwellFactor * base) {
        this.flagged.add(pa);
        this.marks.flag(pa, pb, true);
        this.ui.flag({ word: pa, end: pb, reason: 'slow', reads: timesRead(this.cursor.counts, pa, pb) });
      }
    }

    // Thought probe at a random point every few minutes of active reading.
    if (st.probesOn && this.activeMs >= this.nextProbeAt) {
      this.nextProbeAt = this.activeMs + this.probeGap();
      this.paused = true;
      this.stopPacer(true);
      this.ui.probe();
    }
  }

  private probeGap() {
    const { probeMinMin: a, probeMaxMin: b } = this.settings;
    return (Math.min(a, b) + Math.random() * Math.abs(b - a)) * 60000;
  }

  unflag(word: number) {
    const [pa, pb] = paragraphAt(this.model.stream, word);
    this.marks.flag(pa, pb, false);
  }

  // ---------- live stats ----------

  stats() {
    const t = totals(this.events, this.idleMs);
    const comp = this.scores.length ? this.scores.reduce((a, b) => a + b, 0) / this.scores.length : null;
    const sessionWpm = wpm(t.words, t.activeMs);
    return {
      wpm: recentWpm(this.events, this.idleMs) || sessionWpm,
      sessionWpm,
      words: t.fresh + t.reread,
      regressions: t.fresh + t.reread ? (t.regressions / (t.fresh + t.reread)) * 100 : 0,
      comprehension: comp,
      effective: comp === null ? null : sessionWpm * comp,
      activeMs: t.activeMs,
    };
  }

  // ---------- quiz ----------

  sectionText(i: number) {
    return wordsText(this.model.stream, ...sectionRange(this.model.stream, i));
  }
  heading(i: number) {
    return (this.model.stream.sections[i]?.heading ?? '').replace(/^chapter\s+\d+\s*/i, '');
  }

  prepareQuiz(i: number): Promise<PreparedQuiz> {
    let p = this.prefetches.get(i);
    if (!p) {
      p = this.buildQuiz(i);
      this.prefetches.set(i, p);
      p.catch(() => this.prefetches.delete(i));
    }
    return p;
  }

  private async buildQuiz(i: number): Promise<PreparedQuiz> {
    const s = this.settings;
    const heading = this.heading(i);
    const text = this.sectionText(i);
    if (!aiAvailable(s)) {
      const texts = this.model.stream.sections.map((_, k) => this.sectionText(k));
      return {
        offline: true,
        questions: [
          {
            q: `In your own words, what were the main points of ${heading ? `"${heading}"` : 'this section'}?`,
            type: 'recall',
            answer_key: keyTerms(text, texts, 6)
              .map((t) => t.word)
              .join(', '),
            evidence: '',
            about: 'current',
            section: i,
            heading,
          },
        ],
      };
    }
    const bookId = this.book.id!;
    const earlier = (await db.sections.where('bookId').equals(bookId).toArray())
      .filter((r) => r.chapter === this.chapter && r.section < i && r.summary)
      .sort((a, b) => a.section - b.section)
      .slice(-8);
    const pool = this.sessionQuizzed.filter((j) => j !== i);
    const j = pool.length && Math.random() < s.interleaveChance ? pool[Math.floor(Math.random() * pool.length)] : null;
    const r = await makeQuiz({
      book: this.book.title,
      chapter: this.book.chapters[this.chapter]?.title ?? '',
      heading,
      text,
      earlier: earlier.map((e) => ({ heading: e.heading, summary: e.summary })),
      n: s.questionsPerSection,
      interleave: j === null ? undefined : { heading: this.heading(j), text: this.sectionText(j) },
    });
    if (r.value.summary) await db.sections.put({ bookId, chapter: this.chapter, section: i, heading, summary: r.value.summary });
    return {
      provider: r.provider,
      questions: r.value.questions.map((q) => {
        const sec = q.about === 'earlier' && j !== null ? j : i;
        return { ...q, section: sec, heading: this.heading(sec) };
      }),
    };
  }

  async grade(view: QuizView, answers: string[]): Promise<Grade[]> {
    const grades: (Grade | null)[] = answers.map((a) => (a.trim() ? null : { score: 0, verdict: 'skipped', feedback: '', missed: [] }));
    const todo = view.questions.map((q, i) => ({ q, i, answer: answers[i].trim() })).filter((x) => x.answer);
    const offline = (x: (typeof todo)[number]) => fallbackGrade(x.q.answer_key, x.answer, this.sectionText(x.q.section));
    if (todo.length) {
      let got: Grade[];
      if (view.offline) got = todo.map(offline);
      else {
        try {
          got = (await gradeAnswers(todo.map((x) => ({ q: x.q.q, answer_key: x.q.answer_key, answer: x.answer, text: this.sectionText(x.q.section) })))).value;
        } catch {
          got = todo.map(offline);
        }
      }
      todo.forEach((x, k) => (grades[x.i] = got[k]));
    }
    const out = grades as Grade[];
    // save
    const [a, b] = sectionRange(this.model.stream, view.section);
    const sec = rangeStats(this.events, this.idleMs, a, b);
    const focus = this.lastProbe && Date.now() - this.lastProbe.t < 15 * 60000 ? this.lastProbe.state : undefined;
    const sessionId = await this.ensureSession();
    const recs: QuestionRec[] = view.questions.map((q, i) => ({
      sessionId,
      bookId: this.book.id!,
      chapter: this.chapter,
      section: q.section,
      askedAt: view.section,
      heading: q.heading,
      q: q.q,
      type: q.type,
      answerKey: q.answer_key,
      evidence: q.evidence,
      interleaved: q.section !== view.section,
      answer: answers[i],
      score: out[i].score,
      verdict: out[i].verdict,
      feedback: out[i].feedback,
      wpm: Math.round(sec.wpm),
      rereadRate: sec.rereadRate,
      focus,
      provider: view.offline ? 'offline' : (view.provider ?? ''),
      ts: Date.now(),
    }));
    await db.questions.bulkAdd(recs);
    this.scores.push(...out.map((g) => g.score));
    return out;
  }

  /** Close a quiz: mark the section done, adapt the pacer, resume. */
  async finishQuiz(view: QuizView, grades: Grade[] | null) {
    this.quizzed.add(view.section);
    if (!this.sessionQuizzed.includes(view.section)) this.sessionQuizzed.push(view.section);
    this.scheduleSave();
    this.paused = false;
    if (grades?.length && this.settings.pacerAdapt) {
      const [a, b] = sectionRange(this.model.stream, view.section);
      const paced = this.events.some((e) => e.kind === 'pacer' && e.from >= a && e.to <= b);
      if (paced) {
        const score = grades.reduce((x, g) => x + g.score, 0) / grades.length;
        const old = this.settings.pacerWpm;
        const next = Math.max(100, Math.min(1200, Math.round(score >= 0.8 ? old * 1.05 : score < 0.6 ? old * 0.95 : old)));
        if (next !== old) {
          this.settings = await patchSettings({ pacerWpm: next });
          this.ui.toast(next > old ? `Good comprehension: pacer up to ${next} wpm` : `Pacer down to ${next} wpm so you can follow`);
        }
      }
    }
    this.resumePacer();
    this.ui.changed();
  }

  /** Where the evidence for question i is, or -1. */
  evidenceWord(view: QuizView, i: number): number {
    const q = view.questions[i];
    const [a, b] = sectionRange(this.model.stream, q.section);
    return locateQuote(this.model.stream.words, a, b, q.evidence);
  }

  // ---------- clarify ----------

  paragraphText(word: number) {
    const [a, b] = paragraphAt(this.model.stream, word);
    return wordsText(this.model.stream, a, b);
  }

  async clarify(view: ClarifyView, id: number | undefined): Promise<{ text: string; id: number }> {
    const sec = sectionIndexAt(this.model.stream, view.word);
    const r = await askClarify({
      book: this.book.title,
      heading: this.heading(sec),
      paragraph: view.paragraph,
      context: this.sectionText(sec),
      history: view.messages,
      reason: view.reason,
    });
    const messages = [...view.messages, { role: 'assistant' as const, text: r.value }];
    const rec = { bookId: this.book.id!, chapter: this.chapter, word: view.word, text: view.paragraph, reason: view.reason, reads: view.reads, messages, ts: Date.now() };
    if (id) await db.clarifications.update(id, rec);
    else id = await db.clarifications.add(rec);
    return { text: r.value, id };
  }

  // ---------- probes ----------

  async answerProbe(state: ProbeState | null) {
    this.paused = false;
    if (state) {
      this.lastProbe = { state, t: Date.now() };
      await db.probes.add({ sessionId: await this.ensureSession(), bookId: this.book.id!, chapter: this.chapter, word: this.cursor.pos, state, wpm: Math.round(recentWpm(this.events, this.idleMs)), ts: Date.now() });
    }
    this.resumePacer();
  }

  // ---------- pacer ----------

  private pacerWanted = false;

  togglePacer() {
    if (this.pacing) this.stopPacer(false);
    else {
      this.pacerWanted = true;
      this.startPacer();
    }
    this.ui.changed();
  }

  private startPacer() {
    if (this.pacing || this.paused || this.cursor.pos >= this.n) return;
    this.pacing = true;
    const tick = () => {
      if (!this.pacing) return;
      if (this.paused || this.cursor.pos >= this.n) return this.stopPacer(true);
      const w = this.model.stream.words[this.cursor.pos] ?? '';
      // longer words take longer; an average word (5 letters + space) gets 60000/wpm ms
      const delay = (60000 / this.settings.pacerWpm) * Math.max(0.5, (w.length + 1) / 6);
      this.pacerTimer = window.setTimeout(() => {
        if (!this.pacing) return;
        this.move('pacer', this.cursor.pos + 1);
        tick();
      }, delay);
    };
    tick();
  }

  stopPacer(keepWanted: boolean) {
    this.pacing = false;
    if (!keepWanted) this.pacerWanted = false;
    clearTimeout(this.pacerTimer);
    this.ui.changed();
  }

  private resumePacer() {
    if (this.pacerWanted) this.startPacer();
  }

  setPacerWpm(v: number) {
    void patchSettings({ pacerWpm: v }).then((s) => (this.settings = s));
    this.settings = { ...this.settings, pacerWpm: v };
    this.ui.changed();
  }

  // ---------- persistence ----------

  private ensureSession(): Promise<number> {
    if (!this.sessionP) {
      const start = this.events[0]?.t ?? Date.now();
      this.sessionP = db.sessions.add({ bookId: this.book.id!, chapter: this.chapter, start, end: start, activeMs: 0, fresh: 0, reread: 0, regressions: 0, pacer: false });
    }
    return this.sessionP;
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.saveState(), 1500);
  }

  async saveState() {
    clearTimeout(this.saveTimer);
    const c = this.cursor;
    await db.chapters.put({
      bookId: this.book.id!,
      chapter: this.chapter,
      pos: c.pos,
      maxPos: c.maxPos,
      total: this.n,
      counts: c.counts.slice(),
      quizzed: [...this.quizzed],
      updatedAt: Date.now(),
    });
  }

  async flush() {
    if (!this.events.length) return;
    const id = await this.ensureSession();
    const q = this.queue.splice(0);
    if (q.length) {
      for (const e of q) e.sessionId = id;
      await db.events.bulkAdd(q);
    }
    const t = totals(this.events, this.idleMs);
    await db.sessions.update(id, {
      end: this.events[this.events.length - 1].t,
      activeMs: t.activeMs,
      fresh: t.fresh,
      reread: t.reread,
      regressions: t.regressions,
      pacer: this.events.some((e) => e.kind === 'pacer'),
    });
  }

  dispose() {
    this.stopPacer(false);
    clearInterval(this.flushTimer);
    void this.saveState();
    void this.flush();
  }
}
