/** Soft caps for in-memory / localStorage video lists to limit JS heap growth. */

export const RECOMMENDED_FEED_SOFT_LIMIT = 300;
export const LIKED_VIDEOS_SOFT_LIMIT = 500;
export const COLLECTED_VIDEOS_SOFT_LIMIT = 500;
export const MIX_VIDEOS_SOFT_LIMIT = 500;

/**
 * Keep the newest continuous window when a list grows past the soft limit.
 * Pagination cursors remain valid because they track the remote feed position,
 * not local array indices.
 */
export function trimVideoListWindow<T>(items: T[], maxItems: number): T[] {
  if (!Array.isArray(items) || maxItems <= 0 || items.length <= maxItems) {
    return items;
  }
  return items.slice(items.length - maxItems);
}
