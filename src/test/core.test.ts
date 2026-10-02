import { describe, it, expect, beforeEach } from 'vitest';
import { readTo, moveTo, isRegression, timesRead, type CursorState } from '../reader/cursor';
import { totals, recentWpm, dwell, rangeStats, median, type MoveEvent } from '../reader/metrics';
import { complete, pickModel, resetCooldowns } from '../ai/router';
import { AiError, type ProviderName } from '../ai/providers';
import { checkQuiz, checkGrades, fallbackGrade, locateQuote, quizPrompt } from '../ai/prompts';
import { DEFAULT_SETTINGS } from '../db/db';

const cursor = (n: number): CursorState => ({ pos: 0, maxPos: 0, counts: new Uint8Array(n) });

describe('cursor', () => {
  it('reads forward and counts fresh words', () => {
    const st = cursor(10);
    expect(readTo(st, 1)).toEqual({ from: 0, to: 1, fresh: 1, reread: 0 });
    expect(readTo(st, 5)).toEqual({ from: 1, to: 5, fresh: 4, reread: 0 });
    expect(st.pos).toBe(5);
    expect(st.maxPos).toBe(5);
    expect(Array.from(st.counts.slice(0, 6))).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it('going back is a regression and rereading darkens', () => {
    const st = cursor(10);
    readTo(st, 6);
    const m = moveTo(st, 2);
    expect(isRegression(m)).toBe(true);
    expect(st.maxPos).toBe(6);
    expect(readTo(st, 8)).toEqual({ from: 2, to: 8, fresh: 2, reread: 4 });
    expect(Array.from(st.counts.slice(0, 9))).toEqual([1, 1, 2, 2, 2, 2, 1, 1, 0]);
    expect(timesRead(st.counts, 2, 6)).toBe(2);
    expect(timesRead(st.counts, 0, 9)).toBe(0);
  });

  it('clamps to the chapter', () => {
    const st = cursor(3);
    readTo(st, 99);
    expect(st.pos).toBe(3);
    moveTo(st, -5);
    expect(st.pos).toBe(0);
    expect(readTo(st, -1)).toEqual({ from: 0, to: 0, fresh: 0, reread: 0 });
  });
});

const ev = (t: number, from: number, to: number, fresh = to - from, reread = 0, kind = 'next'): MoveEvent => ({ t, kind, from, to, fresh, reread });

describe('metrics', () => {
  it('counts active time and skips idle gaps', () => {
    const events = [ev(0, 0, 1), ev(1000, 1, 2), ev(2000, 2, 4), ev(100000, 4, 5), ev(101000, 5, 6)];
    const t = totals(events, 60000);
    expect(t.activeMs).toBe(3000);
    expect(t.words).toBe(4); // words of the first move and of the post-break move have no timing
    expect(t.fresh).toBe(6);
  });

  it('computes recent wpm', () => {
    const events: MoveEvent[] = [];
    for (let i = 0; i < 30; i++) events.push(ev(i * 250, i, i + 1)); // 4 words/s
    expect(recentWpm(events, 60000)).toBeCloseTo(240, 0);
  });

  it('attributes dwell to the words a move covered', () => {
    const events = [ev(0, 0, 1), ev(1000, 1, 3), ev(4000, 3, 4)];
    const d = dwell(events, 60000, 5);
    expect(Array.from(d)).toEqual([0, 500, 500, 3000, 0]);
    expect(median(d)).toBe(500);
  });

  it('measures a word range', () => {
    const events = [ev(0, 0, 1), ev(1000, 1, 3), ev(2000, 0, 0, 0, 0, 'jump'), ev(2100, 0, 1, 0, 1), ev(3100, 1, 3, 0, 2)];
    const r = rangeStats(events, 60000, 1, 3);
    expect(r.wpm).toBeCloseTo((4 / 2000) * 60000, 5);
    expect(r.rereadRate).toBe(1);
  });
});

beforeEach(() => resetCooldowns());

describe('AI router', () => {
  const settings = { ...DEFAULT_SETTINGS, geminiKey: 'g', groqKey: 'q' };
  const ok = (text: string) => async () => ({ text, tokensIn: 1, tokensOut: 1 });

  it('uses the primary provider', async () => {
    const used: ProviderName[] = [];
    const impls = {
      gemini: async () => (used.push('gemini'), { text: 'hi', tokensIn: 1, tokensOut: 1 }),
      groq: async () => (used.push('groq'), { text: 'yo', tokensIn: 1, tokensOut: 1 }),
    };
    const r = await complete(() => ({ system: '', messages: [] }), { settings, impls });
    expect(r).toMatchObject({ provider: 'gemini', value: 'hi' });
    expect(used).toEqual(['gemini']);
  });

  it('falls back to Groq when Gemini is out of quota', async () => {
    const impls = {
      gemini: async () => {
        throw new AiError('HTTP 429', 429, true);
      },
      groq: ok('fallback'),
    };
    const r = await complete(() => ({ system: '', messages: [] }), { settings, impls });
    expect(r.provider).toBe('groq');
  });

  it('falls back when a reply fails validation, and builds per-provider prompts', async () => {
    const seen: ProviderName[] = [];
    const impls = { gemini: ok('not json'), groq: ok('{"x":1}') };
    const r = await complete(
      (p) => {
        seen.push(p);
        return { system: '', messages: [] };
      },
      { settings, impls, check: (t) => JSON.parse(t) as { x: number }, sleep: async () => {} },
    );
    expect(r.value.x).toBe(1);
    expect(seen).toEqual(['gemini', 'gemini', 'groq']); // one retry, then the other provider
  });

  it('explains missing keys and reports all errors', async () => {
    await expect(complete(() => ({ system: '', messages: [] }), { settings: DEFAULT_SETTINGS })).rejects.toThrow(/No API key/);
    const impls = {
      gemini: async () => {
        throw new AiError('HTTP 500', 500);
      },
      groq: async () => {
        throw new AiError('HTTP 401', 401, false);
      },
    };
    await expect(complete(() => ({ system: '', messages: [] }), { settings, impls, sleep: async () => {} })).rejects.toThrow(/gemini: HTTP 500 · groq: HTTP 401/);
  });

  it('honors the primary setting and skips providers without keys', async () => {
    const impls = { gemini: ok('g'), groq: ok('q') };
    expect((await complete(() => ({ system: '', messages: [] }), { settings: { ...settings, primary: 'groq' }, impls })).provider).toBe('groq');
    expect((await complete(() => ({ system: '', messages: [] }), { settings: { ...settings, geminiKey: '' }, impls })).provider).toBe('groq');
  });
});

describe('AI router recovery', () => {
  const settings = { ...DEFAULT_SETTINGS, geminiKey: 'g', groqKey: 'q', geminiModel: 'gemini-flash-latest', groqModel: 'llama-3.3-70b-versatile' };
  const req = () => ({ system: '', messages: [] });
  const sleep = async () => {};
  const log = () => {
    const calls: string[] = [];
    const impl = (name: string, f: (model: string, n: number) => string) => async (cfg: { model: string }) => {
      calls.push(`${name}:${cfg.model}`);
      return { text: f(cfg.model, calls.length), tokensIn: 0, tokensOut: 0 };
    };
    return { calls, impl };
  };

  it('retries a busy model once, then succeeds', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', (_m, n) => {
        if (n === 1) throw new AiError('HTTP 503: high demand', 503, true);
        return 'ok';
      }),
      groq: impl('groq', () => 'groq'),
    };
    const r = await complete(req, { settings, impls, sleep });
    expect(r.provider).toBe('gemini');
    expect(calls).toEqual(['gemini:gemini-flash-latest', 'gemini:gemini-flash-latest']);
  });

  it('moves to a backup model when one stays overloaded, before switching provider', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', (m) => {
        if (m === 'gemini-flash-latest') throw new AiError('HTTP 503', 503, true);
        return 'lite';
      }),
      groq: impl('groq', () => 'groq'),
    };
    const r = await complete(req, { settings, impls, sleep });
    expect(r.value).toBe('lite');
    expect(calls).toEqual(['gemini:gemini-flash-latest', 'gemini:gemini-flash-latest', 'gemini:gemini-flash-lite-latest']);
  });

  it('replaces a retired model with one the key can use', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', () => {
        throw new AiError('HTTP 503', 503, true);
      }),
      groq: impl('groq', (m) => {
        if (m === 'llama-3.3-70b-versatile') throw new AiError('HTTP 404: The model does not exist', 404, true);
        return m;
      }),
    };
    const listModels = async () => ['whisper-large-v3', 'qwen/qwen3-32b', 'openai/gpt-oss-20b'];
    const r = await complete(req, { settings, impls, sleep, listModels });
    expect(r).toMatchObject({ provider: 'groq', value: 'openai/gpt-oss-20b' });
    expect(calls.filter((c) => c.startsWith('groq'))).toEqual(['groq:llama-3.3-70b-versatile', 'groq:openai/gpt-oss-20b']);
  });

  it('stops trying models when the key is bad', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', () => {
        throw new AiError('HTTP 400: API key not valid. Please pass a valid API key.', 400, false);
      }),
      groq: impl('groq', () => 'groq'),
    };
    const r = await complete(req, { settings, impls, sleep });
    expect(r.provider).toBe('groq');
    expect(calls.filter((c) => c.startsWith('gemini'))).toHaveLength(1);
  });

  it('skips the next model on a daily quota without retrying', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', (m) => {
        if (m === 'gemini-flash-latest') throw new AiError('HTTP 429: You exceeded your current quota', 429, true);
        return 'lite';
      }),
      groq: impl('groq', () => 'groq'),
    };
    await complete(req, { settings, impls, sleep });
    expect(calls).toEqual(['gemini:gemini-flash-latest', 'gemini:gemini-flash-lite-latest']);
  });

  it('tries a provider that just failed everywhere last for a while', async () => {
    const { calls, impl } = log();
    const impls = {
      gemini: impl('gemini', () => {
        throw new AiError('HTTP 503', 503, true);
      }),
      groq: impl('groq', () => 'groq'),
    };
    await complete(req, { settings, impls, sleep, listModels: async () => [] });
    calls.length = 0;
    await complete(req, { settings, impls, sleep });
    expect(calls).toEqual(['groq:llama-3.3-70b-versatile']);
  });

  it('picks sensible replacement models', () => {
    expect(pickModel('groq', ['whisper-large-v3', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'])).toBe('openai/gpt-oss-120b');
    expect(pickModel('groq', ['whisper-large-v3', 'some/new-model'])).toBe('some/new-model');
    expect(pickModel('gemini', ['gemini-3.5-flash-image', 'gemini-3.5-flash'])).toBe('gemini-3.5-flash');
    expect(pickModel('gemini', ['gemini-flash-latest'], ['gemini-flash-latest'])).toBe(null);
  });
});

describe('prompts', () => {
  it('parses a quiz and keeps one interleaved question', () => {
    const reply =
      '```json\n' +
      JSON.stringify({
        summary: 'S.',
        questions: [
          { q: 'Why?', type: 'inference', answer_key: 'Because.', evidence: 'a b c', about: 'current' },
          { q: 'What?', type: 'weird', answer_key: 'This.', evidence: '', about: 'current' },
          { q: 'Extra?', type: 'recall', answer_key: '', evidence: '', about: 'current' },
          { q: 'Before?', type: 'recall', answer_key: 'Then.', evidence: '', about: 'earlier' },
          { q: 'Before 2?', type: 'recall', answer_key: 'Then.', evidence: '', about: 'earlier' },
        ],
      }) +
      '\n```';
    const quiz = checkQuiz(reply, 2, true);
    expect(quiz.questions.map((q) => q.q)).toEqual(['Why?', 'What?', 'Before?']);
    expect(quiz.questions[1].type).toBe('recall');
    expect(checkQuiz(reply, 2, false).questions).toHaveLength(2);
    expect(() => checkQuiz('{"questions": []}', 2, false)).toThrow();
  });

  it('parses grades and derives verdicts', () => {
    const g = checkGrades('{"results":[{"score":0.9,"feedback":"Good"},{"score":2,"verdict":"partial","missed":["x","y","z","w"]}]}', 2);
    expect(g[0]).toMatchObject({ score: 0.9, verdict: 'correct', feedback: 'Good' });
    expect(g[1]).toMatchObject({ score: 1, verdict: 'partial', missed: ['x', 'y', 'z'] });
    expect(() => checkGrades('{"results":[]}', 1)).toThrow();
  });

  it('trims long sections for Groq but not Gemini', () => {
    const text = 'word '.repeat(10000);
    const input = { book: 'B', chapter: 'C', heading: 'H', text, earlier: [], n: 2 };
    expect(quizPrompt(input, 'gemini').messages[0].text.length).toBeGreaterThan(50000);
    expect(quizPrompt(input, 'groq').messages[0].text.length).toBeLessThan(16000);
  });

  it('grades offline by key terms', () => {
    const g = fallbackGrade('Replication keeps copies of data on several machines for fault tolerance.', 'copies of the data on machines so faults are tolerated', 'replication text');
    expect(g.score).toBeGreaterThan(0.3);
    expect(fallbackGrade('Replication keeps copies of data.', 'no idea', '').score).toBe(0);
  });

  it('locates an evidence quote in the text', () => {
    const words = 'Many applications today are data-intensive, as opposed to compute-intensive. Raw CPU power is rarely a limiting factor.'.split(' ');
    expect(locateQuote(words, 0, words.length, 'Raw CPU power is rarely')).toBe(9);
    expect(locateQuote(words, 0, words.length, 'nothing like this at all')).toBe(-1);
  });
});
