// Build the typing stream (what the user types) from classified pages, keeping a two-way
// mapping between stream positions and the printed characters ("visual chars", vids).

import { normalizeChar } from '../text/normalize';
import { readingOrder } from './classify';
import type { ItemModel, PageModel, Section, Stream } from './types';

interface Pair {
  ch: string;
  vid: number; // -1 for inserted separators
}

// Citation markers like "[1]" or "[12, 13]" are shown but not typed.
const CITATION = /\s?\[\d+(?:\s?[,–-]\s?\d+)*\]/g;
const ABBREV = /^(e\.g\.|i\.e\.|etc\.|vs\.|Dr\.|Mr\.|Ms\.|Mrs\.|cf\.|al\.|Fig\.|No\.)$/i;

export function buildStream(pages: PageModel[]): Stream {
  let vidCount = 0;
  const pairs: Pair[] = [];
  const attach: { vid: number; pair: number }[] = [];
  let pending: number[] = []; // skipped vids before any pair exists
  const paraPairs: number[] = [];
  const sectionPairs: { pair: number; heading: string }[] = [];

  const lastIsSpace = () => pairs.length === 0 || pairs[pairs.length - 1].ch === ' ';
  const skipVid = (vid: number) => {
    if (pairs.length) attach.push({ vid, pair: pairs.length - 1 });
    else pending.push(vid);
  };
  const emitSpace = (vid: number) => {
    if (lastIsSpace()) {
      if (vid >= 0) skipVid(vid);
      return;
    }
    pairs.push({ ch: ' ', vid });
  };
  const emitChar = (ch: string, vid: number) => {
    if (pending.length && pairs.length === 0) {
      pairs.push({ ch, vid });
      for (const v of pending) attach.push({ vid: v, pair: 0 });
      pending = [];
      return;
    }
    pairs.push({ ch, vid });
  };
  /** Mark that the next emitted non-space pair starts a paragraph/section. */
  let markPara = false;
  let markSection: string | null = null;
  const flushMarks = () => {
    if (markPara) paraPairs.push(pairs.length);
    if (markSection !== null) sectionPairs.push({ pair: pairs.length, heading: markSection });
    markPara = false;
    markSection = null;
  };

  let prev: { y: number; fs: number; page: number; heading: boolean } | null = null;
  let joinNoSpace = false;
  let headingBuf: string[] = [];

  for (const page of pages) {
    for (const lineIdx of readingOrder(page)) {
      const items = lineIdx.map((i) => page.items[i]).filter((it) => it.kind !== 'skip');
      if (!items.some((it) => it.str.trim())) continue;
      for (const it of items) {
        it.vidBase = vidCount;
        vidCount += it.str.length;
      }
      const isHeading = items.every((it) => it.kind === 'heading');
      const first = items[0];

      // Paragraph / section boundaries
      const newPara =
        !prev ||
        prev.heading !== isHeading ||
        (prev.page === page.page && prev.y - first.y > 1.45 * Math.max(prev.fs, first.fs)) ||
        /^\s*[•●▪‣◦]/.test(first.str);
      if (isHeading) {
        if (!prev?.heading) {
          headingBuf = [];
          markSection = '';
        }
        headingBuf.push(items.map((i) => i.str).join('').trim());
        if (markSection !== null) markSection = headingBuf.join(' ');
        else sectionPairs[sectionPairs.length - 1].heading = headingBuf.join(' ');
      }
      if (newPara) markPara = true;

      // Separator from the previous line
      if (prev && !joinNoSpace) emitSpace(-1);
      joinNoSpace = false;

      // Line characters (with gap-inserted spaces between items)
      const chars: { ch: string; vid: number }[] = [];
      let lastItem: ItemModel | null = null;
      for (const it of items) {
        if (lastItem) {
          const gap = it.x - (lastItem.x + lastItem.w);
          const prevCh = chars[chars.length - 1]?.ch ?? ' ';
          if (gap > 0.15 * it.fs && !/\s/.test(prevCh) && !/^\s/.test(it.str)) chars.push({ ch: ' ', vid: -1 });
        }
        for (let i = 0; i < it.str.length; i++) chars.push({ ch: it.str[i], vid: it.vidBase + i });
        lastItem = it;
      }
      const lineStr = chars.map((c) => c.ch).join('');
      const skip = new Uint8Array(chars.length);
      for (const m of lineStr.matchAll(CITATION)) for (let k = m.index!; k < m.index! + m[0].length; k++) skip[k] = 1;
      // Hyphenation at the end of the line
      let end = chars.length - 1;
      while (end >= 0 && /\s/.test(chars[end].ch)) end--;
      if (end >= 0) {
        const last = chars[end].ch;
        if (last === '‐' || last === '­') {
          skip[end] = 1;
          joinNoSpace = true;
        } else if (/[-—]/.test(last) && end > 0 && /[A-Za-z]/.test(chars[end - 1].ch)) {
          joinNoSpace = true;
        }
      }

      for (let k = 0; k < chars.length; k++) {
        const { ch, vid } = chars[k];
        if (skip[k]) {
          if (vid >= 0) skipVid(vid);
          continue;
        }
        const n = normalizeChar(ch);
        if (n === '') {
          if (vid >= 0) skipVid(vid);
          continue;
        }
        for (let j = 0; j < n.length; j++) {
          const c = n[j];
          const v = j === 0 ? vid : -2; // -2: extra chars of a ligature, mapped to the same vid below
          if (c === ' ') emitSpace(v === -2 ? -1 : v);
          else {
            if (lastIsSpace()) flushMarks();
            emitChar(c, v === -2 ? vid : v);
          }
        }
      }
      prev = { y: first.y, fs: Math.max(...items.map((i) => i.fs)), page: page.page, heading: isHeading };
    }
  }

  // Trim trailing space
  if (pairs.length && pairs[pairs.length - 1].ch === ' ') {
    const sp = pairs.pop()!;
    if (sp.vid >= 0 && pairs.length) attach.push({ vid: sp.vid, pair: pairs.length - 1 });
  }
  const posCount = pairs.length + 1;

  // Words
  const words: string[] = [];
  const wordStartArr: number[] = [];
  const posWord = new Int32Array(posCount);
  let cur = '';
  let start = 0;
  for (let p = 0; p <= pairs.length; p++) {
    const ch = p < pairs.length ? pairs[p].ch : ' ';
    if (ch === ' ') {
      if (cur.length) {
        words.push(cur);
        wordStartArr.push(start);
        for (let q = start; q <= p; q++) posWord[q] = words.length - 1;
      }
      cur = '';
      start = p + 1;
    } else cur += ch;
  }

  // Position → vids (CSR)
  const lists: number[][] = Array.from({ length: posCount }, () => []);
  pairs.forEach((pr, p) => {
    if (pr.vid >= 0 && !lists[p].includes(pr.vid)) lists[p].push(pr.vid);
  });
  for (const a of attach) if (!lists[a.pair].includes(a.vid)) lists[a.pair].push(a.vid);
  const posVidStart = new Int32Array(posCount + 1);
  let total = 0;
  for (let p = 0; p < posCount; p++) {
    posVidStart[p] = total;
    total += lists[p].length;
  }
  posVidStart[posCount] = total;
  const posVids = new Int32Array(total);
  const vidPos = new Int32Array(vidCount).fill(-1);
  const vidPosEnd = new Int32Array(vidCount).fill(-1);
  for (let p = 0; p < posCount; p++) {
    lists[p].forEach((v, k) => {
      posVids[posVidStart[p] + k] = v;
      if (vidPos[v] === -1 || p < vidPos[v]) vidPos[v] = p;
      if (p > vidPosEnd[v]) vidPosEnd[v] = p;
    });
  }

  const toWord = (pair: number) => (pair >= pairs.length ? words.length : posWord[pair]);
  const paragraphs = [...new Set(paraPairs.map(toWord))].filter((w) => w < words.length);
  const sections: Section[] = [];
  for (const s of sectionPairs) {
    const w = toWord(s.pair);
    if (w >= words.length) continue;
    if (sections.length && sections[sections.length - 1].word === w) sections[sections.length - 1].heading = s.heading;
    else sections.push({ word: w, heading: s.heading.replace(/\s+/g, ' ').replace(/‐/g, '') });
  }
  if (!sections.length || sections[0].word !== 0) sections.unshift({ word: 0, heading: '' });

  const sentenceEnds = new Uint8Array(words.length);
  words.forEach((w, i) => {
    if (/[.?!]["')\]]*$/.test(w) && !ABBREV.test(w)) sentenceEnds[i] = 1;
  });
  if (words.length) sentenceEnds[words.length - 1] = 1;

  return {
    words,
    wordStart: Int32Array.from(wordStartArr),
    posCount,
    posVidStart,
    posVids,
    vidPos,
    vidPosEnd,
    vidCount,
    posWord,
    paragraphs,
    sections,
    sentenceEnds,
  };
}

/** Plain text of words [from, to). */
export function wordsText(stream: Stream, from: number, to: number): string {
  return stream.words.slice(Math.max(0, from), Math.min(stream.words.length, to)).join(' ');
}

/** Sentence containing word w: [start, end) word range. */
export function sentenceAt(stream: Stream, w: number): [number, number] {
  let s = w;
  while (s > 0 && !stream.sentenceEnds[s - 1] && !stream.paragraphs.includes(s)) s--;
  let e = w;
  while (e < stream.words.length - 1 && !stream.sentenceEnds[e]) e++;
  return [s, e + 1];
}

export function sectionIndexAt(stream: Stream, w: number): number {
  let lo = 0;
  for (let i = 0; i < stream.sections.length; i++) if (stream.sections[i].word <= w) lo = i;
  return lo;
}

export function sectionRange(stream: Stream, idx: number): [number, number] {
  const s = stream.sections[idx];
  const next = stream.sections[idx + 1];
  return [s.word, next ? next.word : stream.words.length];
}
