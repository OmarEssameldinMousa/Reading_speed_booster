// Decide which printed text the user types ("body"/"heading") and which is only shown ("skip"):
// figure labels, captions, code blocks, footnotes, running headers/footers, tables.

import type { ItemKind, ItemModel, PageModel, RawItem, RawPage } from './types';

export type Overrides = Record<string, 'type' | 'skip'>; // key: `${page}:${line}`

export function lineKey(page: number, line: number): string {
  return `${page}:${line}`;
}

/** Most common font size, weighted by character count. */
export function bodyFontSize(pages: RawPage[]): number {
  const hist = new Map<number, number>();
  for (const p of pages)
    for (const it of p.items) {
      const k = Math.round(it.fs * 10) / 10;
      hist.set(k, (hist.get(k) ?? 0) + it.str.trim().length);
    }
  let best = 10;
  let n = -1;
  for (const [k, v] of hist) if (v > n) [best, n] = [k, v];
  return best;
}

interface Line {
  items: RawItem[];
  idx: number[]; // index into page.items
  y: number;
  fs: number;
  text: string;
}

export function groupLines(items: RawItem[]): Line[] {
  const order = items.map((_, i) => i).sort((a, b) => items[b].y - items[a].y || items[a].x - items[b].x);
  const lines: Line[] = [];
  for (const i of order) {
    const it = items[i];
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) < Math.max(2, 0.35 * Math.min(last.fs, it.fs))) {
      last.items.push(it);
      last.idx.push(i);
      last.fs = Math.max(last.fs, it.fs);
    } else {
      lines.push({ items: [it], idx: [i], y: it.y, fs: it.fs, text: '' });
    }
  }
  for (const l of lines) {
    const pairs = l.items.map((it, k) => [it, l.idx[k]] as const).sort((a, b) => a[0].x - b[0].x);
    l.items = pairs.map((p) => p[0]);
    l.idx = pairs.map((p) => p[1]);
    l.text = l.items.map((it) => it.str).join('');
  }
  return lines;
}

const CAPTION = /^\s*(Figure|Table|Example|Listing)\s+[A-Z]?\d+([-.]\d+)*[.:]\s/;
const STOP_HEADINGS = /^(references|notes|footnotes|bibliography|further reading)$/i;

export interface ClassifyResult {
  pages: PageModel[];
  bodySize: number;
}

export function classifyPages(raw: RawPage[], overrides: Overrides = {}): ClassifyResult {
  const body = bodyFontSize(raw);
  let stopped = false; // after a "References" heading, nothing more is typed in this chapter
  const pages: PageModel[] = raw.map((p) => {
    const lines = groupLines(p.items);
    const kinds: ItemKind[] = new Array(p.items.length).fill('skip');
    const lineOf: number[] = new Array(p.items.length).fill(0);
    let inCaption = false;
    let prevCaptionLine: Line | null = null;
    lines.forEach((l, li) => {
      for (const i of l.idx) lineOf[i] = li;
      const trimmed = l.text.trim();
      const visible = l.items.filter((it) => it.str.trim());
      if (!visible.length) return;

      // Captions (and their continuation lines)
      if (CAPTION.test(l.text)) inCaption = true;
      else if (inCaption && prevCaptionLine && (prevCaptionLine.y - l.y > 1.6 * l.fs || l.items[0].font !== prevCaptionLine.items[0].font)) inCaption = false;
      if (inCaption) {
        prevCaptionLine = l;
        return;
      }

      // Running headers / footers / page numbers
      const inMargin = l.y < 0.085 * p.height || l.y > 0.93 * p.height;
      if ((inMargin && l.fs <= body * 1.05) || /^\d+$/.test(trimmed)) return;

      // Tables: several items separated by wide gaps
      let wideGaps = 0;
      for (let k = 1; k < visible.length; k++) {
        const gap = visible[k].x - (visible[k - 1].x + visible[k - 1].w);
        if (gap > 1.8 * l.fs) wideGaps++;
      }
      const tableLike = wideGaps >= 2;

      const isHeadingLine = visible.every(
        (it) => (it.family === 'sans-serif' && it.fs >= body * 1.08) || it.fs >= body * 1.3,
      );
      if (isHeadingLine && STOP_HEADINGS.test(trimmed)) stopped = true;
      if (stopped) return;

      for (const i of l.idx) {
        const it = p.items[i];
        const rel = it.fs / body;
        if (isHeadingLine) kinds[i] = 'heading';
        else if (tableLike) kinds[i] = 'skip';
        else if (rel >= 0.88 && rel <= 1.12) kinds[i] = 'body';
        else if (!it.str.trim() && rel > 0.5) kinds[i] = 'body'; // spaces between body items
      }
      // A line that is only monospace is a code block → show only
      if (visible.every((it) => it.family === 'monospace')) for (const i of l.idx) kinds[i] = 'skip';
    });

    // Manual per-line overrides
    lines.forEach((l, li) => {
      const o = overrides[lineKey(p.page, li)];
      if (!o) return;
      for (const i of l.idx) {
        if (o === 'skip') kinds[i] = 'skip';
        else if (kinds[i] === 'skip' && p.items[i].str.trim()) kinds[i] = p.items[i].fs >= body * 1.3 ? 'heading' : 'body';
      }
    });

    const items: ItemModel[] = p.items.map((it, i) => ({ ...it, kind: kinds[i], line: lineOf[i], vidBase: -1 }));
    return { page: p.page, width: p.width, height: p.height, items };
  });
  return { pages, bodySize: body };
}

/** Reading order of a page's items: top-to-bottom lines, left-to-right within a line. */
export function readingOrder(page: PageModel): number[][] {
  const byLine = new Map<number, number[]>();
  page.items.forEach((it, i) => {
    const arr = byLine.get(it.line) ?? [];
    arr.push(i);
    byLine.set(it.line, arr);
  });
  return [...byLine.keys()].sort((a, b) => a - b).map((k) => byLine.get(k)!.sort((a, b) => page.items[a].x - page.items[b].x));
}
