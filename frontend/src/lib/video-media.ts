import type { BitRateInfo, VideoInfo, VideoMediaUrl } from "@/lib/tauri";

export type VideoMediaType = "video" | "image" | "live_photo";

export interface VideoMediaItem {
  type: VideoMediaType;
  url: string;
  poster?: string;
}

export interface VideoQualityOption {
  key: string;
  label: string;
  detail: string;
  url: string;
  codec: string;
  isAuto?: boolean;
  width: number;
  height: number;
  bitRate: number;
  dataSize: number;
  qualityType: number;
}

type VideoLikeSource = VideoInfo & {
  cover_url?: string | null;
  bgm_url?: string | null;
  images?: string[] | null;
  live_photos?: string[] | null;
  bit_rate?: BitRateInfo[] | null;
  media_urls?: Array<VideoMediaUrl | string> | null;
  video?: VideoInfo["video"] & {
    media_urls?: Array<VideoMediaUrl | string> | null;
  };
};

const MAX_REASONABLE_VIDEO_DURATION_SECONDS = 24 * 60 * 60;

export function normalizeVideoMediaType(type: unknown): VideoMediaType {
  if (type === 1 || type === "1") return "image";
  const normalized = String(type || "").trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "image" || normalized === "images" || normalized === "photo") return "image";
  if (normalized === "live_photo" || normalized === "livephoto" || normalized === "live") {
    return "live_photo";
  }
  return "video";
}

export function isVideoLikeMedia(media: VideoMediaItem | null | undefined): boolean {
  return media?.type === "video" || media?.type === "live_photo";
}

export function shouldUseSeparateBgm(media: VideoMediaItem | null | undefined): boolean {
  return media?.type === "image" || media?.type === "live_photo";
}

export function shouldUseSeparateBgmForVideo(
  media: VideoMediaItem | null | undefined,
  video: VideoInfo | null | undefined
): boolean {
  if (shouldUseSeparateBgm(media)) return true;
  if (!media || media.type !== "video") return false;
  const videoData = ((video as VideoLikeSource | null | undefined)?.video || {}) as NonNullable<VideoLikeSource["video"]>;
  const audioUrl = readUrl(videoData.audio_addr);
  if (!audioUrl) return false;
  const mediaUrl = readUrl(media.url);
  const dashUrl = readUrl(videoData.dash_addr);
  return Boolean(mediaUrl && (mediaUrl === dashUrl || isDashVideoOnlyUrl(mediaUrl)));
}

export function getMediaProxyType(media: VideoMediaItem | null | undefined): "video" | "image" {
  return media?.type === "image" ? "image" : "video";
}

export function collectVideoMedia(video: VideoInfo | null | undefined): VideoMediaItem[] {
  if (!video) return [];

  const source = video as VideoLikeSource;
  const videoData = source.video || {};
  const poster = getVideoCover(video);
  const rawMediaItems = collectRawMediaItems(source.media_urls || videoData.media_urls, poster);
  if (rawMediaItems.length > 0) {
    const progressiveItems = rawMediaItems.filter(
      (item) => item.type !== "video" || !isDashVideoOnlyUrl(item.url)
    );
    if (progressiveItems.length > 0) return progressiveItems;
  }

  const previewUrl = readUrl(videoData.preview_addr);
  if (previewUrl) {
    return [{ type: "video", url: previewUrl, poster }];
  }

  const items: VideoMediaItem[] = [];
  const livePhotoUrls = readUrlList(source.live_photo_urls || source.live_photos);
  const imageUrls = readUrlList(source.image_urls || source.images);

  for (const url of livePhotoUrls) {
    items.push({ type: "live_photo", url, poster });
  }

  for (const url of imageUrls) {
    items.push({ type: "image", url });
  }

  const playUrl = readUrl(videoData.play_addr);
  const downloadUrl = readUrl(videoData.download_addr);
  const h264Url = readUrl(videoData.play_addr_h264);
  const lowbrUrl = readUrl(videoData.play_addr_lowbr);
  const mediaType = String(source.media_type || source.raw_media_type || "").toLowerCase();

  if (items.length === 0) {
    const candidateUrls = [downloadUrl, h264Url, playUrl, lowbrUrl, previewUrl].filter(
      (url) => Boolean(url) && !isDashVideoOnlyUrl(url)
    );
    for (const url of candidateUrls) {
      items.push({
        type: source.has_live_photo || mediaType === "live_photo" ? "live_photo" : "video",
        url,
        poster,
      });
    }
  }

  if (items.length === 0 && poster && mediaType !== "video") {
    items.push({ type: "image", url: poster });
  }

  return uniqueMediaItems(items);
}

export function collectVideoQualityOptions(
  video: VideoInfo | null | undefined,
  fallbackUrl?: string
): VideoQualityOption[] {
  if (!video) return [];

  const videoData = video.video || {};
  const fallback = readUrl(fallbackUrl || videoData.preview_addr || videoData.play_addr);
  const autoOption: VideoQualityOption | null = fallback && !isDashVideoOnlyUrl(fallback)
    ? {
        key: "auto",
        label: "自动",
        detail: "当前播放线路",
        url: fallback,
        codec: "",
        isAuto: true,
        width: Number(videoData.width || 0),
        height: Number(videoData.height || 0),
        bitRate: 0,
        dataSize: 0,
        qualityType: 0,
      }
    : null;
  const seenUrls = new Set<string>();
  const qualityMap = new Map<string, VideoQualityOption>();

  const pushQualityOption = (option: VideoQualityOption) => {
    const url = option.url.trim();
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);

    const normalized = { ...option, url };
    const key = qualityGroupKey(normalized);
    const existing = qualityMap.get(key);
    if (!existing || qualityRank(normalized) > qualityRank(existing)) {
      qualityMap.set(key, normalized);
    }
  };

  const bitRates = Array.isArray(videoData.bit_rate) ? videoData.bit_rate : [];
  bitRates
    .flatMap((bitRate, index) => buildQualityCandidates(bitRate, index))
    .forEach(pushQualityOption);

  const qualityOptions = Array.from(qualityMap.values()).sort((a, b) => qualityRank(b) - qualityRank(a));
  return autoOption ? [autoOption, ...qualityOptions] : qualityOptions;
}

export function getVideoCover(video: VideoInfo | null | undefined): string {
  if (!video) return "";

  const source = video as VideoLikeSource;
  const videoData = source.video || {};
  const directCover = firstUrl([
    videoData.cover,
    videoData.origin_cover,
    videoData.dynamic_cover,
    source.cover_url,
  ]);
  if (directCover) return directCover;

  const imageCover = firstUrl([
    ...(source.image_urls || []),
    ...(source.images || []),
    ...collectRawMediaItems(source.media_urls || videoData.media_urls)
      .filter((item) => item.type === "image")
      .map((item) => item.url),
  ]);

  return imageCover;
}

export function getVideoBgmUrl(
  video: VideoInfo | null | undefined,
  media?: VideoMediaItem | null
): string {
  if (!video) return "";
  const source = video as VideoLikeSource;
  const musicUrl = readUrl(video.music?.play_url || source.bgm_url);
  if (musicUrl) return musicUrl;
  if (media && shouldUseSeparateBgmForVideo(media, video)) {
    const audioUrl = readUrl(source.video?.audio_addr);
    if (audioUrl) return audioUrl;
  }
  return "";
}

export function getVideoDurationSeconds(video: VideoInfo | null | undefined): number {
  const duration = Number(video?.video?.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const unit = String(video?.video?.duration_unit || "").toLowerCase();
  const bitRateDuration = estimateDurationSecondsFromBitRates(video);

  if (unit === "seconds" || unit === "second" || unit === "s") {
    return pickReliableDuration(duration, bitRateDuration);
  }
  if (unit === "milliseconds" || unit === "millisecond" || unit === "ms") {
    return pickReliableDuration(duration / 1000, bitRateDuration);
  }

  return pickReliableDuration(duration > 1000 ? duration / 1000 : duration, bitRateDuration);
}

export function getVideoMediaLabel(video: VideoInfo | null | undefined): string {
  const items = collectVideoMedia(video);
  if (items.length === 0) return "未知";

  const imageCount = items.filter((item) => item.type === "image").length;
  const liveCount = items.filter((item) => item.type === "live_photo").length;
  const videoCount = items.filter((item) => item.type === "video").length;

  if ((imageCount > 0 || liveCount > 0) && videoCount > 0) return `混合 ${items.length}`;
  if (liveCount > 0 && imageCount > 0) return `混合 ${items.length}`;
  if (liveCount > 0) return liveCount > 1 ? `实况 ${liveCount}` : "实况";
  if (imageCount > 0) return imageCount > 1 ? `图集 ${imageCount}` : "图集";
  return "视频";
}

function collectRawMediaItems(value: unknown, poster?: string): VideoMediaItem[] {
  if (!Array.isArray(value)) return [];

  const items = value
    .map((item) => {
      if (!item) return null;
      if (typeof item === "string") {
        const url = readUrl(item);
        return url ? { type: inferMediaTypeFromUrl(url), url, poster } : null;
      }
      if (typeof item !== "object") return null;

      const record = item as Record<string, unknown>;
      const url = readUrl(
        record.url ||
          record.play_url ||
          record.play_addr ||
          record.download_addr ||
          record.url_list ||
          record.video ||
          record.image ||
          record.display_url
      );
      if (!url) return null;
      const explicitType = record.type ?? record.media_type ?? record.raw_media_type;

      return {
        type: explicitType ? normalizeVideoMediaType(explicitType) : inferMediaTypeFromUrl(url),
        url,
        poster,
      };
    })
    .filter(Boolean) as VideoMediaItem[];

  return uniqueMediaItems(items);
}

function uniqueMediaItems(items: VideoMediaItem[]): VideoMediaItem[] {
  const seen = new Set<string>();
  const result: VideoMediaItem[] = [];

  for (const item of items) {
    const url = item.url.trim();
    if (!url || seen.has(`${item.type}::${url}`)) continue;
    seen.add(`${item.type}::${url}`);
    result.push({ ...item, url });
  }

  return result;
}

function buildQualityCandidates(bitRate: BitRateInfo, index: number): VideoQualityOption[] {
  const inferredHeight = inferQualityHeight(bitRate);
  const rawWidth = Number(bitRate.width || 0);
  const options: VideoQualityOption[] = [];
  const base = {
    width: rawWidth > 0 ? rawWidth : inferredHeight > 0 ? Math.round(inferredHeight * 16 / 9) : 0,
    height: inferredHeight,
    bitRate: Number(bitRate.bit_rate || 0),
    dataSize: Number(bitRate.data_size || 0),
    qualityType: Number(bitRate.quality_type || 0),
  };

  const playUrl = readUrl(bitRate.play_addr);
  if (playUrl && !isDashVideoOnlyUrl(playUrl)) {
    const codec = bitRate.is_h265 ? "H.265" : "H.264";
    options.push({
      ...base,
      key: `quality-${index}-${codec}-main`,
      label: formatQualityLabel(bitRate),
      detail: formatQualityDetail(bitRate, codec),
      url: playUrl,
      codec,
    });
  }

  const h264Url = readUrl(bitRate.play_addr_h264);
  if (h264Url && h264Url !== playUrl && !isDashVideoOnlyUrl(h264Url)) {
    const codec = "H.264";
    options.push({
      ...base,
      key: `quality-${index}-${codec}-h264`,
      label: formatQualityLabel(bitRate),
      detail: formatQualityDetail(bitRate, codec),
      url: h264Url,
      codec,
    });
  }

  return options;
}

function isDashVideoOnlyUrl(url: string | null | undefined): boolean {
  const text = String(url || "").toLowerCase();
  return text.includes("media-video") || text.includes("media_video");
}

function formatQualityLabel(bitRate: BitRateInfo): string {
  const height = inferQualityHeight(bitRate);
  if (height >= 2160) return "4K";
  if (height >= 1440) return "2K";
  if (height > 0) return `${height}p`;

  const qualityType = Number(bitRate.quality_type || 0);
  if (qualityType > 0) return `Q${qualityType}`;

  return "画质";
}

function inferQualityHeight(bitRate: BitRateInfo): number {
  const explicitHeight = Number(bitRate.height || 0);
  if (explicitHeight > 0) return explicitHeight;

  const gearName = String(bitRate.gear_name || "").trim().toLowerCase();
  if (/(^|[_-])(4k|uhd|2160p?)([_-]|$)/i.test(gearName)) return 2160;
  if (/(^|[_-])(2k|qhd|1440p?)([_-]|$)/i.test(gearName)) return 1440;

  const matchedHeight = gearName.match(/(?:^|[_-])(\d{3,4})(?:p|[_-]|$)/i)?.[1];
  if (matchedHeight) return Number(matchedHeight);

  const qualityType = Number(bitRate.quality_type || 0);
  if (qualityType === 72 || qualityType === 73) return 2160;

  return 0;
}

function formatQualityDetail(bitRate: BitRateInfo, codec: string): string {
  const parts = [codec];
  const bitRateValue = Number(bitRate.bit_rate || 0);
  const dataSize = Number(bitRate.data_size || 0);
  const gearName = String(bitRate.gear_name || "").trim();

  if (bitRateValue > 0) {
    parts.push(formatBitRate(bitRateValue));
  }
  if (dataSize > 0) {
    parts.push(formatDataSize(dataSize));
  }
  if (gearName) {
    parts.push(gearName);
  }

  return parts.filter(Boolean).join(" · ");
}

function formatBitRate(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mbps`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} Kbps`;
  return `${value} bps`;
}

function formatDataSize(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function estimateDurationSecondsFromBitRates(video: VideoInfo | null | undefined): number {
  const source = video as VideoLikeSource | null | undefined;
  const bitRates = source?.video?.bit_rate || source?.bit_rate || [];
  if (!Array.isArray(bitRates)) return 0;

  const estimates = bitRates
    .map((bitRate) => {
      const bitsPerSecond = Number(bitRate?.bit_rate || 0);
      const bytes = Number(bitRate?.data_size || 0);
      if (!Number.isFinite(bitsPerSecond) || !Number.isFinite(bytes) || bitsPerSecond <= 0 || bytes <= 0) {
        return 0;
      }
      return (bytes * 8) / bitsPerSecond;
    })
    .filter((seconds) => seconds > 0 && seconds <= MAX_REASONABLE_VIDEO_DURATION_SECONDS)
    .sort((a, b) => a - b);

  if (estimates.length === 0) return 0;
  return estimates[Math.floor(estimates.length / 2)];
}

function pickReliableDuration(primarySeconds: number, bitRateSeconds: number): number {
  if (!Number.isFinite(primarySeconds) || primarySeconds <= 0) return bitRateSeconds || 0;
  if (!Number.isFinite(bitRateSeconds) || bitRateSeconds <= 0) return primarySeconds;

  const diff = Math.abs(primarySeconds - bitRateSeconds);
  const closeEnough = diff <= Math.max(2, bitRateSeconds * 0.2);
  if (closeEnough) return primarySeconds;

  if (primarySeconds < 10 && bitRateSeconds >= 30) {
    return bitRateSeconds;
  }

  return primarySeconds;
}

function qualityRank(option: VideoQualityOption): number {
  const height = option.height || parseQualityLabelHeight(option.label);
  const width = option.width || (height > 0 ? Math.round(height * 16 / 9) : 0);
  const resolution = height > 0 ? height * 1_000_000_000 + width * 100_000 : 0;
  return resolution + option.dataSize + option.bitRate + option.qualityType;
}

function qualityGroupKey(option: VideoQualityOption): string {
  const height = option.height || parseQualityLabelHeight(option.label);
  if (height > 0) return `height:${height}`;

  const label = option.label.trim().toLowerCase();
  if (label) return `label:${label}`;

  return `quality:${option.qualityType || option.key}`;
}

function parseQualityLabelHeight(label: string): number {
  const normalized = label.trim().toLowerCase();
  if (normalized === "4k") return 2160;
  if (normalized === "2k") return 1440;
  const matchedHeight = normalized.match(/^(\d{3,4})p$/)?.[1];
  return matchedHeight ? Number(matchedHeight) : 0;
}

function readUrl(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = readUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return readUrl(
      record.url ||
        record.play_url ||
        record.play_addr ||
        record.download_addr ||
        record.url_list ||
        record.uri ||
        record.video ||
        record.image ||
        record.display_url
    );
  }
  return "";
}

function readUrlList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => readUrl(item)).filter(Boolean)));
}

function firstUrl(values: unknown[]): string {
  for (const value of values) {
    const url = readUrl(value);
    if (url) return url;
  }
  return "";
}

function inferMediaTypeFromUrl(url: string): VideoMediaType {
  const lower = url.toLowerCase();
  if (
    lower.includes(".jpg") ||
    lower.includes(".jpeg") ||
    lower.includes(".png") ||
    lower.includes(".webp") ||
    lower.includes("douyinpic") ||
    lower.includes("byteimg")
  ) {
    return "image";
  }
  return "video";
}
