import { normalizeLikedVideo, type UserInfo, type VideoInfo } from "@/lib/tauri";

const LIKED_VIDEOS_KEY = "liked_videos_cache";
const LIKED_AUTHORS_KEY = "liked_authors_cache";
const CACHE_VERSION = 4;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CacheEnvelope<T> {
  version: number;
  data: T[];
  count?: number;
  timestamp: number;
}

function readCache<T>(key: string): CacheEnvelope<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== CACHE_VERSION) {
      localStorage.removeItem(key);
      return null;
    }
    if (Date.now() - parsed.timestamp > MAX_AGE_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCache<T>(key: string, data: T[]) {
  try {
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      data,
      count: data.length,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // Ignore cache write failures.
  }
}

function scopedKey(baseKey: string, scope: string) {
  const trimmed = scope.trim();
  return trimmed ? `${baseKey}:${trimmed}` : "";
}

export function loadLikedVideosCache(scope: string): VideoInfo[] {
  const key = scopedKey(LIKED_VIDEOS_KEY, scope);
  if (!key) return [];
  const cache = readCache<unknown>(key);
  if (!cache?.data) return [];
  return cache.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[];
}

export function saveLikedVideosCache(videos: VideoInfo[], scope: string) {
  const key = scopedKey(LIKED_VIDEOS_KEY, scope);
  if (!key) return;
  writeCache(key, videos);
}

export function loadLikedAuthorsCache(): UserInfo[] {
  const cache = readCache<UserInfo>(LIKED_AUTHORS_KEY);
  return cache?.data || [];
}

export function saveLikedAuthorsCache(authors: UserInfo[]) {
  writeCache(LIKED_AUTHORS_KEY, authors);
}
