// Shared payload normalization for the Python and Rust frontends.
// Keep this file byte-for-byte aligned in both apps until it moves into a real shared package.

import type {
  BitRateInfo,
  HistoryItem,
  Statistics,
  UserInfo,
  VideoData,
  VideoInfo,
  VideoMediaUrl,
  VideoStatus,
} from "./contracts";

type LikedVideoMediaUrl = VideoMediaUrl;

interface LikedVideoAuthorRaw {
  nickname?: string;
  sec_uid?: string;
  avatar_thumb?: string;
}

interface LikedVideoItemRaw {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  digg_count?: number;
  comment_count?: number;
  share_count?: number;
  cover_url?: string;
  duration?: number;
  duration_unit?: string | null;
  media_type?: string;
  raw_media_type?: string | number | null;
  status?: VideoStatus | null;
  media_urls?: LikedVideoMediaUrl[];
  bgm_url?: string | null;
  is_liked?: boolean;
  is_collected?: boolean;
  collect_stat?: unknown;
  collect_status?: unknown;
  statistics?: Partial<Statistics>;
  video?: Partial<VideoData>;
  author?: LikedVideoAuthorRaw;
}

function buildEmptyVideoData(): VideoData {
  return {
    preview_addr: null,
    play_addr: "",
    play_addr_h264: null,
    play_addr_lowbr: null,
    download_addr: null,
    cover: "",
    dynamic_cover: "",
    origin_cover: "",
    width: 0,
    height: 0,
    duration: 0,
    duration_unit: null,
    ratio: "",
    bit_rate: null,
  };
}

function buildEmptyStatistics(): Statistics {
  return {
    play_count: 0,
    digg_count: 0,
    comment_count: 0,
    share_count: 0,
    collect_count: 0,
    forward_count: 0,
  };
}

function normalizeStatus(value: unknown): VideoStatus | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  return {
    is_delete: Boolean(source.is_delete),
    private_status: Number(source.private_status || 0),
    review_status: Number(source.review_status || 0),
    with_goods: Boolean(source.with_goods),
    is_prohibited: Boolean(source.is_prohibited),
  };
}

function isUnavailableStatus(status: VideoStatus | null | undefined): boolean {
  if (!status) return false;
  return Boolean(status.is_delete || status.is_prohibited || Number(status.private_status || 0) !== 0);
}

function boolish(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return false;
}

function hasPlayableMedia(video: VideoInfo): boolean {
  if (!video.aweme_id.trim()) return false;
  if (isUnavailableStatus(video.status)) return false;
  if (video.video.play_addr || video.video.preview_addr || video.video.download_addr) return true;
  if (video.media_urls?.some((item) => item.url?.trim())) return true;
  if (video.image_urls?.some((url) => url.trim()) || video.images?.some((url) => url.trim())) return true;
  if (video.live_photo_urls?.some((url) => url.trim()) || video.live_photos?.some((url) => url.trim())) return true;
  return false;
}

function extractUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of [
      "url_list",
      "url",
      "main_url",
      "backup_url",
      "fallback_url",
      "play_addr",
      "play_url",
      "download_addr",
      "download_url",
      "display_url",
      "uri",
    ]) {
      const nested = record[key];
      if (nested === undefined || nested === value) continue;
      const url = extractUrl(nested);
      if (key === "uri" && !/^https?:\/\//i.test(url)) continue;
      if (url) return url;
    }
  }
  return "";
}

function normalizeBitRates(value: unknown): BitRateInfo[] | null {
  if (!Array.isArray(value)) return null;

  const bitRates = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const playAddr = extractUrl(record.play_addr);
      const playAddrH264 = extractUrl(record.play_addr_h264);
      if (!playAddr && !playAddrH264) return null;
      return {
        gear_name: String(record.gear_name || ""),
        bit_rate: Number(record.bit_rate || 0),
        quality_type: Number(record.quality_type || 0),
        is_h265: Boolean(record.is_h265),
        data_size: Number(record.data_size || 0),
        width: Number(record.width || 0),
        height: Number(record.height || 0),
        play_addr: playAddr || null,
        play_addr_h264: playAddrH264 || null,
      };
    })
    .filter(Boolean) as BitRateInfo[];

  return bitRates.length > 0 ? bitRates : null;
}

function normalizeMediaType(type: unknown, fallback = "video"): string {
  const normalized = String(type || fallback).trim().toLowerCase();
  if (normalized === "livephoto") return "live_photo";
  if (normalized === "live-photo") return "live_photo";
  if (normalized === "image" || normalized === "live_photo" || normalized === "video" || normalized === "audio") {
    return normalized;
  }
  return fallback;
}

function normalizeMediaUrls(value: unknown): VideoMediaUrl[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        const url = extractUrl(item);
        return url ? { type: "video", url } : null;
      }
      if (typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const url = extractUrl(record.url || record.play_url || record.play_addr || record.url_list);
      if (!url) return null;
      return {
        type: normalizeMediaType(record.type),
        url,
      };
    })
    .filter(Boolean) as VideoMediaUrl[];
}

function uniqueMediaUrls(urls: VideoMediaUrl[]): VideoMediaUrl[] {
  const seen = new Set<string>();
  const items: VideoMediaUrl[] = [];

  for (const item of urls) {
    const url = (item.url || "").trim();
    if (!url || seen.has(`${item.type || "video"}::${url}`)) continue;
    seen.add(`${item.type || "video"}::${url}`);
    items.push({
      type: normalizeMediaType(item.type),
      url,
    });
  }

  return items;
}

function normalizeMediaUrlsFromVideo(
  explicitMediaUrls: VideoMediaUrl[],
  livePhotoUrls: string[],
  imageUrls: string[],
  fallbackVideoUrl: string,
  mediaType: string
): VideoMediaUrl[] {
  if (explicitMediaUrls.length > 0) {
    return uniqueMediaUrls(explicitMediaUrls);
  }

  const items: VideoMediaUrl[] = [];

  for (const url of livePhotoUrls) {
    if (!url.trim()) continue;
    items.push({ type: "live_photo", url });
  }

  for (const url of imageUrls) {
    if (!url.trim()) continue;
    items.push({ type: "image", url });
  }

  if (items.length === 0 && fallbackVideoUrl.trim()) {
    items.push({
      type: normalizeMediaType(mediaType, "video"),
      url: fallbackVideoUrl.trim(),
    });
  }

  return uniqueMediaUrls(items);
}

export function normalizeLikedVideo(item: unknown): VideoInfo | null {
  if (!item || typeof item !== "object") return null;

  const candidate = item as Partial<VideoInfo> & LikedVideoItemRaw;
  if (candidate.aweme_id && candidate.video) {
    return normalizeVideo(candidate);
  }

  const mediaUrls = uniqueMediaUrls(normalizeMediaUrls(candidate.media_urls));
  const imageUrls = mediaUrls.filter((media) => media.type === "image").map((media) => media.url);
  const livePhotoUrls = mediaUrls.filter((media) => media.type === "live_photo").map((media) => media.url);
  const primaryVideoUrl = mediaUrls.find((media) => media.type === "video")?.url || "";
  const cover = candidate.cover_url || imageUrls[0] || "";
  const mediaType = String(candidate.media_type || (imageUrls.length > 0 ? "image" : "video"));
  const isImage = mediaType === "image" || mediaType === "mixed" || mediaType === "live_photo";
  const status = normalizeStatus(candidate.status);

  const normalized: VideoInfo = {
    aweme_id: candidate.aweme_id || "",
    desc: candidate.desc || "",
    create_time: candidate.create_time || 0,
    author: {
      uid: "",
      sec_uid: candidate.author?.sec_uid || "",
      nickname: candidate.author?.nickname || "",
      avatar_thumb: candidate.author?.avatar_thumb || "",
      avatar_medium: candidate.author?.avatar_thumb || "",
      signature: "",
      follower_count: 0,
      following_count: 0,
      aweme_count: 0,
      favoriting_count: 0,
      is_follow: false,
      follow_status: 0,
      verify_status: 0,
      unique_id: "",
    },
    video: {
      ...buildEmptyVideoData(),
      play_addr: primaryVideoUrl || livePhotoUrls[0] || "",
      dash_addr: candidate.video?.dash_addr || null,
      audio_addr: candidate.video?.audio_addr || null,
      download_addr: primaryVideoUrl || livePhotoUrls[0] || null,
      cover,
      dynamic_cover: cover,
      origin_cover: cover,
      duration: Number(candidate.duration || 0),
      duration_unit: candidate.duration_unit || candidate.video?.duration_unit || null,
    },
    statistics: {
      ...buildEmptyStatistics(),
      play_count: Number(candidate.statistics?.play_count || 0),
      digg_count: Number(candidate.digg_count || candidate.statistics?.digg_count || 0),
      comment_count: Number(candidate.comment_count || candidate.statistics?.comment_count || 0),
      share_count: Number(candidate.share_count || candidate.statistics?.share_count || 0),
      collect_count: Number(candidate.statistics?.collect_count || 0),
      forward_count: Number(candidate.statistics?.forward_count || 0),
    },
    image_urls: imageUrls.length > 0 ? imageUrls : null,
    images: imageUrls.length > 0 ? imageUrls : null,
    live_photo_urls: livePhotoUrls.length > 0 ? livePhotoUrls : null,
    live_photos: livePhotoUrls.length > 0 ? livePhotoUrls : null,
    has_live_photo: livePhotoUrls.length > 0,
    is_liked: Boolean(candidate.is_liked),
    is_collected: boolish(candidate.is_collected ?? candidate.collect_stat ?? candidate.collect_status),
    is_image: isImage,
    media_type: mediaType,
    status,
    media_urls: mediaUrls.length > 0 ? mediaUrls : null,
    bgm_url: candidate.bgm_url || null,
    cover_url: cover || null,
    music: candidate.bgm_url
      ? {
          title: "抖音原声",
          author: candidate.author?.nickname || "",
          play_url: candidate.bgm_url,
          cover,
          duration: 0,
        }
      : null,
  };

  return hasPlayableMedia(normalized) ? normalized : null;
}

function normalizeCount(value: unknown): number {
  if (typeof value === "string") {
    const text = value.trim().replace(/,/g, "");
    const match = text.match(/^(\d+(?:\.\d+)?)([wW万kK千])?$/);
    if (match) {
      const unit = match[2]?.toLowerCase();
      const multiplier = unit === "w" || unit === "万" ? 10000 : unit === "k" || unit === "千" ? 1000 : 1;
      return Math.round(Number(match[1]) * multiplier);
    }
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

export function normalizeUser(user: unknown): UserInfo {
  const source = user && typeof user === "object" ? (user as Partial<UserInfo> & Record<string, unknown>) : {};
  return {
    uid: source.uid || "",
    sec_uid: source.sec_uid || "",
    nickname: source.nickname || "",
    avatar_thumb: source.avatar_thumb || source.avatar_medium || source.avatar_larger || "",
    avatar_medium: source.avatar_medium || source.avatar_thumb || source.avatar_larger || "",
    avatar_larger: source.avatar_larger || source.avatar_medium || source.avatar_thumb || "",
    signature: source.signature || "",
    follower_count: normalizeCount(source.follower_count),
    following_count: normalizeCount(source.following_count),
    total_favorited: normalizeCount(source.total_favorited),
    aweme_count: normalizeCount(source.aweme_count ?? source.aweme_count_str ?? source.aweme_count_text ?? source.work_count),
    favoriting_count: normalizeCount(source.favoriting_count),
    is_follow: source.is_follow || false,
    follow_status: source.follow_status || 0,
    unique_id: source.unique_id || "",
    verify_status: source.verify_status || 0,
  };
}

export function normalizeVideo(video: unknown): VideoInfo | null {
  if (!video || typeof video !== "object") return null;

  const source = video as Record<string, unknown>;
  const author = normalizeUser(source.author || source.user || {});
  const stats = (source.statistics && typeof source.statistics === "object")
    ? (source.statistics as Partial<Statistics>)
    : {};
  const videoRecord = source.video && typeof source.video === "object" ? (source.video as Record<string, unknown>) : {};
  const topLevelMediaUrls = normalizeMediaUrls(source.media_urls);
  const nestedMediaUrls = normalizeMediaUrls(videoRecord.media_urls);
  const mediaUrls = uniqueMediaUrls(topLevelMediaUrls.length > 0 ? topLevelMediaUrls : nestedMediaUrls);
  const imageUrls = uniqueMediaUrls([
    ...(
      Array.isArray(source.image_urls)
        ? (source.image_urls as unknown[]).map((item) => extractUrl(item)).filter(Boolean)
        : Array.isArray(source.images)
          ? (source.images as unknown[]).map((item) => extractUrl(item)).filter(Boolean)
          : []
    ).map((url) => ({ type: "image", url })),
    ...mediaUrls.filter((item) => item.type === "image"),
  ]).map((item) => item.url);
  const livePhotoUrls = uniqueMediaUrls([
    ...(
      Array.isArray(source.live_photo_urls)
        ? (source.live_photo_urls as unknown[]).map((item) => extractUrl(item)).filter(Boolean)
        : Array.isArray(source.live_photos)
          ? (source.live_photos as unknown[]).map((item) => extractUrl(item)).filter(Boolean)
          : []
    ).map((url) => ({ type: "live_photo", url })),
    ...mediaUrls.filter((item) => item.type === "live_photo"),
  ]).map((item) => item.url);
  const primaryMediaUrl =
    mediaUrls.find((item) => item.type === "video")?.url ||
    mediaUrls.find((item) => item.type === "live_photo")?.url ||
    "";
  const cover = String(
    source.cover_url ||
      videoRecord.cover ||
      videoRecord.origin_cover ||
      videoRecord.dynamic_cover ||
      imageUrls[0] ||
      livePhotoUrls[0] ||
      ""
  );
  const playAddr = extractUrl(
    videoRecord.play_addr ||
    source.play_addr ||
    source.video_url ||
    source.url
  ) || primaryMediaUrl;
  const playAddrH264 = extractUrl(videoRecord.play_addr_h264 || source.play_addr_h264);
  const playAddrLowbr = extractUrl(videoRecord.play_addr_lowbr || source.play_addr_lowbr);
  const downloadAddr = extractUrl(videoRecord.download_addr || source.download_addr);
  const bitRates = normalizeBitRates(videoRecord.bit_rate || source.bit_rate);
  const previewAddr = extractUrl(
    source.preview_addr ||
      source.play_addr_lowbr ||
      source.play_addr_h264 ||
      videoRecord.preview_addr ||
      videoRecord.play_addr_lowbr ||
      videoRecord.play_addr_h264
  );
  const duration = Number(source.duration || videoRecord.duration || 0);
  const durationUnit = String(videoRecord.duration_unit || source.duration_unit || "").trim() || null;
  const musicSource = source.music && typeof source.music === "object" ? (source.music as Record<string, unknown>) : null;
  const musicPlayUrl = extractUrl(
    musicSource?.play_url ||
      source.music_url ||
      source.music_play_url ||
      source.music_play_addr ||
      source.bgm_url
  );
  const mediaType = String(source.media_type || source.raw_media_type || (imageUrls.length > 0 ? "image" : "video"));
  const isImage = Boolean(source.is_image || mediaType === "image" || mediaType === "mixed" || mediaType === "live_photo" || imageUrls.length > 0);
  const rawMediaType =
    typeof source.raw_media_type === "string" || typeof source.raw_media_type === "number"
      ? source.raw_media_type
      : null;
  const normalizedMediaUrls = normalizeMediaUrlsFromVideo(
    mediaUrls,
    livePhotoUrls,
    imageUrls,
    playAddr || previewAddr || livePhotoUrls[0] || "",
    mediaType
  );
  const status = normalizeStatus(source.status);

  const normalized: VideoInfo = {
    aweme_id: String(source.aweme_id || ""),
    desc: String(source.desc || ""),
    create_time: Number(source.create_time || 0),
    author,
    video: {
      preview_addr: previewAddr || null,
      play_addr: playAddr || previewAddr || livePhotoUrls[0] || "",
      dash_addr: extractUrl(videoRecord.dash_addr) || null,
      audio_addr: extractUrl(videoRecord.audio_addr) || null,
      play_addr_h264: playAddrH264 || null,
      play_addr_lowbr: playAddrLowbr || null,
      download_addr: downloadAddr || playAddr || previewAddr || livePhotoUrls[0] || null,
      cover,
      dynamic_cover: String(source.dynamic_cover || cover),
      origin_cover: String(source.origin_cover || cover),
      width: Number(videoRecord.width || source.width || 0),
      height: Number(videoRecord.height || source.height || 0),
      duration,
      duration_unit: durationUnit,
      ratio: String(videoRecord.ratio || source.ratio || ""),
      bit_rate: bitRates,
    },
    statistics: {
      play_count: Number(stats.play_count || 0),
      digg_count: Number(source.digg_count || stats.digg_count || 0),
      comment_count: Number(source.comment_count || stats.comment_count || 0),
      share_count: Number(source.share_count || stats.share_count || 0),
      collect_count: Number(source.collect_count || stats.collect_count || 0),
      forward_count: Number(stats.forward_count || 0),
    },
    image_urls: imageUrls.length > 0 ? imageUrls : null,
    images: imageUrls.length > 0 ? imageUrls : null,
    live_photo_urls: livePhotoUrls.length > 0 ? livePhotoUrls : null,
    live_photos: livePhotoUrls.length > 0 ? livePhotoUrls : null,
    has_live_photo: Boolean(source.has_live_photo || livePhotoUrls.length > 0),
    is_liked: Boolean(source.is_liked),
    is_collected: boolish(source.is_collected ?? source.collect_stat ?? source.collect_status),
    is_image: isImage,
    media_type: mediaType,
    raw_media_type: rawMediaType,
    status,
    media_urls: normalizedMediaUrls.length > 0 ? normalizedMediaUrls : null,
    bgm_url: musicPlayUrl || null,
    cover_url: cover || null,
    music: musicPlayUrl
      ? {
          title: String(musicSource?.title || source.music_title || ""),
          author: String(musicSource?.author || source.music_author || ""),
          play_url: musicPlayUrl,
          cover: String(musicSource?.cover || musicSource?.cover_thumb || ""),
          duration: Number(musicSource?.duration || source.music_duration || 0),
        }
      : null,
  };

  return hasPlayableMedia(normalized) ? normalized : null;
}

export function normalizeVideos(videos: unknown): VideoInfo[] {
  if (!Array.isArray(videos)) return [];
  return videos.map(normalizeVideo).filter(Boolean) as VideoInfo[];
}

export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

export function normalizeHistoryItem(value: unknown): HistoryItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const path = String(item.path || item.file_path || "").trim();
  const awemeId = String(item.aweme_id || item.id || "").trim();
  
  // Extract filename stem from path to use as a fallback title
  const filenameFromPath = path.split(/[\\/]/).pop() || "";
  const dotIndex = filenameFromPath.lastIndexOf(".");
  const fileStem = dotIndex <= 0 ? filenameFromPath : filenameFromPath.slice(0, dotIndex);
  
  const title = String(item.title || item.filename || item.desc || item.name || fileStem || awemeId || "未命名作品").trim();
  const fileSize = Number(item.file_size ?? item.size ?? 0) || 0;
  const timestamp = Number(item.timestamp ?? item.modified_at ?? item.create_time ?? 0) || 0;
  const mediaType = String(item.media_type || item.file_type || item.extension || "").trim();

  return {
    id: awemeId || path || title,
    aweme_id: awemeId,
    filename: title,
    title,
    path,
    file_path: path,
    author: String(item.author || "").trim(),
    author_id: String(item.author_id || "").trim(),
    desc: title,
    size: fileSize,
    file_size: fileSize,
    timestamp,
    create_time: timestamp,
    file_type: mediaType,
    media_type: mediaType,
    cover: String(item.cover || "").trim(),
  };
}
