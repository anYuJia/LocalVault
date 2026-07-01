import {
  isBrowserBridgeRuntime,
  loadRecentSearchUsersFromBackend,
  saveRecentSearchUsersToBackend,
  type UserInfo,
  type VideoInfo,
} from "@/lib/tauri";

const STORAGE_KEY = "dy_recent_searches";
const USER_STORAGE_KEY = "dy_recent_search_users";
const LINK_STORAGE_KEY = "dy_recent_links";
const MAX_ITEMS = 8;
const MAX_USER_ITEMS = 200;
const MAX_LINK_ITEMS = 120;

export interface RecentSearch {
  text: string;
  timestamp: number;
}

export interface RecentSearchUser {
  key: string;
  user: UserInfo;
  lastSearchedAt: number;
}

export interface RecentParsedLink {
  key: string;
  link: string;
  title: string;
  subtitle: string;
  kind: "video" | "user" | "mixed" | "unknown";
  videoCount: number;
  userName: string;
  cover: string;
  lastParsedAt: number;
}

function userHistoryKey(user: Partial<UserInfo>): string {
  return String(user.sec_uid || user.uid || user.unique_id || user.nickname || "").trim();
}

function extractFirstLink(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/https?:\/\/[^\s<>"']+|www\.[^\s<>"']+/i);
  const link = match?.[0] || trimmed;
  const delimiterIndex = link.search(/[，。！？；、,!;]/u);
  const token = delimiterIndex >= 0 ? link.slice(0, delimiterIndex) : link;
  return token.trim().replace(/[，。！？；、,.!;]+$/u, "");
}

function linkHistoryKey(link: string): string {
  return extractFirstLink(link).toLowerCase();
}

function linkHost(link: string): string {
  try {
    const value = extractFirstLink(link);
    const parsed = new URL(value.startsWith("www.") ? `https://${value}` : value);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "douyin.com";
  }
}

export function loadRecentSearches(): RecentSearch[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentSearch[];
  } catch {
    return [];
  }
}

export function loadRecentSearchUsers(): RecentSearchUser[] {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentSearchUser =>
        Boolean(item && typeof item === "object" && item.user && item.lastSearchedAt)
      )
      .sort((a, b) => Number(b.lastSearchedAt || 0) - Number(a.lastSearchedAt || 0));
  } catch {
    return [];
  }
}

function cacheRecentSearchUsers(users: RecentSearchUser[]): void {
  try {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(users));
  } catch {
    // Ignore storage failures
  }
}

function persistRecentSearchUsers(users: RecentSearchUser[]): void {
  if (!isBrowserBridgeRuntime()) return;
  void saveRecentSearchUsersToBackend<RecentSearchUser>(users).catch(() => {
    // Local cache remains usable if the backend is unavailable during startup/shutdown.
  });
}

export async function loadRecentSearchUsersAsync(): Promise<RecentSearchUser[]> {
  if (!isBrowserBridgeRuntime()) return loadRecentSearchUsers();
  const localUsers = loadRecentSearchUsers();

  try {
    const users = await loadRecentSearchUsersFromBackend<RecentSearchUser>();
    if (users.length > 0) {
      cacheRecentSearchUsers(users);
      return loadRecentSearchUsers();
    }
    if (localUsers.length > 0) {
      persistRecentSearchUsers(localUsers);
    }
  } catch {
    // Fall back to localStorage for browser dev mode or transient backend errors.
  }

  return localUsers;
}

export function saveRecentSearchUser(user: UserInfo): RecentSearchUser[] {
  const key = userHistoryKey(user);
  if (!key) return loadRecentSearchUsers();

  const current = loadRecentSearchUsers();
  const existing = current.filter((item) => item.key !== key);
  const previous = current.find((item) => item.key === key)?.user;
  const updatedUser = { ...(previous || {}), ...user };
  const updated: RecentSearchUser[] = [
    { key, user: updatedUser, lastSearchedAt: Date.now() },
    ...existing,
  ].slice(0, MAX_USER_ITEMS);

  try {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }
  persistRecentSearchUsers(updated);

  return updated;
}

export function removeRecentSearchUser(key: string): RecentSearchUser[] {
  const updated = loadRecentSearchUsers().filter((item) => item.key !== key);
  try {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }
  persistRecentSearchUsers(updated);
  return updated;
}

export function clearRecentSearchUsers(): void {
  try {
    localStorage.removeItem(USER_STORAGE_KEY);
  } catch {
    // Ignore storage failures
  }
  persistRecentSearchUsers([]);
}

export function saveRecentSearch(text: string): RecentSearch[] {
  const trimmed = text.trim();
  if (!trimmed) return loadRecentSearches();

  const existing = loadRecentSearches().filter((s) => s.text !== trimmed);
  const updated: RecentSearch[] = [
    { text: trimmed, timestamp: Date.now() },
    ...existing,
  ].slice(0, MAX_ITEMS);

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }

  return updated;
}

export function removeRecentSearch(text: string): RecentSearch[] {
  const updated = loadRecentSearches().filter((s) => s.text !== text);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }
  return updated;
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures
  }
}

export function loadRecentParsedLinks(): RecentParsedLink[] {
  try {
    const raw = localStorage.getItem(LINK_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentParsedLink =>
        Boolean(item && typeof item === "object" && item.link && item.lastParsedAt)
      )
      .sort((a, b) => Number(b.lastParsedAt || 0) - Number(a.lastParsedAt || 0));
  } catch {
    return [];
  }
}

export function saveRecentParsedLink(
  rawLink: string,
  result: { videos?: VideoInfo[]; user?: UserInfo | null } = {}
): RecentParsedLink[] {
  const link = extractFirstLink(rawLink);
  const key = linkHistoryKey(link);
  if (!key) return loadRecentParsedLinks();

  const videos = result.videos || [];
  const firstVideo = videos[0];
  const user = result.user || firstVideo?.author || null;
  const videoTitle = firstVideo?.desc || firstVideo?.aweme_id || "";
  const userName = user?.nickname || "";
  const title = videoTitle || userName || "抖音链接";
  const cover = firstVideo?.cover_url || firstVideo?.video?.cover || user?.avatar_thumb || user?.avatar_medium || "";
  const kind: RecentParsedLink["kind"] =
    videos.length > 0 && user ? "mixed" : videos.length > 0 ? "video" : user ? "user" : "unknown";
  const subtitle = [
    linkHost(link),
    videos.length > 0 ? `${videos.length} 个作品` : "",
    userName ? `@${userName}` : "",
  ].filter(Boolean).join(" · ");

  const current = loadRecentParsedLinks();
  const existing = current.filter((item) => item.key !== key);
  const updated: RecentParsedLink[] = [
    {
      key,
      link,
      title,
      subtitle,
      kind,
      videoCount: videos.length,
      userName,
      cover,
      lastParsedAt: Date.now(),
    },
    ...existing,
  ].slice(0, MAX_LINK_ITEMS);

  try {
    localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }

  return updated;
}

export function removeRecentParsedLink(key: string): RecentParsedLink[] {
  const updated = loadRecentParsedLinks().filter((item) => item.key !== key);
  try {
    localStorage.setItem(LINK_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage failures
  }
  return updated;
}

export function clearRecentParsedLinks(): void {
  try {
    localStorage.removeItem(LINK_STORAGE_KEY);
  } catch {
    // Ignore storage failures
  }
}
