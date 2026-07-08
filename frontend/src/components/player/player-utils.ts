import type { Variants } from "framer-motion";
import { mediaProxyUrl, type CommentInfo } from "@/lib/tauri";

export const IMAGE_DURATION_SECONDS = 1.5;
export const LOAD_MORE_THRESHOLD = 8;
export const PLAYER_VIDEO_MAX_AUTO_RETRIES = 1;
export const PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS = 450;
export const PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS = 1400;
export const PLAYER_VIDEO_LOAD_TIMEOUT_MS = 18_000;
export const PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS = 1800;
export const PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS = 10;
export const MAX_PRELOADED_MEDIA_NODES = 8;
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export const WHEEL_VIDEO_SWITCH_THRESHOLD = 80;
export const WHEEL_VIDEO_SWITCH_LOCK_MS = 520;
export const WHEEL_IDLE_RESET_MS = 160;
export const PLAYER_PANEL_CLOSE_DELAY_MS = 220;
export const PROGRESS_PREVIEW_WIDTH = 184;
export const PROGRESS_PREVIEW_HEIGHT = 104;
export const PROGRESS_PREVIEW_SAMPLE_RATIOS = [0.08, 0.22, 0.38, 0.55, 0.72, 0.88] as const;

export type PlayerPanel = "volume" | "rate" | "quality" | "download" | "music" | "share";

export const mediaMotionVariants: Variants = {
  enter: (direction = 0) => ({
    x: direction === 0 ? 0 : `${direction * 100}%`,
  }),
  center: {
    x: 0,
  },
  exit: (direction = 0) => ({
    x: direction === 0 ? 0 : `${direction * -100}%`,
  }),
};

// 模块级别的会话唯一缓存击碎器：只在页面加载时生成一次，在整个会话中保持稳定，
// 避免组件重新渲染时生成新 URL 导致视频元素被反复重置。
export const SESSION_CACHE_BUSTER = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

export function playerMediaProxyUrl(url: string | null | undefined, mediaType: "video" | "image" | "audio", retryKey = 0): string {
  const proxied = mediaProxyUrl(url, mediaType);
  if (!proxied) return "";
  if (mediaType === "video" || mediaType === "audio") {
    const sep = proxied.includes("?") ? "&" : "?";
    const buster = retryKey > 0 ? `${SESSION_CACHE_BUSTER}_r${retryKey}` : SESSION_CACHE_BUSTER;
    return `${proxied}${sep}t=${buster}`;
  }
  if (retryKey <= 0) return proxied;
  return `${proxied}${proxied.includes("?") ? "&" : "?"}player_retry=${encodeURIComponent(String(retryKey))}`;
}

export function finiteMediaTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function readMediaDuration(node: HTMLMediaElement): number {
  const duration = finiteMediaTime(node.duration);
  if (duration > 0) return duration;

  const ranges = node.seekable;
  if (!ranges.length) return 0;
  return finiteMediaTime(ranges.end(ranges.length - 1));
}

export function formatCommentTime(createTime: number): string {
  const timestamp = Number(createTime || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const ms = timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1000;
  const diffSeconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSeconds < 60) return "刚刚";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}天前`;
  return new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

export type CommentRepliesState = Record<
  string,
  {
    items: CommentInfo[];
    cursor: number;
    hasMore: boolean;
    loading: boolean;
    error: string;
    total: number;
    loaded: boolean;
  }
>;

export type CommentReplyTarget = {
  replyId: string;
  replyToReplyId: string;
  nickname: string;
} | null;

export function getDocumentVideoNode(reference: HTMLElement | null): HTMLVideoElement | null {
  return reference?.ownerDocument.querySelector("video") || null;
}

export function releaseMediaElement(node: HTMLMediaElement | null | undefined) {
  if (!node) return;
  node.pause();
  node.removeAttribute("src");
  for (const source of Array.from(node.querySelectorAll("source"))) {
    source.removeAttribute("src");
  }
  try {
    node.load();
  } catch {
    // Ignore partial media implementations while the element is unmounting.
  }
}

export function releaseScopedMediaElements(reference: HTMLElement | null | undefined) {
  if (!reference) return;
  for (const node of Array.from(reference.querySelectorAll<HTMLMediaElement>("video, audio"))) {
    releaseMediaElement(node);
  }
}

export function applyPlaybackRateToNode(node: HTMLMediaElement | null, rate: number) {
  if (!node) return;
  const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  try {
    if (Math.abs(node.defaultPlaybackRate - safeRate) > 0.001) {
      node.defaultPlaybackRate = safeRate;
    }
  } catch {
    // Some embedded engines expose a partial media API while loading.
  }
  try {
    if (Math.abs(node.playbackRate - safeRate) > 0.001) {
      node.playbackRate = safeRate;
    }
  } catch {
    // Keep playback usable if the current media backend rejects speed changes.
  }
}

export function resolveMediaDirection(currentIndex: number, requestedIndex: number, total: number): number {
  if (total <= 1) return 0;
  if (requestedIndex >= total) return 1;
  if (requestedIndex < 0) return -1;
  if (currentIndex === requestedIndex) return 0;
  return requestedIndex > currentIndex ? 1 : -1;
}

export function normalizeWheelDelta(event: React.WheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

export function isKeyboardInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}
