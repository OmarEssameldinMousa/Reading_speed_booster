// Free-tier LLM providers called straight from the browser. Keys live in IndexedDB only.

export type ProviderName = 'gemini' | 'groq';

export interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
}

export interface CompleteReq {
  system: string;
  messages: ChatMsg[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface CompleteRes {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export class AiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public retryable = true,
  ) {
    super(message);
  }
}

export interface ProviderConfig {
  key: string;
  model: string;
}

async function post(url: string, body: unknown, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal });
  } catch (e) {
    throw new AiError(signal?.aborted ? 'Timed out' : `Network error: ${(e as Error).message}`, 0, true);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } };
      detail = j.error?.message ?? '';
    } catch {
      /* not json */
    }
    // 429 (quota), 5xx and 404 (model retired) are worth trying the other provider for
    throw new AiError(`HTTP ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`, res.status, res.status === 429 || res.status >= 500 || res.status === 404 || res.status === 403);
  }
  return res.json();
}

export async function geminiComplete(cfg: ProviderConfig, req: CompleteReq, signal?: AbortSignal): Promise<CompleteRes> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`;
  const body = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] })),
    generationConfig: {
      temperature: req.temperature ?? 0.4,
      maxOutputTokens: req.maxTokens ?? 4096,
      ...(req.json ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const j = (await post(url, body, {}, signal)) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    promptFeedback?: { blockReason?: string };
  };
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('');
  if (!text) throw new AiError(`Empty reply (${j.promptFeedback?.blockReason ?? j.candidates?.[0]?.finishReason ?? 'no candidates'})`, 0, true);
  return { text, tokensIn: j.usageMetadata?.promptTokenCount ?? 0, tokensOut: j.usageMetadata?.candidatesTokenCount ?? 0 };
}

export async function groqComplete(cfg: ProviderConfig, req: CompleteReq, signal?: AbortSignal): Promise<CompleteRes> {
  const body = {
    model: cfg.model,
    temperature: req.temperature ?? 0.4,
    max_tokens: Math.max(req.maxTokens ?? 2048, 4096), // reasoning models spend some of this thinking
    ...(/gpt-oss/.test(cfg.model) ? { reasoning_effort: 'low' } : {}),
    messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.text }))],
    ...(req.json ? { response_format: { type: 'json_object' } } : {}),
  };
  const send = (b: typeof body) => post('https://api.groq.com/openai/v1/chat/completions', b, { Authorization: `Bearer ${cfg.key}` }, signal);
  let raw: unknown;
  try {
    raw = await send(body);
  } catch (e) {
    // some models don't support JSON mode or reasoning settings; replies are parsed leniently anyway
    if (!(e instanceof AiError && e.status === 400 && /response_format|json|reasoning/i.test(e.message))) throw e;
    const { response_format: _rf, reasoning_effort: _re, ...plain } = body as typeof body & { response_format?: unknown; reasoning_effort?: unknown };
    raw = await send(plain as typeof body);
  }
  const j = raw as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = j.choices?.[0]?.message?.content ?? '';
  if (!text) throw new AiError('Empty reply', 0, true);
  return { text, tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0 };
}

/** Models the key can use (for the Settings page). */
export async function listModels(name: ProviderName, key: string): Promise<string[]> {
  if (name === 'gemini') {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`);
    if (!res.ok) throw new AiError(`HTTP ${res.status}`, res.status, false);
    const j = (await res.json()) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
    return (j.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''))
      .filter((m) => /flash|gemma/i.test(m));
  }
  const res = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new AiError(`HTTP ${res.status}`, res.status, false);
  const j = (await res.json()) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id).filter((id) => !/whisper|tts|guard|playai/i.test(id));
}
