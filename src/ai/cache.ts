// Remember AI answers for the same request, so selecting the same passage twice costs no tokens.

import { db } from '../db/db';

/** 53-bit FNV-1a-style hash of a string, as base36. */
export function hashKey(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export async function cached<T>(parts: string[], make: () => Promise<T>, maxAgeDays = 30): Promise<T> {
  const key = hashKey(parts.join('\u0001'));
  try {
    const hit = await db.cache.get(key);
    if (hit && Date.now() - hit.ts < maxAgeDays * 86400e3) return hit.value as T;
  } catch {
    /* cache is best-effort */
  }
  const value = await make();
  try {
    await db.cache.put({ key, value, ts: Date.now() });
  } catch {
    /* ignore */
  }
  return value;
}
