// Where each stream word sits on the page: page, line, and its printed boxes.

import type { ChapterModel, PageModel, Stream } from './types';

/** Visual char id → (page index in model, item index, char index). */
export interface VidMap {
  page: Int32Array;
  item: Int32Array;
  char: Int32Array;
}

export function buildVidMap(model: ChapterModel): VidMap {
  const n = model.stream.vidCount;
  const m: VidMap = { page: new Int32Array(n).fill(-1), item: new Int32Array(n), char: new Int32Array(n) };
  model.pages.forEach((p, pi) =>
    p.items.forEach((it, ii) => {
      if (it.vidBase < 0) return;
      for (let c = 0; c < it.str.length; c++) {
        const v = it.vidBase + c;
        if (v >= n) continue;
        m.page[v] = pi;
        m.item[v] = ii;
        m.char[v] = c;
      }
    }),
  );
  return m;
}

/** Printed chars of word w (not its trailing separator). */
export function wordVids(s: Stream, w: number): number[] {
  const out: number[] = [];
  const from = s.wordStart[w];
  const to = from + s.words[w].length;
  for (let p = from; p < to; p++) for (let k = s.posVidStart[p]; k < s.posVidStart[p + 1]; k++) out.push(s.posVids[k]);
  return out;
}

export interface WordLayout {
  page: Int32Array; // word → page index in the model (first char)
  line: Int32Array; // word → global line id (first char), monotonic in reading order
  lineEnd: Int32Array; // word → last word on the same line
}

export function layoutWords(model: ChapterModel, vm: VidMap = buildVidMap(model)): WordLayout {
  const s = model.stream;
  const n = s.words.length;
  const page = new Int32Array(n);
  const line = new Int32Array(n);
  let lineId = -1;
  let lastKey = '';
  for (let w = 0; w < n; w++) {
    const v = wordVids(s, w)[0];
    const pi = v !== undefined ? vm.page[v] : -1;
    const key = pi >= 0 ? `${pi}:${model.pages[pi].items[vm.item[v]].line}` : lastKey;
    if (key !== lastKey) lineId++;
    lastKey = key;
    page[w] = pi >= 0 ? pi : w ? page[w - 1] : 0;
    line[w] = Math.max(lineId, 0);
  }
  const lineEnd = new Int32Array(n);
  for (let w = n - 1; w >= 0; w--) lineEnd[w] = w + 1 < n && line[w + 1] === line[w] ? lineEnd[w + 1] : w;
  return { page, line, lineEnd };
}

/** A box in page coordinates (points, origin top-left, y down). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Measure = (font: string, family: string, text: string) => number; // width at 100px

/**
 * Per-char x offsets of each item, matching how justified lines are printed: glyphs scale by a
 * per-font ratio and the remaining width goes into the spaces.
 */
function charOffsets(page: PageModel, measure: Measure): Map<number, { x: number[]; w: number[] }> {
  const items = page.items.map((it, i) => [it, i] as const).filter(([it]) => it.vidBase >= 0 && it.str);
  const nat = new Map<number, number>();
  const samples = new Map<string, number[]>();
  for (const [it, i] of items) {
    const width = (measure(it.font, it.family, it.str) * it.fs) / 100 || 1;
    nat.set(i, width);
    if (!it.str.includes(' ') && it.str.length >= 3) {
      const k = it.w / width;
      if (k > 0.5 && k < 2) samples.set(it.font, [...(samples.get(it.font) ?? []), k]);
    }
  }
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = new Map<number, { x: number[]; w: number[] }>();
  for (const [it, i] of items) {
    const natural = nat.get(i)!;
    const spaces = (it.str.match(/ /g) ?? []).length;
    const sample = samples.get(it.font);
    let k = it.w / natural;
    let ws = 0;
    if (spaces > 0 && spaces < it.str.length && sample?.length) {
      const r = median(sample);
      const extra = (it.w - natural * r) / spaces;
      if (extra >= -0.18 * it.fs) {
        k = r;
        ws = extra;
      }
    }
    const xs: number[] = [];
    const wsArr: number[] = [];
    let spacesBefore = 0;
    for (let c = 0; c < it.str.length; c++) {
      const pre = c ? (measure(it.font, it.family, it.str.slice(0, c)) * it.fs) / 100 : 0;
      const cw = (measure(it.font, it.family, it.str[c]) * it.fs) / 100;
      xs.push(it.x + pre * k + spacesBefore * ws);
      wsArr.push(cw * k);
      if (it.str[c] === ' ') spacesBefore++;
    }
    out.set(i, { x: xs, w: wsArr });
  }
  return out;
}

/** Boxes of every word printed on `pageIdx`, one per line the word touches. */
export function pageWordBoxes(model: ChapterModel, pageIdx: number, measure: Measure): Map<number, Box[]> {
  const s = model.stream;
  const page = model.pages[pageIdx];
  const offs = charOffsets(page, measure);
  const byWord = new Map<number, Map<number, Box>>();
  page.items.forEach((it, ii) => {
    const o = offs.get(ii);
    if (!o) return;
    const top = page.height - it.y - 0.8 * it.fs;
    const h = 1.05 * it.fs;
    for (let c = 0; c < it.str.length; c++) {
      const v = it.vidBase + c;
      const p = s.vidPos[v];
      if (p < 0 || it.str[c] === ' ') continue;
      const w = s.posWord[p];
      // chars attached to a separator (e.g. a skipped citation) belong to no word
      if (p >= s.wordStart[w] + s.words[w].length) continue;
      const lines = byWord.get(w) ?? new Map<number, Box>();
      const x0 = o.x[c];
      const x1 = x0 + o.w[c];
      const b = lines.get(it.line);
      if (!b) lines.set(it.line, { x: x0, y: top, w: x1 - x0, h });
      else {
        const nx0 = Math.min(b.x, x0);
        const nx1 = Math.max(b.x + b.w, x1);
        const ny0 = Math.min(b.y, top);
        const ny1 = Math.max(b.y + b.h, top + h);
        Object.assign(b, { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 });
      }
      byWord.set(w, lines);
    }
  });
  const out = new Map<number, Box[]>();
  for (const [w, lines] of byWord) out.set(w, [...lines.values()]);
  return out;
}

/** Paragraph containing word w: [start, end). */
export function paragraphAt(s: Stream, w: number): [number, number] {
  const ps = s.paragraphs;
  let lo = 0;
  for (let i = 0; i < ps.length; i++) if (ps[i] <= w) lo = i;
  return [ps[lo] ?? 0, ps[lo + 1] ?? s.words.length];
}

/** Sentences of [from, to) as word ranges. */
export function sentencesIn(s: Stream, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let a = from;
  for (let w = from; w < to; w++) {
    if (s.sentenceEnds[w] || w === to - 1) {
      out.push([a, w + 1]);
      a = w + 1;
    }
  }
  return out;
}
