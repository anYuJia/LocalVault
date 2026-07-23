import {
  mediaProxyUrl,
  parseLink,
  sendFriendImageMessage,
  sendFriendVideoMessage,
  type AiInteractionConfig,
} from "@/lib/tauri";
import { createVideoPosterDataUrl } from "@/lib/video-poster";

const SHARE_URL = /https?:\/\/[^\s<>"，。！？；、]+|www\.[^\s<>"，。！？；、]+/i;
const NATIVE_MEDIA_SEND_SPACING_MS = 1200;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function imageDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("读取下载的图片失败"));
    reader.readAsDataURL(blob);
  });
}

function sharedCardItemId(value: string) {
  try {
    const root = JSON.parse(value) as unknown;
    const visit = (item: unknown, depth = 0): string => {
      if (!item || typeof item !== "object" || depth > 4) return "";
      if (Array.isArray(item)) {
        for (const child of item) {
          const found = visit(child, depth + 1);
          if (found) return found;
        }
        return "";
      }
      const record = item as Record<string, unknown>;
      for (const key of ["itemId", "item_id", "aweme_id", "awemeId", "share_id"]) {
        const candidate = String(record[key] || "").trim();
        if (/^\d{10,}$/.test(candidate)) return candidate;
      }
      for (const child of Object.values(record)) {
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return "";
    };
    return visit(root);
  } catch {
    return "";
  }
}

function sharedUrl(value: string) {
  const direct = value.match(SHARE_URL)?.[0].replace(/[，。！？；、,.!;]+$/, "");
  if (direct && /(?:^https?:\/\/)?(?:[^/]+\.)?douyin\.com\//i.test(direct)) return direct;
  const itemId = sharedCardItemId(value);
  return itemId ? `https://www.douyin.com/video/${itemId}` : "";
}

export function isSharedWorkPayload(value: string) {
  return Boolean(sharedUrl(value));
}

type ParsedSharedVideo = NonNullable<Awaited<ReturnType<typeof parseLink>>["video"]>;

type ReturnMediaItem = {
  type: "image" | "video";
  url: string;
  fallbackUrls: string[];
};

function normalizeReturnMediaType(value: unknown): ReturnMediaItem["type"] | null {
  const type = String(value || "").trim().toLowerCase().replace(/-/g, "_");
  if (type === "image" || type === "images" || type === "photo") return "image";
  // A live photo is uploaded as an IM video.  Its optional still-image part
  // is intentionally not duplicated in the logical return media sequence.
  if (type === "video" || type === "live_photo" || type === "livephoto" || type === "live") return "video";
  return null;
}

function cleanReturnMediaItem(type: unknown, url: unknown, fallbackUrls: unknown): ReturnMediaItem | null {
  const normalizedType = normalizeReturnMediaType(type);
  const primaryUrl = String(url || "").trim();
  if (!normalizedType || !primaryUrl) return null;
  const seen = new Set<string>([primaryUrl]);
  const candidates = Array.isArray(fallbackUrls) ? fallbackUrls : [];
  const cleanedFallbackUrls = candidates.flatMap((candidate) => {
    const text = String(candidate || "").trim();
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [text];
  });
  return { type: normalizedType, url: primaryUrl, fallbackUrls: cleanedFallbackUrls };
}

/**
 * Prefer the backend-provided logical source-media sequence.  Its order maps
 * one-to-one to the original gallery slots, unlike legacy image/live-photo
 * fields that intentionally expand a Live Photo into a still image plus video
 * for downloader workflows.
 */
function collectReturnMediaItems(video: ParsedSharedVideo): ReturnMediaItem[] {
  const hasExplicitReturnMedia = Array.isArray(video.return_media_urls);
  const typedItems = (video.return_media_urls || [])
    .map((item) => cleanReturnMediaItem(item.type, item.url, item.fallback_urls))
    .filter(Boolean) as ReturnMediaItem[];
  // An explicit empty list means the backend inspected the source slots and
  // found no safely downloadable media. Do not fall back to their posters.
  if (hasExplicitReturnMedia) return typedItems;

  // Compatibility for older Rust/Python backends that do not yet expose
  // `return_media_urls`. Keep their historical image-album behavior rather
  // than turning one legacy Live Photo into duplicate image/video messages.
  const imageUrls = (video.image_urls || video.images || [])
    .map((url) => String(url || "").trim())
    .filter(Boolean);
  if (imageUrls.length > 0) {
    return imageUrls.map((url) => ({ type: "image" as const, url, fallbackUrls: [] }));
  }

  const livePhotoUrls = (video.live_photo_urls || video.live_photos || [])
    .map((url) => String(url || "").trim())
    .filter(Boolean);
  if (livePhotoUrls.length > 0) {
    return livePhotoUrls.map((url) => ({ type: "video" as const, url, fallbackUrls: [] }));
  }

  const videoUrl = String(video.video?.play_addr || video.video?.download_addr || "").trim();
  return videoUrl ? [{ type: "video", url: videoUrl, fallbackUrls: [] }] : [];
}

/**
 * Return a shared work to its sender. Image albums are downloaded through the
 * local media proxy, uploaded to IM one by one, then released from memory.
 * Videos follow the same download → binary upload → release flow; no work card
 * is sent back to the friend.
 */
export async function autoReturnSharedMedia(
  senderUid: string,
  incomingText: string,
  config: AiInteractionConfig,
  options: { shouldContinue?: () => boolean } = {},
) {
  const shouldContinue = options.shouldContinue || (() => true);
  const cancelled = () => ({ handled: true, sent: 0, skipped: "account_changed" });
  if (!shouldContinue()) return cancelled();
  if (!config.auto_return_shared_media || !senderUid) return { handled: false, sent: 0, skipped: "disabled" };
  const link = sharedUrl(incomingText);
  if (!link) return { handled: false, sent: 0, skipped: "no_link" };
  const parsed = await parseLink(link);
  if (!shouldContinue()) return cancelled();
  const video = parsed.video;
  if (!parsed.success || !video) throw new Error(parsed.message || "解析分享链接失败");
  const maxBytes = Math.max(1, Number(config.auto_return_shared_max_size_mb || 20)) * 1024 * 1024;
  const maxMedia = Math.max(1, Number(config.auto_return_shared_max_media_count || 9));
  const sourceMediaItems = collectReturnMediaItems(video);
  if (sourceMediaItems.length === 0) return { handled: true, sent: 0, skipped: "no_media" };

  const skippedImages = sourceMediaItems.filter((item) => item.type === "image" && !config.auto_return_shared_allow_images).length;
  const skippedVideos = sourceMediaItems.filter((item) => item.type === "video" && !config.auto_return_shared_allow_videos).length;
  // Apply the media-count cap after per-type permission filtering. Disabled
  // images must not consume a slot that could otherwise return a later video.
  const mediaItems = sourceMediaItems
    .filter((item) => (item.type === "image" ? config.auto_return_shared_allow_images : config.auto_return_shared_allow_videos))
    .slice(0, maxMedia);
  if (mediaItems.length === 0) {
    if (skippedImages > 0 && skippedVideos === 0) return { handled: true, sent: 0, skipped: "images_disabled" };
    if (skippedVideos > 0 && skippedImages === 0) return { handled: true, sent: 0, skipped: "videos_disabled" };
    return { handled: true, sent: 0, skipped: "media_disabled" };
  }

  let sent = 0;
  let skippedBySize = 0;

  for (let index = 0; index < mediaItems.length; index += 1) {
    const item = mediaItems[index];
    if (!shouldContinue()) return cancelled();

    let response: Response | null = null;
    let lastDownloadError = "";
    for (const candidateUrl of [item.url, ...item.fallbackUrls]) {
      if (!shouldContinue()) return cancelled();
      try {
        const candidateResponse = await fetch(mediaProxyUrl(candidateUrl, item.type));
        if (candidateResponse.ok) {
          response = candidateResponse;
          break;
        }
        lastDownloadError = `HTTP ${candidateResponse.status}`;
      } catch (error) {
        lastDownloadError = error instanceof Error ? error.message : "网络请求失败";
      }
    }
    if (!shouldContinue()) return cancelled();
    if (!response) {
      const label = item.type === "image" ? "图片" : "视频";
      throw new Error(`下载第 ${index + 1} 个${label}失败${lastDownloadError ? `: ${lastDownloadError}` : ""}`);
    }

    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > maxBytes) {
      skippedBySize += 1;
      continue;
    }
    const blob = await response.blob();
    if (!shouldContinue()) return cancelled();
    if (!blob.size || blob.size > maxBytes) {
      skippedBySize += 1;
      continue;
    }
    const dataUrl = await imageDataUrl(blob);
    if (!shouldContinue()) return cancelled();

    if (item.type === "image") {
      const result = await sendFriendImageMessage({
        toUserId: senderUid,
        imageDataUrl: dataUrl,
        fileName: `${video.aweme_id || "shared"}-${index + 1}.${blob.type.includes("png") ? "png" : "jpg"}`,
        mimeType: blob.type || "image/jpeg",
      });
      if (!result.success) throw new Error(result.message || `发送第 ${index + 1} 张图片失败`);
    } else {
      const coverDataUrl = await createVideoPosterDataUrl(blob);
      if (!shouldContinue()) return cancelled();
      const result = await sendFriendVideoMessage({
        toUserId: senderUid,
        videoDataUrl: dataUrl,
        coverDataUrl,
        fileName: `${video.aweme_id || "shared"}-${index + 1}.mp4`,
        mimeType: blob.type || "video/mp4",
      });
      if (!result.success) throw new Error(result.message || `发送第 ${index + 1} 个视频失败`);
    }
    sent += 1;
    if (index < mediaItems.length - 1) {
      await sleep(NATIVE_MEDIA_SEND_SPACING_MS);
      if (!shouldContinue()) return cancelled();
    }
  }

  if (sent > 0) return { handled: true, sent, skipped: "" };
  if (skippedBySize > 0) return { handled: true, sent, skipped: "size_limit" };
  return { handled: true, sent, skipped: "no_media" };
}
