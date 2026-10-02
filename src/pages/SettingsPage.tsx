import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, dayKey, DEFAULT_SETTINGS, getSettings, resetEverything, saveSettings, type Settings } from '../db/db';
import { Modal } from '../reader/panels';
import { IMPLS } from '../ai/router';
import { listModels, type ProviderName } from '../ai/providers';

type Key = keyof Settings;

type Field =
  | { key: Key; label: string; help: string; kind: 'toggle' }
  | { key: Key; label: string; help: string; kind: 'number'; min: number; max: number; step?: number; unit?: string; percent?: boolean }
  | { key: Key; label: string; help: string; kind: 'select'; options: { value: string; label: string }[] };

interface Group {
  title: string;
  intro?: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: 'Comprehension checks',
    intro: 'Answering questions from memory (retrieval practice) is one of the best-supported ways to understand and remember what you read.',
    fields: [
      { key: 'questionsPerSection', label: 'Questions per section', help: 'Asked when you finish a section. Two is enough to show whether you understood without breaking your flow.', kind: 'number', min: 1, max: 5 },
      { key: 'interleaveChance', label: 'Questions about earlier sections', help: 'Chance that a check also asks about a section you read earlier this session. Mixing old and new material helps it stick.', kind: 'number', min: 0, max: 100, step: 5, percent: true, unit: '%' },
      { key: 'minSectionWords', label: 'Skip sections shorter than', help: 'Very short sections get no check of their own.', kind: 'number', min: 0, max: 2000, step: 10, unit: 'words' },
    ],
  },
  {
    title: 'Help when you get stuck',
    fields: [
      { key: 'rereadThreshold', label: 'Offer an explanation after reading a sentence', help: 'When you have read the same sentence this many times, the AI offers to explain its paragraph.', kind: 'number', min: 2, max: 10, unit: 'times' },
      { key: 'dwellFactor', label: '…or after slowing down to', help: 'A paragraph that takes this many times longer per word than your usual pace also counts as hard.', kind: 'number', min: 1.5, max: 10, step: 0.5, unit: '× your pace' },
    ],
  },
  {
    title: 'Focus',
    intro: 'Thought probes are how researchers measure mind-wandering: a quick question at a random moment about where your attention was.',
    fields: [
      { key: 'probesOn', label: 'Focus checks', help: 'Every few minutes: "where was your mind just now?" Your answers are matched with your scores, so you can see what autopilot reading costs you.', kind: 'toggle' },
      { key: 'probeMinMin', label: 'At the earliest every', help: 'Minimum minutes of active reading between focus checks.', kind: 'number', min: 1, max: 60, unit: 'min' },
      { key: 'probeMaxMin', label: 'At the latest every', help: 'Maximum minutes of active reading between focus checks. The exact moment is random.', kind: 'number', min: 1, max: 120, unit: 'min' },
      { key: 'idleSec', label: 'Pause that counts as a break', help: "A pause longer than this isn't counted as reading time, so a coffee break doesn't lower your speed.", kind: 'number', min: 10, max: 600, step: 5, unit: 'sec' },
    ],
  },
  {
    title: 'Speed training',
    intro: 'The pacer moves the highlight for you. Pushing slightly past your comfortable speed trains faster reading, but only while comprehension holds.',
    fields: [
      { key: 'pacerWpm', label: 'Pacer speed', help: 'Words per minute. Most people read non-fiction at 200–300 wpm.', kind: 'number', min: 100, max: 1200, step: 10, unit: 'wpm' },
      { key: 'pacerAdapt', label: 'Adapt pacer to comprehension', help: 'After each check: +5% when you scored 80% or more, −5% when you scored under 60%.', kind: 'toggle' },
    ],
  },
  {
    title: 'Reader',
    fields: [
      { key: 'theme', label: 'Theme', help: 'Paper is easier for long daytime reading; night inverts the pages for dark rooms.', kind: 'select', options: [{ value: 'paper', label: 'Paper' }, { value: 'night', label: 'Night' }] },
      { key: 'pageWidth', label: 'Page width', help: 'Maximum width of a book page on screen.', kind: 'number', min: 500, max: 1600, step: 20, unit: 'px' },
    ],
  },
];

function display(f: Field, v: Settings[Key]): string {
  if (f.kind === 'toggle') return v ? 'On' : 'Off';
  if (f.kind === 'select') return f.options.find((o) => o.value === v)?.label ?? String(v);
  const n = f.percent ? Math.round((v as number) * 100) : (v as number);
  return `${n}${f.unit ? ' ' + f.unit : ''}`;
}

const SECRET: Key[] = ['geminiKey', 'groqKey'];

export function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number>(undefined);

  useEffect(() => {
    getSettings().then(setS);
  }, []);

  const commit = (next: Settings) => {
    if (next.probeMinMin > next.probeMaxMin) next.probeMaxMin = next.probeMinMin;
    setS(next);
    saveSettings(next);
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaved(false), 1500);
  };
  const set = (key: Key, value: Settings[Key]) => s && commit({ ...s, [key]: value } as Settings);

  if (!s) return <div className="center-msg">Loading…</div>;
  const changed = (Object.keys(DEFAULT_SETTINGS) as Key[]).filter((k) => !SECRET.includes(k) && s[k] !== DEFAULT_SETTINGS[k]).length;

  return (
    <div className="page-wrap narrow settings">
      <div className="section-head">
        <div>
          <div className="eyebrow">Make it yours</div>
          <h1>Settings</h1>
        </div>
        <div className="row">
          <span className={'saved' + (saved ? ' show' : '')}>Saved ✓</span>
          <button onClick={() => commit({ ...DEFAULT_SETTINGS, geminiKey: s.geminiKey, groqKey: s.groqKey })} disabled={!changed}>
            Restore all suggested defaults{changed ? ` (${changed})` : ''}
          </button>
        </div>
      </div>

      <AiSettings s={s} set={set} />

      {GROUPS.map((g) => (
        <section key={g.title} className="settings-group">
          <h2>{g.title}</h2>
          {g.intro && <p className="muted small">{g.intro}</p>}
          {g.fields.map((f) => {
            const v = s[f.key];
            const def = DEFAULT_SETTINGS[f.key];
            return (
              <div key={f.key} className="setting">
                <div className="setting-text">
                  <label htmlFor={'set-' + f.key}>{f.label}</label>
                  <div className="muted small">{f.help}</div>
                  <div className="suggested small">
                    Suggested: <b>{display(f, def)}</b>
                    {v !== def && (
                      <button className="linkish" onClick={() => set(f.key, def)}>
                        use suggested
                      </button>
                    )}
                  </div>
                </div>
                <div className="setting-control">
                  {f.kind === 'toggle' && (
                    <button id={'set-' + f.key} className={'switch' + (v ? ' on' : '')} role="switch" aria-checked={!!v} onClick={() => set(f.key, !v)}>
                      <span />
                    </button>
                  )}
                  {f.kind === 'select' && (
                    <select id={'set-' + f.key} value={String(v)} onChange={(e) => set(f.key, e.target.value as Settings[Key])}>
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                  {f.kind === 'number' && (
                    <NumberInput
                      id={'set-' + f.key}
                      value={f.percent ? Math.round((v as number) * 100) : (v as number)}
                      min={f.min}
                      max={f.max}
                      step={f.step ?? 1}
                      unit={f.unit}
                      onCommit={(n) => set(f.key, (f.percent ? n / 100 : n) as Settings[Key])}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </section>
      ))}

      <section className="settings-group danger">
        <h2>Danger zone</h2>
        <div className="setting">
          <div className="setting-text">
            <label>Reset everything</label>
            <div className="small">
              Permanently deletes <b>all books, reading history, questions and answers, explanations, statistics, settings and API keys</b> from
              this browser. Your PDF files on disk are not touched. This cannot be undone.
            </div>
            <div className="small muted">
              Want a copy first? Use <a href="#/stats">Export JSON</a> on the Progress page.
            </div>
          </div>
          <div className="setting-control">
            <button className="danger-btn" onClick={() => setConfirming(true)}>
              Reset everything
            </button>
          </div>
        </div>
      </section>

      {confirming && <ConfirmReset onCancel={() => setConfirming(false)} />}
    </div>
  );
}

// ---------------- AI provider settings ----------------

const PROVIDERS: { name: ProviderName; title: string; keyField: 'geminiKey' | 'groqKey'; modelField: 'geminiModel' | 'groqModel'; url: string; note: string }[] = [
  {
    name: 'gemini',
    title: 'Google Gemini',
    keyField: 'geminiKey',
    modelField: 'geminiModel',
    url: 'https://aistudio.google.com/apikey',
    note: 'Free tier: about 1,500 requests a day on Flash models, with a context big enough for a whole chapter. On the free tier Google may use what you send to improve its models.',
  },
  {
    name: 'groq',
    title: 'Groq',
    keyField: 'groqKey',
    modelField: 'groqModel',
    url: 'https://console.groq.com/keys',
    note: 'Free tier with fast open models (Llama, Qwen). Used when Gemini is unavailable or out of quota. Smaller per-minute limits, so long sections are trimmed.',
  },
];

function AiSettings({ s, set }: { s: Settings; set: (k: Key, v: Settings[Key]) => void }) {
  const usage = useLiveQuery(() => db.usage.where('day').equals(dayKey(Date.now())).toArray(), []);
  return (
    <section className="settings-group">
      <h2>AI tutor</h2>
      <p className="muted small">
        Questions, grading and explanations come from a free AI API. Keys are stored only in this browser and sent only to that provider. Only
        the book's body text is sent, never figures or tables. Free tiers change often; your live limits are on each provider's dashboard.
      </p>
      <div className="setting">
        <div className="setting-text">
          <label htmlFor="set-aiOn">Use AI</label>
          <div className="muted small">Off: checks become free recall graded by key words, and there are no explanations.</div>
        </div>
        <div className="setting-control">
          <button id="set-aiOn" className={'switch' + (s.aiOn ? ' on' : '')} role="switch" aria-checked={s.aiOn} onClick={() => set('aiOn', !s.aiOn)}>
            <span />
          </button>
        </div>
      </div>
      <div className="setting">
        <div className="setting-text">
          <label htmlFor="set-primary">Try first</label>
          <div className="muted small">The other provider is used automatically when this one fails or runs out of free quota.</div>
          <div className="suggested small">
            Suggested: <b>Gemini</b>
          </div>
        </div>
        <div className="setting-control">
          <select id="set-primary" value={s.primary} onChange={(e) => set('primary', e.target.value as ProviderName)}>
            <option value="gemini">Gemini</option>
            <option value="groq">Groq</option>
          </select>
        </div>
      </div>
      {PROVIDERS.map((p) => {
        const u = usage?.find((x) => x.provider === p.name);
        return (
          <div key={p.name} className="provider">
            <div className="provider-head">
              <b>{p.title}</b>
              <a href={p.url} target="_blank" rel="noreferrer" className="small">
                Get a free key ↗
              </a>
              {u && (
                <span className="small muted">
                  today: {u.requests} request{u.requests === 1 ? '' : 's'}
                  {u.failures ? `, ${u.failures} failed` : ''} · {Math.round((u.tokensIn + u.tokensOut) / 1000)}k tokens
                </span>
              )}
            </div>
            <p className="small muted">{p.note}</p>
            <ProviderFields p={p} s={s} set={set} />
          </div>
        );
      })}
    </section>
  );
}

function ProviderFields({ p, s, set }: { p: (typeof PROVIDERS)[number]; s: Settings; set: (k: Key, v: Settings[Key]) => void }) {
  const [key, setKey] = useState(s[p.keyField]);
  const [model, setModel] = useState(s[p.modelField]);
  const [show, setShow] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    setKey(s[p.keyField]);
  }, [s, p.keyField]);
  useEffect(() => {
    setModel(s[p.modelField]);
  }, [s, p.modelField]);

  const run = async () => {
    setTesting(true);
    setTest(null);
    const t0 = performance.now();
    try {
      const r = await IMPLS[p.name]({ key: key.trim(), model: model.trim() }, { system: 'You are a connection test.', messages: [{ role: 'user', text: 'Reply with the single word OK.' }], maxTokens: 512 });
      setTest({ ok: true, msg: `Connected in ${Math.round(performance.now() - t0)} ms: "${r.text.trim().slice(0, 40)}"` });
      listModels(p.name, key.trim()).then(setModels, () => {});
    } catch (e) {
      setTest({ ok: false, msg: String((e as Error).message ?? e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="provider-fields">
      <label className="small">
        API key
        <span className="row">
          <input
            type={show ? 'text' : 'password'}
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder="paste your key"
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => key !== s[p.keyField] && set(p.keyField, key.trim())}
          />
          <button type="button" className="ghost small" onClick={() => setShow(!show)}>
            {show ? 'Hide' : 'Show'}
          </button>
        </span>
      </label>
      <label className="small">
        Model <span className="muted">(suggested: {DEFAULT_SETTINGS[p.modelField]})</span>
        <input
          list={`models-${p.name}`}
          value={model}
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model !== s[p.modelField] && set(p.modelField, model.trim() || DEFAULT_SETTINGS[p.modelField])}
        />
        <datalist id={`models-${p.name}`}>
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </label>
      <div className="row">
        <button type="button" onClick={run} disabled={!key.trim() || testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {test && <span className={'small ' + (test.ok ? 'ok-text' : 'danger-text')}>{test.msg}</span>}
      </div>
    </div>
  );
}

function NumberInput({ id, value, min, max, step, unit, onCommit }: { id: string; value: number; min: number; max: number; step: number; unit?: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const commit = () => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return setText(String(value));
    const clamped = Math.min(max, Math.max(min, n));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <span className="num">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {unit && <span className="muted small">{unit}</span>}
    </span>
  );
}

function ConfirmReset({ onCancel }: { onCancel: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<string>('');
  useEffect(() => {
    Promise.all([db.books.count(), db.sessions.count(), db.questions.count()]).then(([b, s, q]) =>
      setCounts(`${b} book${b === 1 ? '' : 's'}, ${s} reading session${s === 1 ? '' : 's'}, ${q} answered question${q === 1 ? '' : 's'}`),
    );
  }, []);
  const ok = text.trim().toUpperCase() === 'RESET';
  const go = async () => {
    if (!ok) return;
    setBusy(true);
    await resetEverything();
    location.hash = '#/';
    location.reload();
  };
  return (
    <Modal onClose={busy ? undefined : onCancel}>
      <div className="eyebrow danger-text">Cannot be undone</div>
      <h2>Delete everything?</h2>
      <p>This removes {counts || 'all your data'}, plus explanations, statistics, settings and your API keys. The app will start fresh.</p>
      <p className="small">
        Type <b>RESET</b> to confirm.
      </p>
      <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder="RESET" style={{ width: '100%' }} />
      <div className="row end">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="danger-btn" onClick={go} disabled={!ok || busy}>
          {busy ? 'Deleting…' : 'Delete everything'}
        </button>
      </div>
    </Modal>
  );
}
