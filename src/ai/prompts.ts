// What we ask the model, and how we check what comes back.

import { complete, parseJson } from './router';
import { AiError, type ChatMsg, type ProviderName } from './providers';
import { coverage, keyTerms } from '../text/keyterms';
import type { Verdict } from '../db/db';

// How much section text to send. Gemini's free tier has a huge context; Groq's free tier
// limits tokens per minute, so it gets a trimmed section.
const BUDGET: Record<ProviderName, { main: number; earlier: number }> = {
  gemini: { main: 60000, earlier: 12000 },
  groq: { main: 14000, earlier: 3000 },
};

function clip(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, chars) + ' […]';
}

const TUTOR = `You are a reading-comprehension tutor helping an adult learn faster from technical and non-fiction books.
You only use the prose text you are given. Never ask about or rely on figures, tables, diagrams, code listings,
page numbers or citations, even when the text mentions them (e.g. "see Figure 1-1"). Reply with JSON only.`;

export type QType = 'recall' | 'inference' | 'application';

export interface QuizQuestion {
  q: string;
  type: QType;
  answer_key: string;
  evidence: string;
  about: 'current' | 'earlier';
}

export interface Quiz {
  summary: string;
  questions: QuizQuestion[];
}

export interface QuizInput {
  book: string;
  chapter: string;
  heading: string;
  text: string;
  earlier: { heading: string; summary: string }[];
  n: number;
  interleave?: { heading: string; text: string };
}

export function quizPrompt(input: QuizInput, p: ProviderName) {
  const b = BUDGET[p];
  const parts = [`Book: ${input.book}`, `Chapter: ${input.chapter}`];
  if (input.earlier.length)
    parts.push('What the reader has read earlier in this session (summaries):\n' + input.earlier.map((e) => `- ${e.heading || 'Untitled'}: ${e.summary}`).join('\n'));
  parts.push(`=== SECTION: ${input.heading || 'Untitled'} ===\n${clip(input.text, b.main)}\n=== END SECTION ===`);
  if (input.interleave) parts.push(`=== EARLIER SECTION: ${input.interleave.heading || 'Untitled'} ===\n${clip(input.interleave.text, b.earlier)}\n=== END EARLIER SECTION ===`);
  parts.push(`Task:
1. "summary": 2-3 sentences with the main ideas of SECTION.
2. "questions": exactly ${input.n} question(s) about SECTION${input.interleave ? ', then exactly 1 question about EARLIER SECTION (about: "earlier"); if possible, make it connect the earlier idea to the new section' : ''}.
   Test understanding, not trivia: include at least one "inference" (why / how / what follows) or "application" (apply the idea to a new situation) question.
   Each question must be answerable in 1-3 sentences from the text alone, and be at most 30 words.
Each question object: {"q": string, "type": "recall" | "inference" | "application", "answer_key": ideal answer in 1-3 sentences,
"evidence": a short exact quote (6-15 words) copied from the text that supports the answer, "about": "current" | "earlier"}.
Return JSON: {"summary": string, "questions": [...]}`);
  return { system: TUTOR, messages: [{ role: 'user' as const, text: parts.join('\n\n') }], json: true, temperature: 0.5 };
}

export function checkQuiz(text: string, n: number, wantEarlier: boolean): Quiz {
  const j = parseJson<{ summary?: unknown; questions?: unknown }>(text);
  if (!Array.isArray(j.questions)) throw new AiError('No questions in reply');
  const qs: QuizQuestion[] = [];
  for (const raw of j.questions as Record<string, unknown>[]) {
    const q = String(raw?.q ?? '').trim();
    if (!q) continue;
    const type = (['recall', 'inference', 'application'] as const).find((t) => t === raw.type) ?? 'recall';
    qs.push({
      q,
      type,
      answer_key: String(raw.answer_key ?? '').trim(),
      evidence: String(raw.evidence ?? '').trim(),
      about: raw.about === 'earlier' ? 'earlier' : 'current',
    });
  }
  const current = qs.filter((q) => q.about === 'current').slice(0, n);
  const earlier = wantEarlier ? qs.filter((q) => q.about === 'earlier').slice(0, 1) : [];
  if (!current.length) throw new AiError('No usable questions in reply');
  return { summary: String(j.summary ?? '').trim(), questions: [...current, ...earlier] };
}

export async function makeQuiz(input: QuizInput) {
  return complete((p) => quizPrompt(input, p), { check: (t) => checkQuiz(t, input.n, !!input.interleave) });
}

export interface Grade {
  score: number;
  verdict: Verdict;
  feedback: string;
  missed: string[];
}

export interface GradeItem {
  q: string;
  answer_key: string;
  answer: string;
  text: string; // the section the question is about
}

export function gradePrompt(items: GradeItem[], p: ProviderName) {
  const per = Math.floor(BUDGET[p].main / Math.max(1, new Set(items.map((i) => i.text)).size));
  const texts = [...new Set(items.map((i) => i.text))];
  const body = [
    texts.map((t, i) => `=== TEXT ${i + 1} ===\n${clip(t, per)}\n=== END TEXT ${i + 1} ===`).join('\n\n'),
    'Grade each answer:\n' +
      items
        .map((it, i) => `${i + 1}. [TEXT ${texts.indexOf(it.text) + 1}] Question: ${it.q}\n   Ideal answer: ${it.answer_key}\n   Reader's answer: ${it.answer}`)
        .join('\n'),
    `Judge meaning, not wording or spelling. Give partial credit for partly right answers.
For each answer return {"score": number from 0 to 1, "verdict": "correct" | "partial" | "incorrect",
"feedback": 1-2 sentences addressed to the reader as "you": what they got right and what is missing or wrong,
"missed": up to 3 short phrases naming the key ideas they missed}.
Return JSON: {"results": [...]} with exactly ${items.length} result(s) in order.`,
  ];
  return { system: TUTOR, messages: [{ role: 'user' as const, text: body.join('\n\n') }], json: true, temperature: 0.1 };
}

export function checkGrades(text: string, n: number): Grade[] {
  const j = parseJson<{ results?: Record<string, unknown>[] }>(text);
  if (!Array.isArray(j.results) || j.results.length < n) throw new AiError('Wrong number of grades');
  return j.results.slice(0, n).map((r) => {
    const score = Math.max(0, Math.min(1, Number(r.score) || 0));
    const verdict = (['correct', 'partial', 'incorrect'] as const).find((v) => v === r.verdict) ?? (score >= 0.8 ? 'correct' : score >= 0.35 ? 'partial' : 'incorrect');
    return {
      score,
      verdict,
      feedback: String(r.feedback ?? '').trim(),
      missed: Array.isArray(r.missed) ? r.missed.map(String).slice(0, 3) : [],
    };
  });
}

export async function gradeAnswers(items: GradeItem[]) {
  return complete((p) => gradePrompt(items, p), { check: (t) => checkGrades(t, items.length) });
}

/** Offline grading when no model is reachable: key-term overlap with the ideal answer. */
export function fallbackGrade(answerKey: string, answer: string, sectionText: string): Grade {
  const terms = keyTerms(answerKey, [sectionText], 6);
  const c = coverage(answer, terms);
  const score = Math.min(1, c.score * 1.2);
  return {
    score,
    verdict: score >= 0.8 ? 'correct' : score >= 0.35 ? 'partial' : 'incorrect',
    feedback: 'Graded offline by key words (the AI was unreachable), so treat this score as rough.',
    missed: c.missed.slice(0, 3),
  };
}

export interface ClarifyInput {
  book: string;
  heading: string;
  paragraph: string;
  context: string; // surrounding section text
  history: ChatMsg[];
  reason: 'rereads' | 'slow' | 'asked';
}

const CLARIFY = `You are a patient tutor sitting next to a reader of a technical or non-fiction book.
Explain clearly and concretely. Use plain words, define any jargon, and keep it short. Use **bold** for key terms
and "- " for bullet points; no headings, no tables. Don't refer to figures or tables you cannot see.`;

export function clarifyPrompt(input: ClarifyInput, p: ProviderName) {
  const why = input.reason === 'rereads' ? 'The reader has reread this paragraph several times.' : input.reason === 'slow' ? 'The reader slowed down a lot on this paragraph.' : 'The reader asked for help with this paragraph.';
  const first = `Book: ${input.book}
Section: ${input.heading || 'Untitled'}
Context (the surrounding section):
${clip(input.context, BUDGET[p].earlier)}

PARAGRAPH:
"""${input.paragraph}"""

${why} Help them understand it. Reply with:
**In plain words:** the paragraph's point in 2-3 sentences.
**Example:** one concrete example or analogy.
**Check yourself:** one short question they can answer if they understood.
Stay under 170 words.`;
  return { system: CLARIFY, messages: [{ role: 'user' as const, text: first }, ...input.history], temperature: 0.5, maxTokens: 1024 };
}

export async function clarify(input: ClarifyInput) {
  return complete((p) => clarifyPrompt(input, p));
}

/** Find where a quote appears in a list of words (fuzzy: best run of matching tokens). */
export function locateQuote(words: string[], from: number, to: number, quote: string): number {
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');
  const q = quote.split(/\s+/).map(norm).filter(Boolean);
  if (!q.length) return -1;
  let best = -1;
  let bestScore = 0;
  for (let w = from; w < to; w++) {
    let score = 0;
    for (let k = 0; k < q.length && w + k < to; k++) if (norm(words[w + k]) === q[k]) score++;
    if (score > bestScore) [best, bestScore] = [w, score];
  }
  return bestScore >= Math.min(3, q.length) ? best : -1;
}
