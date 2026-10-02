// Map printed characters to what the user should type on a normal keyboard.
// Returns '' for characters that are shown but skipped (they light up automatically).

const MAP: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '`': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '…': '...',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '\t': ' ',
  '­': '', '​': '', '‌': '', '‍': '', '﻿': '',
  '•': '', '●': '', '▪': '', '‣': '', '·': '',
  '×': 'x', '→': '->', '←': '<-', '≤': '<=', '≥': '>=', '≠': '!=',
  '©': '(c)', '®': '(r)', '™': '(tm)', '°': '', '§': '',
};

export function normalizeChar(ch: string): string {
  const m = MAP[ch];
  if (m !== undefined) return m;
  const code = ch.charCodeAt(0);
  if (code >= 32 && code < 127) return ch;
  // Strip accents: é → e
  const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  if (stripped && /^[\x20-\x7e]+$/.test(stripped)) return stripped;
  return '';
}

export function normalizeText(s: string): string {
  let out = '';
  for (const ch of s) out += normalizeChar(ch);
  return out.replace(/\s+/g, ' ');
}

/** Loose comparison for recall answers: case-insensitive, punctuation-insensitive. */
export function looseEq(a: string, b: string): boolean {
  const n = (x: string) => normalizeText(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  return n(a) === n(b);
}

/** Normalized Levenshtein similarity in 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
