// Turn stored sessions, answers and focus checks into the numbers on the Progress page.

import { dayKey, type FocusRec, type ProbeState, type QuestionRec, type ReviewRec, type Session } from '../db/db';

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface SessionRow {
  id: number;
  start: number;
  words: number;
  minutes: number;
  wpm: number;
  comprehension: number | null;
  effective: number | null;
  regressionsPer100: number;
}

export function sessionRows(sessions: Session[], questions: QuestionRec[]): SessionRow[] {
  const bySession = new Map<number, number[]>();
  for (const q of questions) bySession.set(q.sessionId, [...(bySession.get(q.sessionId) ?? []), q.score]);
  return sessions
    .filter((s) => s.activeMs > 20000 && s.fresh + s.reread > 0)
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const words = s.fresh + s.reread;
      const wpm = words / (s.activeMs / 60000);
      const comp = avg(bySession.get(s.id!) ?? []);
      return {
        id: s.id!,
        start: s.start,
        words,
        minutes: s.activeMs / 60000,
        wpm,
        comprehension: comp,
        effective: comp === null ? null : wpm * comp,
        regressionsPer100: (s.regressions / words) * 100,
      };
    });
}

/** One point per comprehension check: reading speed on that section vs. score. */
export function checkPoints(questions: QuestionRec[]): { wpm: number; score: number; label: string }[] {
  const groups = new Map<string, QuestionRec[]>();
  for (const q of questions) {
    if (q.interleaved) continue;
    const k = `${q.sessionId}|${q.chapter}|${q.askedAt}`;
    groups.set(k, [...(groups.get(k) ?? []), q]);
  }
  return [...groups.values()]
    .filter((g) => g[0].wpm > 0)
    .map((g) => ({ wpm: g[0].wpm, score: avg(g.map((q) => q.score))!, label: g[0].heading || 'Section' }));
}

export function byFocus(questions: QuestionRec[]): { state: ProbeState; score: number | null; n: number }[] {
  return (['on', 'wander', 'zoned'] as const).map((state) => {
    const qs = questions.filter((q) => q.focus === state);
    return { state, score: avg(qs.map((q) => q.score)), n: qs.length };
  });
}

export function byType(questions: QuestionRec[]): { label: string; score: number | null; n: number }[] {
  const rows: [string, (q: QuestionRec) => boolean][] = [
    ['Recall', (q) => q.type === 'recall' && !q.interleaved],
    ['Why / how', (q) => q.type === 'inference' && !q.interleaved],
    ['Apply it', (q) => q.type === 'application' && !q.interleaved],
    ['Earlier sections', (q) => q.interleaved],
  ];
  return rows.map(([label, f]) => {
    const qs = questions.filter(f);
    return { label, score: avg(qs.map((q) => q.score)), n: qs.length };
  });
}

export function wordsByDay(sessions: Session[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions) m.set(dayKey(s.start), (m.get(dayKey(s.start)) ?? 0) + s.fresh + s.reread);
  return m;
}

/** Averages over the most recent `n` rows that have a value. */
export function recent<T>(rows: T[], pick: (r: T) => number | null, n = 5): number | null {
  return avg(
    rows
      .map(pick)
      .filter((v): v is number => v !== null)
      .slice(-n),
  );
}

/** Minutes at the screen and completed sprints for each of the last `days` days. */
export function timeByDay(sessions: Session[], focus: FocusRec[], days = 14, now = Date.now()): { key: string; minutes: number; sprints: number }[] {
  const out: { key: string; minutes: number; sprints: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push({ key: dayKey(d.getTime()), minutes: 0, sprints: 0 });
  }
  const at = new Map(out.map((r) => [r.key, r]));
  for (const s of sessions) {
    const r = at.get(dayKey(s.start));
    if (r) r.minutes += (s.presentMs ?? s.activeMs) / 60000;
  }
  for (const f of focus) {
    const r = at.get(dayKey(f.start));
    if (r && f.kind === 'focus' && f.completed) r.sprints++;
  }
  return out;
}

/** Share of reviews of already-seen cards that you remembered (rated Hard or better). */
export function recallRate(reviews: ReviewRec[]): number | null {
  const seen = new Set<number>();
  let n = 0;
  let ok = 0;
  for (const r of [...reviews].sort((a, b) => a.ts - b.ts)) {
    if (seen.has(r.cardId)) {
      n++;
      if (r.rating >= 2) ok++;
    }
    seen.add(r.cardId);
  }
  return n ? ok / n : null;
}
