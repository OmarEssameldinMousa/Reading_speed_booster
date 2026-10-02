// Trophies: badges with tiers (Bronze → Silver → Gold → Platinum), so there's always a next target.

import { db, dayKey, type QuestionRec, type Session } from '../db/db';
import { bookFraction } from '../stats/progress';
import { recent, sessionRows } from '../stats/aggregate';

export const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'] as const;

export interface Stats {
  sections: number;
  chapters: number;
  books: number;
  words: number;
  minutes: number;
  streak: number; // current
  bestStreak: number;
  sprints: number;
  perfectChecks: number;
  deepCorrect: number;
  recentComp: number; // % over the last 20 questions (0 until there are 20)
  cards: number;
  reviews: number;
  effGain: number; // % gain in effective reading rate vs. your first sessions
  explanations: number;
}

export interface BadgeDef {
  id: string;
  icon: string;
  title: string;
  what: string; // what you collect, e.g. "sections finished"
  tiers: [number, number, number, number];
  metric: (s: Stats) => number;
  unit?: string;
}

export const BADGES: BadgeDef[] = [
  { id: 'sections', icon: '📖', title: 'Section Hunter', what: 'sections finished', tiers: [1, 10, 50, 200], metric: (s) => s.sections },
  { id: 'chapters', icon: '📚', title: 'Chapter Closer', what: 'chapters finished', tiers: [1, 5, 15, 40], metric: (s) => s.chapters },
  { id: 'books', icon: '🏆', title: 'Book Conqueror', what: 'books finished', tiers: [1, 3, 10, 25], metric: (s) => s.books },
  { id: 'words', icon: '⛏️', title: 'Word Miner', what: 'words read', tiers: [2000, 20000, 100000, 500000], metric: (s) => s.words },
  { id: 'time', icon: '⏳', title: 'Time Invested', what: 'minutes of focused reading', tiers: [60, 600, 3000, 10000], metric: (s) => Math.floor(s.minutes) },
  { id: 'streak', icon: '🔥', title: 'Daily Reader', what: 'days in a row (best streak)', tiers: [3, 7, 30, 100], metric: (s) => s.bestStreak },
  { id: 'sprints', icon: '🍅', title: 'Deep Focus', what: 'focus sprints completed', tiers: [1, 10, 50, 200], metric: (s) => s.sprints },
  { id: 'perfect', icon: '🎯', title: 'Bullseye', what: 'perfect comprehension checks', tiers: [1, 5, 25, 100], metric: (s) => s.perfectChecks },
  { id: 'deep', icon: '🧠', title: 'Deep Thinker', what: 'why/how and apply-it answers right', tiers: [3, 25, 100, 300], metric: (s) => s.deepCorrect },
  { id: 'sharp', icon: '💡', title: 'Sharp Mind', what: '% understood over your last 20 questions', tiers: [70, 80, 90, 95], metric: (s) => s.recentComp, unit: '%' },
  { id: 'faster', icon: '🚀', title: 'Getting Faster', what: '% gain in effective reading rate', tiers: [5, 15, 30, 50], metric: (s) => s.effGain, unit: '%' },
  { id: 'cards', icon: '🗂️', title: 'Memory Builder', what: 'memory cards made', tiers: [5, 50, 200, 1000], metric: (s) => s.cards },
  { id: 'reviews', icon: '🔁', title: 'Steady Reviewer', what: 'card reviews done', tiers: [10, 100, 500, 2000], metric: (s) => s.reviews },
  { id: 'curious', icon: '🤔', title: 'Curious Mind', what: 'hard spots explained', tiers: [1, 10, 50, 150], metric: (s) => s.explanations },
];

/** Current and best run of consecutive reading days. */
export function streaks(days: Set<string>, now = Date.now()): { streak: number; best: number } {
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const k of sorted) {
    const t = new Date(k + 'T12:00').getTime();
    run = prev !== null && Math.round((t - prev) / 86400e3) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  }
  // current: ending today, or yesterday if you haven't read yet today
  let streak = 0;
  const d = new Date(now);
  if (!days.has(dayKey(d.getTime()))) d.setDate(d.getDate() - 1);
  while (days.has(dayKey(d.getTime()))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return { streak, best };
}

export function perfectChecks(questions: QuestionRec[]): number {
  const groups = new Map<string, number[]>();
  for (const q of questions) {
    if (q.interleaved) continue;
    const k = `${q.sessionId}|${q.bookId}|${q.chapter}|${q.askedAt}`;
    groups.set(k, [...(groups.get(k) ?? []), q.score]);
  }
  return [...groups.values()].filter((g) => g.every((s) => s >= 0.95)).length;
}

export function readingDays(sessions: Session[]): Set<string> {
  return new Set(sessions.filter((s) => s.fresh + s.reread >= 50 || (s.presentMs ?? 0) >= 120000).map((s) => dayKey(s.start)));
}

export async function loadStats(): Promise<Stats> {
  const [sessions, questions, books, states, sections, sprints, cards, reviews, explanations] = await Promise.all([
    db.sessions.toArray(),
    db.questions.toArray(),
    db.books.toArray(),
    db.chapters.toArray(),
    db.milestones.count(),
    db.focus.filter((f) => f.kind === 'focus' && f.completed).count(),
    db.cards.count(),
    db.reviews.count(),
    db.clarifications.count(),
  ]);
  const { streak, best } = streaks(readingDays(sessions));
  const rows = sessionRows(sessions, questions);
  const eff = rows.filter((r) => r.effective !== null);
  const first = eff.length >= 6 ? recent(eff.slice(0, 3), (r) => r.effective, 3) : null;
  const now = eff.length >= 6 ? recent(eff, (r) => r.effective) : null;
  const sortedQ = [...questions].sort((a, b) => a.ts - b.ts);
  return {
    sections,
    chapters: states.filter((c) => c.total > 0 && c.maxPos >= c.total).length,
    books: books.filter((b) => bookFraction(b, states.filter((s) => s.bookId === b.id)) >= 0.995).length,
    words: sessions.reduce((a, s) => a + s.fresh + s.reread, 0),
    minutes: sessions.reduce((a, s) => a + (s.presentMs ?? s.activeMs), 0) / 60000,
    streak,
    bestStreak: best,
    sprints,
    perfectChecks: perfectChecks(questions),
    deepCorrect: questions.filter((q) => q.type !== 'recall' && q.score >= 0.8).length,
    recentComp: sortedQ.length >= 20 ? Math.round((sortedQ.slice(-20).reduce((a, q) => a + q.score, 0) / 20) * 100) : 0,
    cards,
    reviews,
    effGain: first && now ? Math.max(0, Math.round(((now - first) / first) * 100)) : 0,
    explanations,
  };
}

export interface Progress {
  def: BadgeDef;
  value: number;
  tier: number; // highest tier reached, -1 = none
  next: number | null; // next threshold
  ratio: number; // progress toward the next tier, 0..1
}

export function progressOf(def: BadgeDef, s: Stats): Progress {
  const value = def.metric(s);
  let tier = -1;
  def.tiers.forEach((t, i) => value >= t && (tier = i));
  const next = tier < 3 ? def.tiers[tier + 1] : null;
  const from = tier >= 0 ? def.tiers[tier] : 0;
  const ratio = next === null ? 1 : Math.max(0, Math.min(1, (value - from) / (next - from)));
  return { def, value, tier, next, ratio };
}

/** The badges you're closest to levelling up: something to aim for. */
export function nextTargets(s: Stats, n = 3): Progress[] {
  return BADGES.map((d) => progressOf(d, s))
    .filter((p) => p.next !== null && p.value > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, n);
}

export interface Unlock {
  def: BadgeDef;
  tier: number;
}

type Listener = (u: Unlock[]) => void;
const listeners = new Set<Listener>();
export function onUnlock(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

let running: Promise<void> | null = null;
let again = false;

/** Recompute stats and unlock any new tiers. Safe to call often; runs are coalesced. */
export function checkBadges(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        const [stats, have] = await Promise.all([loadStats(), db.achievements.toArray()]);
        const got = new Set(have.map((a) => a.id));
        const fresh: Unlock[] = [];
        for (const def of BADGES) {
          const p = progressOf(def, stats);
          for (let t = 0; t <= p.tier; t++) if (!got.has(`${def.id}:${t}`)) fresh.push({ def, tier: t });
        }
        if (fresh.length) {
          const at = Date.now();
          await db.achievements.bulkPut(fresh.map((u) => ({ id: `${u.def.id}:${u.tier}`, badge: u.def.id, tier: u.tier, at })));
          // several tiers of one badge at once (e.g. imported history): announce only the highest
          const best = new Map<string, Unlock>();
          for (const u of fresh) if ((best.get(u.def.id)?.tier ?? -1) < u.tier) best.set(u.def.id, u);
          const list = [...best.values()];
          for (const l of listeners) l(list);
        }
      } while (again);
    } catch {
      /* badges are best-effort */
    } finally {
      running = null;
    }
  })();
  return running;
}
