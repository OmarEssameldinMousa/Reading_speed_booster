// Try the primary provider, fall back to the other one on quota/network errors, and count usage.

import { db, dayKey, getSettings, type Settings } from '../db/db';
import { AiError, geminiComplete, groqComplete, type CompleteReq, type CompleteRes, type ProviderConfig, type ProviderName } from './providers';

export type Impl = (cfg: ProviderConfig, req: CompleteReq, signal?: AbortSignal) => Promise<CompleteRes>;

export const IMPLS: Record<ProviderName, Impl> = { gemini: geminiComplete, groq: groqComplete };

export function providerOrder(s: Settings): { name: ProviderName; cfg: ProviderConfig }[] {
  const all: { name: ProviderName; cfg: ProviderConfig }[] = [
    { name: 'gemini', cfg: { key: s.geminiKey.trim(), model: s.geminiModel.trim() } },
    { name: 'groq', cfg: { key: s.groqKey.trim(), model: s.groqModel.trim() } },
  ];
  const usable = all.filter((p) => p.cfg.key && p.cfg.model);
  return usable.sort((a, b) => (a.name === s.primary ? -1 : b.name === s.primary ? 1 : 0));
}

export function aiAvailable(s: Settings): boolean {
  return s.aiOn && providerOrder(s).length > 0;
}

async function record(provider: string, ok: boolean, res?: CompleteRes) {
  const day = dayKey(Date.now());
  const key = `${day}|${provider}`;
  try {
    await db.transaction('rw', db.usage, async () => {
      const u = (await db.usage.get(key)) ?? { key, day, provider, requests: 0, failures: 0, tokensIn: 0, tokensOut: 0 };
      u.requests++;
      if (!ok) u.failures++;
      u.tokensIn += res?.tokensIn ?? 0;
      u.tokensOut += res?.tokensOut ?? 0;
      await db.usage.put(u);
    });
  } catch {
    /* usage is best-effort */
  }
}

export interface AiResult {
  text: string;
  provider: ProviderName;
}

export interface CompleteOpts<T> {
  timeoutMs?: number;
  settings?: Settings;
  impls?: Record<ProviderName, Impl>;
  /** Validate/convert the reply; throwing makes the router try the next provider. */
  check?: (text: string) => T;
}

/**
 * Run a request on the first provider that answers. `build` gets the provider name so prompts can
 * fit its context (Groq's free tier has small per-minute token limits).
 */
export async function complete<T = string>(build: (p: ProviderName) => CompleteReq, opts: CompleteOpts<T> = {}): Promise<AiResult & { value: T }> {
  const s = opts.settings ?? (await getSettings());
  if (!s.aiOn) throw new AiError('AI is turned off in Settings', 0, false);
  const order = providerOrder(s);
  if (!order.length) throw new AiError('No API key yet. Add a free Gemini or Groq key in Settings.', 0, false);
  const impls = opts.impls ?? IMPLS;
  const errors: string[] = [];
  for (const { name, cfg } of order) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45000);
    try {
      const res = await impls[name](cfg, build(name), ctl.signal);
      const value = opts.check ? opts.check(res.text) : (res.text as T);
      void record(name, true, res);
      return { text: res.text, provider: name, value };
    } catch (e) {
      void record(name, false);
      const err = e instanceof AiError ? e : new AiError(String(e));
      errors.push(`${name}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AiError(errors.join(' · '), 0, false);
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in ``` fences). */
export function parseJson<T>(text: string): T {
  const t = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new AiError('Reply was not JSON', 0, true);
  return JSON.parse(t.slice(a, b + 1)) as T;
}
