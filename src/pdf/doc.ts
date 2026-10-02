import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { db } from '../db/db';
import { extractPages } from './extract';
import { classifyPages, type Overrides } from './classify';
import { buildStream } from './stream';
import type { ChapterModel } from './types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };

const docs = new Map<number, Promise<PDFDocumentProxy>>();

export function openBytes(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
}

export function openBook(bookId: number): Promise<PDFDocumentProxy> {
  let p = docs.get(bookId);
  if (!p) {
    p = (async () => {
      const f = await db.files.get(bookId);
      if (!f) throw new Error('PDF file missing for this book');
      return openBytes(await f.blob.arrayBuffer());
    })();
    docs.set(bookId, p);
    p.catch(() => docs.delete(bookId));
  }
  return p;
}

export async function loadOverrides(bookId: number): Promise<Overrides> {
  const rows = await db.overrides.where('bookId').equals(bookId).toArray();
  return Object.fromEntries(rows.map((r) => [r.key, r.v]));
}

export async function loadChapter(bookId: number, chapter: number): Promise<ChapterModel> {
  const book = await db.books.get(bookId);
  if (!book) throw new Error('Book not found');
  const ch = book.chapters[chapter];
  const doc = await openBook(bookId);
  const raw = await extractPages(doc, ch.startPage, ch.endPage);
  const { pages, bodySize } = classifyPages(raw, await loadOverrides(bookId));
  return { pages, bodySize, stream: buildStream(pages) };
}
