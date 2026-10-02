// Pick high-information words from a passage: used for cloze blanks, summary coverage
// and next-day recall scoring.

const STOP = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between both but by
  can cannot could did do does doing down during each either else ever every few for from further had has have having he her here hers
  him his how however i if in into is it its itself just let like made make many may me might more most much must my no nor not now of
  off often on once one only or other our out over own per perhaps rather really same say says see seem seems she should since so some
  such than that the their them then there these they thing things this those though through thus to too under until up upon us use used
  uses using very was way we well were what when where whether which while who whom whose why will with within without would yet you your
  also another around because become becomes something sometimes anything everything nothing first second new need needs want wants
  example chapter section figure table following different important usually actually still even always never already however
  everybody everyone somebody someone anybody anyone good better best bad worse worst great little large small big lot lots kind kinds
  prevent prevents allow allows mean means become got getting going come comes give gives take takes look looks keep keeps put puts
  able possible likely certain several various whole rest part parts case cases fact point points place time times year years day days`.split(/\s+/),
);

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9'-]*[a-z0-9]|[a-z]/g) ?? [];
  // Em dashes are typed as '-', so "deliberately-for" is really two words: split when a part is a
  // stop word or tiny. Real compounds like "fault-tolerant" survive.
  return raw.flatMap((w) => {
    if (!w.includes('-')) return [w];
    const parts = w.split('-').filter(Boolean);
    return parts.some((p) => p.length <= 2 || STOP.has(p)) ? parts : [w];
  });
}

export function stem(w: string): string {
  return w.replace(/'s$/, '').replace(/(ing|ed|es|s|ly)$/, '').slice(0, 7);
}

function isContent(w: string): boolean {
  return w.length >= 4 && !STOP.has(w);
}

export interface Term {
  word: string; // most common surface form
  score: number;
}

/**
 * Score terms in `passage` against a `background` corpus (e.g. the whole chapter): TF-IDF-ish,
 * with a bonus for longer words and words that appear capitalized mid-sentence (names, concepts).
 */
export function keyTerms(passage: string, background: string[] = [], limit = 8): Term[] {
  const tf = new Map<string, { n: number; forms: Map<string, number> }>();
  for (let w of tokenize(passage)) {
    if (w.includes("'")) {
      if (!w.endsWith("'s")) continue; // contractions carry no information
      w = w.slice(0, -2);
    }
    if (!isContent(w)) continue;
    const s = stem(w);
    const e = tf.get(s) ?? { n: 0, forms: new Map() };
    e.n++;
    e.forms.set(w, (e.forms.get(w) ?? 0) + 1);
    tf.set(s, e);
  }
  const df = new Map<string, number>();
  for (const doc of background) {
    const seen = new Set(tokenize(doc).filter(isContent).map(stem));
    for (const s of seen) df.set(s, (df.get(s) ?? 0) + 1);
  }
  const caps = new Set((passage.match(/(?<=[a-z,;] )[A-Z][a-zA-Z]{2,}/g) ?? []).map((w) => stem(w.toLowerCase())));
  const N = background.length + 1;
  const out: Term[] = [];
  for (const [s, e] of tf) {
    const idf = Math.log((N + 1) / ((df.get(s) ?? 0) + 1)) + 1;
    const form = [...e.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const adverb = /ly$/.test(form) && form.length > 5 ? 0.35 : 1;
    const score = (1 + Math.log(e.n)) * idf * (1 + Math.min(form.length, 12) / 12) * (caps.has(s) ? 1.5 : 1) * adverb;
    out.push({ word: form, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Fraction of key terms mentioned in `answer` (stem match). */
export function coverage(answer: string, terms: Term[]): { score: number; hit: string[]; missed: string[] } {
  const got = new Set(tokenize(answer).map(stem));
  const hit: string[] = [];
  const missed: string[] = [];
  for (const t of terms) (got.has(stem(t.word)) ? hit : missed).push(t.word);
  return { score: terms.length ? hit.length / terms.length : 0, hit, missed };
}

/** Turn a section heading into a question for the "question-first" prompt. */
export function headingToQuestion(heading: string): string {
  const h = heading.replace(/^chapter\s+\d+\s*/i, '').replace(/\s+/g, ' ').trim().replace(/[.:]$/, '');
  if (/\?$/.test(h)) return h;
  if (/^(how|why|what|when|where|which|who)\b/i.test(h)) return h + '?';
  if (/^(the )?(problem|limits?|cost|trade-?offs?|challenges?) of /i.test(h)) return `What are the ${h.replace(/^the /i, '').toLowerCase()}?`;
  if (/ing$/i.test(h.split(' ')[0])) return `What is involved in ${h.toLowerCase()}, and why does it matter?`;
  if (/ (vs\.?|versus) /i.test(h)) return `How do ${h.replace(/ (vs\.?|versus) /i, ' and ')} differ?`;
  return `What is "${h}", and why does it matter?`;
}
