// Try the primary provider, fall back to the other one on quota/network errors, and count usage.

import { db, dayKey, getSettings, saveSettings, type Settings } from '../db/db';
import { AiError, geminiComplete, groqComplete, listModels, type CompleteReq, type CompleteRes, type ProviderConfig, type ProviderName } from './providers';

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
  model: string;
}

export interface CompleteOpts<T> {
  timeoutMs?: number; // per request
  settings?: Settings;
  impls?: Record<ProviderName, Impl>;
  /** Validate/convert the reply; throwing makes the router try the next provider. */
  check?: (text: string) => T;
  /** Models the key can use (for replacing a retired model); defaults to the provider's /models API. */
  listModels?: (name: ProviderName, key: string) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
}

/** Backup models per provider, best first. Free tiers retire models often, so this is only a starting list. */
export const BACKUP_MODELS: Record<ProviderName, string[]> = {
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  groq: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.1-8b-instant'],
};

/** Pick the best available model for a provider from what the key can use. */
export function pickModel(name: ProviderName, available: string[], exclude: string[] = []): string | null {
  const ok = available.filter((m) => !exclude.includes(m));
  for (const m of BACKUP_MODELS[name]) if (ok.includes(m)) return m;
  if (name === 'gemini') return ok.find((m) => /flash/.test(m) && !/image|tts|live|audio|embed/.test(m)) ?? null;
  return ok.find((m) => !/whisper|tts|guard|orpheus|compound|embed/i.test(m)) ?? null;
}

// A provider that just failed on every model is tried last for a while, so a Gemini outage
// doesn't add several failing calls in front of every request.
const COOLDOWN_MS = 2 * 60000;
const cooldownUntil: Partial<Record<ProviderName, number>> = {};
export function resetCooldowns() {
  for (const k of Object.keys(cooldownUntil)) delete cooldownUntil[k as ProviderName];
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const overloaded = (e: AiError) => e.status === 503 || e.status === 500 || e.status === 502 || e.status === 504 || e.status === 429 || e.status === 0;
const missingModel = (e: AiError) => e.status === 404 || (e.status === 400 && /model/i.test(e.message) && /not (found|exist|supported)|decommission/i.test(e.message));

/**
 * Run a request on the first provider that answers. `build` gets the provider name so prompts can
 * fit its context (Groq's free tier has small per-minute token limits).
 *
 * Per provider: retry briefly when overloaded, then try a backup model; if the model was retired,
 * ask the provider which models the key can use and remember the replacement.
 */
export async function complete<T = string>(build: (p: ProviderName) => CompleteReq, opts: CompleteOpts<T> = {}): Promise<AiResult & { value: T }> {
  const s = opts.settings ?? (await getSettings());
  if (!s.aiOn) throw new AiError('AI is turned off in Settings', 0, false);
  const cooling = (n: ProviderName) => (cooldownUntil[n] ?? 0) > Date.now();
  const order = providerOrder(s).sort((a, b) => Number(cooling(a.name)) - Number(cooling(b.name)));
  if (!order.length) throw new AiError('No API key yet. Add a free Gemini or Groq key in Settings.', 0, false);
  const impls = opts.impls ?? IMPLS;
  const sleep = opts.sleep ?? sleepMs;
  const errors: string[] = [];

  for (const { name, cfg } of order) {
    const tried = new Set<string>();
    let model: string | null = cfg.model;
    let lastErr: AiError | null = null;
    let discovered = false;
    let giveUp = false;
    while (model && !giveUp && tried.size < 3) {
      tried.add(model);
      let retireModel = false;
      let badReply = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 45000);
        try {
          const res = await impls[name]({ ...cfg, model }, build(name), ctl.signal);
          badReply = true;
          const value = opts.check ? opts.check(res.text) : (res.text as T);
          badReply = false;
          void record(name, true, res);
          delete cooldownUntil[name];
          if (model !== cfg.model && discovered) void rememberModel(name, model);
          return { text: res.text, provider: name, model, value };
        } catch (e) {
          void record(name, false);
          lastErr = e instanceof AiError ? e : new AiError(String((e as Error)?.message ?? e));
          if (lastErr.status === 401 || lastErr.status === 403 || /api.?key/i.test(lastErr.message)) {
            giveUp = true; // bad key: other models won't help
            break;
          }
          if (missingModel(lastErr)) {
            retireModel = true;
            break;
          }
          // A bad reply (not JSON) or a busy server: retry the same model once
          const quota = lastErr.status === 429 && /quota|per day|exhausted|limit: 0/i.test(lastErr.message);
          if (quota || !lastErr.retryable || attempt === 1) break;
          await sleep(overloaded(lastErr) ? 2000 : 300);
        } finally {
          clearTimeout(timer);
        }
      }
      // Next model: a discovered replacement for a retired model, otherwise the next backup.
      if (retireModel && !discovered) {
        discovered = true;
        try {
          const available = await (opts.listModels ?? listModels)(name, cfg.key);
          model = pickModel(name, available, [...tried]);
          continue;
        } catch {
          /* fall through to the static backups */
        }
      }
      if (giveUp || badReply) break; // a model that answers but not usefully: let the other provider try
      model = BACKUP_MODELS[name].find((m) => !tried.has(m)) ?? null;
      if (retireModel) discovered = true;
    }
    if (lastErr && overloaded(lastErr)) cooldownUntil[name] = Date.now() + COOLDOWN_MS;
    errors.push(`${name}: ${lastErr?.message ?? 'no usable model'}`);
  }
  throw new AiError(errors.join(' · '), 0, false);
}

/** Save a replacement model so the next request goes straight to it. */
async function rememberModel(name: ProviderName, model: string) {
  try {
    const field = name === 'gemini' ? 'geminiModel' : 'groqModel';
    const s = await getSettings();
    if (s[field] !== model) await saveSettings({ ...s, [field]: model });
  } catch {
    /* best-effort */
  }
}

/** Pull the first JSON object out of a reply (models sometimes wrap it in ``` fences). */
export function parseJson<T>(text: string): T {
  const t = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new AiError('Reply was not JSON', 0, true);
  return JSON.parse(t.slice(a, b + 1)) as T;
}
