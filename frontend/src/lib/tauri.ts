// ═══════════════════════════════════════════════
// Tauri IPC Wrappers
// ═══════════════════════════════════════════════

import { convertFileSrc } from "@tauri-apps/api/core";
import type {
  AppConfig,
  AccountInfo,
  ApiResponse,
  AiInteractionSuggestPayload,
  AiInteractionSuggestResponse,
  BitRateInfo,
  CommentDiggResponse,
  CommentsResponse,
  CookieStatus,
  McpConfig,
  McpConnectionInfo,
  McpLogEntry,
  McpStatus,
  CollectedMixItem,
  CollectedMixesResponse,
  CollectedVideosResponse,
  DownloadFilesResult,
  DownloadProgress,
  FriendChatStateResponse,
  FriendMessageHistoryResponse,
  FriendOnlineStatusResponse,
  HistoryItem,
  LikedAuthorsResponse,
  LikedVideosResponse,
  LinkParseResponse,
  MixVideosResponse,
  PublishCommentResponse,
  NoticesResponse,
  RecommendedFeedType,
  RecommendedResponse,
  SearchUserResponse,
  SendFriendMessageResponse,
  ShareFriendsResponse,
  Statistics,
  UserDetailResponse,
  UserInfo,
  UserVideosResponse,
  VideoData,
  VideoDetailResponse,
  VideoInfo,
  VideoMediaUrl,
  VideoRelationResponse,
  FollowResponse,
} from "./contracts";

let verifyCookieInFlight: Promise<CookieStatus> | null = null;
let lastVerifyCookieResult: CookieStatus | null = null;
let lastVerifyCookieTime = 0;

export type * from "./contracts";

import {
  getErrorMessage,
  normalizeHistoryItem,
  normalizeLikedVideo,
  normalizeUser,
  normalizeVideo,
  normalizeVideos,
} from "./normalizers";

export {
  getErrorMessage,
  normalizeHistoryItem,
  normalizeLikedVideo,
  normalizeUser,
  normalizeVideo,
  normalizeVideos,
} from "./normalizers";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type BrowserSocketListener = (payload: unknown) => void;
type BrowserSocket = {
  on: (event: string, listener: BrowserSocketListener) => void;
  off: (event: string, listener: BrowserSocketListener) => void;
  connected?: boolean;
};
type PywebviewApi = {
  open_external_url?: (url: string) => Promise<void> | void;
};

declare global {
  interface Window {
    __TAURI__?: {
      core?: {
        invoke?: TauriInvoke;
      };
      event?: {
        listen?: <T>(event: string, cb: (ev: { payload: T }) => void) => Promise<() => void>;
      };
    };
    pywebview?: {
      api?: PywebviewApi;
    };
    io?: (options?: { transports?: string[] }) => BrowserSocket;
    SOCKET_TRANSPORTS?: string[];
  }
}

function isTauriRuntime() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeWithCookieInvalidEvent(command, args, true);
}

function invokeLocal<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeWithCookieInvalidEvent(command, args, false);
}

function invokeWithCookieInvalidEvent<T>(
  command: string,
  args: Record<string, unknown> | undefined,
  emitCookieInvalidEvent: boolean
): Promise<T> {
  const tauriInvoke = window.__TAURI__?.core?.invoke;

  if (!tauriInvoke) {
    return Promise.reject(new Error("Tauri API unavailable"));
  }

  return tauriInvoke<T>(command, args)
    .then((result) => {
      if (emitCookieInvalidEvent) {
        emitCookieInvalidIfNeeded(result);
      }
      return result;
    })
    .catch((error) => {
      if (emitCookieInvalidEvent) {
        emitCookieInvalidFromError(error);
      }
      throw error;
    });
}

function emitCookieInvalidIfNeeded(payload: unknown) {
  if (!payload || typeof payload !== "object") return;
  const data = payload as Record<string, unknown>;
  if (data.security_blocked) return;
  const message = String(data.message || "Cookie 已失效，请重新登录").trim();
  if (isLocalLoginPromptMessage(message)) return;
  const failedWithLoginMessage = data.success === false && isCookieInvalidMessage(message);
  if (!data.need_login && !failedWithLoginMessage) return;

  window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
}

function emitCookieInvalidFromError(error: unknown) {
  const message = getErrorMessage(error, "");
  if (!message) return;
  if (isLocalLoginPromptMessage(message)) return;
  if (!isCookieInvalidMessage(message)) return;
  window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
}

function isCookieInvalidMessage(message: string) {
  return /用户未登录|未登录|请先登录|请先设置\s*Cookie|登录态|重新登录|not login|not logged in|login required|session expired/i.test(message);
}

function isLocalLoginPromptMessage(message: string) {
  return /请先设置\s*Cookie|未配置\s*Cookie|请登录后获取(?:推荐视频|点赞视频|收藏视频|收藏合集)/i.test(message);
}

function normalizeFeatureLoginResponse<T>(
  result: T,
  feature: "点赞视频" | "收藏视频" | "收藏合集"
): T {
  if (!result || typeof result !== "object") return result;
  const data = result as Record<string, unknown>;
  if (data.success !== false) return result;

  const rawMessage = String(data.message || "").trim();
  if (!data.need_login && !isCookieInvalidMessage(rawMessage)) return result;

  return {
    ...data,
    need_login: true,
    need_verify: false,
    message: `请登录后获取${feature}`,
  } as T;
}

let browserSocket: BrowserSocket | null = null;

function getBrowserSocket() {
  if (isTauriRuntime()) return null;
  if (browserSocket) return browserSocket;
  if (typeof window.io !== "function") return null;

  browserSocket = window.io({
    transports:
      Array.isArray(window.SOCKET_TRANSPORTS) && window.SOCKET_TRANSPORTS.length > 0
        ? window.SOCKET_TRANSPORTS
        : ["websocket", "polling"],
  });

  return browserSocket;
}

type RequestJsonOptions = RequestInit & {
  suppressCookieInvalidEvent?: boolean;
};

async function requestJson<T>(path: string, init: RequestJsonOptions = {}): Promise<T> {
  const { suppressCookieInvalidEvent, ...fetchInit } = init;
  const headers = new Headers(fetchInit.headers || {});
  if (!headers.has("Content-Type") && fetchInit.body) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...fetchInit,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => ({}))
    : {};

  if (!suppressCookieInvalidEvent) {
    emitCookieInvalidIfNeeded(data);
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data
        ? String((data as Record<string, unknown>).message || "").trim()
        : "";
    throw new Error(message || `${response.status} ${response.statusText}`.trim());
  }

  return data as T;
}

export function mediaProxyUrl(url: string | null | undefined, mediaType = "image", extraParams: Record<string, string | undefined> = {}): string {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;
  if (
    trimmed.startsWith("/") ||
    trimmed.includes("127.0.0.1:39143/api/media/proxy") ||
    trimmed.includes("127.0.0.1:39143/api/local-media")
  ) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed;
    const base = isTauriRuntime()
      ? "http://127.0.0.1:39143/api/media/proxy"
      : "/api/media/proxy";
    const extra = Object.entries(extraParams)
      .filter(([, value]) => value)
      .map(([key, value]) => `&${encodeURIComponent(key)}=${encodeURIComponent(value || "")}`)
      .join("");
    return `${base}?url=${encodeURIComponent(trimmed)}&media_type=${encodeURIComponent(mediaType)}${extra}`;
  } catch {
    return trimmed;
  }
}

export function isBrowserBridgeRuntime() {
  return shouldUseBrowserBridge();
}

export async function loadRecentSearchUsersFromBackend<T>(): Promise<T[]> {
  const result = await requestJson<{ success?: boolean; users?: T[] }>("/api/recent_search_users", {
    suppressCookieInvalidEvent: true,
  });
  return Array.isArray(result.users) ? result.users : [];
}

export async function saveRecentSearchUsersToBackend<T>(users: T[]): Promise<T[]> {
  const result = await requestJson<{ success?: boolean; users?: T[] }>("/api/recent_search_users", {
    method: "POST",
    body: JSON.stringify({ users }),
    suppressCookieInvalidEvent: true,
  });
  return Array.isArray(result.users) ? result.users : users;
}

export function localFileAssetUrl(path: string | null | undefined): string {
  const trimmed = (path || "").trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return trimmed;
  if (!isTauriRuntime()) {
    return `/api/local-media?path=${encodeURIComponent(trimmed)}`;
  }
  try {
    return convertFileSrc(trimmed);
  } catch {
    return "";
  }
}

async function writeTextWithBrowserClipboard(text: string): Promise<boolean> {
  if (window.navigator?.clipboard?.writeText) {
    try {
      await window.navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Embedded WebViews can reject clipboard writes even after a click.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  const value = String(text || "");
  if (!value) return false;

  if (isTauriRuntime()) {
    try {
      await invoke("copy_text_to_clipboard", { text: value });
      return true;
    } catch {
      // Fall back to browser clipboard if the native bridge is unavailable.
    }
  }

  try {
    const result = await requestJson<{ success?: boolean }>("/api/clipboard/write", {
      method: "POST",
      body: JSON.stringify({ text: value }),
    });
    if (result.success !== false) return true;
  } catch {
    // Fall back to browser clipboard below.
  }

  return writeTextWithBrowserClipboard(value);
}

// ── Tauri / Browser event listener ──

type TauriUnlisten = () => void;
type EventHandler<T> = (payload: T) => void;

function toFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeProgress(value: unknown, processed?: number, total?: number, currentProgress?: unknown) {
  const explicit = toFiniteNumber(value);
  if (explicit !== undefined) return Math.max(0, Math.min(100, explicit));
  const current = toFiniteNumber(currentProgress);
  if (total !== undefined && total > 0 && processed !== undefined) {
    const currentWeight = current !== undefined ? Math.max(0, Math.min(100, current)) / 100 : 0;
    return Math.max(0, Math.min(100, ((processed + currentWeight) / total) * 100));
  }
  return current !== undefined ? Math.max(0, Math.min(100, current)) : 0;
}

export function normalizeBrowserTask(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const task = value as Record<string, unknown>;
  const id = String(task.id || task.task_id || "").trim();
  if (!id) return null;

  const status = String(task.status || "pending").trim().toLowerCase();
  const mappedStatus =
    status === "completed" ? "completed"
      : status === "downloading" ? "downloading"
      : status === "paused" ? "paused"
      : status === "cancelled" || status === "canceled" ? "cancelled"
      : status === "error" || status === "failed" ? "error"
      : "pending";
  const total = toFiniteNumber(task.total_videos ?? task.file_total ?? task.fileTotal ?? task.total_files);
  const processed = toFiniteNumber(task.processed ?? task.current_downloaded ?? task.file_index ?? task.fileIndex ?? task.completed_files);

  return {
    id,
    filename: String(task.filename || task.display_name || task.desc || id).trim(),
    progress: normalizeProgress(task.overall_progress, processed, total, task.progress),
    speed: Number(task.speed ?? task.speed_bps ?? 0) || 0,
    status: mappedStatus,
    isBatch: Boolean(task.isBatch ?? task.total_videos ?? task.fileTotal ?? task.total_files ?? false),
    awemeId: String(task.aweme_id || task.awemeId || "").trim() || undefined,
    currentAwemeId: String(task.current_aweme_id || task.currentAwemeId || "").trim() || undefined,
    currentName: String(task.current_name || task.currentName || "").trim() || undefined,
    savePath: String(task.save_path || task.savePath || "").trim() || undefined,
    filePath: String(task.file_path || task.filePath || "").trim() || undefined,
    mediaType: String(task.media_type || task.mediaType || "").trim() || undefined,
    mediaCount: toFiniteNumber(task.media_count ?? task.mediaCount ?? total),
    fileIndex: processed,
    fileTotal: total,
    fileProgress: Number(task.file_progress ?? task.fileProgress ?? 0) || undefined,
    completedCount: Number(task.completed_count ?? task.completedCount ?? 0) || undefined,
    skippedCount: Number(task.skipped_count ?? task.skippedCount ?? 0) || undefined,
    failedCount: Number(task.failed_count ?? task.failedCount ?? 0) || undefined,
    succeededCount: Number(task.succeeded_count ?? task.succeededCount ?? task.succeeded ?? 0) || undefined,
    etaSeconds: Number(task.eta_seconds ?? task.etaSeconds ?? 0) || undefined,
    totalBytes: Number(task.total_bytes ?? task.totalBytes ?? 0) || undefined,
    downloadedBytes: Number(task.downloaded_bytes ?? task.downloadedBytes ?? 0) || undefined,
    capacityTotalBytes: Number(task.capacity_total_bytes ?? task.capacityTotalBytes ?? 0) || undefined,
    capacityDownloadedBytes: Number(task.capacity_downloaded_bytes ?? task.capacityDownloadedBytes ?? 0) || undefined,
    startTime: Number(task.start_time ?? task.startTime ?? 0) || undefined,
    finishedTime: Number(task.finished_time ?? task.finishedTime ?? 0) || undefined,
    errorMessage: String(task.error_message || task.errorMessage || "").trim() || undefined,
  };
}

function normalizeBrowserDownloadProgress(payload: Record<string, unknown>) {
  const currentVideo = payload.current_video && typeof payload.current_video === "object"
    ? (payload.current_video as Record<string, unknown>)
    : {};
  const hasCurrentVideo = Object.keys(currentVideo).length > 0;
  const useCurrentVideoProgress = hasCurrentVideo && payload.progress_scope === "current_video";
  const total = toFiniteNumber(payload.total_videos ?? payload.total);
  const processed = toFiniteNumber(payload.processed ?? payload.current_downloaded ?? payload.completed);
  const overallProgress = normalizeProgress(payload.overall_progress, processed, total, payload.progress);
  const currentProgress = Number(currentVideo.progress ?? payload.file_progress ?? 0) || 0;
  const currentAwemeId = String(currentVideo.aweme_id || "").trim();
  const currentName = String(currentVideo.desc || currentVideo.name || payload.message || "").trim();

  return {
    task_id: String(payload.task_id || ""),
    progress_scope: String(payload.progress_scope || ""),
    progress: useCurrentVideoProgress ? currentProgress : overallProgress,
    overall_progress: overallProgress,
    completed: Number(payload.current_downloaded ?? payload.completed ?? 0) || 0,
    current_downloaded: processed,
    total: Number(payload.total_videos ?? payload.total ?? 0) || 0,
    total_videos: total,
    processed,
    skipped: Number(payload.skipped ?? 0) || undefined,
    failed: Number(payload.failed ?? 0) || undefined,
    succeeded: Number(payload.succeeded ?? 0) || undefined,
    status: String(payload.status || "downloading"),
    current_aweme_id: currentAwemeId || undefined,
    current_name: currentName || undefined,
    current_video_status: String(currentVideo.status || "").trim() || undefined,
    worker_slot: Number(currentVideo.worker_slot ?? currentVideo.slot ?? 0) || undefined,
    desc: String(payload.desc || ""),
    display_name: String(payload.display_name || payload.desc || ""),
    file_index: Number(currentVideo.file_index ?? payload.file_index ?? 0) || undefined,
    file_total: Number(currentVideo.file_total ?? payload.file_total ?? 0) || undefined,
    file_progress: currentProgress || undefined,
    bytes_downloaded: Number(currentVideo.bytes_downloaded ?? payload.bytes_downloaded ?? 0) || undefined,
    bytes_total: Number(currentVideo.bytes_total ?? payload.bytes_total ?? 0) || undefined,
    capacity_bytes_downloaded: Number(payload.bytes_downloaded ?? 0) || undefined,
    capacity_bytes_total: Number(payload.bytes_total ?? 0) || undefined,
    speed_bps: Number(currentVideo.speed_bps ?? payload.speed_bps ?? 0) || undefined,
    eta_seconds: Number(payload.eta_seconds ?? currentVideo.eta_seconds ?? 0) || undefined,
    message: String(payload.message || currentVideo.message || ""),
  };
}

function normalizeDownloadInfoPayload(payload: Record<string, unknown>) {
  const total = toFiniteNumber(payload.total_videos);
  const processed = toFiniteNumber(payload.processed ?? payload.current_downloaded);
  return {
    task_id: String(payload.task_id || ""),
    progress: normalizeProgress(payload.overall_progress, processed, total),
    overall_progress: normalizeProgress(payload.overall_progress, processed, total),
    completed: Number(payload.current_downloaded ?? 0) || 0,
    current_downloaded: processed,
    total: Number(payload.total_videos ?? 0) || 0,
    total_videos: total,
    processed,
    skipped: Number(payload.skipped ?? 0) || undefined,
    failed: Number(payload.failed ?? 0) || undefined,
    status: "downloading",
    desc: String(payload.desc || ""),
    display_name: String(payload.display_name || payload.desc || ""),
    message: String(payload.message || ""),
  };
}

export function getDownloadPayload(video: VideoInfo) {
  const normalized = normalizeVideo(video) || video;
  const authorName = normalized.author?.nickname || "未知作者";
  const mediaUrls = normalized.media_urls && normalized.media_urls.length > 0
    ? normalized.media_urls
    : [];
  return {
    aweme_id: normalized.aweme_id,
    desc: normalized.desc || "",
    create_time: normalized.create_time || 0,
    author: normalized.author,
    video: normalized.video,
    cover_url: normalized.cover_url || normalized.video?.cover || "",
    media_type: normalized.media_type ?? "video",
    media_urls: mediaUrls,
    raw_media_type: normalized.raw_media_type ?? normalized.media_type ?? "video",
    author_name: authorName,
  };
}

function shouldUseBrowserBridge() {
  return !isTauriRuntime();
}

export async function listenEvent<T>(event: string, handler: EventHandler<T>): Promise<TauriUnlisten> {
  const tauriListen = window.__TAURI__?.event?.listen;
  if (tauriListen) {
    return tauriListen(event, (ev) => handler(ev.payload as T));
  }

  const socket = getBrowserSocket();
  if (!socket) return () => {};

  const bindings: Array<{ event: string; listener: BrowserSocketListener }> = [];
  const bind = (socketEvent: string, transform: (payload: unknown) => T | null) => {
    const listener: BrowserSocketListener = (payload) => {
      const mapped = transform(payload);
      if (mapped !== null) handler(mapped);
    };
    socket.on(socketEvent, listener);
    bindings.push({ event: socketEvent, listener });
  };

  switch (event) {
    case "download-started":
      bind("download_started", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (String(data.type || "") === "single_video") {
          return {
            task_id: String(data.task_id || ""),
            desc: String(data.desc || ""),
            display_name: String(data.display_name || data.desc || ""),
            type: String(data.type || ""),
            aweme_id: String(data.aweme_id || ""),
            media_type: String(data.media_type || ""),
            media_count: Number(data.media_count || 0) || 0,
          } as T;
        }
        return null;
      });
      break;
    case "batch-download-started":
      bind("download_started", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (String(data.type || "") === "single_video") return null;
        return {
          task_id: String(data.task_id || ""),
          nickname: String(data.user || data.nickname || ""),
          total_videos: Number(data.total_videos || 0) || undefined,
          message: String(data.message || ""),
        } as T;
      });
      break;
    case "download-progress":
      bind("download_progress", (payload) => payload as T);
      bind("user_video_download_progress", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return normalizeBrowserDownloadProgress(data) as T;
      });
      bind("download_info", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return normalizeDownloadInfoPayload(data) as T;
      });
      break;
    case "download-log":
      bind("download_log", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return {
          task_id: String(data.task_id || ""),
          display_name: String(data.display_name || data.desc || ""),
          message: String(data.message || ""),
          timestamp: String(data.timestamp || ""),
        } as T;
      });
      break;
    case "download-failed":
      bind("download_failed", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return {
          task_id: String(data.task_id || ""),
          error: String(data.error || data.message || ""),
        } as T;
      });
      break;
    case "download-error":
      bind("download_error", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return {
          task_id: String(data.task_id || ""),
          message: String(data.message || data.error || ""),
        } as T;
      });
      break;
    case "download-cancelled":
      bind("download_cancelled", (payload) => payload as T);
      break;
    case "download-completed":
      bind("download_completed", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (data.total_videos !== undefined && data.aweme_id === undefined) return null;
        return {
          task_id: String(data.task_id || ""),
          display_name: String(data.display_name || data.message || ""),
          message: String(data.message || ""),
          files: Array.isArray(data.files) ? data.files.map((item) => String(item)) : undefined,
          file_path: String(data.file_path || ""),
          save_path: String(data.save_path || ""),
          total_size: Number(data.total_size || 0) || undefined,
        } as T;
      });
      break;
    case "batch-download-completed":
      bind("download_completed", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        if (data.total_videos === undefined && data.aweme_id !== undefined) return null;
        return {
          task_id: String(data.task_id || ""),
          total_videos: Number(data.total_videos || 0) || undefined,
          completed: Number(data.current_downloaded ?? data.completed ?? 0) || undefined,
          succeeded: Number(data.succeeded ?? 0) || undefined,
          skipped: Number(data.skipped ?? 0) || undefined,
          failed: Number(data.failed ?? 0) || undefined,
          processed: Number(data.processed ?? data.current_downloaded ?? data.completed ?? 0) || undefined,
          message: String(data.message || ""),
        } as T;
      });
      break;
    case "batch-download-cancelled":
      bind("download_cancelled", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        return {
          task_id: String(data.task_id || ""),
          message: String(data.message || ""),
        } as T;
      });
      break;
    case "current-video-progress":
      bind("user_video_download_progress", (payload) => {
        const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
        const currentVideo = data.current_video && typeof data.current_video === "object"
          ? (data.current_video as Record<string, unknown>)
          : {};
        const awemeId = String(currentVideo.aweme_id || "").trim();
        if (!awemeId) return null;
        return {
          task_id: String(data.task_id || ""),
          aweme_id: awemeId,
          name: String(currentVideo.desc || data.message || ""),
          progress: Number(currentVideo.progress ?? 0) || 0,
          status: String(currentVideo.status || data.status || ""),
          worker_slot: Number(currentVideo.worker_slot ?? currentVideo.slot ?? 0) || undefined,
          file_index: Number(currentVideo.file_index ?? 0) || undefined,
          file_total: Number(currentVideo.file_total ?? 0) || undefined,
          bytes_downloaded: Number(currentVideo.bytes_downloaded ?? 0) || undefined,
          bytes_total: Number(currentVideo.bytes_total ?? 0) || undefined,
          speed_bps: Number(currentVideo.speed_bps ?? 0) || undefined,
          speed_mbps: Number(currentVideo.speed_mbps ?? 0) || undefined,
        } as T;
      });
      break;
    case "cookie-login-status":
      bind("cookie_login_status", (payload) => payload as T);
      break;
    default: {
      const fallback = event.replace(/-/g, "_");
      bind(fallback, (payload) => payload as T);
      break;
    }
  }

  return () => {
    bindings.forEach(({ event: socketEvent, listener }) => socket.off(socketEvent, listener));
  };
}

// ── React frontend browser bridge ──

export async function initClient(): Promise<{ success: boolean }> {
  if (shouldUseBrowserBridge()) return { success: true };
  return invoke("init_client");
}

export async function getAppVersion(): Promise<string> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<string | { version?: string }>("/api/get_app_version");
    return typeof result === "string" ? result : String(result?.version || "");
  }
  return invoke("get_app_version");
}

export async function checkUpdate(): Promise<{
  success: boolean;
  has_update: boolean;
  version?: string;
  current_version?: string;
  notes?: string;
  message?: string;
  html_url?: string;
  download_url?: string;
  asset_name?: string;
  asset_size?: number;
  portable?: boolean;
  install_mode?: string;
}> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/check_update");
  }
  return invoke("check_update");
}

export async function downloadUpdate(): Promise<{
  success: boolean;
  message: string;
  mode?: string;
  portable?: boolean;
  install_mode?: string;
  restart_required?: boolean;
  download_url?: string;
  file_path?: string;
}> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_update");
  }
  return invoke("download_update");
}

export async function restartApp(): Promise<void> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<{ success?: boolean; message?: string }>("/api/restart_app");
    if (result && result.success === false) {
      throw new Error(result.message || "重启失败");
    }
    return;
  }
  return invoke("restart_app");
}

export async function getConfig(): Promise<AppConfig> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<Record<string, unknown>>("/api/config");
    return {
      download_path: String(result.download_path || result.download_dir || ""),
      download_dir: String(result.download_dir || result.download_path || ""),
      filename_template: String(result.filename_template || "{title}"),
      max_concurrent: Number(result.max_concurrent || 3) || 3,
      download_quality: String(result.download_quality || "auto"),
      download_live_photo_video: Boolean(result.download_live_photo_video ?? true),
      download_live_photo_image: Boolean(result.download_live_photo_image ?? true),
      auto_create_folder: Boolean(result.auto_create_folder ?? true),
      folder_name_template: String(result.folder_name_template || "{author}"),
      save_metadata: Boolean(result.save_metadata ?? true),
      proxy: (result.proxy as string | null) ?? null,
      cookie: "",
      im_friend_sec_user_ids: Array.isArray(result.im_friend_sec_user_ids)
        ? result.im_friend_sec_user_ids.filter((item): item is string => typeof item === "string")
        : [],
      im_friend_include_all_users: Boolean(result.im_friend_include_all_users ?? false),
      im_friend_refresh_interval_seconds: Number(result.im_friend_refresh_interval_seconds || 30) || 30,
      ai_interaction: normalizeAiInteractionConfig(result.ai_interaction),
      mcp: normalizeMcpConfig(result.mcp),
      theme: String(result.theme || "dark"),
      language: String(result.language || "zh-CN"),
      cookie_set: Boolean(result.cookie_set ?? false),
    };
  }
  return invoke("get_config");
}

export async function saveConfig(config: Partial<AppConfig>): Promise<{ success: boolean; message: string }> {
  const hasProxyPatch = Object.prototype.hasOwnProperty.call(config, "proxy");
  if (shouldUseBrowserBridge()) {
    const current = await getConfig().catch(() => ({} as Partial<AppConfig>));
    const payload: Record<string, unknown> = {
      download_dir: config.download_path ?? config.download_dir ?? current.download_path ?? current.download_dir ?? "",
      download_quality: config.download_quality ?? current.download_quality ?? "auto",
      download_live_photo_video: config.download_live_photo_video ?? current.download_live_photo_video ?? true,
      download_live_photo_image: config.download_live_photo_image ?? current.download_live_photo_image ?? true,
      max_concurrent: config.max_concurrent ?? current.max_concurrent ?? 3,
      filename_template: config.filename_template ?? current.filename_template ?? "{title}",
      folder_name_template: config.folder_name_template ?? current.folder_name_template ?? "{author}",
      auto_create_folder: config.auto_create_folder ?? current.auto_create_folder ?? true,
      im_friend_sec_user_ids: config.im_friend_sec_user_ids ?? current.im_friend_sec_user_ids ?? [],
      im_friend_include_all_users:
        config.im_friend_include_all_users ?? current.im_friend_include_all_users ?? false,
      im_friend_refresh_interval_seconds:
        config.im_friend_refresh_interval_seconds ?? current.im_friend_refresh_interval_seconds ?? 30,
      ai_interaction: config.ai_interaction ?? current.ai_interaction,
      mcp: config.mcp ?? current.mcp,
      proxy: hasProxyPatch ? (config.proxy ?? null) : (current.proxy ?? null),
    };
    if (typeof config.cookie === "string") {
      payload.cookie = config.cookie;
    }
    return requestJson("/api/config", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  const current = await getConfig().catch(() => ({} as Partial<AppConfig>));
  const nextConfig: AppConfig = {
    download_path: config.download_path ?? config.download_dir ?? current.download_path ?? current.download_dir ?? "",
    filename_template: config.filename_template ?? current.filename_template ?? "{title}",
    max_concurrent: config.max_concurrent ?? current.max_concurrent ?? 3,
    download_quality: config.download_quality ?? current.download_quality ?? "auto",
    download_live_photo_video: config.download_live_photo_video ?? current.download_live_photo_video ?? true,
    download_live_photo_image: config.download_live_photo_image ?? current.download_live_photo_image ?? true,
    auto_create_folder: config.auto_create_folder ?? current.auto_create_folder ?? true,
    folder_name_template: config.folder_name_template ?? current.folder_name_template ?? "{author}",
    save_metadata: config.save_metadata ?? current.save_metadata ?? true,
    proxy: hasProxyPatch ? (config.proxy ?? null) : (current.proxy ?? null),
    cookie: config.cookie ?? "",
    im_friend_sec_user_ids: config.im_friend_sec_user_ids ?? current.im_friend_sec_user_ids ?? [],
    im_friend_include_all_users:
      config.im_friend_include_all_users ?? current.im_friend_include_all_users ?? false,
    im_friend_refresh_interval_seconds:
      config.im_friend_refresh_interval_seconds ?? current.im_friend_refresh_interval_seconds ?? 30,
    ai_interaction: config.ai_interaction ?? current.ai_interaction,
    mcp: config.mcp ?? current.mcp ?? normalizeMcpConfig(undefined),
    theme: config.theme ?? current.theme ?? "dark",
    language: config.language ?? current.language ?? "zh-CN",
  };
  return invoke("save_config", { config: nextConfig });
}

function normalizeMcpConfig(value: unknown): McpConfig {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    enabled: Boolean(data.enabled ?? false),
    preferred_port: Math.max(1, Math.min(65535, Number(data.preferred_port ?? 39144) || 39144)),
    allow_write_actions: Boolean(data.allow_write_actions ?? false),
    require_confirmation: Boolean(data.require_confirmation ?? true),
    token: typeof data.token === "string" ? data.token : "",
    token_set: Boolean(data.token_set ?? false),
    log_retention: Math.max(50, Math.min(2000, Number(data.log_retention ?? 300) || 300)),
  };
}

export async function getMcpStatus(): Promise<McpStatus> {
  if (shouldUseBrowserBridge()) return requestJson("/api/mcp/status", { suppressCookieInvalidEvent: true });
  return invoke("get_mcp_status");
}

export async function getMcpLogs(limit = 50): Promise<McpLogEntry[]> {
  if (shouldUseBrowserBridge()) {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
    const result = await requestJson<{ logs?: McpLogEntry[] }>(`/api/mcp/logs?limit=${safeLimit}`, { suppressCookieInvalidEvent: true });
    return Array.isArray(result.logs) ? result.logs : [];
  }
  return invoke("get_mcp_logs", { limit });
}

export async function clearMcpLogs(): Promise<void> {
  if (shouldUseBrowserBridge()) {
    await requestJson("/api/mcp/logs", { method: "DELETE", suppressCookieInvalidEvent: true });
    return;
  }
  return invoke("clear_mcp_logs");
}

export async function getMcpConnectionInfo(): Promise<McpConnectionInfo> {
  if (shouldUseBrowserBridge()) return requestJson("/api/mcp/connection", { suppressCookieInvalidEvent: true });
  return invoke("get_mcp_connection_info");
}

export async function regenerateMcpToken(): Promise<{ success: boolean; token: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/mcp/token", { method: "POST", suppressCookieInvalidEvent: true });
  }
  return invoke("regenerate_mcp_token");
}

export async function restartMcpServer(): Promise<McpStatus> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/mcp/restart", { method: "POST", suppressCookieInvalidEvent: true });
  }
  return invoke("restart_mcp_server");
}

function normalizeAiInteractionConfig(value: unknown) {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const rawPresets = Array.isArray(data.provider_presets) ? data.provider_presets : Array.isArray(data.providerPresets) ? data.providerPresets : [];
  const provider_presets = rawPresets
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      id: String(item.id || ""),
      label: String(item.label || item.id || ""),
      api_base: String(item.api_base || item.apiBase || ""),
      default_model: String(item.default_model || item.defaultModel || item.model || ""),
      format: typeof item.format === "string" ? item.format : undefined,
    }))
    .filter((item) => item.id && item.api_base && item.default_model);
  return {
    enabled: Boolean(data.enabled ?? false),
    provider: String(data.provider || "openai_compatible"),
    api_base: String(data.api_base || data.apiBase || "https://api.openai.com/v1"),
    api_key_set: Boolean(data.api_key_set ?? data.apiKeySet ?? false),
    model: String(data.model || "gpt-4o-mini"),
    system_prompt: String(data.system_prompt || data.systemPrompt || ""),
    user_prompt: String(data.user_prompt || data.userPrompt || ""),
    provider_presets,
    auto_send_comments: Boolean(data.auto_send_comments ?? data.autoSendComments ?? false),
    auto_send_private_messages: Boolean(data.auto_send_private_messages ?? data.autoSendPrivateMessages ?? false),
    auto_like: Boolean(data.auto_like ?? data.autoLike ?? false),
    auto_collect: Boolean(data.auto_collect ?? data.autoCollect ?? false),
    auto_send_delay_ms: Number(data.auto_send_delay_ms ?? data.autoSendDelayMs ?? 0),
    auto_send_max_chars: Number(data.auto_send_max_chars ?? data.autoSendMaxChars ?? 180),
    auto_require_context: Boolean(data.auto_require_context ?? data.autoRequireContext ?? true),
    auto_monitor_notices: Boolean(data.auto_monitor_notices ?? data.autoMonitorNotices ?? false),
    auto_monitor_friends: Boolean(data.auto_monitor_friends ?? data.autoMonitorFriends ?? false),
    auto_monitor_comments: Boolean(data.auto_monitor_comments ?? data.autoMonitorComments ?? false),
    auto_monitor_feed: Boolean(data.auto_monitor_feed ?? data.autoMonitorFeed ?? false),
    auto_match_keywords: String(data.auto_match_keywords ?? data.autoMatchKeywords ?? ""),
    auto_exclude_keywords: String(data.auto_exclude_keywords ?? data.autoExcludeKeywords ?? ""),
    auto_private_match_keywords: String(data.auto_private_match_keywords ?? data.autoPrivateMatchKeywords ?? ""),
    auto_private_exclude_keywords: String(data.auto_private_exclude_keywords ?? data.autoPrivateExcludeKeywords ?? ""),
    auto_comment_match_keywords: String(data.auto_comment_match_keywords ?? data.autoCommentMatchKeywords ?? ""),
    auto_comment_exclude_keywords: String(data.auto_comment_exclude_keywords ?? data.autoCommentExcludeKeywords ?? ""),
    auto_like_match_keywords: String(data.auto_like_match_keywords ?? data.autoLikeMatchKeywords ?? ""),
    auto_like_exclude_keywords: String(data.auto_like_exclude_keywords ?? data.autoLikeExcludeKeywords ?? ""),
    auto_collect_match_keywords: String(data.auto_collect_match_keywords ?? data.autoCollectMatchKeywords ?? ""),
    auto_collect_exclude_keywords: String(data.auto_collect_exclude_keywords ?? data.autoCollectExcludeKeywords ?? ""),
    auto_min_digg_count: Number(data.auto_min_digg_count ?? data.autoMinDiggCount ?? 0),
    auto_min_comment_count: Number(data.auto_min_comment_count ?? data.autoMinCommentCount ?? 0),
    auto_min_play_count: Number(data.auto_min_play_count ?? data.autoMinPlayCount ?? 0),
    auto_scan_interval_seconds: Number(data.auto_scan_interval_seconds ?? data.autoScanIntervalSeconds ?? 30),
    auto_max_actions_per_run: Number(data.auto_max_actions_per_run ?? data.autoMaxActionsPerRun ?? 5),
    auto_return_shared_media: Boolean(data.auto_return_shared_media ?? data.autoReturnSharedMedia ?? false),
    auto_return_shared_allow_images: Boolean(data.auto_return_shared_allow_images ?? data.autoReturnSharedAllowImages ?? true),
    auto_return_shared_allow_videos: Boolean(data.auto_return_shared_allow_videos ?? data.autoReturnSharedAllowVideos ?? true),
    auto_return_shared_max_size_mb: Number(data.auto_return_shared_max_size_mb ?? data.autoReturnSharedMaxSizeMb ?? 20),
    auto_return_shared_max_media_count: Number(data.auto_return_shared_max_media_count ?? data.autoReturnSharedMaxMediaCount ?? 9),
  };
}

export async function suggestAiInteraction(payload: AiInteractionSuggestPayload): Promise<AiInteractionSuggestResponse> {
  const body = {
    ...payload,
    incomingText: payload.incoming_text,
    authorName: payload.author_name,
    maxSuggestions: payload.max_suggestions,
  };
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/ai_interaction/suggest", {
      method: "POST",
      body: JSON.stringify(body),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("suggest_ai_interaction", { payload: body });
}

export async function selectDirectory(): Promise<string | null> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<{ success: boolean; path?: string; message?: string }>("/api/select_directory", {
      method: "POST",
    });
    if (result.success) {
      return result.path || null;
    }
    const message = result.message || "选择目录失败";
    if (/取消/.test(message)) {
      return null;
    }
    throw new Error(message);
  }
  return invoke("select_directory");
}

export async function searchUser(keyword: string): Promise<SearchUserResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<SearchUserResponse>("/api/search_user", {
      method: "POST",
      suppressCookieInvalidEvent: true,
      body: JSON.stringify({ keyword }),
    });
    return {
      ...result,
      user: result.user ? normalizeUser(result.user) : undefined,
      users: Array.isArray(result.users) ? result.users.map(normalizeUser) : undefined,
    };
  }
  const result = await invokeLocal<SearchUserResponse>("search_user", { keyword });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
    users: Array.isArray(result.users) ? result.users.map(normalizeUser) : undefined,
  };
}

export async function getUserDetail(secUid: string, nickname?: string): Promise<UserDetailResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<UserDetailResponse>("/api/user_detail", {
      method: "POST",
      suppressCookieInvalidEvent: true,
      body: JSON.stringify({ sec_uid: secUid, nickname }),
    });
    return { ...result, user: result.user ? normalizeUser(result.user) : undefined };
  }
  const result = await invokeLocal<UserDetailResponse>("get_user_detail", {
    secUid,
    sec_uid: secUid,
    nickname,
  });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
  };
}

export async function getUserVideos(secUid: string, count: number, cursor: number): Promise<UserVideosResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<UserVideosResponse & { videos?: unknown[] }>("/api/user_videos", {
      method: "POST",
      suppressCookieInvalidEvent: true,
      body: JSON.stringify({ sec_uid: secUid, count, cursor }),
    });
    return {
      ...result,
      videos: normalizeVideos(result.videos),
    };
  }
  const result = await invokeLocal<UserVideosResponse & { videos?: unknown[] }>("get_user_videos", {
    secUid,
    sec_uid: secUid,
    count,
    cursor,
  });
  return {
    ...result,
    videos: normalizeVideos(result.videos),
  };
}

export async function getVideoDetail(awemeId: string): Promise<VideoDetailResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<VideoDetailResponse & { video?: unknown }>("/api/video_detail", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId }),
    });
    return {
      ...result,
      video: normalizeVideo(result.video) || undefined,
    };
  }
  const result = await invoke<VideoDetailResponse & { video?: unknown }>("get_video_detail", {
    awemeId,
    aweme_id: awemeId,
  });
  return {
    ...result,
    video: normalizeVideo(result.video) || undefined,
  };
}

export async function parseUrl(url: string): Promise<VideoInfo> {
  const result = await parseLink(url);
  return result.video || (normalizeVideo(result as unknown) as VideoInfo) || (result as unknown as VideoInfo);
}

export async function parseLink(link: string): Promise<LinkParseResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<LinkParseResponse & { video?: unknown; videos?: unknown[]; user?: unknown }>("/api/parse_link", {
      method: "POST",
      body: JSON.stringify({ link }),
    });
    return {
      ...result,
      user: result.user ? normalizeUser(result.user) : undefined,
      video: normalizeVideo(result.video) || undefined,
      videos: normalizeVideos(result.videos),
    };
  }
  const result = await invoke<LinkParseResponse & { video?: unknown; videos?: unknown[]; user?: unknown }>("parse_link", { link });
  return {
    ...result,
    user: result.user ? normalizeUser(result.user) : undefined,
    video: normalizeVideo(result.video) || undefined,
    videos: normalizeVideos(result.videos),
  };
}

export async function setVideoLiked(awemeId: string, liked: boolean): Promise<VideoRelationResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/video_like", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, liked }),
    });
  }
  return invoke("set_video_liked", { awemeId, aweme_id: awemeId, liked });
}

export async function setVideoCollected(awemeId: string, collected: boolean): Promise<VideoRelationResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/video_collect", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, collected }),
    });
  }
  return invoke("set_video_collected", { awemeId, aweme_id: awemeId, collected });
}

export async function setUserFollowed(userId: string, follow: boolean): Promise<FollowResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/user_follow", {
      method: "POST",
      body: JSON.stringify({ user_id: userId, follow }),
    });
  }
  return invoke("set_user_followed", { userId, user_id: userId, follow });
}

export async function downloadVideo(video: VideoInfo): Promise<ApiResponse & { task_id?: string }> {
  const payload = getDownloadPayload(video);
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_single_video", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  return invoke("download_video", { video: payload });
}

export async function downloadUserVideos(
  secUid: string,
  nickname: string,
  awemeCount: number
): Promise<ApiResponse & { task_id?: string; total_videos?: number; nickname?: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_user_video", {
      method: "POST",
      body: JSON.stringify({
        sec_uid: secUid,
        nickname,
        aweme_count: awemeCount,
      }),
    });
  }
  return invoke("download_user_videos", {
    secUid,
    sec_uid: secUid,
    nickname,
    awemeCount,
    aweme_count: awemeCount,
  });
}

export async function downloadVideos(
  videos: VideoInfo[],
  name: string
): Promise<ApiResponse & { task_id?: string; total_videos?: number; nickname?: string }> {
  const payloads = videos.map(getDownloadPayload);
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_videos", {
      method: "POST",
      body: JSON.stringify({ videos: payloads, name }),
    });
  }
  return invoke("download_videos", { videos: payloads, name });
}

export async function downloadLikedVideos(count: number): Promise<{ success: boolean; message: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_liked", {
      method: "POST",
      body: JSON.stringify({ count }),
    });
  }
  return invoke("download_liked_videos", { count });
}

export async function downloadLikedAuthors(count: number): Promise<{ success: boolean; message: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/download_liked_authors", {
      method: "POST",
      body: JSON.stringify({ count }),
    });
  }
  return invoke("download_liked_authors", { count });
}

export async function addDownloadTask(video: VideoInfo, savePath?: string): Promise<string> {
  const payload = getDownloadPayload(video);
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<ApiResponse & { task_id?: string }>("/api/download_single_video", {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        save_path: savePath,
      }),
    });
    return result.task_id || video.aweme_id;
  }
  return invoke("add_download_task", { video: payload, savePath, save_path: savePath });
}

export async function startDownload(taskId: string): Promise<void> {
  if (shouldUseBrowserBridge()) return;
  return invoke("start_download", { taskId, task_id: taskId });
}

export async function getDownloadTasks(): Promise<unknown[]> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<{ success: boolean; tasks?: unknown }>(
      "/api/tasks"
    );
    const tasks = result.tasks;
    if (Array.isArray(tasks)) return tasks;
    if (tasks && typeof tasks === "object") {
      return Object.values(tasks as Record<string, unknown>);
    }
    return [];
  }
  const result = await invoke<{ success: boolean; tasks?: unknown[] }>("get_download_tasks");
  return result.tasks || [];
}

export async function cancelDownloadTask(taskId: string): Promise<ApiResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/cancel_download", {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    });
  }
  return invoke("cancel_download_task", { taskId, task_id: taskId });
}

export async function removeDownloadTask(taskId: string): Promise<void> {
  if (shouldUseBrowserBridge()) return;
  return invoke("remove_download_task", { taskId, task_id: taskId });
}

export async function pauseDownload(taskId: string): Promise<ApiResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/pause_download", {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    });
  }
  return invoke("pause_download", { taskId, task_id: taskId });
}

export async function resumeDownload(taskId: string): Promise<ApiResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/resume_download", {
      method: "POST",
      body: JSON.stringify({ task_id: taskId }),
    });
  }
  return invoke("resume_download", { taskId, task_id: taskId });
}

export async function getRecommended(
  cursor: number,
  count: number,
  feedType: RecommendedFeedType = "featured"
): Promise<RecommendedResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<RecommendedResponse & { videos?: unknown[] }>("/api/recommended_feed", {
      method: "POST",
      body: JSON.stringify({ cursor, count, feed_type: feedType, feedType }),
    });
    return {
      ...result,
      videos: normalizeVideos(result.videos),
    };
  }
  const result = await invoke<RecommendedResponse & { videos?: unknown[] }>("get_recommended", {
    cursor,
    count,
    feedType,
    feed_type: feedType,
  });
  return {
    ...result,
    videos: normalizeVideos(result.videos),
  };
}

export async function getLikedVideos(
  count: number,
  secUid = "",
  cursor = 0
): Promise<LikedVideosResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<LikedVideosResponse & { data?: unknown[] }>("/api/get_liked_videos", {
      method: "POST",
      body: JSON.stringify({ count, sec_uid: secUid, cursor }),
      suppressCookieInvalidEvent: true,
    });
    return normalizeFeatureLoginResponse({
      ...result,
      data: Array.isArray(result.data)
        ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
        : [],
    }, "点赞视频");
  }
  const result = await invokeLocal<LikedVideosResponse & { data?: unknown[] }>("get_liked_videos", {
    count,
    secUid,
    sec_uid: secUid,
    cursor,
  });

  return normalizeFeatureLoginResponse({
    ...result,
    data: Array.isArray(result.data)
      ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
      : [],
  }, "点赞视频");
}

export async function getLikedAuthors(count: number): Promise<LikedAuthorsResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<LikedAuthorsResponse & { data?: unknown[] }>("/api/get_liked_authors", {
      method: "POST",
      body: JSON.stringify({ count }),
    });
    return {
      ...result,
      data: Array.isArray(result.data) ? result.data.map(normalizeUser) : [],
    };
  }
  const result = await invoke<LikedAuthorsResponse & { data?: unknown[] }>("get_liked_authors", { count });
  return {
    ...result,
    data: Array.isArray(result.data) ? result.data.map(normalizeUser) : [],
  };
}

export async function getCollectedVideos(cursor: number, count: number): Promise<CollectedVideosResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<CollectedVideosResponse & { data?: unknown[] }>("/api/get_collected_videos", {
      method: "POST",
      body: JSON.stringify({ cursor, count }),
      suppressCookieInvalidEvent: true,
    });
    return normalizeFeatureLoginResponse({
      ...result,
      data: Array.isArray(result.data)
        ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
        : [],
    }, "收藏视频");
  }
  const result = await invokeLocal<CollectedVideosResponse & { data?: unknown[] }>("get_collected_videos", {
    cursor,
    count,
  });
  return normalizeFeatureLoginResponse({
    ...result,
    data: Array.isArray(result.data)
      ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
      : [],
  }, "收藏视频");
}

export async function getCollectedMixes(cursor: number, count: number): Promise<CollectedMixesResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<CollectedMixesResponse & { data?: CollectedMixItem[] }>("/api/get_collected_mixes", {
      method: "POST",
      body: JSON.stringify({ cursor, count }),
      suppressCookieInvalidEvent: true,
    });
    return normalizeFeatureLoginResponse({
      ...result,
      data: Array.isArray(result.data) ? result.data : [],
    }, "收藏合集");
  }
  const result = await invokeLocal<CollectedMixesResponse & { data?: CollectedMixItem[] }>("get_collected_mixes", {
    cursor,
    count,
  });
  return normalizeFeatureLoginResponse({
    ...result,
    data: Array.isArray(result.data) ? result.data : [],
  }, "收藏合集");
}

export async function getMixVideos(seriesId: string, cursor: number, count: number): Promise<MixVideosResponse> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<MixVideosResponse & { data?: unknown[] }>("/api/get_mix_videos", {
      method: "POST",
      body: JSON.stringify({ series_id: seriesId, cursor, count }),
    });
    return {
      ...result,
      data: Array.isArray(result.data)
        ? (result.data.map(normalizeLikedVideo).filter(Boolean) as VideoInfo[])
        : [],
    };
  }
  const result = await invoke<MixVideosResponse & { data?: unknown[] }>("get_mix_videos", {
    seriesId,
    series_id: seriesId,
    cursor,
    count,
  });
  return {
    ...result,
    data: Array.isArray(result.data) ? normalizeVideos(result.data) : [],
  };
}

export async function getComments(awemeId: string, count: number, cursor = 0, insertIds = ""): Promise<CommentsResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/get_comments", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, count, cursor, insert_ids: insertIds, insertIds }),
    });
  }
  return invoke("get_comments", { awemeId, count, cursor, insertIds, insert_ids: insertIds });
}

export async function getCommentReplies(
  awemeId: string,
  commentId: string,
  count: number,
  cursor = 0
): Promise<CommentsResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/get_comment_replies", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, comment_id: commentId, count, cursor }),
    });
  }
  return invoke("get_comment_replies", { awemeId, commentId, count, cursor });
}

export async function setCommentLiked(
  awemeId: string,
  commentId: string,
  liked: boolean,
  level = 1
): Promise<CommentDiggResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/comment_digg", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, comment_id: commentId, liked, level }),
    });
  }
  return invoke("set_comment_liked", { awemeId, commentId, liked, level });
}

export async function publishComment(
  awemeId: string,
  text: string,
  replyId = "",
  replyToReplyId = ""
): Promise<PublishCommentResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/comment_publish", {
      method: "POST",
      body: JSON.stringify({ aweme_id: awemeId, text, reply_id: replyId, reply_to_reply_id: replyToReplyId }),
    });
  }
  return invoke("publish_comment", { awemeId, text, replyId, replyToReplyId });
}

export async function getFriendOnlineStatus(
  secUserIds: string[],
  convIds: string[] = [],
  options: { offset?: number; limit?: number } = {}
): Promise<FriendOnlineStatusResponse> {
  const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 20)));
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/get_friend_online_status", {
      method: "POST",
      body: JSON.stringify({
        sec_user_ids: secUserIds,
        secUserIds,
        conv_ids: convIds,
        convIds,
        offset,
        limit,
      }),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("get_friend_online_status", {
    secUserIds,
    sec_user_ids: secUserIds,
    convIds,
    conv_ids: convIds,
    offset,
    limit,
  });
}

export async function getShareFriends(count = 50): Promise<ShareFriendsResponse> {
  const safeCount = Math.max(1, Math.min(100, Math.floor(Number(count) || 50)));
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/get_share_friends", {
      method: "POST",
      body: JSON.stringify({ count: safeCount }),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("get_share_friends", { count: safeCount });
}

export async function sendFriendMessage(payload: {
  toUserId: string | number;
  content: string;
}): Promise<SendFriendMessageResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/send_friend_message", {
      method: "POST",
      body: JSON.stringify({
        to_user_id: payload.toUserId,
        toUserId: payload.toUserId,
        uid: payload.toUserId,
        content: payload.content,
      }),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("send_friend_message", {
    to_user_id: payload.toUserId,
    toUserId: payload.toUserId,
    uid: payload.toUserId,
    content: payload.content,
  });
}

export async function sendFriendVideoShare(payload: {
  toUserId: string | number;
  video: VideoInfo;
}): Promise<SendFriendMessageResponse> {
  const body = {
    to_user_id: payload.toUserId,
    toUserId: payload.toUserId,
    uid: payload.toUserId,
    video: payload.video,
  };
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/send_friend_video_share", {
      method: "POST",
      body: JSON.stringify(body),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("send_friend_video_share", body);
}

export async function sendFriendImageMessage(payload: {
  toUserId: string | number;
  imageDataUrl: string;
  width?: number;
  height?: number;
  fileName?: string;
  mimeType?: string;
}): Promise<SendFriendMessageResponse> {
  const body = {
    to_user_id: payload.toUserId,
    toUserId: payload.toUserId,
    uid: payload.toUserId,
    image_data_url: payload.imageDataUrl,
    imageDataUrl: payload.imageDataUrl,
    width: payload.width,
    height: payload.height,
    file_name: payload.fileName,
    fileName: payload.fileName,
    mime_type: payload.mimeType,
    mimeType: payload.mimeType,
  };
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/send_friend_image_message", {
      method: "POST",
      body: JSON.stringify(body),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("send_friend_image_message", body);
}

export async function getFriendMessageHistory(payload: {
  cursor?: number;
  toUserId?: string;
  conversationId?: string;
  conversationShortId?: string | number;
  conversationType?: string | number;
} = {}): Promise<FriendMessageHistoryResponse> {
  const body = {
    cursor: payload.cursor || 0,
    to_user_id: payload.toUserId,
    toUserId: payload.toUserId,
    conversation_id: payload.conversationId,
    conversationId: payload.conversationId,
    conversation_short_id: payload.conversationShortId,
    conversationShortId: payload.conversationShortId,
    conversation_type: payload.conversationType,
    conversationType: payload.conversationType,
  };
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/get_friend_message_history", {
      method: "POST",
      body: JSON.stringify(body),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal("get_friend_message_history", {
    ...body,
  });
}

export async function getNotices(payload: {
  count?: number;
  maxTime?: number;
  minTime?: number;
  noticeGroup?: number;
} = {}): Promise<NoticesResponse> {
  const body = {
    count: payload.count ?? 10,
    max_time: payload.maxTime ?? 0,
    maxTime: payload.maxTime ?? 0,
    min_time: payload.minTime ?? 0,
    minTime: payload.minTime ?? 0,
    notice_group: payload.noticeGroup ?? 960,
    noticeGroup: payload.noticeGroup ?? 960,
  };
  if (shouldUseBrowserBridge()) {
    return requestJson<NoticesResponse>("/api/get_notices", {
      method: "POST",
      body: JSON.stringify(body),
      suppressCookieInvalidEvent: true,
    });
  }
  return invokeLocal<NoticesResponse>("get_notices", body);
}

export async function getFriendChatState(currentSecUid?: string): Promise<FriendChatStateResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson<FriendChatStateResponse>("/api/friend_chat_state");
  }
  return { success: true, summaries: {}, unreadCounts: {} };
}

export async function saveFriendChatState(payload: {
  summaries?: Record<string, unknown>;
  unreadCounts?: Record<string, number>;
}, currentSecUid?: string): Promise<ApiResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson<ApiResponse>("/api/friend_chat_state", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }
  return { success: true };
}

export async function verifyCookie(): Promise<CookieStatus> {
  const now = Date.now();
  if (lastVerifyCookieResult && (now - lastVerifyCookieTime < 300_000)) {
    return lastVerifyCookieResult;
  }
  if (!verifyCookieInFlight) {
    verifyCookieInFlight = (async () => {
      let result: CookieStatus;
      try {
        if (shouldUseBrowserBridge()) {
          result = await requestJson<CookieStatus>("/api/verify_cookie", {
            suppressCookieInvalidEvent: true,
          });
        } else {
          result = await invokeLocal<CookieStatus>("verify_cookie");
        }
        if (result && result.valid) {
          lastVerifyCookieResult = result;
          lastVerifyCookieTime = Date.now();
        }
        return result;
      } finally {
        verifyCookieInFlight = null;
      }
    })();
  }
  return verifyCookieInFlight;
}

export function clearVerifyCookieCache() {
  lastVerifyCookieResult = null;
  lastVerifyCookieTime = 0;
}

export async function cookieBrowserLogin(timeout?: number, browser?: string, cookie?: string): Promise<{ success: boolean; message: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/cookie/browser_login", {
      method: "POST",
      body: JSON.stringify({ timeout, browser, cookie }),
    });
  }
  return invoke("cookie_browser_login", { timeout, browser, cookie });
}

export async function cancelCookieBrowserLogin(): Promise<{ success: boolean; message: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/cookie/browser_login/cancel", { method: "POST" });
  }
  return invoke("cancel_cookie_browser_login");
}

export async function logoutCookie(): Promise<{ success: boolean; message: string }> {
  if (shouldUseBrowserBridge()) {
    return saveConfig({ cookie: "" });
  }
  return invoke("logout_cookie");
}

export type AccountsResponse = {
  success: boolean;
  accounts: AccountInfo[];
  current_sec_uid: string;
  message?: string;
};

export async function getAccounts(): Promise<AccountsResponse> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/accounts");
  }
  return invoke("get_accounts");
}

export async function refreshAccountProfile(secUid: string): Promise<{ success: boolean; message?: string; account?: AccountInfo; current_sec_uid?: string }> {
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/accounts/refresh_profile", {
      method: "POST",
      body: JSON.stringify({ sec_uid: secUid }),
      suppressCookieInvalidEvent: true,
    });
  }
  return invoke("refresh_account_profile", { secUid, sec_uid: secUid });
}

export async function switchAccount(secUid: string): Promise<{ success: boolean; message: string; nickname?: string; sec_uid?: string }> {
  clearVerifyCookieCache();
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<{ success: boolean; message: string; nickname?: string; sec_uid?: string }>("/api/accounts/switch", {
      method: "POST",
      body: JSON.stringify({ sec_uid: secUid }),
    });
    if (result.success) {
      window.dispatchEvent(new CustomEvent("cookie-login-status", {
        detail: { event: "success", cookie_set: true, sec_uid: result.sec_uid || secUid, nickname: result.nickname },
      }));
    }
    return result;
  }
  const result = await invoke<{ success: boolean; message: string; nickname?: string; sec_uid?: string }>("switch_account", { secUid, sec_uid: secUid });
  if (result.success) {
    window.dispatchEvent(new CustomEvent("cookie-login-status", {
      detail: { event: "success", cookie_set: true, sec_uid: result.sec_uid || secUid, nickname: result.nickname },
    }));
  }
  return result;
}

export async function deleteAccount(secUid: string): Promise<{ success: boolean; message: string }> {
  clearVerifyCookieCache();
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/accounts", {
      method: "DELETE",
      body: JSON.stringify({ sec_uid: secUid }),
    });
  }
  return invoke("delete_account", { secUid, sec_uid: secUid });
}

export async function addAccount(cookie: string): Promise<{ success: boolean; message: string; nickname?: string; sec_uid?: string; avatar_thumb?: string }> {
  clearVerifyCookieCache();
  if (shouldUseBrowserBridge()) {
    return requestJson("/api/accounts/add", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    });
  }
  return invoke("add_account", { cookie });
}

type VerifyBrowserResponse = {
  success: boolean;
  message: string;
  open_url?: string;
};

export async function openVerifyBrowser(targetUrl?: string): Promise<VerifyBrowserResponse> {
  if (shouldUseBrowserBridge()) {
    try {
      return await requestJson<VerifyBrowserResponse>("/api/open_verify_browser", {
        method: "POST",
        body: JSON.stringify({ target_url: targetUrl }),
      });
    } catch (error) {
      return {
        success: false,
        message: getErrorMessage(error, "无法打开应用内验证窗口，请通过桌面版启动后重试"),
        open_url: targetUrl,
      };
    }
  }
  return invoke<VerifyBrowserResponse>("open_verify_browser", { targetUrl, target_url: targetUrl });
}

/**
 * 获取下载历史（数据库/索引中的记录）。
 * 默认最多返回 1000 条；需要全量时显式传 `{ limit: 0 }`（bridge 不带 limit）。
 * browser bridge 路径通过 query 参数做 offset/limit/query/media_type/sort_by 过滤。
 */
export type GetHistoryOptions = {
  offset?: number;
  limit?: number;
  query?: string;
  mediaType?: string;
  sortBy?: string;
  forceRefresh?: boolean;
};

export async function getHistory(options: GetHistoryOptions = {}): Promise<HistoryItem[]> {
  const limit = options.limit ?? 1000;
  if (shouldUseBrowserBridge()) {
    const params = buildDownloadHistoryParams(
      {
        ...options,
        // limit <= 0 表示不截断（兼容清空/按 id 查找等需要全量的场景）
        limit: limit > 0 ? limit : undefined,
        offset: options.offset ?? 0,
      },
      Boolean(options.forceRefresh),
    );
    // 当 limit 为默认 1000 且未显式传入 forceRefresh 时仍带上 limit
    if (limit > 0 && !params.has("limit")) {
      params.set("limit", String(limit));
    }
    if (!params.has("offset") && options.offset === undefined) {
      params.set("offset", "0");
    }
    const result = await requestJson<{ success: boolean; items?: unknown[] }>(
      `/api/download_history?${params.toString()}`
    );
    return (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
  }
  // 原生 get_history 返回的是应用内下载记录（通常远小于磁盘扫描），暂不分页
  const result = await invoke<{ success: boolean; items?: unknown[] }>("get_history");
  let items = (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
  if (limit > 0) {
    const offset = Math.max(0, options.offset ?? 0);
    items = items.slice(offset, offset + limit);
  }
  return items;
}

function buildDownloadHistoryParams(
  options: {
    offset?: number;
    limit?: number;
    forceRefresh?: boolean;
    query?: string;
    mediaType?: string;
    sortBy?: string;
  } = {},
  forceRefresh = false
): URLSearchParams {
  const params = new URLSearchParams();
  if (forceRefresh || options.forceRefresh) params.set("refresh", "1");
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.query?.trim()) params.set("query", options.query.trim());
  if (options.mediaType) params.set("media_type", options.mediaType);
  if (options.sortBy) params.set("sort_by", options.sortBy);
  return params;
}

export async function listDownloadFiles(options?: {
  offset?: number;
  limit?: number;
  forceRefresh?: boolean;
  query?: string;
  mediaType?: string;
  sortBy?: string;
}): Promise<HistoryItem[]> {
  if (shouldUseBrowserBridge()) {
    const params = buildDownloadHistoryParams(options, true);
    const result = await requestJson<{ success: boolean; items?: unknown[] }>(`/api/download_history?${params.toString()}`);
    return (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
  }
  const result = await invoke<{ success: boolean; items?: unknown[] }>("list_download_files", {
    offset: options?.offset,
    limit: options?.limit,
    forceRefresh: options?.forceRefresh,
    query: options?.query,
    mediaType: options?.mediaType,
    media_type: options?.mediaType,
    sortBy: options?.sortBy,
    sort_by: options?.sortBy,
  });
  return (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[];
}

export async function listDownloadFilesPage(options: {
  offset?: number;
  limit?: number;
  forceRefresh?: boolean;
  query?: string;
  mediaType?: string;
  sortBy?: string;
} = {}): Promise<DownloadFilesResult> {
  if (shouldUseBrowserBridge()) {
    const params = buildDownloadHistoryParams(options, true);
    const result = await requestJson<{ success: boolean; items?: unknown[]; total?: number; total_size?: number; latest?: unknown }>(
      `/api/download_history?${params.toString()}`
    );
    return {
      items: (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[],
      total: Number(result.total ?? 0) || 0,
      totalSize: Number(result.total_size ?? 0) || 0,
      latest: normalizeHistoryItem(result.latest) as HistoryItem | null,
    };
  }
  const result = await invoke<{ success: boolean; items?: unknown[]; total?: number; total_size?: number; latest?: unknown }>(
    "list_download_files",
    {
      offset: options.offset,
      limit: options.limit,
      forceRefresh: options.forceRefresh,
      query: options.query,
      mediaType: options.mediaType,
      media_type: options.mediaType,
      sortBy: options.sortBy,
      sort_by: options.sortBy,
    }
  );
  return {
    items: (result.items || []).map(normalizeHistoryItem).filter(Boolean) as HistoryItem[],
    total: Number(result.total ?? 0) || 0,
    totalSize: Number(result.total_size ?? 0) || 0,
    latest: normalizeHistoryItem(result.latest) as HistoryItem | null,
  };
}

export async function clearHistory(): Promise<void> {
  if (shouldUseBrowserBridge()) {
    // 清空历史需要拿到全部路径，显式 limit: 0 表示不截断
    const history = await getHistory({ limit: 0 }).catch(() => []);
    const paths = history.map((item) => item.path).filter(Boolean);
    if (paths.length > 0) {
      await requestJson("/api/download_history/delete", {
        method: "POST",
        body: JSON.stringify({ paths }),
      });
    }
    return;
  }
  return invoke("clear_history");
}

export async function deleteHistory(id: string): Promise<void> {
  if (shouldUseBrowserBridge()) {
    // 按 id 定位条目时可能需要扫描更多记录，显式 limit: 0
    const history = await getHistory({ limit: 0 }).catch(() => []);
    const target = history.find((item) => item.id === id || item.aweme_id === id || item.path === id);
    if (target?.path) {
      await deleteFile(target.path);
    }
    return;
  }
  return invoke("delete_history", { awemeId: id, aweme_id: id });
}

export async function addHistory(entry: Omit<HistoryItem, "id">): Promise<void> {
  if (shouldUseBrowserBridge()) return;
  return invoke("add_history", { entry });
}

export async function openFile(path: string): Promise<void> {
  if (shouldUseBrowserBridge()) {
    await requestJson("/api/download_history/open", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return;
  }
  return invoke("open_file", { path });
}

export async function openDownloadDirectory(): Promise<void> {
  if (shouldUseBrowserBridge()) {
    await requestJson("/api/download_history/open_directory", { method: "POST" });
    return;
  }
  return invoke("open_download_directory");
}

export async function openFileLocation(path: string): Promise<void> {
  if (shouldUseBrowserBridge()) {
    await requestJson("/api/download_history/open_location", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    return;
  }
  return invoke("open_file_location", { path });
}

export async function openExternalUrl(url: string): Promise<void> {
  const target = String(url || "").trim();
  if (!target) return;

  if (isTauriRuntime()) {
    return invoke("open_external_url", { url: target });
  }

  if (window.pywebview?.api?.open_external_url) {
    void window.pywebview.api.open_external_url(target);
    return;
  }

  window.open(target, "_blank", "noopener,noreferrer");
}

export async function deleteFile(path: string): Promise<void> {
  if (shouldUseBrowserBridge()) {
    await requestJson("/api/download_history/delete", {
      method: "POST",
      body: JSON.stringify({ paths: [path] }),
    });
    return;
  }
  return invoke("delete_file", { path });
}

export async function checkFilesExist(paths: string[]): Promise<boolean[]> {
  if (shouldUseBrowserBridge()) {
    const result = await requestJson<{ success: boolean; exists?: boolean[] }>("/api/check_files_exist", {
      method: "POST",
      body: JSON.stringify({ paths }),
    });
    return result.exists || paths.map(() => false);
  }
  return invoke<boolean[]>("check_files_exist", { paths });
}
