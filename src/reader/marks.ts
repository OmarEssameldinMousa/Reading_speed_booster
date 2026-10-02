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
    this.onMount?.(pageIdx);
  }

  unmountPage(pageIdx: number) {
    const all = this.mounted.get(pageIdx);
    if (!all) return;
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
    const cls = `w r${level(this.counts[w])}${w === this.cursorWord ? ' cur' : ''}`;
    for (const d of list) d.className = cls;
  }

  refresh(from: number, to: number) {
    for (let w = Math.max(0, from); w < Math.min(to, this.els.length); w++) this.paint(w);
  }

  setCursor(w: number) {
    const prev = this.cursorWord;
    this.cursorWord = w;
    this.paint(prev);
    this.paint(w);
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
