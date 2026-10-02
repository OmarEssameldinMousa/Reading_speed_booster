import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Grade } from 'ts-fsrs';
import { db, getSettings, type CardRec, type Settings } from '../db/db';
import { aiAvailable } from '../ai/router';
import { fallbackGrade, gradeCardAnswer } from '../ai/prompts';
import { checkBadges } from '../gamify/badges';
import { configureScheduler, formatDays, localGrade, previewDays, RATING_LABEL, ratingFor, review } from '../srs/schedule';

interface Result {
  score: number;
  feedback: string;
  graded: 'ai' | 'local';
  suggested: Grade;
}

export function Review() {
  const [tab, setTab] = useState<'due' | 'all'>('due');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [now] = useState(() => Date.now());
  const due = useLiveQuery(() => db.cards.where('due').belowOrEqual(now).sortBy('due'), [now]);
  const total = useLiveQuery(() => db.cards.count(), []);
  const [done, setDone] = useState<number[]>([]);

  useEffect(() => {
    getSettings().then((s) => {
      configureScheduler(s.retention, s.maxIntervalDays);
      setSettings(s);
    });
  }, []);

  const queue = (due ?? []).filter((c) => !done.includes(c.id!));
  const card = queue[0];

  return (
    <div className="page-wrap narrow">
      <div className="section-head">
        <div>
          <div className="eyebrow">Spaced repetition</div>
          <h1>Review</h1>
        </div>
        <div className="row tabs">
          <button className={tab === 'due' ? 'primary' : ''} onClick={() => setTab('due')}>
            Due ({queue.length})
          </button>
          <button className={tab === 'all' ? 'primary' : ''} onClick={() => setTab('all')}>
            All cards ({total ?? 0})
          </button>
        </div>
      </div>

      {tab === 'due' &&
        (!settings || !due ? (
          <div className="center-msg">Loading…</div>
        ) : card ? (
          <ReviewCard key={card.id} card={card} settings={settings} left={queue.length} onDone={() => setDone((d) => [...d, card.id!])} />
        ) : (
          <div className="empty">
            <div className="big-emoji">✅</div>
            <h2>{done.length ? `Done: ${done.length} card${done.length === 1 ? '' : 's'} reviewed` : 'Nothing due right now'}</h2>
            <p className="muted">
              Make cards while reading: drag across a passage (or double-click a paragraph) and press <kbd>C</kbd>. Paragraphs you keep
              rereading become cards automatically.
            </p>
          </div>
        ))}

      {tab === 'all' && <AllCards />}
    </div>
  );
}

function ReviewCard({ card, settings, left, onDone }: { card: CardRec; settings: Settings; left: number; onDone: () => void }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showSource, setShowSource] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const days = useMemo(() => previewDays(card.fsrs), [card]);
  const book = useLiveQuery(() => db.books.get(card.bookId), [card.bookId]);

  useEffect(() => {
    box.current?.focus();
  }, []);

  const check = async (text: string) => {
    setBusy(true);
    let score = localGrade(card.a, text);
    let feedback = '';
    let graded: Result['graded'] = 'local';
    if (score === null) {
      if (aiAvailable(settings)) {
        try {
          const r = await gradeCardAnswer(card.q, card.a, text);
          score = r.value.score;
          feedback = r.value.feedback;
          graded = 'ai';
        } catch {
          /* fall back below */
        }
      }
      if (score === null) {
        const g = fallbackGrade(card.a, text, card.source);
        score = g.score;
        feedback = 'Graded by key words (AI unavailable), so this is rough. Adjust the rating if it feels wrong.';
      }
    } else feedback = score === 1 ? 'Spot on.' : '';
    setResult({ score, feedback, graded, suggested: ratingFor(score) });
    setBusy(false);
  };

  const rate = async (g: Grade) => {
    if (!result) return;
    await review(card, g, { answer, score: result.score, suggested: result.suggested, graded: result.graded });
    void checkBadges();
    onDone();
  };

  useEffect(() => {
    if (!result) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void rate(result.suggested);
      } else if (['1', '2', '3', '4'].includes(e.key)) void rate(Number(e.key) as Grade);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <div className="review-card">
      <div className="review-context small muted">
        {book?.title} · {card.heading || book?.chapters[card.chapter]?.title} · {left} left
        {card.origin === 'auto' && <span className="pill">auto: you reread this</span>}
      </div>
      <div className="q-text big-q">{card.q}</div>
      {!result ? (
        <>
          <textarea
            ref={box}
            rows={3}
            value={answer}
            disabled={busy}
            placeholder="Answer from memory, in your own words…"
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void check(answer);
              }
            }}
          />
          <div className="row">
            <button className="primary" onClick={() => void check(answer)} disabled={busy || !answer.trim()}>
              {busy ? 'Checking…' : 'Check'} <kbd>Ctrl+Enter</kbd>
            </button>
            <button className="ghost" onClick={() => void check('')} disabled={busy}>
              I don't remember
            </button>
          </div>
        </>
      ) : (
        <>
          {answer && (
            <div className="your-answer small">
              <span className="muted">You: </span>
              {answer}
            </div>
          )}
          <div className="grade-box">
            <div className="grade-line">
              <b className={'verdict ' + (result.score >= 0.7 ? 'correct' : result.score >= 0.35 ? 'partial' : 'incorrect')}>{Math.round(result.score * 100)}%</b>
              {result.feedback && <span>{result.feedback}</span>}
            </div>
            <p>
              <span className="muted">Answer: </span>
              {card.a}
            </p>
          </div>
          <p className="small">
            Suggested: <b>{RATING_LABEL[result.suggested]}</b>, next review in <b>{formatDays(days[result.suggested])}</b>
            {result.graded === 'ai' ? ' (AI grade → FSRS schedule).' : '.'} Press <kbd>Enter</kbd> to accept, or pick another:
          </p>
          <div className="grades">
            {([1, 2, 3, 4] as Grade[]).map((g) => (
              <button key={g} className={'grade' + (g === result.suggested ? ' suggested' : '')} onClick={() => void rate(g)}>
                <kbd>{g}</kbd> {RATING_LABEL[g]}
                <small>{formatDays(days[g])}</small>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="row source-row">
        <button className="ghost small" onClick={() => setShowSource(!showSource)}>
          {showSource ? 'Hide' : 'Show'} the passage
        </button>
        <a className="small" href={`#/read/${card.bookId}/${card.chapter}/${card.wordFrom}`}>
          Open in the book →
        </a>
      </div>
      {showSource && <blockquote className="para-quote">{card.source}</blockquote>}
    </div>
  );
}

function AllCards() {
  const cards = useLiveQuery(() => db.cards.orderBy('due').toArray(), []);
  const books = useLiveQuery(() => db.books.toArray(), []);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  if (!cards) return <div className="center-msg">Loading…</div>;
  const shown = cards.filter((c) => !q || (c.q + ' ' + c.a + ' ' + c.heading).toLowerCase().includes(q.toLowerCase()));
  return (
    <div>
      <input className="search" placeholder="Search cards…" value={q} onChange={(e) => setQ(e.target.value)} />
      {!shown.length && <div className="chart-empty">No cards yet</div>}
      <ul className="card-list">
        {shown.map((c) => (
          <li key={c.id}>
            {editing === c.id ? (
              <CardEditor card={c} onDone={() => setEditing(null)} />
            ) : (
              <>
                <div className="card-q">{c.q}</div>
                <div className="card-a small">{c.a}</div>
                <div className="small muted row">
                  <span>{books?.find((b) => b.id === c.bookId)?.title} · {c.heading}</span>
                  {c.origin === 'auto' && <span className="pill">auto</span>}
                  <span>due {c.due <= Date.now() ? 'now' : 'in ' + formatDays((c.due - Date.now()) / 86400e3)}</span>
                  <button className="linkish" onClick={() => setEditing(c.id!)}>
                    edit
                  </button>
                  <button
                    className="linkish danger-text"
                    onClick={async () => {
                      if (!confirm('Delete this card?')) return;
                      await db.transaction('rw', db.cards, db.reviews, async () => {
                        await db.cards.delete(c.id!);
                        await db.reviews.where('cardId').equals(c.id!).delete();
                      });
                    }}
                  >
                    delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardEditor({ card, onDone }: { card: CardRec; onDone: () => void }) {
  const [q, setQ] = useState(card.q);
  const [a, setA] = useState(card.a);
  return (
    <div className="card-draft">
      <textarea rows={2} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Question" />
      <textarea rows={2} className="answer" value={a} onChange={(e) => setA(e.target.value)} aria-label="Answer" />
      <div className="row">
        <button
          className="primary small"
          disabled={!q.trim() || !a.trim()}
          onClick={async () => {
            await db.cards.update(card.id!, { q: q.trim(), a: a.trim() });
            onDone();
          }}
        >
          Save
        </button>
        <button className="ghost small" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}
