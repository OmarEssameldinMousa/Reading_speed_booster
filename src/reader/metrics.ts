// Reading metrics from the move log. A move's duration (time since the previous move) is the time
// spent reading the words it covers; gaps longer than `idleMs` are breaks and don't count.

export interface MoveEvent {
  t: number;
  kind: string;
  from: number;
  to: number;
  fresh: number;
  reread: number;
}

const read = (e: MoveEvent) => e.fresh + e.reread;

/** Active reading time and words read. */
export function totals(events: MoveEvent[], idleMs: number): { activeMs: number; words: number; fresh: number; reread: number; regressions: number } {
  let activeMs = 0;
  let words = 0;
  let fresh = 0;
  let reread = 0;
  let regressions = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.to < e.from) regressions++;
    fresh += e.fresh;
    reread += e.reread;
    if (i === 0) continue;
    const dt = e.t - events[i - 1].t;
    if (dt <= idleMs) {
      activeMs += dt;
      words += read(e);
    }
  }
  return { activeMs, words, fresh, reread, regressions };
}

export function wpm(words: number, activeMs: number): number {
  return activeMs > 0 ? words / (activeMs / 60000) : 0;
}

/** Words per minute over the most recent `windowMs` of active reading. */
export function recentWpm(events: MoveEvent[], idleMs: number, windowMs = 60000): number {
  let ms = 0;
  let words = 0;
  for (let i = events.length - 1; i > 0 && ms < windowMs; i--) {
    const dt = events[i].t - events[i - 1].t;
    if (dt > idleMs) continue;
    ms += dt;
    words += read(events[i]);
  }
  return ms > 3000 ? wpm(words, ms) : 0;
}

/** Milliseconds spent on each word (all passes), from moves that read words. */
export function dwell(events: MoveEvent[], idleMs: number, nWords: number): Float32Array {
  const out = new Float32Array(nWords);
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const n = e.to - e.from;
    const dt = e.t - events[i - 1].t;
    if (n <= 0 || read(e) === 0 || dt > idleMs) continue;
    const per = dt / n;
    for (let w = e.from; w < e.to && w < nWords; w++) out[w] += per;
  }
  return out;
}

export function median(xs: ArrayLike<number>): number {
  const a = Array.from(xs).filter((x) => x > 0).sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
}

/** Speed and rereading inside the word range [from, to). */
export function rangeStats(events: MoveEvent[], idleMs: number, from: number, to: number): { wpm: number; rereadRate: number; activeMs: number } {
  let ms = 0;
  let words = 0;
  let reread = 0;
  for (let i = 1; i < events.length; i++) {
    const e = events[i];
    const n = e.to - e.from;
    if (n <= 0 || read(e) === 0) continue;
    const a = Math.max(e.from, from);
    const b = Math.min(e.to, to);
    if (b <= a) continue;
    const share = (b - a) / n;
    reread += e.reread * share;
    const dt = e.t - events[i - 1].t;
    if (dt > idleMs) continue;
    ms += dt * share;
    words += b - a;
  }
  return { wpm: wpm(words, ms), rereadRate: to > from ? reread / (to - from) : 0, activeMs: ms };
}

/** Effective reading rate: speed weighted by comprehension (0..1). */
export function effectiveRate(wpmValue: number, comprehension: number): number {
  return wpmValue * comprehension;
}
