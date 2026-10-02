import type { Book, ChapterState } from '../db/db';

/** Share of the book read (from its start chapter), weighted by chapter length in pages. */
export function bookFraction(book: Book, states: Pick<ChapterState, 'chapter' | 'maxPos' | 'total'>[]): number {
  let done = 0;
  let total = 0;
  book.chapters.forEach((c, i) => {
    if (i < book.startChapter) return;
    const pages = c.endPage - c.startPage + 1;
    total += pages;
    const st = states.find((s) => s.chapter === i);
    if (st?.total) done += pages * Math.min(1, st.maxPos / st.total);
  });
  return total ? done / total : 0;
}

