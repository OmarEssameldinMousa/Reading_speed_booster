import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPages, readChapters } from '../pdf/extract';
import { classifyPages } from '../pdf/classify';
import { buildStream, wordsText } from '../pdf/stream';
import type { Stream } from '../pdf/types';
import { keyTerms } from '../text/keyterms';
import { sectionRange } from '../pdf/stream';
import { layoutWords } from '../pdf/words';
import type { ChapterModel } from '../pdf/types';

const PDF = new URL('../../Book-2Designing-data-intensive-applications.pdf', import.meta.url);
const have = fs.existsSync(PDF);

describe.skipIf(!have)('DDIA chapter 1', () => {
  let stream: Stream;
  let text: string;
  let chapters: Awaited<ReturnType<typeof readChapters>>;
  let model: ChapterModel;
  beforeAll(async () => {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), verbosity: 0 }).promise;
    chapters = await readChapters(doc as never);
    const ch1 = chapters.find((c) => c.title.startsWith('Chapter 1'))!;
    const raw = await extractPages(doc as never, ch1.startPage, ch1.endPage);
    const { pages, bodySize } = classifyPages(raw);
    stream = buildStream(pages);
    model = { pages, stream, bodySize };
    text = wordsText(stream, 0, stream.words.length);
  });

  it('reads chapters from the outline', () => {
    const titles = chapters.map((c) => c.title);
    expect(titles).toContain('Chapter 1. Reliable, Scalable, and Maintainable Applications');
    expect(titles).toContain('Chapter 12. The Future of Data Systems');
    const ch1 = chapters.find((c) => c.title.startsWith('Chapter 1'))!;
    expect([ch1.startPage, ch1.endPage]).toEqual([24, 47]);
  });

  it('starts with the chapter heading and body text', () => {
    expect(text.slice(0, 200)).toMatch(/^CHAPTER 1 Reliable, Scalable, and Maintainable Applications Many applications today are data-intensive, as opposed to compute-intensive/);
  });

  it('joins words broken across lines and skips citations, footers, captions', () => {
    expect(text).toContain('broken down into tasks that can be performed efficiently on a single tool');
    expect(text).toContain('traditional categories. For example');
    expect(text).not.toMatch(/Figure 1-1\. One possible architecture/);
    expect(text).not.toContain('Chapter 1: Reliable, Scalable, and Maintainable Applications');
    expect(text).not.toMatch(/‐|’|—/);
  });

  it('finds sections', () => {
    const headings = stream.sections.map((s) => s.heading);
    expect(headings).toContain('Thinking About Data Systems');
    expect(headings.some((h) => /^Reliability$/.test(h))).toBe(true);
    expect(headings.some((h) => /References/.test(h))).toBe(false);
  });

  it('maps every stream char to a printed char and back', () => {
    let mapped = 0;
    for (let p = 0; p < stream.posCount; p++) if (stream.posVidStart[p + 1] > stream.posVidStart[p]) mapped++;
    // every non-separator position should map to a printed char
    const nonSep = stream.words.reduce((a, w) => a + w.length, 0);
    expect(mapped).toBeGreaterThanOrEqual(nonSep);
    for (let v = 0; v < stream.vidCount; v++) if (stream.vidPos[v] >= 0) expect(stream.vidPosEnd[v]).toBeGreaterThanOrEqual(stream.vidPos[v]);
  });

  it('picks meaningful key terms per section', () => {
    const texts = stream.sections.map((_, i) => wordsText(stream, ...sectionRange(stream, i)));
    const out = stream.sections.map((s, i) => `${s.heading}: ${keyTerms(texts[i], texts, 8).map((t) => t.word).join(', ')}`);
    const rel = out.find((l) => l.startsWith('Reliability:'))!;
    expect(rel).toMatch(/fault/);
    expect(rel).not.toMatch(/deliberately-for/);
  });

  it('lays words out on lines in reading order', () => {
    const L = layoutWords(model);
    // line ids never go backwards and every word's line end is on its line
    for (let w = 1; w < stream.words.length; w++) expect(L.line[w]).toBeGreaterThanOrEqual(L.line[w - 1]);
    for (let w = 0; w < stream.words.length; w++) expect(L.line[L.lineEnd[w]]).toBe(L.line[w]);
    // a typical body line holds several words, and the chapter spans many lines
    const lines = L.line[stream.words.length - 1] + 1;
    expect(lines).toBeGreaterThan(300);
    expect(stream.words.length / lines).toBeGreaterThan(6);
  });
});
