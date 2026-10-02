import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, dayKey, getSettings, type Book, type ChapterState } from '../db/db';
import { openBytes } from '../pdf/doc';
import { readChapters } from '../pdf/extract';
import { navigate } from '../router';
import { aiAvailable } from '../ai/router';

export function bookFraction(book: Book, states: ChapterState[]): number {
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

/** Suggested first chapter: the first entry that looks like real content. */
function guessStart(chapters: Book['chapters']): number {
  const i = chapters.findIndex((c) => /^chapter\s|^1[.\s]/i.test(c.title));
  if (i >= 0) return i;
  const part = chapters.findIndex((c) => /^part\s/i.test(c.title));
  if (part >= 0) return part;
  const j = chapters.findIndex((c) => !/copyright|contents|preface|foreword|acknowledg|dedication|title|praise|about/i.test(c.title));
  return Math.max(0, j);
}

export function Library() {
  const books = useLiveQuery(() => db.books.toArray(), []);
  const states = useLiveQuery(() => db.chapters.toArray(), []);
  const progress = useLiveQuery(() => db.progress.toArray(), []);
  const today = useLiveQuery(async () => {
    const day = dayKey(Date.now());
    const [sessions, questions, s] = await Promise.all([db.sessions.where('start').aboveOrEqual(Date.now() - 86400e3).toArray(), db.questions.where('ts').aboveOrEqual(Date.now() - 86400e3).toArray(), getSettings()]);
    const todays = sessions.filter((x) => dayKey(x.start) === day);
    const qs = questions.filter((q) => dayKey(q.ts) === day);
    return {
      words: todays.reduce((a, x) => a + x.fresh + x.reread, 0),
      minutes: todays.reduce((a, x) => a + x.activeMs, 0) / 60000,
      comprehension: qs.length ? qs.reduce((a, q) => a + q.score, 0) / qs.length : null,
      ai: aiAvailable(s),
    };
  }, []);
  const [busy, setBusy] = useState<string>();
  const [drag, setDrag] = useState(false);

  const importFile = async (file: File) => {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') return alert('Please choose a PDF file.');
    setBusy(`Reading ${file.name}…`);
    try {
      const bytes = await file.arrayBuffer();
      const doc = await openBytes(bytes.slice(0));
      let chapters = await readChapters(doc);
      if (!chapters.length) {
        // No outline: split into 20-page parts
        chapters = [];
        for (let p = 0; p < doc.numPages; p += 20) chapters.push({ title: `Pages ${p + 1}–${Math.min(doc.numPages, p + 20)}`, startPage: p, endPage: Math.min(doc.numPages, p + 20) - 1 });
      }
      const meta = await doc.getMetadata().catch(() => null);
      const info = meta?.info as { Title?: string } | undefined;
      const title = info?.Title?.trim() || file.name.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ');
      const id = await db.books.add({ title, fileName: file.name, pageCount: doc.numPages, chapters, startChapter: guessStart(chapters), addedAt: Date.now() });
      await db.files.put({ bookId: id, blob: new Blob([bytes], { type: 'application/pdf' }) });
      void doc.cleanup();
      navigate(`#/book/${id}`);
    } catch (e) {
      alert('Could not open this PDF: ' + e);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="page-wrap">
      <section className="hero">
        <h1>
          Read <span className="accent">faster</span>. Understand more.
        </h1>
        <p className="muted">
          Move a highlight through the real pages of your book as you read. An AI tutor checks your understanding after every section, notices
          where you get stuck, and helps you find the fastest speed you can still understand at.
        </p>
      </section>

      {today && (
        <section className="today">
          <div className="today-card">
            <div className="eyebrow">Today</div>
            <div className="today-row">
              <span>
                <b>{today.words}</b> words read
              </span>
              <span>
                <b>{Math.round(today.minutes)}</b> min of focused reading
              </span>
              <span>
                <b>{today.comprehension === null ? '–' : `${Math.round(today.comprehension * 100)}%`}</b> understood
              </span>
              {!today.ai && (
                <button className="primary" onClick={() => navigate('#/settings')}>
                  Add a free AI key for comprehension questions
                </button>
              )}
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Your books</h2>
        </div>
        <div className="books">
          {books?.map((b) => {
            const f = bookFraction(b, states?.filter((x) => x.bookId === b.id) ?? []);
            const p = progress?.find((x) => x.bookId === b.id);
            return (
              <div key={b.id} className="book-card" onClick={() => navigate(`#/book/${b.id}`)}>
                <div className="book-spine" />
                <div className="book-info">
                  <div className="book-title">{b.title}</div>
                  <div className="muted small">
                    {b.chapters.length} chapters · {b.pageCount} pages
                  </div>
                  <div className="progress-line">
                    <div style={{ width: `${f * 100}%` }} />
                  </div>
                  <div className="small">{(f * 100).toFixed(1)}% read</div>
                </div>
                <div className="book-actions">
                  <button
                    className="primary"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`#/read/${b.id}/${p?.current ?? b.startChapter}`);
                    }}
                  >
                    {p ? 'Continue' : 'Start'}
                  </button>
                </div>
              </div>
            );
          })}
          <label
            className={'dropzone' + (drag ? ' drag' : '')}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              const f = e.dataTransfer.files[0];
              if (f) importFile(f);
            }}
          >
            <input type="file" accept="application/pdf,.pdf" hidden onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
            {busy ?? (
              <>
                <b>+ Add a PDF book</b>
                <span className="muted small">Drop it here or click to choose. It stays on your computer.</span>
              </>
            )}
          </label>
        </div>
      </section>
    </div>
  );
}
