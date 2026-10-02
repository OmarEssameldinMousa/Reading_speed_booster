import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { navigate } from '../router';
import { bookFraction } from './Library';

export function BookPage({ bookId }: { bookId: number }) {
  const book = useLiveQuery(() => db.books.get(bookId), [bookId]);
  const progress = useLiveQuery(() => db.progress.get(bookId), [bookId]);
  const states = useLiveQuery(() => db.chapters.where('bookId').equals(bookId).toArray(), [bookId]);
  const questions = useLiveQuery(() => db.questions.where('bookId').equals(bookId).toArray(), [bookId]);
  if (!book) return <div className="center-msg">Loading…</div>;
  const f = bookFraction(book, states ?? []);
  const comp = questions?.length ? questions.reduce((a, q) => a + q.score, 0) / questions.length : null;

  const remove = async () => {
    if (!confirm(`Remove "${book.title}" and all its reading history? This can't be undone.`)) return;
    await db.transaction('rw', [db.books, db.files, db.progress, db.chapters, db.sections, db.overrides, db.clarifications, db.questions], async () => {
      await db.books.delete(bookId);
      await db.files.delete(bookId);
      await db.progress.delete(bookId);
      await db.chapters.where('bookId').equals(bookId).delete();
      await db.sections.where('bookId').equals(bookId).delete();
      await db.overrides.where('bookId').equals(bookId).delete();
      await db.clarifications.where('bookId').equals(bookId).delete();
      await db.questions.where('bookId').equals(bookId).delete();
    });
    navigate('#/');
  };

  return (
    <div className="page-wrap">
      <div className="section-head">
        <div>
          <div className="eyebrow">Book</div>
          <h1>{book.title}</h1>
        </div>
        <button className="primary big" onClick={() => navigate(`#/read/${bookId}/${progress?.current ?? book.startChapter}`)}>
          {progress ? 'Continue reading' : 'Start reading'} →
        </button>
      </div>

      <div className="book-milestones">
        <div className="progress-line">
          <div style={{ width: `${f * 100}%` }} />
        </div>
        <div className="muted small">
          {(f * 100).toFixed(1)}% of the book read · {questions?.length ?? 0} questions answered
          {comp !== null && ` · ${Math.round(comp * 100)}% understood`}
        </div>
      </div>

      <p className="muted">
        Choose where the real content starts. Everything before it (copyright, table of contents, preface…) is skipped. Figures, tables and
        code stay visible on the page, but they're never highlighted and the AI doesn't ask about them.
      </p>

      <ol className="chapters">
        {book.chapters.map((c, i) => {
          const st = states?.find((s) => s.chapter === i);
          const pct = st?.total ? Math.min(1, st.maxPos / st.total) : 0;
          const qs = questions?.filter((q) => q.chapter === i) ?? [];
          const before = i < book.startChapter;
          const isCur = (progress?.current ?? book.startChapter) === i;
          const isPart = /^part\b/i.test(c.title);
          return (
            <li key={i} className={'chapter-row' + (before ? ' before' : '') + (isCur ? ' current' : '') + (isPart ? ' part' : '')}>
              <div className="ch-main" onClick={() => !before && navigate(`#/read/${bookId}/${i}`)}>
                <div className="ch-title">
                  {pct >= 1 && <span className="check">✓ </span>}
                  {c.title}
                </div>
                <div className="muted small">
                  pages {c.startPage + 1}–{c.endPage + 1}
                  {st && pct < 1 ? ` · ${Math.round(pct * 100)}%` : ''}
                  {qs.length > 0 && ` · ${Math.round((qs.reduce((a, q) => a + q.score, 0) / qs.length) * 100)}% understood`}
                </div>
                {!before && (
                  <div className="progress-line thin">
                    <div style={{ width: `${pct * 100}%` }} />
                  </div>
                )}
              </div>
              {book.startChapter !== i ? (
                <button className="ghost small" onClick={() => db.books.update(bookId, { startChapter: i })} title="Treat this as the first real chapter">
                  Start here
                </button>
              ) : (
                <span className="pill">start</span>
              )}
            </li>
          );
        })}
      </ol>
      <div className="danger-zone">
        <button className="ghost small" onClick={remove}>
          Remove book
        </button>
      </div>
    </div>
  );
}
