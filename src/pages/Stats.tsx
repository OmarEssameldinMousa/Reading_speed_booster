import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { BarChart, Calendar, LineChart, Scatter } from '../stats/charts';
import { byFocus, byType, checkPoints, recallRate, recent, sessionRows, timeByDay, wordsByDay } from '../stats/aggregate';

const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);
const date = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function Stats() {
  const data = useLiveQuery(async () => {
    const [sessions, questions, clarifications, books, probes, sprints, cards, reviews] = await Promise.all([
      db.sessions.toArray(),
      db.questions.toArray(),
      db.clarifications.orderBy('ts').reverse().toArray(),
      db.books.toArray(),
      db.probes.toArray(),
      db.focus.toArray(),
      db.cards.count(),
      db.reviews.toArray(),
    ]);
    return { sessions, questions, clarifications, books, probes, sprints, cards, reviews };
  }, []);
  if (!data) return <div className="center-msg">Loading…</div>;
  const { sessions, questions, clarifications, books, probes, sprints, cards, reviews } = data;
  const time = timeByDay(sessions, sprints);
  const recall = recallRate(reviews);
  const rows = sessionRows(sessions, questions);
  const checks = checkPoints(questions);
  const focus = byFocus(questions);
  const types = byType(questions);
  const byDay = wordsByDay(sessions);
  const dayValues = [...byDay.values()].filter((v) => v > 0).sort((a, b) => a - b);
  const totalWords = sessions.reduce((a, s) => a + s.fresh + s.reread, 0);
  const totalMin = sessions.reduce((a, s) => a + (s.presentMs ?? s.activeMs), 0) / 60000;
  const first = rows.length >= 6 ? recent(rows.slice(0, 3), (r) => r.effective, 3) : null;
  const now = recent(rows, (r) => r.effective);
  const effRows = rows.filter((r) => r.effective !== null);
  const onTask = probes.length ? probes.filter((p) => p.state === 'on').length / probes.length : null;

  const exportJson = async () => {
    const tables = ['books', 'chapters', 'sessions', 'events', 'sections', 'questions', 'probes', 'clarifications', 'cards', 'reviews', 'focus', 'usage'] as const;
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
    for (const t of tables) {
      const rows = await db.table(t).toArray();
      out[t] = rows.map((r) => (r.counts instanceof Uint8Array ? { ...r, counts: Array.from(r.counts as Uint8Array) } : r));
    }
    download('reading-booster-data.json', JSON.stringify(out, null, 1), 'application/json');
  };
  const exportCsv = () => {
    const cols = ['ts', 'chapter', 'heading', 'type', 'interleaved', 'q', 'answer', 'score', 'verdict', 'wpm', 'rereadRate', 'focus', 'provider'] as const;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [cols.join(','), ...questions.map((q) => cols.map((c) => esc(c === 'ts' ? new Date(q.ts).toISOString() : q[c])).join(','))];
    download('reading-booster-questions.csv', lines.join('\n'), 'text/csv');
  };

  return (
    <div className="page-wrap">
      <div className="section-head">
        <div>
          <div className="eyebrow">Is it working?</div>
          <h1>Progress</h1>
        </div>
        <div className="row">
          <button onClick={exportCsv} disabled={!questions.length}>
            Export answers (CSV)
          </button>
          <button onClick={exportJson}>Export everything (JSON)</button>
        </div>
      </div>

      <div className="tiles">
        <Tile v={totalWords.toLocaleString()} l="words read" />
        <Tile v={`${Math.round(totalMin)} min`} l="active reading" />
        <Tile v={recent(rows, (r) => r.wpm) === null ? '–' : Math.round(recent(rows, (r) => r.wpm)!)} l="wpm (last 5 sessions)" />
        <Tile v={pct(recent(questions, (q) => q.score, 30))} l="understood (last 30 questions)" />
        <Tile v={now === null ? '–' : Math.round(now)} l="effective wpm" sub={first !== null && now !== null ? `${now >= first ? '+' : ''}${Math.round(((now - first) / first) * 100)}% vs. your first sessions` : undefined} />
        <Tile v={pct(onTask)} l="focus checks on-task" />
        <Tile v={cards} l="memory cards" sub={recall === null ? undefined : `${pct(recall)} remembered on review`} />
        <Tile v={sprints.filter((f) => f.kind === 'focus' && f.completed).length} l="focus sprints done" />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Reading time</h3>
          <span className="muted small">Minutes at the screen per day (away time doesn't count), last 14 days. Hover for sprints.</span>
        </div>
        <BarChart data={time.map((d) => ({ x: 0, y: d.minutes, label: `${date(new Date(d.key + 'T12:00').getTime())}: ${Math.round(d.minutes)} min, ${d.sprints} sprint${d.sprints === 1 ? '' : 's'}` }))} format={(v) => `${Math.round(v)}m`} />
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Effective reading rate</h3>
          <span className="muted small">words per minute × comprehension, per session. This is the number to grow.</span>
        </div>
        <LineChart data={effRows.map((r, i) => ({ x: i, y: r.effective!, label: date(r.start) }))} unit=" wpm" />
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="panel-head">
            <h3>Speed vs. understanding</h3>
            <span className="muted small">Each dot is one section. If the line falls steeply, you're reading faster than you can follow.</span>
          </div>
          <Scatter data={checks.map((c) => ({ x: c.wpm, y: c.score * 100, label: c.label }))} xLabel="wpm on the section" yLabel="score %" yMax={100} formatY={(v) => `${v.toFixed(0)}%`} />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Reading speed</h3>
            <span className="muted small">Words per minute per session.</span>
          </div>
          <LineChart data={rows.map((r, i) => ({ x: i, y: r.wpm, label: date(r.start) }))} unit=" wpm" color="var(--series-2)" />
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="panel-head">
            <h3>Focus vs. score</h3>
            <span className="muted small">Average score on questions answered after each kind of focus check.</span>
          </div>
          <BarChart
            data={focus.map((f) => ({ x: 0, y: (f.score ?? 0) * 100, label: `${f.state === 'on' ? 'On task' : f.state === 'wander' ? 'Mind elsewhere' : 'Zoned out'} (${f.n})` }))}
            colors={['var(--series-1)', 'var(--series-2)', 'var(--muted)']}
            yMax={100}
            format={(v) => `${v.toFixed(0)}%`}
          />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>By question type</h3>
            <span className="muted small">"Why / how" and "apply it" show deeper understanding than recall.</span>
          </div>
          <BarChart data={types.map((t) => ({ x: 0, y: (t.score ?? 0) * 100, label: `${t.label} (${t.n})` }))} yMax={100} format={(v) => `${v.toFixed(0)}%`} />
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <div className="panel-head">
            <h3>Going back</h3>
            <span className="muted small">Regressions per 100 words. Some are healthy; a falling line with steady comprehension means more confident reading.</span>
          </div>
          <LineChart data={rows.map((r, i) => ({ x: i, y: r.regressionsPer100, label: date(r.start) }))} format={(v) => v.toFixed(1)} color="var(--series-2)" />
        </div>
        <div className="panel">
          <div className="panel-head">
            <h3>Reading days</h3>
          </div>
          <Calendar byDay={byDay} goal={dayValues.length ? dayValues[Math.floor(dayValues.length * 0.75)] : 1000} />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Hard spots</h3>
          <span className="muted small">Paragraphs you reread, slowed down on, or asked about. Worth a second look before moving on.</span>
        </div>
        {clarifications.length === 0 ? (
          <div className="chart-empty">Nothing yet</div>
        ) : (
          <ul className="hotspots">
            {clarifications.slice(0, 30).map((c) => {
              const book = books.find((b) => b.id === c.bookId);
              return (
                <li key={c.id}>
                  <a href={`#/read/${c.bookId}/${c.chapter}/${c.word}`}>
                    <span className="pill">{c.reason === 'rereads' ? `read ${c.reads}×` : c.reason === 'slow' ? 'slow' : 'asked'}</span> {c.text.slice(0, 160)}
                    {c.text.length > 160 ? '…' : ''}
                  </a>
                  <div className="small muted">
                    {book?.title} · {book?.chapters[c.chapter]?.title} · {date(c.ts)}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function Tile({ v, l, sub }: { v: React.ReactNode; l: string; sub?: string }) {
  return (
    <div className="tile">
      <div className="tile-v">{v}</div>
      <div className="tile-l">{l}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
