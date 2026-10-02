// Imperative highlight layer: one absolutely-positioned box per printed word, colored by how many
// times it has been read. Only pages near the viewport are mounted.

import type { ChapterModel } from '../pdf/types';
import { pageWordBoxes, type Box, type Measure } from '../pdf/words';
import { level } from './cursor';

const FAMILIES: Record<string, string> = {
  serif: "'Crimson Pro', Georgia, 'Times New Roman', serif",
  'sans-serif': "'Source Sans 3', 'Segoe UI', Arial, sans-serif",
  monospace: "'Source Code Pro', Menlo, monospace",
};

let ctx: CanvasRenderingContext2D | null = null;
const cache = new Map<string, number>();
export const measure: Measure = (_font, family, text) => {
  const key = family + '\u0000' + text;
  let v = cache.get(key);
  if (v === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')!;
    ctx.font = `100px ${FAMILIES[family] ?? FAMILIES.serif}`;
    v = ctx.measureText(text).width;
    if (cache.size > 200000) cache.clear();
    cache.set(key, v);
  }
  return v;
};

export class Marks {
  private boxes = new Map<number, Map<number, Box[]>>(); // page index → word → boxes
  private els: (HTMLDivElement[] | undefined)[];
  private mounted = new Map<number, HTMLDivElement[]>();
  private cursorWord = -1;
  private sel: [number, number] | null = null;
  private caret: HTMLDivElement | null = null;
  private caretTimer = 0;
  onMount?: (pageIdx: number) => void;

  constructor(
    public model: ChapterModel,
    public counts: Uint8Array,
  ) {
    this.els = new Array(model.stream.words.length);
  }

  boxesOf(pageIdx: number): Map<number, Box[]> {
    let b = this.boxes.get(pageIdx);
    if (!b) {
      b = pageWordBoxes(this.model, pageIdx, measure);
      this.boxes.set(pageIdx, b);
    }
    return b;
  }

  mountPage(pageIdx: number, layer: HTMLElement, scale: number) {
    this.unmountPage(pageIdx);
    const frag = document.createDocumentFragment();
    const all: HTMLDivElement[] = [];
    for (const [w, boxes] of this.boxesOf(pageIdx)) {
      const list = this.els[w]?.filter((e) => e.isConnected) ?? [];
      for (const b of boxes) {
        const d = document.createElement('div');
        d.dataset.w = String(w);
        d.style.left = `${(b.x - 1) * scale}px`;
        d.style.top = `${b.y * scale}px`;
        d.style.width = `${(b.w + 2) * scale}px`;
        d.style.height = `${b.h * scale}px`;
        list.push(d);
        all.push(d);
        frag.appendChild(d);
      }
      this.els[w] = list;
      this.paint(w);
    }
    layer.appendChild(frag);
    this.mounted.set(pageIdx, all);
    if (this.els[this.cursorWord]?.some((d) => d.parentElement === layer)) this.placeCaret(false);
    this.onMount?.(pageIdx);
  }

  unmountPage(pageIdx: number) {
    const all = this.mounted.get(pageIdx);
    if (!all) return;
    if (this.caret && all[0] && this.caret.parentElement === all[0].parentElement) this.caret.remove();
    for (const d of all) d.remove();
    for (const w of this.boxesOf(pageIdx).keys()) {
      const left = this.els[w]?.filter((e) => e.isConnected);
      this.els[w] = left?.length ? left : undefined;
    }
    this.mounted.delete(pageIdx);
  }

  private paint(w: number) {
    const list = this.els[w];
    if (!list) return;
    const sel = this.sel && w >= this.sel[0] && w < this.sel[1];
    const cls = `w r${level(this.counts[w])}${w === this.cursorWord ? ' cur' : ''}${sel ? ' sel' : ''}`;
    for (const d of list) {
      const flagged = d.classList.contains('flag');
      d.className = cls + (flagged ? ' flag' : '');
    }
  }

  /**
   * Repaint [from, to). With `sweep`, words that just got darker fill in one after another, left to
   * right, so a line read with Shift+↓ is swept rather than switched on all at once.
   */
  refresh(from: number, to: number, sweep = false) {
    const a = Math.max(0, from);
    const b = Math.min(to, this.els.length);
    const step = sweep && b - a > 1 ? Math.min(28, 220 / (b - a)) : 0;
    for (let w = a; w < b; w++) {
      for (const d of this.els[w] ?? []) {
        if (step) d.style.setProperty('--delay', `${Math.round((w - a) * step)}ms`);
        else d.style.removeProperty('--delay');
      }
      this.paint(w);
    }
  }

  setCursor(w: number) {
    const prev = this.cursorWord;
    this.cursorWord = w;
    this.paint(prev);
    this.paint(w);
    this.placeCaret(true);
  }

  /**
   * The reading caret: one element that glides to the next word. Along a line it slides;
   * to a new line or page it fades out and back in at the new spot instead of cutting across.
   */
  private placeCaret(animate: boolean) {
    const target = this.els[this.cursorWord]?.[0];
    const layer = target?.parentElement;
    if (!target || !layer) {
      this.caret?.remove();
      return;
    }
    if (!this.caret) {
      this.caret = document.createElement('div');
      this.caret.className = 'caret';
      this.caret.setAttribute('aria-hidden', 'true');
    }
    const c = this.caret;
    const sameLayer = c.parentElement === layer;
    const sameLine = sameLayer && Math.abs(parseFloat(c.style.top) - parseFloat(target.style.top)) < parseFloat(target.style.height) / 2;
    const place = () => {
      c.style.left = target.style.left;
      c.style.top = target.style.top;
      c.style.width = target.style.width;
      c.style.height = target.style.height;
    };
    clearTimeout(this.caretTimer);
    if (animate && sameLine) {
      c.classList.remove('jump', 'hop');
      place();
      return;
    }
    // jump without sliding, then fade in
    c.classList.add('jump');
    c.classList.remove('hop');
    if (!sameLayer) layer.appendChild(c);
    place();
    void c.offsetWidth; // apply the new position before re-enabling transitions
    c.classList.remove('jump');
    if (animate) c.classList.add('hop');
    this.caretTimer = window.setTimeout(() => c.classList.remove('hop'), 260);
  }

  /** Show a selection [from, to), or clear it with null. */
  select(range: [number, number] | null) {
    const old = this.sel;
    this.sel = range;
    if (old) this.refresh(old[0], old[1]);
    if (range) this.refresh(range[0], range[1]);
  }

  /** Mark a paragraph as flagged (needs clarification) or clear it. */
  flag(from: number, to: number, on: boolean) {
    for (let w = from; w < to; w++) for (const d of this.els[w] ?? []) d.classList.toggle('flag', on);
  }

  /** Screen rectangle of word w, if its page is mounted. */
  rect(w: number): DOMRect | null {
    const d = this.els[w]?.[0];
    return d?.isConnected ? d.getBoundingClientRect() : null;
  }
}
