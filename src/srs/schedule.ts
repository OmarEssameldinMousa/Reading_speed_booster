// Spaced repetition for memory cards. The AI grades your answer; FSRS (the algorithm modern Anki uses)
// turns that grade into the next review date.

import { createEmptyCard, fsrs, Rating, type Card, type Grade } from 'ts-fsrs';
import { db, type CardRec, type ReviewRec } from '../db/db';
import { normalizeText, similarity } from '../text/normalize';

export { Rating };

let scheduler = fsrs({ enable_fuzz: true, request_retention: 0.9, maximum_interval: 365 });

export function configureScheduler(retention: number, maxIntervalDays: number) {
  scheduler = fsrs({ enable_fuzz: true, request_retention: retention, maximum_interval: maxIntervalDays });
}

export function newFsrsCard(now = new Date()): Card {
  return createEmptyCard(now);
}

/** Rating suggested by an answer's score (0..1). */
export function ratingFor(score: number): Grade {
  if (score < 0.35) return Rating.Again;
  if (score < 0.7) return Rating.Hard;
  if (score < 0.95) return Rating.Good;
  return Rating.Easy;
}

export const RATING_LABEL: Record<number, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

/** When the card would come back for each rating, in days. */
export function previewDays(card: Card, now = new Date()): Record<number, number> {
  const p = scheduler.repeat(card, now);
  const out: Record<number, number> = {};
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]) out[g] = (p[g].card.due.getTime() - now.getTime()) / 86400e3;
  return out;
}

export function formatDays(d: number): string {
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))} min`;
  if (d < 1) return `${Math.round(d * 24)} h`;
  if (d < 31) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1)} y`;
}

/**
 * Grade an answer without the AI when it's obvious: empty → 0, nearly the same words as the answer → 1.
 * Returns null when it needs the AI.
 */
export function localGrade(answerKey: string, answer: string): number | null {
  const a = normalizeText(answer).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const k = normalizeText(answerKey).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!a || /^(i )?(don ?t|do not) know$|^idk$|^\?+$/.test(a)) return 0;
  if (k && similarity(a, k) >= 0.85) return 1;
  return null;
}

export async function review(card: CardRec, rating: Grade, r: Omit<ReviewRec, 'id' | 'cardId' | 'ts' | 'rating' | 'intervalDays'>): Promise<number> {
  const now = new Date();
  const { card: next } = scheduler.next(card.fsrs, now, rating);
  const intervalDays = (next.due.getTime() - now.getTime()) / 86400e3;
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.update(card.id!, { fsrs: next, due: next.due.getTime() });
    await db.reviews.add({ ...r, cardId: card.id!, ts: now.getTime(), rating, intervalDays });
  });
  return intervalDays;
}
