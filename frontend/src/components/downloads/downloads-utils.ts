import {
  localFileAssetUrl,
  type HistoryItem,
  type VideoInfo,
} from "@/lib/tauri";

export const FILE_PAGE_SIZE_OPTIONS = [12, 24, 48, 96] as const;
export type LocalMediaKind = "video" | "image" | "audio" | "media";
export type DownloadDisplayMode = "file" | "work";
export type VideoResolution = { width: number; height: number } | null;
export type DownloadPlayerState = {
  videos: VideoInfo[];
  initialIndex: number;
  initialMediaIndex: number;
} | null;

export interface DownloadWorkGroup {
  id: string;
  title: string;
  author: string;
  timestamp: number;
  size: number;
  items: HistoryItem[];
  coverItem: HistoryItem;
  mediaCounts: Record<LocalMediaKind, number>;
}

export function readVideoResolution(video: HTMLVideoElement): VideoResolution {
  const width = Math.round(Number(video.videoWidth || 0));
  const height = Math.round(Number(video.videoHeight || 0));
  return width > 0 && height > 0 ? { width, height } : null;
}

export function standardQualityHeightFromDimension(value: number): number {
  if (value <= 0) return 0;
  const standardHeights = [4320, 2160, 1440, 1080, 720, 540, 480, 360, 240];
  const nearest = standardHeights.reduce((best, height) =>
    Math.abs(height - value) < Math.abs(best - value) ? height : best
  );
  const tolerance = Math.max(16, nearest * 0.04);
  return Math.abs(nearest - value) <= tolerance ? nearest : 0;
}

export function longSideQualityHeight(value: number): number {
  if (value <= 0) return 0;
  const mappings = [
    [3840, 2160],
    [2560, 1440],
    [1920, 1080],
    [1280, 720],
    [960, 540],
    [854, 480],
    [852, 480],
  ] as const;
  for (const [longSide, qualityHeight] of mappings) {
    const tolerance = Math.max(24, longSide * 0.04);
    if (Math.abs(value - longSide) <= tolerance) return qualityHeight;
  }
  return 0;
}

export function inferResolutionQualityHeight(resolution: VideoResolution): number {
  if (!resolution) return 0;
  return Math.max(
    standardQualityHeightFromDimension(resolution.width),
    standardQualityHeightFromDimension(resolution.height),
    longSideQualityHeight(resolution.width),
    longSideQualityHeight(resolution.height)
  );
}

export function formatVideoResolutionLabel(resolution: VideoResolution): string {
  if (!resolution) return "";
  const qualityHeight = inferResolutionQualityHeight(resolution);
  if (qualityHeight >= 2160) return "4K";
  if (qualityHeight >= 1440) return "2K";
  if (qualityHeight > 0) return `${qualityHeight}p`;
  return `${resolution.width}x${resolution.height}`;
}

export function formatVideoResolutionTitle(resolution: VideoResolution): string {
  if (!resolution) return "";
  return `${resolution.width} x ${resolution.height}`;
}

export function mergeDownloadFileItems(files: HistoryItem[], historyItems: HistoryItem[]): HistoryItem[] {
  const historyByPath = new Map(
    historyItems
      .filter((item) => item.path)
      .map((item) => [item.path, item] as const)
  );

  return files.map((file) => {
    const history = historyByPath.get(file.path);
    return {
      ...file,
      ...history,
      id: file.id || file.path,
      path: file.path,
      file_path: file.path,
      size: file.size || history?.size || 0,
      timestamp: history?.timestamp || file.timestamp,
    };
  });
}

export function getDownloadDeleteKey(item: HistoryItem): string {
  return item.path || item.id || item.aweme_id || item.filename || "";
}

export function buildTitleToAwemeIdMap(items: HistoryItem[]): Map<string, string> {
  const titleToAwemeId = new Map<string, string>();
  for (const item of items) {
    const awemeId = String(item.aweme_id || "").trim();
    if (isUsableAwemeId(awemeId, item)) {
      const title = normalizeDownloadWorkTitle(resolveDownloadItemTitle(item));
      const scope = (item.author || getParentDirectoryName(item.path) || "unknown").trim().toLowerCase();
      const titleKey = `${scope}:${title.toLowerCase()}`;
      titleToAwemeId.set(titleKey, awemeId);
    }
  }
  return titleToAwemeId;
}

export function buildDownloadWorkGroups(items: HistoryItem[], sortBy: string): DownloadWorkGroup[] {
  const grouped = new Map<string, HistoryItem[]>();
  const titleToAwemeId = buildTitleToAwemeIdMap(items);

  for (const item of dedupeDownloadItems(items)) {
    if (!item.path) continue;
    const key = getDownloadWorkKey(item, titleToAwemeId);
    const groupItems = grouped.get(key) || [];
    groupItems.push(item);
    grouped.set(key, groupItems);
  }

  const groups = Array.from(grouped.entries()).map(([id, groupItems]) => {
    const sortedItems = sortDownloadWorkItems(groupItems);
    const coverItem = chooseDownloadWorkCover(sortedItems);
    const mediaCounts = createEmptyMediaCounts();

    for (const item of sortedItems) {
      mediaCounts[getHistoryMediaKind(item)] += 1;
    }

    return {
      id,
      title: resolveDownloadWorkTitle(sortedItems),
      author: sortedItems.find((item) => item.author)?.author || "",
      timestamp: Math.max(...sortedItems.map((item) => Number(item.timestamp || item.create_time || 0))),
      size: sortedItems.reduce((sum, item) => sum + (Number(item.size || item.file_size || 0) || 0), 0),
      items: sortedItems,
      coverItem,
      mediaCounts,
    };
  });

  return sortDownloadWorkGroups(groups, sortBy);
}

export function findDownloadWorkGroupForItem(
  item: HistoryItem,
  items: HistoryItem[],
  sortBy: string
): DownloadWorkGroup | null {
  const titleToAwemeId = buildTitleToAwemeIdMap(items);
  const targetKey = getDownloadWorkKey(item, titleToAwemeId);
  return buildDownloadWorkGroups(items, sortBy).find((group) => group.id === targetKey) || null;
}

export function dedupeDownloadItems(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  const result: HistoryItem[] = [];

  for (const item of items) {
    const key = getDownloadItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

export function getLocalDownloadItems(items: HistoryItem[]): HistoryItem[] {
  return dedupeDownloadItems(items).filter((item) => Boolean(item.path));
}

export function isDownloadPlayerMedia(item: HistoryItem): boolean {
  const kind = getHistoryMediaKind(item);
  return kind === "video" || kind === "image";
}

export function getPlayableDownloadItems(items: HistoryItem[]): HistoryItem[] {
  return getLocalDownloadItems(items).filter(isDownloadPlayerMedia);
}

export function buildDownloadPlayerVideo(items: HistoryItem[]): VideoInfo | null {
  const playableItems = getPlayableDownloadItems(items);
  if (playableItems.length === 0) return null;

  const title = resolveDownloadWorkTitle(playableItems);
  const authorName = playableItems.find((item) => item.author)?.author || "本地下载";
  const coverItem = chooseDownloadWorkCover(playableItems);
  const coverUrl = getDownloadCoverUrl(coverItem);
  const mediaUrls = playableItems.flatMap((item) => {
    const kind = getHistoryMediaKind(item);
    const url = localFileAssetUrl(item.path);
    if (kind === "image") return [{ type: "image", url }];
    if (kind === "video") return [{ type: "video", url }];
    return [];
  });
  if (mediaUrls.length === 0) return null;

  const imageUrls = mediaUrls
    .filter((item) => item.type === "image")
    .map((item) => item.url);
  const firstVideoUrl = mediaUrls.find((item) => item.type === "video")?.url || "";
  const timestamp = Math.max(...playableItems.map((item) => Number(item.timestamp || item.create_time || 0)));
  const allImages = mediaUrls.length > 0 && mediaUrls.every((item) => item.type === "image");
  const allVideos = mediaUrls.length > 0 && mediaUrls.every((item) => item.type === "video");
  const mediaType = allImages ? "image" : allVideos ? "video" : "mixed";

  return {
    aweme_id: "",
    desc: title,
    create_time: timestamp,
    author: {
      uid: "",
      sec_uid: "",
      nickname: authorName,
      avatar_thumb: "",
      avatar_medium: "",
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
      preview_addr: null,
      play_addr: firstVideoUrl,
      play_addr_h264: null,
      play_addr_lowbr: null,
      download_addr: firstVideoUrl || mediaUrls[0]?.url || null,
      cover: coverUrl,
      dynamic_cover: "",
      origin_cover: coverUrl,
      width: 0,
      height: 0,
      duration: 0,
      ratio: "",
      bit_rate: null,
    },
    statistics: {
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0,
      forward_count: 0,
    },
    media_urls: mediaUrls,
    image_urls: imageUrls,
    images: imageUrls,
    live_photo_urls: null,
    live_photos: null,
    has_live_photo: false,
    is_image: allImages,
    media_type: mediaType,
    raw_media_type: mediaType,
    bgm_url: null,
    cover_url: coverUrl,
    music: null,
  };
}

export function getDownloadWorkKey(item: HistoryItem, titleToAwemeId?: Map<string, string>): string {
  const title = normalizeDownloadWorkTitle(resolveDownloadItemTitle(item));
  const scope = (item.author || getParentDirectoryName(item.path) || "unknown").trim().toLowerCase();
  const titleKey = `${scope}:${title.toLowerCase()}`;

  if (titleToAwemeId) {
    const mappedAwemeId = titleToAwemeId.get(titleKey);
    if (mappedAwemeId) return `aweme:${mappedAwemeId}`;
  }

  const awemeId = String(item.aweme_id || "").trim();
  if (isUsableAwemeId(awemeId, item)) return `aweme:${awemeId}`;

  return `work:${titleKey}`;
}

export function isUsableAwemeId(awemeId: string, item: HistoryItem): boolean {
  if (!awemeId) return false;
  if (item.path && awemeId === item.path) return false;
  if (/[\\/]/.test(awemeId) || awemeId.includes(":")) return false;
  return awemeId.length <= 80;
}

export function resolveDownloadWorkTitle(items: HistoryItem[]): string {
  const title = items
    .map(resolveDownloadItemTitle)
    .map(normalizeDownloadWorkTitle)
    .find(Boolean);
  return title || "未命名作品";
}

export function resolveDownloadItemTitle(item: HistoryItem): string {
  const direct = String(item.title || item.desc || item.filename || "").trim();
  if (direct) return stripKnownMediaExtension(direct);
  return getFileStem(item.path || item.file_path || "") || item.id || "未命名作品";
}

export function normalizeDownloadWorkTitle(value: string): string {
  let result = stripKnownMediaExtension(value).trim();

  for (let index = 0; index < 3; index += 1) {
    const next = result
      .replace(/\s*[（(]\d{1,4}[）)]$/u, "")
      .replace(/\s*[\[【]\d{1,4}[\]】]$/u, "")
      .replace(/(?:[_-](?:\d{1,4}|img\d{0,4}|image\d{0,4}|photo\d{0,4}|cover|poster|live[_-]?photo\d{0,4}|实况|封面|图片\d{0,4}))$/iu, "")
      .replace(/第\d{1,4}[张集]$/u, "")
      .trim();
    if (next === result) break;
    result = next;
  }

  return result || stripKnownMediaExtension(value).trim();
}

export function sortDownloadWorkItems(items: HistoryItem[]): HistoryItem[] {
  return [...items].sort((a, b) => {
    const titleCompare = resolveDownloadItemTitle(a).localeCompare(
      resolveDownloadItemTitle(b),
      undefined,
      { numeric: true, sensitivity: "base" }
    );
    if (titleCompare !== 0) return titleCompare;
    return (a.path || "").localeCompare(b.path || "", undefined, { numeric: true, sensitivity: "base" });
  });
}

export function sortDownloadWorkGroups(groups: DownloadWorkGroup[], sortBy: string): DownloadWorkGroup[] {
  return [...groups].sort((a, b) => {
    if (sortBy === "date_asc") return a.timestamp - b.timestamp;
    if (sortBy === "size_desc") return b.size - a.size;
    if (sortBy === "size_asc") return a.size - b.size;
    return b.timestamp - a.timestamp;
  });
}

export function chooseDownloadWorkCover(items: HistoryItem[]): HistoryItem {
  return (
    items.find((item) => item.cover) ||
    items.find((item) => getHistoryMediaKind(item) === "image") ||
    items.find((item) => getHistoryMediaKind(item) === "video") ||
    items[0]!
  );
}

export function getDownloadCoverUrl(item: HistoryItem): string {
  if (item.cover) return item.cover;
  if (getHistoryMediaKind(item) === "image" && item.path) {
    return localFileAssetUrl(item.path);
  }
  return "";
}

export function createEmptyMediaCounts(): Record<LocalMediaKind, number> {
  return {
    video: 0,
    image: 0,
    audio: 0,
    media: 0,
  };
}

export function formatWorkMediaSummary(group: DownloadWorkGroup): string {
  const parts = [
    group.mediaCounts.video ? `视频 ${group.mediaCounts.video}` : "",
    group.mediaCounts.image ? `图片 ${group.mediaCounts.image}` : "",
    group.mediaCounts.audio ? `音频 ${group.mediaCounts.audio}` : "",
    group.mediaCounts.media ? `媒体 ${group.mediaCounts.media}` : "",
  ].filter(Boolean);

  return parts.join(" · ") || `${group.items.length} 个文件`;
}

export function isSameDownloadItem(a: HistoryItem, b: HistoryItem): boolean {
  const aPath = a.path || a.file_path || "";
  const bPath = b.path || b.file_path || "";
  if (aPath && bPath) return aPath === bPath;
  return getDownloadItemKey(a) === getDownloadItemKey(b);
}

export function getDownloadItemKey(item: HistoryItem): string {
  return item.path || item.file_path || item.id || item.aweme_id || item.filename || "";
}

export function getParentDirectoryName(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

export function getFileStem(path: string): string {
  const filename = (path || "").split(/[\\/]/).pop() || "";
  return stripKnownMediaExtension(filename);
}

export function stripKnownMediaExtension(value: string): string {
  const extension = getPathExtension(value);
  if (!extension || !mediaKindFromExtension(extension)) return value;
  return value.slice(0, Math.max(0, value.length - extension.length - 1));
}

export function getHistoryMediaKind(item: HistoryItem): LocalMediaKind {
  const extensionKind = mediaKindFromExtension(getPathExtension(item.path || item.file_path || ""));
  if (extensionKind) return extensionKind;

  const raw = String(item.media_type || item.file_type || "").toLowerCase();
  if (raw.includes("image")) return "image";
  if (raw.includes("audio")) return "audio";
  if (raw.includes("video") || raw.includes("live_photo") || raw.includes("mixed")) return "video";
  return "media";
}

export function mediaKindFromExtension(extension: string): LocalMediaKind | null {
  switch (extension.toLowerCase()) {
    case "mp4":
    case "mov":
    case "m4v":
    case "webm":
    case "mkv":
    case "avi":
    case "flv":
      return "video";
    case "jpg":
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
    case "avif":
    case "heic":
    case "heif":
      return "image";
    case "mp3":
    case "m4a":
    case "aac":
    case "wav":
    case "flac":
    case "ogg":
      return "audio";
    default:
      return null;
  }
}

export function getPathExtension(path: string): string {
  const filename = path.split(/[\\/]/).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return "";
  return filename.slice(dotIndex + 1);
}

export function formatMediaKindLabel(kind: LocalMediaKind): string {
  if (kind === "video") return "视频";
  if (kind === "image") return "图片";
  if (kind === "audio") return "音频";
  return "媒体";
}

export function buildPageRange(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, total, current]);
  for (let offset = -1; offset <= 1; offset += 1) {
    const page = current + offset;
    if (page > 1 && page < total) {
      pages.add(page);
    }
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const output: Array<number | "ellipsis"> = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    const previous = sorted[index - 1];
    if (index > 0 && page - previous > 1) {
      output.push("ellipsis");
    }
    output.push(page);
  }

  return output;
}
