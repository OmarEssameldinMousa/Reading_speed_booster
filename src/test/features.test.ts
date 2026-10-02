import { describe, it, expect } from 'vitest';
import { Presence, Pomodoro, clock, type PhaseEnd } from '../focus/timer';
import { formatDays, localGrade, newFsrsCard, previewDays, ratingFor, Rating } from '../srs/schedule';
import { assistPrompt, cardsPrompt, checkCardGrade, checkCards } from '../ai/prompts';
import { hashKey } from '../ai/cache';
import { recallRate, timeByDay } from '../stats/aggregate';

describe('presence', () => {
  it('asks "still reading?" after the idle time, then goes away and back', () => {
    const states: string[] = [];
    let back = 0;
    const p = new Presence(90, 0, (s, ms) => {
      states.push(s);
      if (s === 'present') back = ms;
    });
    for (let t = 1000; t <= 89000; t += 1000) p.tick(t);
    expect(p.state).toBe('present');
    p.tick(90000);
    expect(p.state).toBe('checking');
    for (let t = 91000; t <= 120000; t += 1000) p.tick(t);
    expect(p.state).toBe('away');
    expect(p.awayCount).toBe(1);
    // 90 s present; the 30 s unanswered check doesn't count
    expect(p.presentMs).toBe(90000);
    for (let t = 121000; t <= 300000; t += 1000) p.tick(t);
    expect(p.presentMs).toBe(90000);
    p.input(300000);
    expect(p.state).toBe('present');
    expect(back).toBe(300000 - 90000);
    expect(states).toEqual(['checking', 'away', 'present']);
  });

  it('answering the check keeps you present', () => {
    const p = new Presence(60, 0);
    for (let t = 1000; t <= 70000; t += 1000) p.tick(t);
    expect(p.state).toBe('checking');
    expect(p.input(70000)).toBe(0);
    expect(p.state).toBe('present');
    expect(p.presentMs).toBe(70000);
  });

  it('a hidden tab counts as away after 10 s, from when it was hidden', () => {
    const p = new Presence(90, 0);
    for (let t = 1000; t <= 20000; t += 1000) p.tick(t);
    p.hidden(20000);
    for (let t = 21000; t <= 25000; t += 1000) p.tick(t);
    expect(p.state).toBe('present'); // quick alt-tab is fine
    for (let t = 26000; t <= 31000; t += 1000) p.tick(t);
    expect(p.state).toBe('away');
    expect(p.presentMs).toBe(20000);
  });
});

describe('pomodoro', () => {
  const cfg = { focusMin: 1, breakMin: 1, longBreakMin: 3, longBreakEvery: 2 };

  it('counts focus only while present, then starts a break', () => {
    const ends: [PhaseEnd, string][] = [];
    const p = new Pomodoro(cfg, 0, (e, next) => ends.push([e, next]));
    p.startFocus(0);
    for (let t = 1000; t <= 30000; t += 1000) p.tick(t, true);
    for (let t = 31000; t <= 90000; t += 1000) p.tick(t, false); // away: paused
    expect(p.phase).toBe('focus');
    expect(clock(p.remaining)).toBe('0:30');
    for (let t = 91000; t <= 120000; t += 1000) p.tick(t, true);
    expect(p.phase).toBe('break');
    expect(ends[0][0]).toMatchObject({ kind: 'focus', completed: true, ms: 60000 });
    expect(ends[0][1]).toBe('break');
    expect(p.planned).toBe(60000);
    // breaks run on the wall clock, even when away
    for (let t = 121000; t <= 180000; t += 1000) p.tick(t, false);
    expect(p.phase).toBe('idle');
    expect(ends[1][0]).toMatchObject({ kind: 'break', completed: true });
  });

  it('gives a long break every N sprints', () => {
    const p = new Pomodoro(cfg, 1);
    expect(p.longBreakNext).toBe(true);
    p.startFocus(0);
    for (let t = 1000; t <= 60000; t += 1000) p.tick(t, true);
    expect(p.sprints).toBe(2);
    expect(p.planned).toBe(3 * 60000);
  });

  it('stopping early records an incomplete phase', () => {
    const ends: PhaseEnd[] = [];
    const p = new Pomodoro(cfg, 0, (e) => ends.push(e));
    p.startFocus(0);
    p.tick(1000, true);
    p.stop(1000);
    expect(p.phase).toBe('idle');
    expect(ends[0]).toMatchObject({ kind: 'focus', completed: false, ms: 1000 });
  });
});

describe('spaced repetition', () => {
  it('maps scores to ratings', () => {
    expect([0, 0.3, 0.5, 0.8, 1].map(ratingFor)).toEqual([Rating.Again, Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]);
  });

  it('grades obvious answers locally', () => {
    expect(localGrade('Because databases are good enough.', '')).toBe(0);
    expect(localGrade('Because databases are good enough.', "I don't know")).toBe(0);
    expect(localGrade('Because databases are good enough.', 'because databases are good enough')).toBe(1);
    expect(localGrade('Because databases are good enough.', 'they are a solid abstraction')).toBe(null);
  });

  it('previews longer intervals for better ratings', () => {
    const d = previewDays(newFsrsCard(new Date('2026-10-01T10:00:00Z')), new Date('2026-10-01T10:00:00Z'));
    expect(d[Rating.Again]).toBeLessThan(d[Rating.Good]);
    expect(d[Rating.Good]).toBeLessThan(d[Rating.Easy]);
    expect(formatDays(10 / 1440)).toBe('10 min');
    expect(formatDays(4)).toBe('4 d');
  });

  it('computes recall on repeat reviews only', () => {
    const r = (cardId: number, ts: number, rating: number) => ({ cardId, ts, rating, answer: '', score: 0, suggested: rating, intervalDays: 1, graded: 'ai' as const });
    expect(recallRate([r(1, 1, 1), r(2, 2, 3)])).toBe(null);
    expect(recallRate([r(1, 1, 1), r(1, 2, 3), r(1, 3, 1), r(2, 4, 3)])).toBe(0.5);
  });
});

describe('card and selection prompts', () => {
  it('parses cards and drops incomplete ones', () => {
    const cards = checkCards('{"cards":[{"q":"Why?","a":"Because."},{"q":"","a":"x"},{"q":"How?","a":"Like so."},{"q":"More?","a":"Yes."}]}', 2);
    expect(cards).toEqual([
      { q: 'Why?', a: 'Because.' },
      { q: 'How?', a: 'Like so.' },
    ]);
    expect(() => checkCards('{"cards":[]}', 2)).toThrow();
  });

  it('parses a card grade', () => {
    expect(checkCardGrade('{"score": 1.4, "feedback": "Right."}')).toEqual({ score: 1, feedback: 'Right.' });
    expect(() => checkCardGrade('{"feedback": "?"}')).toThrow();
  });

  it('sends a small context window and trims long follow-up threads', () => {
    const history = Array.from({ length: 12 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `m${i}` }));
    const base = { book: 'B', heading: 'H', passage: 'the passage', context: 'ctx '.repeat(20000), mode: 'explain' as const, history };
    const p = assistPrompt(base, 'groq');
    expect(p.messages[0].text.length).toBeLessThan(5000);
    expect(p.messages.length).toBeLessThanOrEqual(7);
    expect(p.messages[p.messages.length - 1].text).toBe('m11');
    const ask = assistPrompt({ ...base, mode: 'ask', history: [{ role: 'user', text: 'What is a fault?' }] }, 'gemini');
    expect(ask.messages).toHaveLength(1);
    expect(ask.messages[0].text).toMatch(/Question: What is a fault\?$/);
    expect(cardsPrompt({ book: 'B', heading: 'H', passage: 'p', context: 'c', max: 2 }, 'gemini').messages[0].text).toMatch(/between 1 and 2 flashcards/);
  });

  it('hashes cache keys stably', () => {
    expect(hashKey('abc')).toBe(hashKey('abc'));
    expect(hashKey('abc')).not.toBe(hashKey('abd'));
  });

  it('buckets reading time by day', () => {
    const now = new Date('2026-10-03T15:00:00').getTime();
    const day = (h: number) => new Date(`2026-10-03T${String(h).padStart(2, '0')}:00:00`).getTime();
    const s = (start: number, presentMs: number) => ({ bookId: 1, chapter: 0, start, end: start, activeMs: 0, presentMs, fresh: 0, reread: 0, regressions: 0, pacer: false });
    const t = timeByDay([s(day(9), 20 * 60000), s(day(13), 10 * 60000)], [{ kind: 'focus', start: day(9), end: day(10), ms: 1, planned: 1, completed: true }], 3, now);
    expect(t.map((d) => Math.round(d.minutes))).toEqual([0, 0, 30]);
    expect(t[2].sprints).toBe(1);
  });
});

import { milestoneFor } from '../reader/controller';
import { BADGES, nextTargets, perfectChecks, progressOf, streaks, type Stats } from '../gamify/badges';

describe('milestones', () => {
  const sections = [
    { word: 0, heading: 'CHAPTER 1 Intro' },
    { word: 100, heading: 'Reliability' },
    { word: 400, heading: 'Scalability' },
  ]; // n = 1000
  const none = () => 0;
  it('sparkles for a section, more for chapter quarters, confetti for the chapter, fireworks for the book', () => {
    expect(milestoneFor(sections, 1000, 90, 101, none, 'Ch 1').m).toMatchObject({ level: 1, title: '+1 section', subtitle: 'Intro' });
    expect(milestoneFor(sections, 1000, 90, 101, none, 'Ch 1').sectionsDone).toEqual([0]);
    expect(milestoneFor(sections, 1000, 240, 260, none, 'Ch 1').m).toMatchObject({ level: 2, title: '25% of the chapter' });
    expect(milestoneFor(sections, 1000, 495, 505, none, 'Ch 1').m?.title).toBe('Halfway through the chapter');
    const end = milestoneFor(sections, 1000, 990, 1000, none, 'Ch 1');
    expect(end.m).toMatchObject({ level: 3 });
    expect(end.sectionsDone).toEqual([2]);
    const book = milestoneFor(sections, 1000, 990, 1000, (m) => 0.4 + m / 10000, 'Ch 1');
    expect(book.m).toMatchObject({ level: 4, title: '50% of the book!' });
    expect(milestoneFor(sections, 1000, 300, 320, none, 'Ch 1').m).toBe(null);
  });
});

describe('badges', () => {
  it('computes current and best streaks', () => {
    const now = new Date('2026-10-10T15:00:00').getTime();
    const days = new Set(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-08', '2026-10-09']);
    expect(streaks(days, now)).toEqual({ streak: 2, best: 4 }); // today not read yet: yesterday's run still counts
    days.add('2026-10-10');
    expect(streaks(days, now).streak).toBe(3);
  });

  it('counts perfect checks per section quiz', () => {
    const q = (askedAt: number, score: number, interleaved = false) => ({ sessionId: 1, bookId: 1, chapter: 0, askedAt, score, interleaved }) as never;
    expect(perfectChecks([q(1, 1), q(1, 0.96), q(2, 1), q(2, 0.5), q(3, 1), q(3, 0.2, true)])).toBe(2);
  });

  it('shows tier progress and the closest next targets', () => {
    const zero = Object.fromEntries(Object.keys({ sections: 0, chapters: 0, books: 0, words: 0, minutes: 0, streak: 0, bestStreak: 0, sprints: 0, perfectChecks: 0, deepCorrect: 0, recentComp: 0, cards: 0, reviews: 0, effGain: 0, explanations: 0 }).map((k) => [k, 0])) as unknown as Stats;
    const s = { ...zero, sections: 8, words: 25000, cards: 1 };
    const sec = progressOf(BADGES.find((b) => b.id === 'sections')!, s);
    expect(sec).toMatchObject({ tier: 0, next: 10 });
    expect(sec.ratio).toBeCloseTo(7 / 9);
    expect(progressOf(BADGES.find((b) => b.id === 'words')!, s)).toMatchObject({ tier: 1, next: 100000 });
    expect(nextTargets(s, 2).map((p) => p.def.id)).toEqual(['sections', 'cards']);
  });
});
