const MEDIA_FAILURE_TTL_MS = 3 * 60 * 1000;
const MEDIA_FAILURE_MAX_ITEMS = 500;

type FailureEntry = {
  expiresAt: number;
  lastAccessedAt: number;
};

const failedMediaUrls = new Map<string, FailureEntry>();

function normalizeMediaFailureKey(url: string | undefined): string {
  return String(url || "").trim();
}

function pruneExpiredMediaFailures(now = Date.now()): void {
  for (const [key, entry] of failedMediaUrls) {
    if (entry.expiresAt <= now) failedMediaUrls.delete(key);
  }
}

function trimMediaFailureCache(): void {
  if (failedMediaUrls.size <= MEDIA_FAILURE_MAX_ITEMS) return;
  const oldest = [...failedMediaUrls.entries()].sort(
    ([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt
  )[0]?.[0];
  if (oldest) failedMediaUrls.delete(oldest);
}

export function hasRecentMediaFailure(url: string | undefined): boolean {
  const key = normalizeMediaFailureKey(url);
  if (!key) return false;

  const entry = failedMediaUrls.get(key);
  const now = Date.now();
  if (!entry || entry.expiresAt <= now) {
    failedMediaUrls.delete(key);
    return false;
  }

  entry.lastAccessedAt = now;
  return true;
}

export function markMediaFailure(url: string | undefined): void {
  const key = normalizeMediaFailureKey(url);
  if (!key) return;

  const now = Date.now();
  pruneExpiredMediaFailures(now);
  failedMediaUrls.set(key, {
    expiresAt: now + MEDIA_FAILURE_TTL_MS,
    lastAccessedAt: now,
  });
  trimMediaFailureCache();
}

export function clearMediaFailure(url: string | undefined): void {
  const key = normalizeMediaFailureKey(url);
  if (!key) return;
  failedMediaUrls.delete(key);
}
