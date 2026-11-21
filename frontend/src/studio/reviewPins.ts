import type { Review } from '../lib/review';

const REVIEW_MAP_KEY = 'infrastudio_reviews_v1';

export function rememberedReview(url: string | null): string | null {
  if (!url) return null;
  try {
    return (JSON.parse(localStorage.getItem(REVIEW_MAP_KEY) || '{}') as Record<string, string>)[url] ?? null;
  } catch {
    return null;
  }
}

export function remember(url: string, id: string) {
  try {
    const map = JSON.parse(localStorage.getItem(REVIEW_MAP_KEY) || '{}') as Record<string, string>;
    map[url] = id;
    localStorage.setItem(REVIEW_MAP_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

/** Puts a numbered marker above each commented element. */
export function pinsFor(review: Review) {
  return review.comments.map((c, i) => ({ guid: c.guid, label: String(i + 1), color: c.resolved ? '#9ca3af' : '#f59e0b' }));
}
