import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { RawItem, RawPage } from './types';

export async function extractPage(doc: PDFDocumentProxy, pageIndex: number): Promise<RawPage> {
  const page = await doc.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items: RawItem[] = [];
  for (const it of tc.items) {
    if (!('str' in it) || it.str === '') continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a < 0) continue; // rotated text: show, never type
    const style = tc.styles[it.fontName];
    items.push({
      str: it.str,
      x: e - vp.viewBox[0],
      y: f - vp.viewBox[1],
      w: it.width,
      fs: Math.hypot(c, d) || Math.abs(a),
      font: it.fontName,
      family: style?.fontFamily ?? 'serif',
      ascent: style?.ascent || 0.8,
      descent: style?.descent || -0.2,
    });
  }
  return { page: pageIndex, width: vp.width, height: vp.height, items };
}

export async function extractPages(doc: PDFDocumentProxy, from: number, to: number): Promise<RawPage[]> {
  const out: RawPage[] = [];
  for (let p = from; p <= to; p++) out.push(await extractPage(doc, p));
  return out;
}

export interface OutlineChapter {
  title: string;
  startPage: number;
  endPage: number;
}

/**
 * Flatten the outline into "chapters": top-level entries, except that entries whose
 * children look like chapters (e.g. "Part I" → "Chapter 1…") are expanded.
 */
export async function readChapters(doc: PDFDocumentProxy): Promise<OutlineChapter[]> {
  const outline = await doc.getOutline();
  if (!outline?.length) return [];
  const pageOf = async (dest: unknown): Promise<number> => {
    try {
      const d = typeof dest === 'string' ? await doc.getDestination(dest) : (dest as unknown[] | null);
      if (!d) return -1;
      const ref = d[0];
      return typeof ref === 'number' ? ref : await doc.getPageIndex(ref as never);
    } catch {
      return -1;
    }
  };
  const flat: { title: string; startPage: number }[] = [];
  for (const it of outline) {
    const kids = it.items ?? [];
    const chapterKids = kids.filter((k) => /^(chapter|part)\b|^\d+[.\s]/i.test(k.title.trim()));
    flat.push({ title: it.title.trim(), startPage: await pageOf(it.dest) });
    if (chapterKids.length >= 2 && chapterKids.length >= kids.length / 2) {
      for (const k of kids) flat.push({ title: k.title.trim(), startPage: await pageOf(k.dest) });
    }
  }
  const valid = flat.filter((c) => c.startPage >= 0).sort((a, b) => a.startPage - b.startPage);
  return valid.map((c, i) => ({
    ...c,
    endPage: Math.max(c.startPage, (valid[i + 1]?.startPage ?? doc.numPages) - 1),
  }));
}
