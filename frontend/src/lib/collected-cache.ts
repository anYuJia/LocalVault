import { normalizeVideo, type CollectedMixItem, type VideoInfo } from "@/lib/tauri";
import { COLLECTED_VIDEOS_SOFT_LIMIT, trimVideoListWindow } from "@/lib/list-limits";

const COLLECTED_VIDEOS_KEY = "collected_videos_cache";
const COLLECTED_MIXES_KEY = "collected_mixes_cache";
const CACHE_VERSION = 1;
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

export function loadCollectedVideosCache(scope: string): VideoInfo[] {
  const key = scopedKey(COLLECTED_VIDEOS_KEY, scope);
  if (!key) return [];
  const cache = readCache<unknown>(key);
  if (!cache?.data) return [];
  return cache.data.map(normalizeVideo).filter(Boolean) as VideoInfo[];
}

export function saveCollectedVideosCache(videos: VideoInfo[], scope: string) {
  const key = scopedKey(COLLECTED_VIDEOS_KEY, scope);
  if (!key) return;
  writeCache(key, trimVideoListWindow(videos, COLLECTED_VIDEOS_SOFT_LIMIT));
}

export function loadCollectedMixesCache(scope: string): CollectedMixItem[] {
  const key = scopedKey(COLLECTED_MIXES_KEY, scope);
  if (!key) return [];
  const cache = readCache<CollectedMixItem>(key);
  return cache?.data || [];
}

export function saveCollectedMixesCache(mixes: CollectedMixItem[], scope: string) {
  const key = scopedKey(COLLECTED_MIXES_KEY, scope);
  if (!key) return;
  writeCache(key, mixes);
}
