import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { db, getChapterState, getSettings, patchSettings, type Book, type ProbeState } from '../db/db';
import { loadChapter, openBook } from '../pdf/doc';
import { sectionRange } from '../pdf/stream';
import { buildVidMap, layoutWords } from '../pdf/words';
import type { ChapterModel } from '../pdf/types';
import { navigate } from '../router';
import { aiAvailable } from '../ai/router';
import { Marks } from './marks';
import { Pages } from './PageView';
import { ReaderController, type Flag } from './controller';
import { ClarifyPanel, ProbeModal, QuizPanel, type ClarifyView, type QuizView } from './panels';

interface Loaded {
  book: Book;
  doc: PDFDocumentProxy;
  model: ChapterModel;
  ctl: ReaderController;
}

function hintSeen(): boolean {
  try {
    return localStorage.getItem('rsb-hint') === '1';
  } catch {
    return false;
  }
}

export function Read({ bookId, chapter, at }: { bookId: number; chapter: number; at?: number }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string>();
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const [quiz, setQuiz] = useState<QuizView | null>(null);
  const [clar, setClar] = useState<(ClarifyView & { id?: number }) | null>(null);
  const [flag, setFlag] = useState<Flag | null>(null);
  const [probe, setProbe] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setTheme] = useState<'paper' | 'night'>('paper');
  const [winW, setWinW] = useState(window.innerWidth);
  const [hint, setHint] = useState(!hintSeen());
  const ctlRef = useRef<ReaderController | null>(null);
  const scrollReq = useRef(false);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      const book = await db.books.get(bookId);
      if (!book) throw new Error('Book not found');
      const [settings, doc, model] = await Promise.all([getSettings(), openBook(bookId), loadChapter(bookId, chapter)]);
      const vm = buildVidMap(model);
      const layout = layoutWords(model, vm);
      const st = await getChapterState(bookId, chapter, model.stream.words.length);
      const cursor = { pos: st.pos, maxPos: st.maxPos, counts: st.counts };
      if (at !== undefined && at >= 0 && at < model.stream.words.length) cursor.pos = at; // opened from a hard spot
      const marks = new Marks(model, cursor.counts);
      marks.setCursor(cursor.pos);
      const ctl = new ReaderController(book, chapter, model, layout, cursor, marks, new Set(st.quizzed), settings, {
        changed: () => {
          scrollReq.current = true;
          tick();
        },
        quiz: (section) => openQuiz(ctl, section),
        flag: (f) => setFlag(f),
        probe: () => setProbe(true),
        toast: (m) => setToast(m),
      });
      marks.onMount = () => ensureVisible(false);
      await db.progress.put({ bookId, current: chapter });
      if (!alive) return ctl.dispose();
      ctlRef.current = ctl;
      setTheme(settings.theme);
      setData({ book, doc, model, ctl });
      scrollReq.current = true;
    })().catch((e) => alive && setError(String(e?.message ?? e)));
    return () => {
      alive = false;
      ctlRef.current?.dispose();
      ctlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId, chapter, at]);

  useEffect(() => {
    const r = () => setWinW(window.innerWidth);
    const hide = () => {
      if (document.visibilityState === 'hidden') {
        void ctlRef.current?.saveState();
        void ctlRef.current?.flush();
      }
    };
    window.addEventListener('resize', r);
    document.addEventListener('visibilitychange', hide);
    return () => {
      window.removeEventListener('resize', r);
      document.removeEventListener('visibilitychange', hide);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---------- keep the cursor in view ----------
  const ensureVisible = useCallback((smooth: boolean) => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    const w = Math.min(ctl.cursor.pos, ctl.n - 1);
    const r = ctl.marks.rect(w);
    if (!r) {
      const page = document.querySelector(`.page[data-page="${ctl.layout.page[w]}"]`);
      page?.scrollIntoView({ block: 'center' });
      return;
    }
    const top = 110;
    if (r.top < top || r.bottom > window.innerHeight * 0.72) window.scrollBy({ top: r.top - window.innerHeight * 0.36, behavior: smooth ? 'smooth' : 'auto' });
  }, []);

  useEffect(() => {
    if (!scrollReq.current) return;
    scrollReq.current = false;
    ensureVisible(!ctlRef.current?.pacing);
  });

  // ---------- quiz ----------
  const openQuiz = useCallback((ctl: ReaderController, section: number) => {
    const base: QuizView = { section, heading: ctl.heading(section), status: 'loading', questions: [] };
    setQuiz(base);
    ctl.prepareQuiz(section).then(
      (p) => setQuiz((q) => (q && q.section === section ? { ...q, ...p, status: 'ready' } : q)),
      (e) => setQuiz((q) => (q && q.section === section ? { ...q, status: 'error', error: String(e?.message ?? e) } : q)),
    );
  }, []);

  const submitQuiz = async (answers: string[]) => {
    const ctl = ctlRef.current;
    if (!ctl || !quiz) return;
    setQuiz({ ...quiz, status: 'grading', answers });
    const grades = await ctl.grade(quiz, answers);
    setQuiz({ ...quiz, status: 'graded', answers, grades });
  };

  const closeQuiz = async (rereadQ?: number) => {
    const ctl = ctlRef.current;
    if (!ctl || !quiz) return;
    const target = rereadQ !== undefined ? ctl.evidenceWord(quiz, rereadQ) : -1;
    setQuiz(null);
    await ctl.finishQuiz(quiz, quiz.grades ?? null);
    if (target >= 0) {
      // back to the start of the sentence with the answer
      let w = target;
      while (w > 0 && !ctl.model.stream.sentenceEnds[w - 1]) w--;
      ctl.jump(w);
    }
  };

  // ---------- clarify ----------
  const runClarify = async (view: ClarifyView & { id?: number }) => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    setClar({ ...view, loading: true, error: undefined });
    try {
      const r = await ctl.clarify(view, view.id);
      setClar((c) => (c && c.word === view.word ? { ...view, id: r.id, loading: false, messages: [...view.messages, { role: 'assistant', text: r.text }] } : c));
    } catch (e) {
      setClar((c) => (c && c.word === view.word ? { ...view, loading: false, error: String((e as Error)?.message ?? e) } : c));
    }
  };

  const explain = (word: number, reason: ClarifyView['reason'], reads: number) => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    setFlag(null);
    const view = { word, paragraph: ctl.paragraphText(word), reason, reads, messages: [], loading: true };
    if (!aiAvailable(ctl.settings)) {
      setClar({ ...view, loading: false, error: 'Add a free Gemini or Groq key in Settings to get explanations.' });
      return;
    }
    void runClarify(view);
  };

  // ---------- keys ----------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const ctl = ctlRef.current;
      if (!ctl) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (e.shiftKey && e.key.startsWith('Arrow')) {
        e.preventDefault();
        if (hint) dismissHint();
        if (e.key === 'ArrowRight') ctl.next();
        else if (e.key === 'ArrowDown') ctl.line();
        else if (e.key === 'ArrowLeft') ctl.back();
        else if (e.key === 'ArrowUp') ctl.lineBack();
      } else if (e.key === ' ' && !e.shiftKey && !quiz && !probe) {
        e.preventDefault();
        ctl.togglePacer();
      } else if (e.key === '?' && !quiz) {
        e.preventDefault();
        explain(Math.min(ctl.cursor.pos, ctl.n - 1), 'asked', 0);
      } else if (e.key === 'Escape' && clar) {
        setClar(null);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const dismissHint = () => {
    setHint(false);
    try {
      localStorage.setItem('rsb-hint', '1');
    } catch {
      /* ignore */
    }
  };

  if (error)
    return (
      <div className="center-msg">
        <p>Couldn't open this chapter: {error}</p>
        <button onClick={() => navigate(`#/book/${bookId}`)}>Back to the book</button>
      </div>
    );
  if (!data) return <div className="center-msg">Opening the book…</div>;

  const { book, doc, model, ctl } = data;
  const st = ctl.stats();
  const n = ctl.n;
  const width = Math.min(ctl.settings.pageWidth, winW - (quiz || clar ? (winW > 1300 ? 460 : 32) : 32));
  const s = model.stream;
  const nextChapter = chapter + 1 < book.chapters.length ? chapter + 1 : null;
  const panelOpen = !!(quiz || clar);

  return (
    <div className={`reader theme-${theme}${panelOpen ? ' with-panel' : ''}`}>
      <header className="toolbar">
        <button className="ghost" onClick={() => navigate(`#/book/${bookId}`)} title="Back to the book">
          ←
        </button>
        <div className="tb-title">
          <div className="tb-book">{book.title}</div>
          <div className="tb-chapter">{book.chapters[chapter]?.title}</div>
        </div>
        <div className="stats-live">
          <Stat v={st.wpm ? Math.round(st.wpm) : '–'} l="wpm" title="Reading speed over the last minute of active reading" />
          <Stat v={st.comprehension === null ? '–' : `${Math.round(st.comprehension * 100)}%`} l="understood" title="Average score on this session's questions" />
          <Stat v={st.effective === null ? '–' : Math.round(st.effective)} l="effective" title="Effective reading rate = words per minute × comprehension" />
          <Stat v={st.words ? st.regressions.toFixed(1) : '–'} l="back/100w" title="Times you went back, per 100 words read" />
        </div>
        <div className="tb-actions">
          <div className={'pacer' + (ctl.pacing ? ' on' : '')}>
            <button className="toggle" onClick={() => ctl.togglePacer()} title="Pacer: moves the highlight at a set speed (Space)">
              {ctl.pacing ? '⏸' : '▶'} Pacer
            </button>
            <button className="ghost small" onClick={() => ctl.setPacerWpm(Math.max(100, ctl.settings.pacerWpm - 10))} aria-label="Slower">
              −
            </button>
            <span className="pacer-wpm">{ctl.settings.pacerWpm}</span>
            <button className="ghost small" onClick={() => ctl.setPacerWpm(Math.min(1200, ctl.settings.pacerWpm + 10))} aria-label="Faster">
              +
            </button>
          </div>
          <button className="toggle" onClick={() => explain(Math.min(ctl.cursor.pos, n - 1), 'asked', 0)} title="Explain the paragraph at the cursor (?)">
            🤔 Explain
          </button>
          <button
            className="toggle"
            title="Page theme"
            onClick={() => {
              const t = theme === 'paper' ? 'night' : 'paper';
              setTheme(t);
              void patchSettings({ theme: t });
            }}
          >
            {theme === 'paper' ? '🌙' : '☀️'}
          </button>
          <button className="toggle" onClick={() => navigate('#/settings')} title="Settings">
            ⚙️
          </button>
        </div>
        <div className="milestones" title={`${Math.round((ctl.cursor.maxPos / Math.max(1, n)) * 100)}% of the chapter`}>
          <div className="ms-fill" style={{ width: `${(ctl.cursor.maxPos / Math.max(1, n)) * 100}%` }} />
          {s.sections.map((sec, i) => {
            const end = sectionRange(s, i)[1];
            if (end - sec.word < ctl.settings.minSectionWords) return null;
            return <div key={i} className={'ms-q' + (ctl.quizzed.has(i) ? ' done' : '')} style={{ left: `${(end / Math.max(1, n)) * 100}%` }} title={sec.heading} />;
          })}
        </div>
      </header>

      {hint && (
        <div className="banner">
          <kbd>Shift</kbd>+<kbd>→</kbd> next word · <kbd>Shift</kbd>+<kbd>↓</kbd> rest of the line · <kbd>Shift</kbd>+<kbd>←</kbd>/<kbd>↑</kbd> go back ·
          click a word to reread from there · <kbd>Space</kbd> pacer · <kbd>?</kbd> explain{' '}
          <button className="ghost small" onClick={dismissHint}>
            Got it
          </button>
        </div>
      )}

      <div className="pages" style={{ width }}>
        <Pages doc={doc} pages={model.pages} marks={ctl.marks} width={width} onWordClick={(w) => ctl.jump(w)} />
        {ctl.cursor.pos >= n && !quiz && (
          <div className="chapter-end">
            <h2>Chapter finished 🎉</h2>
            {st.comprehension !== null && <p>You understood {Math.round(st.comprehension * 100)}% of what you were asked this session.</p>}
            <div className="row center">
              {nextChapter !== null && (
                <button className="primary big" onClick={() => navigate(`#/read/${bookId}/${nextChapter}`)}>
                  Next: {book.chapters[nextChapter].title} →
                </button>
              )}
              <button onClick={() => navigate('#/stats')}>See your progress</button>
            </div>
          </div>
        )}
      </div>

      {quiz && (
        <QuizPanel
          quiz={quiz}
          onSubmit={submitQuiz}
          onRetry={() => openQuiz(ctl, quiz.section)}
          onReread={(i) => void closeQuiz(i)}
          onContinue={() => void closeQuiz()}
          onSkip={() => void closeQuiz()}
        />
      )}
      {clar && !quiz && (
        <ClarifyPanel
          view={clar}
          onClose={() => {
            ctl.unflag(clar.word);
            setClar(null);
          }}
          onRetry={() => void runClarify({ ...clar, messages: clar.messages })}
          onAsk={(q) => void runClarify({ ...clar, messages: [...clar.messages, { role: 'user', text: q }] })}
        />
      )}

      {flag && !quiz && !clar && (
        <div className="flag-chip" role="status">
          <span>{flag.reason === 'rereads' ? `🤔 You've read this part ${flag.reads}×.` : '🐢 That paragraph took you a while.'} Want it explained?</span>
          <button className="primary small" onClick={() => explain(flag.word, flag.reason, flag.reads)}>
            Explain
          </button>
          <button
            className="ghost small"
            onClick={() => {
              ctl.unflag(flag.word);
              setFlag(null);
            }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {probe && (
        <ProbeModal
          onAnswer={(state: ProbeState | null) => {
            setProbe(false);
            void ctl.answerProbe(state);
          }}
        />
      )}
      {toast && <div className="toast-msg">{toast}</div>}
    </div>
  );
}

function Stat({ v, l, title }: { v: React.ReactNode; l: string; title: string }) {
  return (
    <div className="stat" title={title}>
      <div className="stat-v">{v}</div>
      <div className="stat-l">{l}</div>
    </div>
  );
}
