import { Fragment, useEffect, useRef, useState } from 'react';
import type { AssistMode, Grade, QuizQuestion } from '../ai/prompts';
import { clock } from '../focus/timer';
import type { ProbeState } from '../db/db';

export function Modal({ children, onClose, wide }: { children: React.ReactNode; onClose?: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog">
        {children}
      </div>
    </div>
  );
}

/** Tiny markdown: paragraphs, "- " bullets, **bold**. */
export function Md({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : <Fragment key={i}>{part}</Fragment>));
  const blocks: React.ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) blocks.push(<ul key={blocks.length}>{bullets.map((b, i) => <li key={i}>{inline(b)}</li>)}</ul>);
    bullets = [];
  };
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^[-*•]\s+/.test(t)) bullets.push(t.replace(/^[-*•]\s+/, ''));
    else {
      flush();
      if (t) blocks.push(<p key={blocks.length}>{inline(t.replace(/^#+\s*/, ''))}</p>);
    }
  }
  flush();
  return <div className="md">{blocks}</div>;
}

// ---------------- Quiz ----------------

export interface QuizView {
  section: number;
  heading: string;
  status: 'loading' | 'ready' | 'grading' | 'graded' | 'error';
  questions: (QuizQuestion & { section: number; heading: string })[];
  grades?: Grade[];
  answers?: string[];
  error?: string;
  offline?: boolean; // no AI: a free-recall question graded by key words
  provider?: string;
}

const TYPE_LABEL: Record<string, string> = { recall: 'Recall', inference: 'Why / how', application: 'Apply it' };

export function QuizPanel({
  quiz,
  onSubmit,
  onRetry,
  onReread,
  onContinue,
  onSkip,
}: {
  quiz: QuizView;
  onSubmit: (answers: string[]) => void;
  onRetry: () => void;
  onReread: (i: number) => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const [answers, setAnswers] = useState<string[]>([]);
  const first = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setAnswers(quiz.questions.map(() => ''));
  }, [quiz.questions]);
  useEffect(() => {
    if (quiz.status === 'ready') first.current?.focus();
  }, [quiz.status]);
  const graded = quiz.status === 'graded';
  const total = quiz.grades ? quiz.grades.reduce((a, g) => a + g.score, 0) / Math.max(1, quiz.grades.length) : 0;

  return (
    <aside className="side-panel" aria-label="Comprehension check">
      <div className="eyebrow">Comprehension check</div>
      <h2>{quiz.heading || 'This section'}</h2>

      {quiz.status === 'loading' && (
        <div className="panel-loading">
          <div className="spinner" /> Writing questions about what you just read…
        </div>
      )}

      {quiz.status === 'error' && (
        <div className="panel-error">
          <p>Couldn't get questions: {quiz.error}</p>
          <div className="row">
            <button className="primary" onClick={onRetry}>
              Try again
            </button>
            <button onClick={onSkip}>Skip this check</button>
          </div>
        </div>
      )}

      {quiz.offline && quiz.status !== 'loading' && (
        <p className="small muted">
          No AI key yet, so this is a free-recall check graded by key words. <a href="#/settings">Add a free key</a> for real questions.
        </p>
      )}

      {(quiz.status === 'ready' || quiz.status === 'grading' || graded) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (quiz.status === 'ready') onSubmit(answers);
          }}
        >
          {quiz.questions.map((q, i) => {
            const g = quiz.grades?.[i];
            return (
              <div key={i} className={'question' + (g ? ' ' + g.verdict : '')}>
                <div className="q-meta small">
                  <span className="pill">{TYPE_LABEL[q.type] ?? q.type}</span>
                  {q.section !== quiz.section && <span className="pill earlier">From earlier: {q.heading || 'previous section'}</span>}
                </div>
                <div className="q-text">{q.q}</div>
                {!graded ? (
                  <textarea
                    ref={i === 0 ? first : undefined}
                    rows={3}
                    value={answers[i] ?? ''}
                    disabled={quiz.status !== 'ready'}
                    placeholder="Answer in your own words…"
                    onChange={(e) => setAnswers((a) => a.map((x, k) => (k === i ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        onSubmit(answers);
                      }
                      e.stopPropagation();
                    }}
                  />
                ) : (
                  <>
                    <div className="your-answer small">
                      <span className="muted">You: </span>
                      {quiz.answers?.[i] || <i className="muted">no answer</i>}
                    </div>
                    {g && (
                      <div className="grade-box">
                        <div className="grade-line">
                          <b className={'verdict ' + g.verdict}>{g.verdict === 'skipped' ? "Didn't know" : g.verdict}</b>
                          <span className="muted small">{Math.round(g.score * 100)}%</span>
                        </div>
                        {g.feedback && <p>{g.feedback}</p>}
                        {q.answer_key && (
                          <p className="small">
                            <span className="muted">{quiz.offline ? 'Key ideas: ' : 'A good answer: '}</span>
                            {q.answer_key}
                          </p>
                        )}
                        {g.missed.length > 0 && <p className="small muted">Missed: {g.missed.join(' · ')}</p>}
                        {g.score < 0.7 && q.evidence && (
                          <button type="button" className="small" onClick={() => onReread(i)}>
                            ↩ Reread this part
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {!graded ? (
            <div className="row">
              <button className="primary" type="submit" disabled={quiz.status !== 'ready'}>
                {quiz.status === 'grading' ? 'Grading…' : 'Check my answers'} <kbd>Ctrl+Enter</kbd>
              </button>
              <button type="button" className="ghost" onClick={onSkip} disabled={quiz.status !== 'ready'}>
                Skip
              </button>
            </div>
          ) : (
            <div className="quiz-done">
              <div className="meter">
                <div style={{ width: `${total * 100}%` }} />
              </div>
              <div className="row">
                <span className="score">Comprehension {Math.round(total * 100)}%</span>
                <button className="primary" type="button" onClick={onContinue} autoFocus>
                  Keep reading →
                </button>
              </div>
              {quiz.provider && <div className="small muted">Questions by {quiz.provider === 'gemini' ? 'Gemini' : 'Groq'}</div>}
            </div>
          )}
        </form>
      )}
    </aside>
  );
}

// ---------------- Assist: explain / ask / key points ----------------

export interface AssistView {
  mode: AssistMode;
  from: number;
  to: number;
  passage: string;
  reason?: 'rereads' | 'slow' | 'asked';
  reads: number;
  messages: { role: 'user' | 'assistant'; text: string }[];
  loading: boolean;
  error?: string;
  id?: number;
}

const ASSIST_TITLE: Record<AssistMode, string> = { explain: 'Explain this', ask: 'Ask about this', points: 'Key points' };

export function AssistPanel({ view, onAsk, onClose, onRetry, onCard }: { view: AssistView; onAsk: (q: string) => void; onClose: () => void; onRetry: () => void; onCard: () => void }) {
  const [q, setQ] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [view.messages.length, view.loading]);
  useEffect(() => {
    if (view.mode === 'ask') input.current?.focus();
  }, [view.mode, view.from]);
  const why =
    view.reason === 'rereads' ? `You've read this ${view.reads} times.` : view.reason === 'slow' ? 'You slowed down a lot here.' : null;
  const asking = view.mode === 'ask' && view.messages.length === 0;
  return (
    <aside className="side-panel" aria-label={ASSIST_TITLE[view.mode]}>
      <div className="row">
        <div className="eyebrow">{ASSIST_TITLE[view.mode]}</div>
        <button className="ghost small close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {why && <p className="small muted">{why}</p>}
      <blockquote className="para-quote">{view.passage.length > 420 ? view.passage.slice(0, 420) + '…' : view.passage}</blockquote>
      <div className="chat">
        {view.messages.map((m, i) => (
          <div key={i} className={'msg ' + m.role}>
            {m.role === 'assistant' ? <Md text={m.text} /> : m.text}
          </div>
        ))}
        {view.loading && (
          <div className="panel-loading">
            <div className="spinner" /> Thinking…
          </div>
        )}
        {view.error && (
          <div className="panel-error">
            {view.error}{' '}
            {!/key/i.test(view.error) && (
              <button className="small" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
        <div ref={end} />
      </div>
      <form
        className="ask"
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim() || view.loading) return;
          onAsk(q.trim());
          setQ('');
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            e.stopPropagation();
          }}
          placeholder={asking ? 'What do you want to know about this?' : 'Ask a follow-up…'}
        />
        <button type="submit" disabled={!q.trim() || view.loading}>
          Ask
        </button>
      </form>
      <div className="row panel-foot">
        <button className="ghost small" onClick={onCard}>
          ⭐ Make a memory card from this
        </button>
      </div>
    </aside>
  );
}

// ---------------- Selection ----------------

export function SelectionBar({ words, onAction, onClear }: { words: number; onAction: (a: 'card' | 'ask' | 'points' | 'explain') => void; onClear: () => void }) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="Selected text">
      <span className="small muted">{words} word{words === 1 ? '' : 's'} selected</span>
      <button className="primary small" onClick={() => onAction('card')} title="Make memory cards (C)">
        ⭐ Card <kbd>C</kbd>
      </button>
      <button className="small" onClick={() => onAction('ask')} title="Ask a question about it (A)">
        ❓ Ask <kbd>A</kbd>
      </button>
      <button className="small" onClick={() => onAction('points')} title="What to focus on (K)">
        🎯 Key points <kbd>K</kbd>
      </button>
      <button className="small" onClick={() => onAction('explain')} title="Explain it simply (E)">
        🤔 Explain <kbd>E</kbd>
      </button>
      <button className="ghost small" onClick={onClear} aria-label="Clear selection">
        ✕
      </button>
    </div>
  );
}

// ---------------- Card drafts ----------------

export interface CardDraftView {
  from: number;
  to: number;
  passage: string;
  status: 'loading' | 'ready' | 'saving' | 'error';
  drafts: { q: string; a: string; keep: boolean }[];
  error?: string;
}

export function CardPanel({ view, onChange, onSave, onClose, onRetry }: { view: CardDraftView; onChange: (d: CardDraftView['drafts']) => void; onSave: () => void; onClose: () => void; onRetry: () => void }) {
  const kept = view.drafts.filter((d) => d.keep && d.q.trim() && d.a.trim()).length;
  const edit = (i: number, patch: Partial<CardDraftView['drafts'][number]>) => onChange(view.drafts.map((d, k) => (k === i ? { ...d, ...patch } : d)));
  return (
    <aside className="side-panel" aria-label="New memory cards">
      <div className="row">
        <div className="eyebrow">New memory cards</div>
        <button className="ghost small close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <blockquote className="para-quote">{view.passage.length > 300 ? view.passage.slice(0, 300) + '…' : view.passage}</blockquote>
      {view.status === 'loading' && (
        <div className="panel-loading">
          <div className="spinner" /> Writing cards…
        </div>
      )}
      {view.status === 'error' && (
        <div className="panel-error">
          {view.error}{' '}
          <button className="small" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {view.drafts.map((d, i) => (
        <div key={i} className={'card-draft' + (d.keep ? '' : ' dropped')}>
          <label className="row small">
            <input type="checkbox" checked={d.keep} onChange={(e) => edit(i, { keep: e.target.checked })} /> Card {i + 1}
          </label>
          <textarea rows={2} value={d.q} onChange={(e) => edit(i, { q: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Question" />
          <textarea rows={2} className="answer" value={d.a} onChange={(e) => edit(i, { a: e.target.value })} onKeyDown={(e) => e.stopPropagation()} aria-label="Answer" />
        </div>
      ))}
      {(view.status === 'ready' || view.status === 'saving') && (
        <>
          <p className="small muted">Edit anything you'd phrase differently. Cards you write in your own words stick better.</p>
          <div className="row">
            <button className="primary" onClick={onSave} disabled={!kept || view.status === 'saving'}>
              Save {kept} card{kept === 1 ? '' : 's'}
            </button>
            <button className="ghost" onClick={() => onChange([...view.drafts, { q: '', a: '', keep: true }])}>
              + Add one
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

// ---------------- Breaks & presence ----------------

const BREAK_TIPS = [
  'Look at something 6 meters away for 20 seconds.',
  'Stand up and stretch your back and shoulders.',
  'Without looking: what were the main points of what you just read?',
  'Drink some water.',
  "Leave your phone alone: it isn't a break for your attention.",
];

export function BreakModal({ remaining, long, sprint, over, onSkip, onBack }: { remaining: () => number; long: boolean; sprint: number; over: boolean; onSkip: () => void; onBack: () => void }) {
  const [tip] = useState(() => BREAK_TIPS[Math.floor(Math.random() * BREAK_TIPS.length)]);
  const [remainingMs, setRemaining] = useState(remaining());
  useEffect(() => {
    const t = setInterval(() => setRemaining(remaining()), 500);
    return () => clearInterval(t);
  }, [remaining]);
  return (
    <Modal>
      <div className="eyebrow">{over ? 'Break over' : `Sprint ${sprint} done · ${long ? 'long break' : 'break'}`}</div>
      {over ? (
        <>
          <h2>Ready for the next sprint?</h2>
          <p className="muted">The timer starts with your first move.</p>
          <div className="row end">
            <button className="primary" autoFocus onClick={onBack}>
              Back to reading
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="big-timer">{clock(remainingMs)}</div>
          <p>{tip}</p>
          <p className="small muted">Real breaks keep your focus fresh for the next sprint.</p>
          <div className="row end">
            <button className="ghost" onClick={onSkip}>
              Skip break
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export function StillHere({ away, onBack }: { away: boolean; onBack: () => void }) {
  return away ? (
    <div className="away-overlay" onPointerDown={onBack}>
      <div className="away-card">
        <div className="eyebrow">Paused</div>
        <h2>You stepped away</h2>
        <p className="muted">Your reading time and focus sprint are paused. Move the mouse or press any key to continue.</p>
      </div>
    </div>
  ) : (
    <div className="flag-chip still-here" role="status">
      <span>👀 Still reading? Move the mouse or press any key.</span>
      <button className="primary small" onClick={onBack}>
        I'm here
      </button>
    </div>
  );
}

// ---------------- Thought probe ----------------

const PROBES: { state: ProbeState; label: string; hint: string }[] = [
  { state: 'on', label: 'On the text', hint: 'I was following what I read' },
  { state: 'wander', label: 'Somewhere else', hint: 'Thinking about something unrelated' },
  { state: 'zoned', label: 'Zoned out', hint: 'Eyes moving, nothing going in' },
];

export function ProbeModal({ onAnswer }: { onAnswer: (s: ProbeState | null) => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const i = ['1', '2', '3'].indexOf(e.key);
      if (i >= 0) {
        e.preventDefault();
        e.stopPropagation();
        onAnswer(PROBES[i].state);
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onAnswer]);
  return (
    <Modal onClose={() => onAnswer(null)}>
      <div className="eyebrow">Quick focus check</div>
      <h2>Just before this popped up, where was your mind?</h2>
      <div className="probe-options">
        {PROBES.map((p, i) => (
          <button key={p.state} onClick={() => onAnswer(p.state)}>
            <kbd>{i + 1}</kbd>
            <span>
              <b>{p.label}</b>
              <span className="small muted">{p.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <p className="small muted">Answer honestly. It's only used to show you when your reading goes on autopilot.</p>
    </Modal>
  );
}
