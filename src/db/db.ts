import Dexie, { type Table } from 'dexie';
import type { Card as FsrsCard } from 'ts-fsrs';
import type { OutlineChapter } from '../pdf/extract';

export interface Book {
  id?: number;
  title: string;
  fileName: string;
  pageCount: number;
  chapters: OutlineChapter[];
  startChapter: number;
  addedAt: number;
}

/** Reading state of one chapter: cursor and how many times each word has been read. */
export interface ChapterState {
  bookId: number;
  chapter: number;
  pos: number; // cursor: next word to read
  maxPos: number; // furthest word reached
  total: number; // words in the chapter
  counts: Uint8Array; // reads per word (capped at 255)
  quizzed: number[]; // sections already quizzed
  updatedAt: number;
}

export interface Progress {
  bookId: number;
  current: number; // chapter index
}

export type MoveKind = 'next' | 'line' | 'back' | 'jump' | 'pacer';

export interface ReadEvent {
  id?: number;
  sessionId: number;
  bookId: number;
  chapter: number;
  t: number;
  kind: MoveKind;
  from: number;
  to: number;
  fresh: number; // words read for the first time by this move
  reread: number; // words read again by this move
}

export interface Session {
  id?: number;
  bookId: number;
  chapter: number;
  start: number;
  end: number;
  activeMs: number;
  presentMs?: number; // time at the screen with the book open (reading + thinking)
  awayCount?: number;
  fresh: number;
  reread: number;
  regressions: number;
  pacer: boolean;
}

export interface SectionRec {
  bookId: number;
  chapter: number;
  section: number;
  heading: string;
  summary: string;
}

export type Verdict = 'correct' | 'partial' | 'incorrect' | 'skipped';

export interface QuestionRec {
  id?: number;
  sessionId: number;
  bookId: number;
  chapter: number;
  section: number; // section the question is about
  askedAt: number; // section that triggered the quiz
  heading: string;
  q: string;
  type: string;
  answerKey: string;
  evidence: string;
  interleaved: boolean;
  answer: string;
  score: number; // 0..1
  verdict: Verdict;
  feedback: string;
  wpm: number; // reading speed on the triggering section
  rereadRate: number; // rereads per word on the triggering section
  focus?: ProbeState; // latest thought-probe answer in this session
  provider: string;
  ts: number;
}

export type ProbeState = 'on' | 'wander' | 'zoned';

export interface ProbeRec {
  id?: number;
  sessionId: number;
  bookId: number;
  chapter: number;
  word: number;
  state: ProbeState;
  wpm: number;
  ts: number;
}

export interface ClarifyRec {
  id?: number;
  bookId: number;
  chapter: number;
  word: number; // first word of the paragraph
  text: string;
  reason: 'rereads' | 'slow' | 'asked';
  reads: number;
  messages: { role: 'user' | 'assistant'; text: string }[];
  ts: number;
}

export interface UsageRec {
  key: string; // `${day}|${provider}`
  day: string;
  provider: string;
  requests: number;
  failures: number;
  tokensIn: number;
  tokensOut: number;
}

/** A memory card: question and answer about a passage, scheduled with FSRS. */
export interface CardRec {
  id?: number;
  bookId: number;
  chapter: number;
  section: number;
  heading: string;
  wordFrom: number;
  wordTo: number;
  source: string; // the passage it was made from
  q: string;
  a: string;
  origin: 'manual' | 'auto';
  createdAt: number;
  due: number;
  fsrs: FsrsCard;
}

export interface ReviewRec {
  id?: number;
  cardId: number;
  ts: number;
  answer: string;
  score: number; // 0..1
  rating: number; // 1 Again, 2 Hard, 3 Good, 4 Easy
  suggested: number; // rating suggested from the grade
  intervalDays: number;
  graded: 'ai' | 'local';
}

export interface FocusRec {
  id?: number;
  kind: 'focus' | 'break';
  start: number;
  end: number;
  ms: number; // time actually spent (focus: present reading time)
  planned: number; // planned ms
  completed: boolean;
  bookId?: number;
}

/** A section you finished reading for the first time. */
export interface MilestoneRec {
  bookId: number;
  chapter: number;
  section: number;
  ts: number;
}

/** An unlocked badge tier, id `${badge}:${tier}`. */
export interface AchievementRec {
  id: string;
  badge: string;
  tier: number;
  at: number;
}

export interface OverrideRec {
  bookId: number;
  key: string;
  v: 'type' | 'skip';
}

class DB extends Dexie {
  books!: Table<Book, number>;
  files!: Table<{ bookId: number; blob: Blob }, number>;
  progress!: Table<Progress, number>;
  chapters!: Table<ChapterState, [number, number]>;
  events!: Table<ReadEvent, number>;
  sessions!: Table<Session, number>;
  sections!: Table<SectionRec, [number, number, number]>;
  questions!: Table<QuestionRec, number>;
  probes!: Table<ProbeRec, number>;
  clarifications!: Table<ClarifyRec, number>;
  usage!: Table<UsageRec, string>;
  cards!: Table<CardRec, number>;
  reviews!: Table<ReviewRec, number>;
  cache!: Table<{ key: string; value: unknown; ts: number }, string>;
  focus!: Table<FocusRec, number>;
  milestones!: Table<MilestoneRec, [number, number, number]>;
  achievements!: Table<AchievementRec, string>;
  overrides!: Table<OverrideRec, [number, string]>;
  settings!: Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('reading-speed-booster');
    this.version(1).stores({
      books: '++id',
      files: 'bookId',
      progress: 'bookId',
      chapters: '[bookId+chapter], bookId',
      events: '++id, sessionId, bookId, t',
      sessions: '++id, bookId, start',
      sections: '[bookId+chapter+section], bookId',
      questions: '++id, sessionId, bookId, ts',
      probes: '++id, sessionId, ts',
      clarifications: '++id, bookId, ts',
      usage: 'key, day',
      overrides: '[bookId+key], bookId',
      settings: 'key',
    });
    this.version(2).stores({
      cards: '++id, bookId, due, [bookId+chapter]',
      reviews: '++id, cardId, ts',
      cache: 'key',
      focus: '++id, start',
    });
    this.version(3).stores({
      milestones: '[bookId+chapter+section], bookId, ts',
      achievements: 'id, at',
    });
  }
}

export const db = new DB();

export interface Settings {
  // AI
  aiOn: boolean;
  primary: 'gemini' | 'groq';
  geminiKey: string;
  geminiModel: string;
  groqKey: string;
  groqModel: string;
  // comprehension
  questionsPerSection: number;
  interleaveChance: number; // 0..1
  minSectionWords: number;
  // help
  rereadThreshold: number; // reads of a sentence before offering an explanation
  dwellFactor: number; // × your median pace before a paragraph counts as slow
  // focus
  probesOn: boolean;
  probeMinMin: number;
  probeMaxMin: number;
  idleSec: number;
  // speed
  pacerOn: boolean;
  pacerWpm: number;
  pacerAdapt: boolean;
  // memory cards
  autoCards: boolean; // make cards from paragraphs you keep rereading
  retention: number; // 0..1, FSRS desired retention
  maxIntervalDays: number;
  // time & presence
  pomodoroOn: boolean;
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
  longBreakEvery: number;
  awaySec: number; // no input for this long → "still reading?"
  dailyMinutes: number; // reading-time goal
  // motivation
  celebrations: boolean;
  celebrationSound: boolean;
  // reader
  theme: 'paper' | 'night';
  pageWidth: number;
}

export const DEFAULT_SETTINGS: Settings = {
  aiOn: true,
  primary: 'gemini',
  geminiKey: '',
  geminiModel: 'gemini-flash-latest',
  groqKey: '',
  groqModel: 'openai/gpt-oss-120b',
  questionsPerSection: 2,
  interleaveChance: 0.3,
  minSectionWords: 80,
  rereadThreshold: 3,
  dwellFactor: 2.5,
  probesOn: true,
  probeMinMin: 5,
  probeMaxMin: 10,
  idleSec: 60,
  pacerOn: false,
  pacerWpm: 250,
  pacerAdapt: true,
  autoCards: true,
  retention: 0.9,
  maxIntervalDays: 365,
  pomodoroOn: true,
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
  longBreakEvery: 4,
  awaySec: 90,
  dailyMinutes: 30,
  celebrations: true,
  celebrationSound: false,
  theme: 'paper',
  pageWidth: 880,
};

export async function getSettings(): Promise<Settings> {
  const row = await db.settings.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.settings.put({ key: 'settings', value: s });
}

export async function patchSettings(p: Partial<Settings>): Promise<Settings> {
  const s = { ...(await getSettings()), ...p };
  await saveSettings(s);
  return s;
}

export async function getChapterState(bookId: number, chapter: number, total: number): Promise<ChapterState> {
  const st = await db.chapters.get([bookId, chapter]);
  if (st && st.counts.length === total) return st;
  // new chapter, or the text model changed (e.g. a classification fix): keep what still fits
  const counts = new Uint8Array(total);
  if (st) counts.set(st.counts.subarray(0, total));
  return {
    bookId,
    chapter,
    pos: Math.min(st?.pos ?? 0, total),
    maxPos: Math.min(st?.maxPos ?? 0, total),
    total,
    counts,
    quizzed: st?.quizzed ?? [],
    updatedAt: Date.now(),
  };
}

/** Delete every book, reading record, question, statistic and setting. */
export async function resetEverything(): Promise<void> {
  db.close();
  await db.delete();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
