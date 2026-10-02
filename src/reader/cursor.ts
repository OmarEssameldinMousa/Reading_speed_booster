// The reading cursor: a pure model of where you are and how many times you've read each word.
// `pos` is the next word to read; moving forward over words reads them, moving back doesn't.

export interface CursorState {
  pos: number;
  maxPos: number;
  counts: Uint8Array; // reads per word
}

export interface Move {
  from: number;
  to: number;
  fresh: number; // words read for the first time
  reread: number; // words read again
}

/** Read words [pos, to) and move the cursor to `to`. Mutates `counts`. */
export function readTo(st: CursorState, to: number): Move {
  const n = st.counts.length;
  const from = st.pos;
  to = Math.max(from, Math.min(n, to));
  let fresh = 0;
  let reread = 0;
  for (let w = from; w < to; w++) {
    if (st.counts[w] === 0) fresh++;
    else reread++;
    if (st.counts[w] < 255) st.counts[w]++;
  }
  st.pos = to;
  st.maxPos = Math.max(st.maxPos, to);
  return { from, to, fresh, reread };
}

/** Move the cursor without reading (click, Shift+←). */
export function moveTo(st: CursorState, to: number): Move {
  const from = st.pos;
  st.pos = Math.max(0, Math.min(st.counts.length, to));
  return { from, to: st.pos, fresh: 0, reread: 0 };
}

export function isRegression(m: Move): boolean {
  return m.to < m.from;
}

/** Highlight level for a word: 0 unread … 4 read four or more times. */
export function level(count: number): number {
  return Math.min(count, 4);
}

/** How many times the range [from, to) has been read in full (the least-read word). */
export function timesRead(counts: Uint8Array, from: number, to: number): number {
  let m = Infinity;
  for (let w = from; w < to; w++) m = Math.min(m, counts[w]);
  return m === Infinity ? 0 : m;
}
