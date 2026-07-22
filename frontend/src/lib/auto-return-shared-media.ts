import {
  mediaProxyUrl,
  parseLink,
  sendFriendImageMessage,
  sendFriendVideoShare,
  type AiInteractionConfig,
} from "@/lib/tauri";

const SHARE_URL = /https?:\/\/[^\s<>"，。！？；、]+|www\.[^\s<>"，。！？；、]+/i;

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

function videoSizeBytes(video: NonNullable<Awaited<ReturnType<typeof parseLink>>["video"]>) {
  return Number(video.video?.bit_rate?.find((item) => Number(item.data_size) > 0)?.data_size || 0);
}

/**
 * Return a shared work to its sender. Image albums are downloaded through the
 * local media proxy, uploaded to IM one by one, then released from memory. The
 * currently supported Douyin IM API has no binary-video upload endpoint, so a
 * permitted video is returned as its official work card instead.
 */
export async function autoReturnSharedMedia(
  senderUid: string,
  incomingText: string,
  config: AiInteractionConfig,
) {
  if (!config.auto_return_shared_media || !senderUid) return { handled: false, sent: 0, skipped: "disabled" };
  const link = sharedUrl(incomingText);
  if (!link) return { handled: false, sent: 0, skipped: "no_link" };
  const parsed = await parseLink(link);
  const video = parsed.video;
  if (!parsed.success || !video) throw new Error(parsed.message || "解析分享链接失败");
  const maxBytes = Math.max(1, Number(config.auto_return_shared_max_size_mb || 20)) * 1024 * 1024;
  const maxMedia = Math.max(1, Number(config.auto_return_shared_max_media_count || 9));
  const imageUrls = (video.image_urls || video.images || []).filter(Boolean).slice(0, maxMedia);

  if (imageUrls.length > 0 || video.is_image) {
    if (!config.auto_return_shared_allow_images) return { handled: true, sent: 0, skipped: "images_disabled" };
    let sent = 0;
    for (let index = 0; index < imageUrls.length; index += 1) {
      const response = await fetch(mediaProxyUrl(imageUrls[index], "image"));
      if (!response.ok) throw new Error(`下载图集第 ${index + 1} 张失败`);
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (declaredSize > maxBytes) continue;
      const blob = await response.blob();
      if (!blob.size || blob.size > maxBytes) continue;
      const dataUrl = await imageDataUrl(blob);
      try {
        const result = await sendFriendImageMessage({
          toUserId: senderUid,
          imageDataUrl: dataUrl,
          fileName: `${video.aweme_id || "shared"}-${index + 1}.${blob.type.includes("png") ? "png" : "jpg"}`,
          mimeType: blob.type,
        });
        if (!result.success) throw new Error(result.message || `发送图集第 ${index + 1} 张失败`);
        sent += 1;
      } finally {
        // dataUrl/blob only live in this iteration and are released before the next item.
      }
    }
    return { handled: true, sent, skipped: sent ? "" : "size_limit" };
  }

  if (!config.auto_return_shared_allow_videos) return { handled: true, sent: 0, skipped: "videos_disabled" };
  const size = videoSizeBytes(video);
  if (size > maxBytes) return { handled: true, sent: 0, skipped: "size_limit" };
  const result = await sendFriendVideoShare({ toUserId: senderUid, video });
  if (!result.success) throw new Error(result.message || "回传视频作品失败");
  return { handled: true, sent: 1, skipped: "video_card" };
}
