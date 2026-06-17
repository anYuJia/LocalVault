import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import {
  Check,
  Download,
  Gauge,
  Heart,
  Info,
  Loader2,
  MessageCircle,
  Music,
  Pause,
  Play,
  Send,
  Share2,
  Star,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import { prewarmVideoForPlayback } from "@/lib/media-prewarm";
import {
  copyTextToClipboard,
  getCommentReplies,
  getComments,
  getShareFriends,
  getVideoDetail,
  mediaProxyUrl,
  publishComment,
  sendFriendVideoShare,
  setCommentLiked,
  setVideoCollected,
  setVideoLiked,
  type CommentInfo,
  type ShareFriend,
  type VideoInfo,
} from "@/lib/tauri";
import {
  collectVideoMedia,
  collectVideoQualityOptions,
  getMediaProxyType,
  getVideoBgmUrl,
  isVideoLikeMedia,
  shouldUseSeparateBgmForVideo,
  type VideoMediaItem,
} from "@/lib/video-media";

interface FullscreenPlayerProps {
  videos: VideoInfo[];
  initialIndex?: number;
  initialMediaIndex?: number;
  open: boolean;
  onClose: () => void;
  onDownload?: (video: VideoInfo) => void | Promise<void>;
  onLoadMore?: () => void;
  onShowDetail?: (video: VideoInfo) => void;
  onAuthor?: (video: VideoInfo) => void;
  onVideoUpdate?: (video: VideoInfo) => void;
}

const IMAGE_DURATION_SECONDS = 1.5;
const LOAD_MORE_THRESHOLD = 3;
const PLAYER_VIDEO_MAX_AUTO_RETRIES = 1;
const PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS = 450;
const PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS = 1400;
const PLAYER_VIDEO_LOAD_TIMEOUT_MS = 18_000;
const PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS = 10;
const MAX_PRELOADED_MEDIA_NODES = 8;
const MEDIA_TRANSITION_DISTANCE = 34;
const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const WHEEL_VIDEO_SWITCH_THRESHOLD = 80;
const WHEEL_VIDEO_SWITCH_LOCK_MS = 520;
const WHEEL_IDLE_RESET_MS = 160;
const PLAYER_PANEL_CLOSE_DELAY_MS = 220;
const PROGRESS_PREVIEW_WIDTH = 184;
const PROGRESS_PREVIEW_HEIGHT = 104;
const PROGRESS_PREVIEW_SAMPLE_RATIOS = [0.08, 0.22, 0.38, 0.55, 0.72, 0.88] as const;

type PlayerPanel = "volume" | "rate" | "quality" | "download" | "music" | "share";

const mediaMotionVariants: Variants = {
  enter: (direction = 0) => ({
    opacity: 0,
    x: direction * MEDIA_TRANSITION_DISTANCE,
    scale: 0.992,
  }),
  center: {
    opacity: 1,
    x: 0,
    scale: 1,
  },
  exit: (direction = 0) => ({
    opacity: 0,
    x: direction * -MEDIA_TRANSITION_DISTANCE,
    scale: 0.992,
  }),
};
// 模块级别的会话唯一缓存击碎器：只在页面加载时生成一次，在整个会话中保持稳定，
// 避免组件重新渲染时生成新 URL 导致视频元素被反复重置。
const SESSION_CACHE_BUSTER = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

function playerMediaProxyUrl(url: string | null | undefined, mediaType: "video" | "image" | "audio", retryKey = 0): string {
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

function finiteMediaTime(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function readMediaDuration(node: HTMLMediaElement): number {
  const duration = finiteMediaTime(node.duration);
  if (duration > 0) return duration;

  const ranges = node.seekable;
  if (!ranges.length) return 0;
  return finiteMediaTime(ranges.end(ranges.length - 1));
}

function formatCommentTime(createTime: number): string {
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

type CommentRepliesState = Record<
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

type CommentReplyTarget = {
  replyId: string;
  replyToReplyId: string;
  nickname: string;
} | null;

function getDocumentVideoNode(reference: HTMLElement | null): HTMLVideoElement | null {
  return reference?.ownerDocument.querySelector("video") || null;
}

function releaseMediaElement(node: HTMLMediaElement | null | undefined) {
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

function releaseScopedMediaElements(reference: HTMLElement | null | undefined) {
  if (!reference) return;
  for (const node of Array.from(reference.querySelectorAll<HTMLMediaElement>("video, audio"))) {
    releaseMediaElement(node);
  }
}

function applyPlaybackRateToNode(node: HTMLMediaElement | null, rate: number) {
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

export function FullscreenPlayer({
  videos,
  initialIndex = 0,
  initialMediaIndex = 0,
  open,
  onClose,
  onDownload,
  onLoadMore,
  onShowDetail,
  onAuthor,
  onVideoUpdate,
}: FullscreenPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [mediaIndex, setMediaIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [liked, setLiked] = useState(false);
  const [favorited, setFavorited] = useState(false);
  const [relationHydrating, setRelationHydrating] = useState(false);
  const [relationSubmitting, setRelationSubmitting] = useState<"like" | "collect" | null>(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [selectedQualityKey, setSelectedQualityKey] = useState("auto");
  const [openPanel, setOpenPanel] = useState<PlayerPanel | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [showLoadStatus, setShowLoadStatus] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const [downloadSubmitting, setDownloadSubmitting] = useState(false);
  const [shareFriends, setShareFriends] = useState<ShareFriend[]>([]);
  const [shareFriendsLoading, setShareFriendsLoading] = useState(false);
  const [shareFriendsError, setShareFriendsError] = useState("");
  const [shareFriendsLoaded, setShareFriendsLoaded] = useState(false);
  const [shareSendingFriendKey, setShareSendingFriendKey] = useState("");
  const [shareSentFriendKeys, setShareSentFriendKeys] = useState<Set<string>>(() => new Set());
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [comments, setComments] = useState<CommentInfo[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState("");
  const [commentsCursor, setCommentsCursor] = useState(0);
  const [commentsHasMore, setCommentsHasMore] = useState(false);
  const [commentsTotal, setCommentsTotal] = useState(0);
  const [commentsLoadedAwemeId, setCommentsLoadedAwemeId] = useState("");
  const [commentReplies, setCommentReplies] = useState<CommentRepliesState>({});
  const [expandedCommentReplyIds, setExpandedCommentReplyIds] = useState<Set<string>>(() => new Set());
  const [commentDiggingIds, setCommentDiggingIds] = useState<Set<string>>(() => new Set());
  const [commentDraft, setCommentDraft] = useState("");
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [commentReplyTarget, setCommentReplyTarget] = useState<CommentReplyTarget>(null);
  const [videoOverrides, setVideoOverrides] = useState<Record<string, VideoInfo>>({});
  const [mediaTransitionDirection, setMediaTransitionDirection] = useState(0);
  const [navigationNotice, setNavigationNotice] = useState("");
  const playerRootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceHitRef = useRef<HTMLDivElement>(null);
  const bgmRef = useRef<HTMLAudioElement>(null);
  const bgmSourceKeyRef = useRef("");
  const bgmDesiredPlayingRef = useRef(false);
  const bgmPlayPendingRef = useRef(false);
  const bgmPlayRequestSeqRef = useRef(0);
  const touchStart = useRef({ x: 0, y: 0 });
  const wheelLocked = useRef(false);
  const wheelAccumulatedDeltaRef = useRef(0);
  const loadMoreRequestedForLength = useRef(0);
  const imageAdvanceQueued = useRef(false);
  const desiredPlayingRef = useRef(true);
  const playingRef = useRef(false);
  const playbackRateRef = useRef(1);
  const mediaSwitchingRef = useRef(false);
  const qualitySwitchingRef = useRef(false);
  const bgmManuallyPausedRef = useRef(false);
  const mediaSwitchReleaseRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const qualitySwitchReleaseRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const panelCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const commentsHoverCloseTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const commentsPanelStickyRef = useRef(false);
  const wheelResetTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const loadStatusTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const loadTimeoutTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const bufferingTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const navigationNoticeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const autoRetryCountRef = useRef(0);
  const refreshingDetailRef = useRef(false);
  const relationRefreshSeqRef = useRef(0);
  const relationRefreshedIdsRef = useRef(new Set<string>());
  const refreshedDetailIdsRef = useRef(new Set<string>());
  const videoProgressRafRef = useRef<number | null>(null);
  const progressSampleRef = useRef(0);
  const surfaceTapStartRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const lastSurfaceToggleAtRef = useRef(0);
  const pendingQualitySeekRef = useRef<number | null>(null);
  const preloadedMediaRef = useRef(new Map<string, boolean>());
  const preloadedNodesRef = useRef<Array<HTMLImageElement | HTMLVideoElement>>([]);
  const wasOpenRef = useRef(open);

  const safeInitialIndexForOpen = Math.min(Math.max(initialIndex, 0), Math.max(videos.length - 1, 0));
  const isOpeningRender = open && !wasOpenRef.current;
  const activeCurrentIndex = isOpeningRender ? safeInitialIndexForOpen : currentIndex;
  const rawCurrentVideo = videos[activeCurrentIndex] || null;
  const currentVideo = rawCurrentVideo?.aweme_id
    ? videoOverrides[rawCurrentVideo.aweme_id] || rawCurrentVideo
    : rawCurrentVideo;
  const currentAwemeId = (
    currentVideo?.aweme_id ||
    (currentVideo as unknown as { awemeId?: string; id?: string })?.awemeId ||
    (currentVideo as unknown as { awemeId?: string; id?: string })?.id ||
    ""
  ).trim();
  const mediaItems = useMemo(
    () => (currentVideo ? collectVideoMedia(currentVideo) : []),
    [currentVideo]
  );
  const safeInitialMediaIndexForOpen = Math.min(
    Math.max(initialMediaIndex, 0),
    Math.max(mediaItems.length - 1, 0)
  );
  const activeMediaIndex = isOpeningRender ? safeInitialMediaIndexForOpen : mediaIndex;
  const currentMedia = mediaItems[activeMediaIndex] || mediaItems[0] || null;
  const qualityOptions = useMemo(
    () => currentMedia?.type === "video" ? collectVideoQualityOptions(currentVideo, currentMedia.url) : [],
    [currentMedia?.type, currentMedia?.url, currentVideo]
  );
  const selectedQualityOption = qualityOptions.find((option) => option.key === selectedQualityKey);
  const activeQualityOption =
    selectedQualityKey === "auto" || selectedQualityOption?.isAuto
      ? null
      : selectedQualityOption || null;
  const currentPlaybackUrl =
    currentMedia && currentMedia.type === "video" && activeQualityOption
      ? activeQualityOption.url
      : currentMedia?.url || "";
  const currentMediaSrc = currentMedia
    ? playerMediaProxyUrl(currentPlaybackUrl, getMediaProxyType(currentMedia), reloadKey)
    : "";
  const mediaKey = currentMedia
    ? `${currentVideo?.aweme_id || "video"}-${activeMediaIndex}-${currentMedia.type}-${currentMedia.url}-${reloadKey}`
    : "empty";
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const hasMultipleMedia = mediaItems.length > 1;
  const initialVideoKey = videos[initialIndex]?.aweme_id || "";
  const authorAvatar =
    currentVideo?.author?.avatar_thumb || currentVideo?.author?.avatar_medium || "";
  const authorName =
    currentVideo?.author?.nickname || currentVideo?.author?.unique_id || "用户";
  const canOpenAuthor = Boolean(onAuthor && currentVideo?.author?.sec_uid);
  const likeBaseCount = currentVideo?.statistics?.digg_count || 0;
  const favoriteBaseCount = currentVideo?.statistics?.collect_count || 0;
  const likeCount = Math.max(
    0,
    likeBaseCount + (liked && !currentVideo?.is_liked ? 1 : !liked && currentVideo?.is_liked ? -1 : 0)
  );
  const favoriteCount =
    Math.max(
      0,
      favoriteBaseCount +
        (favorited && !currentVideo?.is_collected ? 1 : !favorited && currentVideo?.is_collected ? -1 : 0)
    );
  const workMusicUrl = getVideoBgmUrl(currentVideo);
  const mediaMusicUrl = getVideoBgmUrl(currentVideo, currentMedia);
  const musicUrl = hasMultipleMedia ? workMusicUrl || mediaMusicUrl : mediaMusicUrl;
  const bgmProxyUrl = musicUrl ? mediaProxyUrl(musicUrl, "audio") : "";
  const effectiveVolume = muted ? 0 : volume;
  const shouldUseBgmForCurrentMedia = Boolean(
    currentMedia &&
      musicUrl &&
      (shouldUseSeparateBgmForVideo(currentMedia, currentVideo) || hasMultipleMedia)
  );
  const shouldAutoPlayCurrentMedia = open && (desiredPlayingRef.current || isOpeningRender);
  const showQualityControl = currentMedia?.type === "video";
  const hasQualityChoices = currentMedia?.type === "video" && qualityOptions.length > 1;

  useEffect(() => {
    setLiked(Boolean(currentVideo?.is_liked));
    setFavorited(Boolean(currentVideo?.is_collected));
    setRelationSubmitting(null);
  }, [currentVideo?.aweme_id, currentVideo?.is_liked, currentVideo?.is_collected]);

  const stopVideoProgressLoop = useCallback(() => {
    if (videoProgressRafRef.current === null) return;
    window.cancelAnimationFrame(videoProgressRafRef.current);
    videoProgressRafRef.current = null;
  }, []);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const clearLoadTimers = useCallback(() => {
    if (loadStatusTimerRef.current) {
      window.clearTimeout(loadStatusTimerRef.current);
      loadStatusTimerRef.current = null;
    }
    if (loadTimeoutTimerRef.current) {
      window.clearTimeout(loadTimeoutTimerRef.current);
      loadTimeoutTimerRef.current = null;
    }
    if (bufferingTimerRef.current) {
      window.clearTimeout(bufferingTimerRef.current);
      bufferingTimerRef.current = null;
    }
  }, []);

  const syncVideoProgress = useCallback((node: HTMLVideoElement) => {
    const nextTime = finiteMediaTime(node.currentTime);
    const nextDuration = readMediaDuration(node);
    setCurrentTime((current) => {
      if (nextTime > 0 || current <= 0) return nextTime;
      if (node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || nextDuration <= 0) {
        return current;
      }
      return nextTime;
    });
    if (nextDuration > 0) {
      setDuration(nextDuration);
    }
  }, []);

  const startVideoProgressLoop = useCallback(() => {
    if (videoProgressRafRef.current !== null) return;

    const tick = () => {
      const node = videoRef.current;
      if (!node) {
        videoProgressRafRef.current = null;
        return;
      }

      const now = performance.now();
      if (now - progressSampleRef.current >= 50 || node.paused || node.ended) {
        progressSampleRef.current = now;
        syncVideoProgress(node);
      }

      if (!node.paused && !node.ended) {
        videoProgressRafRef.current = window.requestAnimationFrame(tick);
      } else {
        videoProgressRafRef.current = null;
      }
    };

    videoProgressRafRef.current = window.requestAnimationFrame(tick);
  }, [syncVideoProgress]);

  const setVideoElementRef = useCallback((node: HTMLVideoElement | null) => {
    if (!node) return;

    const previous = videoRef.current;
    if (previous && previous !== node) {
      releaseMediaElement(previous);
    }
    videoRef.current = node;
  }, []);

  const goToVideo = useCallback((index: number) => {
    if (index < 0 || index >= videos.length) return;
    desiredPlayingRef.current = true;
    mediaSwitchingRef.current = false;
    clearLoadTimers();
    stopVideoProgressLoop();
    releaseMediaElement(videoRef.current);
    setMediaTransitionDirection(0);
    setCurrentIndex(index);
    setMediaIndex(0);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(false);
    setReloadKey((value) => value + 1);
  }, [clearLoadTimers, stopVideoProgressLoop, videos.length]);

  const showNavigationNotice = useCallback((message: string) => {
    setNavigationNotice(message);
    if (navigationNoticeTimerRef.current) {
      window.clearTimeout(navigationNoticeTimerRef.current);
    }
    navigationNoticeTimerRef.current = window.setTimeout(() => {
      setNavigationNotice("");
      navigationNoticeTimerRef.current = null;
    }, 1400);
  }, []);

  const patchCurrentVideoRelation = useCallback((awemeId: string, patch: Partial<VideoInfo>) => {
    setVideoOverrides((current) => {
      const base = current[awemeId] || videos.find((video) => video.aweme_id === awemeId);
      if (!base) return current;
      const nextVideo = {
        ...base,
        ...patch,
        statistics: patch.statistics
          ? {
              ...base.statistics,
              ...patch.statistics,
            }
          : base.statistics,
      };
      onVideoUpdate?.(nextVideo);
      return {
        ...current,
        [awemeId]: nextVideo,
      };
    });
  }, [onVideoUpdate, videos]);

  const refreshCurrentRelationState = useCallback(async (awemeId: string) => {
    if (!awemeId) return;
    const requestSeq = relationRefreshSeqRef.current + 1;
    relationRefreshSeqRef.current = requestSeq;
    setRelationHydrating(true);

    try {
      const result = await getVideoDetail(awemeId);
      if (relationRefreshSeqRef.current !== requestSeq || !result.success || !result.video) {
        return;
      }

      const detail = result.video;
      const nextLiked = Boolean(detail.is_liked);
      const nextCollected = Boolean(detail.is_collected);
      setLiked(nextLiked);
      setFavorited(nextCollected);
      patchCurrentVideoRelation(awemeId, {
        is_liked: nextLiked,
        is_collected: nextCollected,
        statistics: detail.statistics,
      });
    } catch {
      // Keep the list-provided relation state if the detail refresh is blocked.
    } finally {
      if (relationRefreshSeqRef.current === requestSeq) {
        setRelationHydrating(false);
      }
    }
  }, [patchCurrentVideoRelation]);

  useEffect(() => {
    if (!open || loadState !== "ready" || !currentVideo?.aweme_id) return;
    if (relationRefreshedIdsRef.current.has(currentVideo.aweme_id)) return;
    relationRefreshedIdsRef.current.add(currentVideo.aweme_id);
    const timer = window.setTimeout(() => {
      void refreshCurrentRelationState(currentVideo.aweme_id);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [currentVideo?.aweme_id, loadState, open, refreshCurrentRelationState]);

  const toggleLike = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || relationSubmitting) return;

    const previousLiked = liked;
    const nextLiked = !previousLiked;
    const nextCount = Math.max(0, likeBaseCount + (nextLiked ? 1 : -1));
    relationRefreshSeqRef.current += 1;
    setRelationSubmitting("like");
    setLiked(nextLiked);
    patchCurrentVideoRelation(awemeId, {
      is_liked: nextLiked,
      statistics: { ...currentVideo.statistics, digg_count: nextCount },
    });

    try {
      const result = await setVideoLiked(awemeId, nextLiked);
      if (!result.success) throw new Error(result.message || "点赞失败");
      const actualLiked = result.is_liked ?? nextLiked;
      const actualCount = Math.max(0, likeBaseCount + (actualLiked && !previousLiked ? 1 : !actualLiked && previousLiked ? -1 : 0));
      setLiked(actualLiked);
      patchCurrentVideoRelation(awemeId, {
        is_liked: actualLiked,
        statistics: { ...currentVideo.statistics, digg_count: actualCount },
      });
      if (actualLiked !== nextLiked) {
        throw new Error(result.message || "点赞状态未生效");
      }
      showNavigationNotice(actualLiked ? "已点赞" : "已取消点赞");
    } catch (error) {
      setLiked(previousLiked);
      patchCurrentVideoRelation(awemeId, {
        is_liked: previousLiked,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "点赞失败");
    } finally {
      setRelationSubmitting(null);
    }
  }, [currentVideo, likeBaseCount, liked, patchCurrentVideoRelation, relationSubmitting, showNavigationNotice]);

  const toggleCollect = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || relationSubmitting) return;

    const previousCollected = favorited;
    const nextCollected = !previousCollected;
    const nextCount = Math.max(0, favoriteBaseCount + (nextCollected ? 1 : -1));
    relationRefreshSeqRef.current += 1;
    setRelationSubmitting("collect");
    setFavorited(nextCollected);
    patchCurrentVideoRelation(awemeId, {
      is_collected: nextCollected,
      statistics: { ...currentVideo.statistics, collect_count: nextCount },
    });

    try {
      const result = await setVideoCollected(awemeId, nextCollected);
      if (!result.success) throw new Error(result.message || "收藏失败");
      showNavigationNotice(nextCollected ? "已收藏" : "已取消收藏");
    } catch (error) {
      setFavorited(previousCollected);
      patchCurrentVideoRelation(awemeId, {
        is_collected: previousCollected,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "收藏失败");
    } finally {
      setRelationSubmitting(null);
    }
  }, [currentVideo, favoriteBaseCount, favorited, patchCurrentVideoRelation, relationSubmitting, showNavigationNotice]);

  const playNextVideo = useCallback(() => {
    if (currentIndex < videos.length - 1) {
      goToVideo(currentIndex + 1);
      return;
    }
    if (onLoadMore) {
      showNavigationNotice("正在加载更多视频...");
      onLoadMore();
      return;
    }
    showNavigationNotice("已经是最后一个视频");
  }, [currentIndex, goToVideo, onLoadMore, showNavigationNotice, videos.length]);

  const playPrevVideo = useCallback(() => {
    if (currentIndex > 0) {
      goToVideo(currentIndex - 1);
      return;
    }
    showNavigationNotice("已经是第一个视频");
  }, [currentIndex, goToVideo, showNavigationNotice]);

  const releaseMediaSwitchSoon = useCallback(() => {
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    mediaSwitchReleaseRef.current = window.setTimeout(() => {
      mediaSwitchingRef.current = false;
      mediaSwitchReleaseRef.current = null;
    }, 650);
  }, []);

  const switchToMedia = useCallback((index: number) => {
    if (mediaItems.length === 0) return;
    const safeIndex = ((index % mediaItems.length) + mediaItems.length) % mediaItems.length;
    const direction = resolveMediaDirection(mediaIndex, safeIndex, mediaItems.length);
    const shouldKeepPlaying = desiredPlayingRef.current || playing;
    desiredPlayingRef.current = shouldKeepPlaying;
    mediaSwitchingRef.current = true;
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    setMediaIndex(safeIndex);
    setMediaTransitionDirection(direction);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(shouldKeepPlaying);
    releaseMediaSwitchSoon();
  }, [mediaItems.length, playing, releaseMediaSwitchSoon]);

  const playNextMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex + 1);
      return;
    }
    playNextVideo();
  }, [mediaIndex, mediaItems.length, playNextVideo, switchToMedia]);

  const playPrevMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex - 1);
      return;
    }
    playPrevVideo();
  }, [mediaIndex, mediaItems.length, playPrevVideo, switchToMedia]);

  const advanceMediaSequence = useCallback(() => {
    if (mediaItems.length === 0) return;
    desiredPlayingRef.current = true;
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex + 1);
      return;
    }
    imageAdvanceQueued.current = false;
    setCurrentTime(0);
    setDuration(IMAGE_DURATION_SECONDS);
    setPlaying(true);
    setReloadKey((value) => value + 1);
  }, [mediaIndex, mediaItems.length, switchToMedia]);

  const requestAdvanceMediaSequence = useCallback(() => {
    window.requestAnimationFrame(() => {
      advanceMediaSequence();
    });
  }, [advanceMediaSequence]);

  const togglePlay = useCallback(() => {
    if (!currentMedia) return;
    if (!isVideoLikeMedia(currentMedia)) {
      setPlaying((value) => {
        desiredPlayingRef.current = !value;
        return !value;
      });
      return;
    }

    const node = videoRef.current || getDocumentVideoNode(surfaceHitRef.current);
    if (!node) return;
    if (node.paused) {
      desiredPlayingRef.current = true;
      void node.play().then(() => {
        setPlaying(true);
        startVideoProgressLoop();
      }).catch(() => setPlaying(false));
    } else {
      desiredPlayingRef.current = false;
      node.pause();
      setPlaying(false);
    }
  }, [currentMedia, startVideoProgressLoop]);

  const togglePlayFromSurface = useCallback((action?: "play" | "pause") => {
    const now = Date.now();
    if (now - lastSurfaceToggleAtRef.current < 420) return;
    lastSurfaceToggleAtRef.current = now;

    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    if (node) {
      const surfaceLabel = surfaceHitRef.current?.getAttribute("aria-label");
      const shouldPause = action ? action === "pause" : surfaceLabel === "暂停" || playingRef.current;
      if (!shouldPause) {
        desiredPlayingRef.current = true;
        void node.play().then(() => {
          playingRef.current = true;
          setPlaying(true);
          startVideoProgressLoop();
        }).catch(() => setPlaying(false));
      } else {
        desiredPlayingRef.current = false;
        playingRef.current = false;
        setPlaying(false);
        try {
          node.pause();
        } catch {
          // Some embedded webviews expose media methods late; keep UI state consistent.
        }
      }
      return;
    }

    togglePlay();
  }, [startVideoProgressLoop, togglePlay]);

  const rememberSurfaceTap = useCallback((x: number, y: number) => {
    surfaceTapStartRef.current = { x, y, at: Date.now() };
  }, []);

  const finishSurfaceTap = useCallback((x: number, y: number) => {
    const start = surfaceTapStartRef.current;
    surfaceTapStartRef.current = null;
    if (!start) return;
    if (Date.now() - start.at > 700) return;
    if (Math.abs(x - start.x) > 14 || Math.abs(y - start.y) > 14) return;
    togglePlayFromSurface();
  }, [togglePlayFromSurface]);

  const handleSurfacePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    rememberSurfaceTap(event.clientX, event.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfacePointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    finishSurfaceTap(event.clientX, event.clientY);
  }, [finishSurfaceTap]);

  const handleSurfacePointerCancel = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
    surfaceTapStartRef.current = null;
  }, []);

  const handleSurfaceMouseDown = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    rememberSurfaceTap(event.clientX, event.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfaceMouseUp = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    finishSurfaceTap(event.clientX, event.clientY);
  }, [finishSurfaceTap]);

  const handleSurfaceTouchStart = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    rememberSurfaceTap(touch.clientX, touch.clientY);
  }, [rememberSurfaceTap]);

  const handleSurfaceTouchEnd = useCallback((event: ReactTouchEvent<HTMLElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    finishSurfaceTap(touch.clientX, touch.clientY);
  }, [finishSurfaceTap]);

  const handleSurfaceClick = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
    togglePlayFromSurface(event.currentTarget.getAttribute("aria-label") === "暂停" ? "pause" : "play");
  }, [togglePlayFromSurface]);

  useEffect(() => {
    if (!open) return;
    const node = surfaceHitRef.current;
    if (!node) return;

    const handleNativePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      rememberSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativePointerUp = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      surfaceTapStartRef.current = null;
    };
    const handleNativePointerCancel = (event: PointerEvent) => {
      event.stopPropagation();
      surfaceTapStartRef.current = null;
    };
    const handleNativeMouseDown = (event: MouseEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      rememberSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativeMouseUp = (event: MouseEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      finishSurfaceTap(event.clientX, event.clientY);
    };
    const handleNativeTouchStart = (event: TouchEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.stopPropagation();
      rememberSurfaceTap(touch.clientX, touch.clientY);
    };
    const handleNativeTouchEnd = (event: TouchEvent) => {
      const ownerWindow = node.ownerDocument.defaultView || window;
      if (typeof ownerWindow.PointerEvent !== "undefined") return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      event.stopPropagation();
      finishSurfaceTap(touch.clientX, touch.clientY);
    };
    const handleNativeClick = (event: MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      togglePlayFromSurface(node.getAttribute("aria-label") === "暂停" ? "pause" : "play");
    };

    node.addEventListener("pointerdown", handleNativePointerDown);
    node.addEventListener("pointerup", handleNativePointerUp);
    node.addEventListener("pointercancel", handleNativePointerCancel);
    node.addEventListener("mousedown", handleNativeMouseDown);
    node.addEventListener("mouseup", handleNativeMouseUp);
    node.addEventListener("touchstart", handleNativeTouchStart, { passive: false });
    node.addEventListener("touchend", handleNativeTouchEnd, { passive: false });
    node.addEventListener("touchcancel", handleNativeTouchEnd, { passive: false });
    node.addEventListener("click", handleNativeClick);

    return () => {
      node.removeEventListener("pointerdown", handleNativePointerDown);
      node.removeEventListener("pointerup", handleNativePointerUp);
      node.removeEventListener("pointercancel", handleNativePointerCancel);
      node.removeEventListener("mousedown", handleNativeMouseDown);
      node.removeEventListener("mouseup", handleNativeMouseUp);
      node.removeEventListener("touchstart", handleNativeTouchStart);
      node.removeEventListener("touchend", handleNativeTouchEnd);
      node.removeEventListener("touchcancel", handleNativeTouchEnd);
      node.removeEventListener("click", handleNativeClick);
    };
  }, [finishSurfaceTap, open, rememberSurfaceTap, togglePlayFromSurface]);

  const clearPanelCloseTimer = useCallback(() => {
    if (!panelCloseTimerRef.current) return;
    window.clearTimeout(panelCloseTimerRef.current);
    panelCloseTimerRef.current = null;
  }, []);

  const openToolPanel = useCallback((panel: PlayerPanel) => {
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const schedulePanelClose = useCallback((panel?: PlayerPanel) => {
    clearPanelCloseTimer();
    panelCloseTimerRef.current = window.setTimeout(() => {
      setOpenPanel((value) => (!panel || value === panel ? null : value));
      panelCloseTimerRef.current = null;
    }, PLAYER_PANEL_CLOSE_DELAY_MS);
  }, [clearPanelCloseTimer]);

  const openPanelOnPointerEnter = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    openToolPanel(panel);
  }, [openToolPanel]);

  const closePanelOnPointerLeave = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    schedulePanelClose(panel);
  }, [schedulePanelClose]);

  const togglePanel = useCallback((panel: PlayerPanel, event: ReactMouseEvent) => {
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const openPanelOnPointerDown = useCallback((panel: PlayerPanel, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(panel);
  }, [clearPanelCloseTimer]);

  const copyCurrentMediaUrl = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    const url = currentPlaybackUrl || currentMedia?.url || "";
    if (!url) return;
    void copyTextToClipboard(url).then((success) => {
      if (success) setOpenPanel(null);
    });
  }, [currentMedia?.url, currentPlaybackUrl]);

  const handleDownloadCurrent = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(null);

    if (!currentVideo || !onDownload || downloadSubmitting) return;

    setDownloadSubmitting(true);
    Promise.resolve(onDownload(currentVideo)).finally(() => {
      window.setTimeout(() => setDownloadSubmitting(false), 350);
    });
  }, [clearPanelCloseTimer, currentVideo, downloadSubmitting, onDownload]);

  const loadShareFriends = useCallback(async () => {
    if (shareFriendsLoading || shareFriendsLoaded) return;
    setShareFriendsLoading(true);
    setShareFriendsError("");
    try {
      const result = await getShareFriends(50);
      if (!result.success) {
        throw new Error(result.message || "获取好友列表失败");
      }
      setShareFriends(Array.isArray(result.friends) ? result.friends : []);
      setShareFriendsLoaded(true);
    } catch (error) {
      setShareFriendsError(error instanceof Error ? error.message : "获取好友列表失败");
    } finally {
      setShareFriendsLoading(false);
    }
  }, [shareFriendsLoaded, shareFriendsLoading]);

  const handleShareFriendClick = useCallback(async (friend: ShareFriend, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!currentVideo || shareSendingFriendKey) return;
    const toUserId = String(friend.uid || "").trim();
    if (!toUserId) {
      showNavigationNotice("这个好友缺少 uid，暂时无法分享");
      return;
    }
    const friendKey = friend.sec_uid || friend.uid;
    setShareSendingFriendKey(friendKey);
    try {
      const result = await sendFriendVideoShare({ toUserId, video: currentVideo });
      if (!result.success) {
        throw new Error(result.message || "分享失败");
      }
      setShareSentFriendKeys((prev) => {
        const next = new Set(prev);
        next.add(friendKey);
        return next;
      });
      showNavigationNotice(friend.nickname ? `已分享给 ${friend.nickname}` : "已分享给好友");
    } catch (error) {
      showNavigationNotice(error instanceof Error ? error.message : "分享失败");
    } finally {
      setShareSendingFriendKey("");
    }
  }, [currentVideo, shareSendingFriendKey, showNavigationNotice]);

  const loadComments = useCallback(async (mode: "initial" | "more" = "initial") => {
    if (!currentVideo?.aweme_id || commentsLoading) return;
    const isMore = mode === "more";
    setCommentsLoading(true);
    setCommentsError("");
    try {
      const result = await getComments(currentVideo.aweme_id, 20, isMore ? commentsCursor : 0);
      if (!result.success) {
        throw new Error(result.message || "获取评论失败");
      }
      const nextComments = Array.isArray(result.comments) ? result.comments : [];
      setComments((prev) => (isMore ? [...prev, ...nextComments] : nextComments));
      setCommentsCursor(Number(result.cursor || 0));
      setCommentsHasMore(Boolean(result.has_more));
      setCommentsTotal(Number(result.total || 0));
      setCommentsLoadedAwemeId(currentVideo.aweme_id);
    } catch (error) {
      setCommentsError(error instanceof Error ? error.message : "获取评论失败");
      if (!isMore) {
        setComments([]);
        setCommentsHasMore(false);
      }
    } finally {
      setCommentsLoading(false);
    }
  }, [commentsCursor, commentsLoading, currentVideo?.aweme_id]);

  const loadCommentReplies = useCallback(async (comment: CommentInfo, mode: "initial" | "more" = "initial") => {
    if (!currentVideo?.aweme_id || !comment.cid) return;
    const currentState = commentReplies[comment.cid];
    if (currentState?.loading) return;
    const isMore = mode === "more";
    const cursor = isMore ? currentState?.cursor || 0 : 0;

    setCommentReplies((prev) => ({
      ...prev,
      [comment.cid]: {
        items: isMore ? prev[comment.cid]?.items || [] : prev[comment.cid]?.items || [],
        cursor,
        hasMore: isMore ? prev[comment.cid]?.hasMore ?? false : prev[comment.cid]?.hasMore ?? false,
        loading: true,
        error: "",
        total: prev[comment.cid]?.total || comment.reply_comment_total || 0,
        loaded: prev[comment.cid]?.loaded || false,
      },
    }));

    try {
      const result = await getCommentReplies(currentVideo.aweme_id, comment.cid, 6, cursor);
      if (!result.success) {
        throw new Error(result.message || "获取回复失败");
      }
      const nextReplies = Array.isArray(result.comments) ? result.comments : [];
      setCommentReplies((prev) => {
        const previous = prev[comment.cid];
        return {
          ...prev,
          [comment.cid]: {
            items: isMore ? [...(previous?.items || []), ...nextReplies] : nextReplies,
            cursor: Number(result.cursor || 0),
            hasMore: Boolean(result.has_more),
            loading: false,
            error: "",
            total: Number(result.total || comment.reply_comment_total || nextReplies.length || 0),
            loaded: true,
          },
        };
      });
    } catch (error) {
      setCommentReplies((prev) => ({
        ...prev,
        [comment.cid]: {
          items: prev[comment.cid]?.items || [],
          cursor: prev[comment.cid]?.cursor || 0,
          hasMore: prev[comment.cid]?.hasMore || false,
          loading: false,
          error: error instanceof Error ? error.message : "获取回复失败",
          total: prev[comment.cid]?.total || comment.reply_comment_total || 0,
          loaded: true,
        },
      }));
    }
  }, [commentReplies, currentVideo?.aweme_id]);

  const toggleCommentReplies = useCallback((comment: CommentInfo) => {
    const willExpand = !expandedCommentReplyIds.has(comment.cid);
    setExpandedCommentReplyIds((prev) => {
      const next = new Set(prev);
      if (willExpand) {
        next.add(comment.cid);
      } else {
        next.delete(comment.cid);
      }
      return next;
    });
    const replyState = commentReplies[comment.cid];
    if (willExpand && !replyState?.loaded && !replyState?.loading) {
      void loadCommentReplies(comment, "initial");
    }
  }, [commentReplies, expandedCommentReplyIds, loadCommentReplies]);

  const updateCommentById = useCallback((commentId: string, updater: (comment: CommentInfo) => CommentInfo) => {
    setComments((prev) => prev.map((comment) => (comment.cid === commentId ? updater(comment) : comment)));
    setCommentReplies((prev) => {
      let changed = false;
      const next: CommentRepliesState = {};
      for (const [cid, state] of Object.entries(prev)) {
        const nextItems = state.items.map((reply) => {
          if (reply.cid !== commentId) return reply;
          changed = true;
          return updater(reply);
        });
        next[cid] = changed ? { ...state, items: nextItems } : state;
      }
      return changed ? next : prev;
    });
  }, []);

  const toggleCommentLike = useCallback(async (comment: CommentInfo, level: number) => {
    if (!currentVideo?.aweme_id || !comment.cid || commentDiggingIds.has(comment.cid)) return;
    const wasLiked = Number(comment.user_digged || 0) > 0;
    const nextLiked = !wasLiked;
    const delta = nextLiked ? 1 : -1;

    setCommentDiggingIds((prev) => new Set(prev).add(comment.cid));
    updateCommentById(comment.cid, (item) => ({
      ...item,
      user_digged: nextLiked ? 1 : 0,
      digg_count: Math.max(0, Number(item.digg_count || 0) + delta),
    }));

    try {
      const result = await setCommentLiked(currentVideo.aweme_id, comment.cid, nextLiked, level);
      if (!result.success) {
        throw new Error(result.message || "评论点赞失败");
      }
    } catch (error) {
      updateCommentById(comment.cid, (item) => ({
        ...item,
        user_digged: wasLiked ? 1 : 0,
        digg_count: Math.max(0, Number(item.digg_count || 0) - delta),
      }));
      showNavigationNotice(error instanceof Error ? error.message : "评论点赞失败");
    } finally {
      setCommentDiggingIds((prev) => {
        const next = new Set(prev);
        next.delete(comment.cid);
        return next;
      });
    }
  }, [commentDiggingIds, currentVideo?.aweme_id, showNavigationNotice, updateCommentById]);

  const submitComment = useCallback(async () => {
    const text = commentDraft.trim();
    if (commentSubmitting) return;
    if (!text) {
      showNavigationNotice("请输入评论内容");
      return;
    }
    if (!currentAwemeId) {
      showNavigationNotice("缺少视频ID，无法发表评论");
      return;
    }
    const target = commentReplyTarget;
    setCommentSubmitting(true);
    try {
      const result = await publishComment(
        currentAwemeId,
        text,
        target?.replyId || "",
        target?.replyToReplyId || ""
      );
      if (!result.success) {
        throw new Error(result.message || "发表评论失败");
      }
      const created = result.comment;
      if (created?.cid) {
        if (target?.replyId) {
          setExpandedCommentReplyIds((prev) => new Set(prev).add(target.replyId));
          setCommentReplies((prev) => {
            const current = prev[target.replyId] || {
              items: [],
              cursor: 0,
              hasMore: false,
              loading: false,
              error: "",
              total: 0,
              loaded: true,
            };
            return {
              ...prev,
              [target.replyId]: {
                ...current,
                items: [created, ...current.items],
                total: current.total + 1,
                loaded: true,
              },
            };
          });
          updateCommentById(target.replyId, (item) => ({
            ...item,
            reply_comment_total: Number(item.reply_comment_total || 0) + 1,
          }));
        } else {
          setComments((prev) => [created, ...prev]);
          setCommentsTotal((prev) => prev + 1);
        }
      } else if (target?.replyId) {
        void loadCommentReplies({ cid: target.replyId } as CommentInfo, "initial");
      } else {
        void loadComments("initial");
      }
      setCommentDraft("");
      setCommentReplyTarget(null);
      showNavigationNotice("评论已发布");
    } catch (error) {
      showNavigationNotice(error instanceof Error ? error.message : "发表评论失败");
    } finally {
      setCommentSubmitting(false);
    }
  }, [
    commentDraft,
    commentReplyTarget,
    commentSubmitting,
    currentAwemeId,
    loadCommentReplies,
    loadComments,
    showNavigationNotice,
    updateCommentById,
  ]);

  const handleCommentsScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceToBottom > 96 || commentsLoading || !commentsHasMore) return;
    void loadComments("more");
  }, [commentsHasMore, commentsLoading, loadComments]);

  const clearCommentsHoverCloseTimer = useCallback(() => {
    if (commentsHoverCloseTimerRef.current) {
      window.clearTimeout(commentsHoverCloseTimerRef.current);
      commentsHoverCloseTimerRef.current = null;
    }
  }, []);

  const openCommentsPanel = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>, options?: { sticky?: boolean }) => {
    event?.stopPropagation();
    clearPanelCloseTimer();
    clearCommentsHoverCloseTimer();
    if (options?.sticky) {
      commentsPanelStickyRef.current = true;
    } else if (!commentsOpen) {
      commentsPanelStickyRef.current = false;
    }
    setOpenPanel(null);
    setCommentsOpen(true);
  }, [clearCommentsHoverCloseTimer, clearPanelCloseTimer, commentsOpen]);

  const markCommentsPanelSticky = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = true;
  }, [clearCommentsHoverCloseTimer]);

  const scheduleTransientCommentsClose = useCallback((event?: ReactMouseEvent | ReactPointerEvent<HTMLElement>) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsHoverCloseTimerRef.current = window.setTimeout(() => {
      if (!commentsPanelStickyRef.current) {
        setCommentsOpen(false);
      }
      commentsHoverCloseTimerRef.current = null;
    }, 180);
  }, [clearCommentsHoverCloseTimer]);

  const closeCommentsPanel = useCallback((event?: ReactMouseEvent) => {
    event?.stopPropagation();
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = false;
    setCommentsOpen(false);
  }, [clearCommentsHoverCloseTimer]);

  const toggleMute = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    if (muted && volume === 0) {
      setVolume(50);
    }
    setMuted((value) => !value);
  }, [muted, volume]);

  const handleVolumeChange = useCallback((nextVolume: number) => {
    const safeVolume = Math.max(0, Math.min(100, nextVolume));
    setVolume(safeVolume);
    setMuted(safeVolume === 0);
  }, []);

  const syncPlaybackRate = useCallback((rate: number) => {
    playbackRateRef.current = rate;
    applyPlaybackRateToNode(videoRef.current || getDocumentVideoNode(playerRootRef.current), rate);
    applyPlaybackRateToNode(bgmRef.current, rate);
  }, []);

  const handlePlaybackRateChange = useCallback((rate: number, event: ReactMouseEvent) => {
    event.stopPropagation();
    setPlaybackRate(rate);
    syncPlaybackRate(rate);
    window.requestAnimationFrame(() => syncPlaybackRate(rate));
    window.setTimeout(() => syncPlaybackRate(rate), 120);
    setOpenPanel(null);
  }, [syncPlaybackRate]);

  const handleQualityChange = useCallback((qualityKey: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (qualityKey === selectedQualityKey) {
      setOpenPanel(null);
      return;
    }

    const nextQualityOption = qualityOptions.find((option) => option.key === qualityKey);
    const nextPlaybackUrl =
      currentMedia && currentMedia.type === "video" && nextQualityOption
        ? nextQualityOption.url
        : currentMedia?.url || "";
    const nextMediaSrc = currentMedia
      ? playerMediaProxyUrl(nextPlaybackUrl, getMediaProxyType(currentMedia), reloadKey)
      : "";
    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    const nextTime = node ? finiteMediaTime(node.currentTime) : currentTime;
    const shouldResume = playingRef.current || desiredPlayingRef.current;
    pendingQualitySeekRef.current = nextTime > 0 ? nextTime : null;
    desiredPlayingRef.current = shouldResume;
    mediaSwitchingRef.current = true;
    qualitySwitchingRef.current = true;
    if (qualitySwitchReleaseRef.current) {
      window.clearTimeout(qualitySwitchReleaseRef.current);
    }
    qualitySwitchReleaseRef.current = window.setTimeout(() => {
      qualitySwitchingRef.current = false;
      qualitySwitchReleaseRef.current = null;
    }, 8000);
    setSelectedQualityKey(qualityKey);
    setPlaying(shouldResume);
    setLoadState("loading");
    setShowLoadStatus(true);
    setDuration(0);
    setOpenPanel(null);

    if (node && nextMediaSrc) {
      node.src = nextMediaSrc;
      node.volume = effectiveVolume / 100;
      const targetMuted = shouldUseBgmForCurrentMedia || muted || volume === 0;
      node.muted = shouldResume && !targetMuted ? true : targetMuted;
      applyPlaybackRateToNode(node, playbackRateRef.current);
      node.load();
      if (shouldResume) {
        void node.play().then(() => {
          node.muted = targetMuted;
          playingRef.current = true;
          setPlaying(true);
          startVideoProgressLoop();
        }).catch(() => {
          node.muted = targetMuted;
          setPlaying(false);
        });
      }
    }
  }, [
    currentMedia,
    currentTime,
    effectiveVolume,
    muted,
    playbackRate,
    qualityOptions,
    reloadKey,
    selectedQualityKey,
    shouldUseBgmForCurrentMedia,
    startVideoProgressLoop,
    volume,
  ]);

  const restorePendingQualitySeek = useCallback((node: HTMLVideoElement) => {
    const pendingTime = pendingQualitySeekRef.current;
    if (!pendingTime || pendingTime <= 0) return;

    const nodeDuration = readMediaDuration(node);
    const safeTime = nodeDuration > 0 ? Math.min(pendingTime, Math.max(0, nodeDuration - 0.15)) : pendingTime;
    try {
      node.currentTime = safeTime;
      setCurrentTime(safeTime);
      pendingQualitySeekRef.current = null;
    } catch {
      // Some streams reject early seeking until canplay; the next metadata event will keep playback usable.
    }
  }, []);

  const resumeVideoIfDesired = useCallback((node: HTMLVideoElement) => {
    if (!desiredPlayingRef.current || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    const targetMuted = shouldUseBgmForCurrentMedia || muted || volume === 0;
    const shouldTemporarilyMute = qualitySwitchingRef.current && !targetMuted;
    if (!node.paused) {
      node.muted = targetMuted;
      setPlaying(true);
      startVideoProgressLoop();
      return;
    }

    if (shouldTemporarilyMute) {
      node.muted = true;
    }
    void node.play().then(() => {
      node.muted = targetMuted;
      playingRef.current = true;
      setPlaying(true);
      startVideoProgressLoop();
    }).catch(() => {
      node.muted = targetMuted;
      setPlaying(false);
    });
  }, [currentMedia, muted, shouldUseBgmForCurrentMedia, startVideoProgressLoop, volume]);

  const ensureBgmSource = useCallback(() => {
    const audio = bgmRef.current;
    if (!audio || !bgmProxyUrl) return null;
    if (bgmSourceKeyRef.current !== bgmProxyUrl) {
      bgmPlayRequestSeqRef.current += 1;
      bgmPlayPendingRef.current = false;
      bgmSourceKeyRef.current = bgmProxyUrl;
      audio.src = bgmProxyUrl;
      audio.loop = true;
      audio.preload = "auto";
      audio.load();
    }
    audio.volume = effectiveVolume / 100;
    audio.muted = muted || volume === 0;
    applyPlaybackRateToNode(audio, playbackRateRef.current);
    return audio;
  }, [bgmProxyUrl, effectiveVolume, muted, volume]);

  const playBgm = useCallback(() => {
    if (bgmManuallyPausedRef.current) {
      bgmDesiredPlayingRef.current = false;
      return;
    }
    bgmDesiredPlayingRef.current = true;
    const audio = ensureBgmSource();
    if (!audio) return;
    if (!audio.paused && !audio.ended) {
      bgmPlayPendingRef.current = false;
      setBgmPlaying(true);
      return;
    }
    if (bgmPlayPendingRef.current) return;

    const requestSeq = ++bgmPlayRequestSeqRef.current;
    bgmPlayPendingRef.current = true;
    void audio.play().then(() => {
      if (requestSeq !== bgmPlayRequestSeqRef.current) return;
      bgmPlayPendingRef.current = false;
      if (!bgmDesiredPlayingRef.current || bgmManuallyPausedRef.current) {
        audio.pause();
        setBgmPlaying(false);
        return;
      }
      setBgmPlaying(true);
    }).catch(() => {
      if (requestSeq !== bgmPlayRequestSeqRef.current) return;
      bgmPlayPendingRef.current = false;
      setBgmPlaying(false);
    });
  }, [ensureBgmSource]);

  const pauseBgm = useCallback(() => {
    bgmDesiredPlayingRef.current = false;
    bgmPlayRequestSeqRef.current += 1;
    bgmPlayPendingRef.current = false;
    const audio = bgmRef.current;
    if (!audio) return;
    audio.pause();
    setBgmPlaying(false);
  }, []);

  const releaseBgm = useCallback(() => {
    bgmDesiredPlayingRef.current = false;
    bgmPlayRequestSeqRef.current += 1;
    bgmPlayPendingRef.current = false;
    const audio = bgmRef.current;
    bgmSourceKeyRef.current = "";
    releaseMediaElement(audio);
    setBgmPlaying(false);
  }, []);

  const toggleBgm = useCallback((event: ReactMouseEvent) => {
    event.stopPropagation();
    const audio = ensureBgmSource();
    if (!audio) return;
    if (audio.paused) {
      bgmManuallyPausedRef.current = false;
      playBgm();
    } else {
      bgmManuallyPausedRef.current = true;
      pauseBgm();
    }
  }, [ensureBgmSource, pauseBgm, playBgm]);

  const handleSeek = useCallback((nextTime: number) => {
    if (!duration) return;
    const safeTime = Math.max(0, Math.min(duration, nextTime));
    setCurrentTime(safeTime);
    progressSampleRef.current = performance.now();

    const node = videoRef.current || getDocumentVideoNode(playerRootRef.current);
    if (currentMedia && isVideoLikeMedia(currentMedia) && node) {
      try {
        if (typeof node.fastSeek === "function") {
          node.fastSeek(safeTime);
        } else {
          node.currentTime = safeTime;
        }
      } catch {
        try {
          node.currentTime = safeTime;
        } catch {
          return;
        }
      }

      window.requestAnimationFrame(() => {
        if (videoRef.current !== node) return;
        const actualTime = finiteMediaTime(node.currentTime);
        setCurrentTime(actualTime || safeTime);
      });
    }
  }, [currentMedia, duration]);

  const refreshCurrentVideoDetail = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || refreshingDetailRef.current || refreshedDetailIdsRef.current.has(awemeId)) {
      return false;
    }

    refreshingDetailRef.current = true;
    refreshedDetailIdsRef.current.add(awemeId);
    setLoadState("loading");
    setShowLoadStatus(true);

    try {
      const result = await getVideoDetail(awemeId);
      if (!result.success || !result.video) {
        return false;
      }

      setVideoOverrides((current) => ({
        ...current,
        [awemeId]: result.video as VideoInfo,
      }));
      setMediaIndex(0);
      setCurrentTime(0);
      setDuration(0);
      setReloadKey((value) => value + 1);
      return true;
    } catch {
      return false;
    } finally {
      refreshingDetailRef.current = false;
    }
  }, [currentVideo?.aweme_id]);

  const retryCurrentMedia = useCallback((event?: ReactMouseEvent, auto = false) => {
    event?.stopPropagation();
    if (!auto && currentVideo?.aweme_id) {
      refreshedDetailIdsRef.current.delete(currentVideo.aweme_id);
    }
    clearLoadTimers();
    autoRetryCountRef.current = auto ? autoRetryCountRef.current : 0;
    setLoadState("loading");
    setShowLoadStatus(true);
    setCurrentTime(0);
    setDuration(0);
    setReloadKey((value) => value + 1);
  }, [clearLoadTimers, currentVideo?.aweme_id]);

  const markMediaReady = useCallback(() => {
    clearLoadTimers();
    setLoadState("ready");
    setShowLoadStatus(false);
    mediaSwitchingRef.current = false;
  }, [clearLoadTimers]);

  const handleMediaFailure = useCallback(async () => {
    clearLoadTimers();
    stopVideoProgressLoop();
    mediaSwitchingRef.current = false;

    const mediaErrorCode = videoRef.current?.error?.code || 0;
    const canAutoRetry =
      (typeof navigator === "undefined" || navigator.onLine !== false) &&
      (mediaErrorCode === 0 || mediaErrorCode === 2 || mediaErrorCode === 4) &&
      autoRetryCountRef.current < PLAYER_VIDEO_MAX_AUTO_RETRIES;

    if (canAutoRetry) {
      autoRetryCountRef.current += 1;
      retryCurrentMedia(undefined, true);
      return;
    }

    const refreshed = await refreshCurrentVideoDetail();
    if (refreshed) return;

    setLoadState("error");
    setPlaying(false);
    setShowLoadStatus(true);
  }, [clearLoadTimers, refreshCurrentVideoDetail, retryCurrentMedia, stopVideoProgressLoop]);

  const scheduleLoadTimeout = useCallback(() => {
    if (loadTimeoutTimerRef.current) {
      window.clearTimeout(loadTimeoutTimerRef.current);
    }

    loadTimeoutTimerRef.current = window.setTimeout(() => {
      const node = videoRef.current;
      if (!currentMedia || !isVideoLikeMedia(currentMedia)) return;
      if (!desiredPlayingRef.current || node?.paused) return;
      if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      void handleMediaFailure();
    }, PLAYER_VIDEO_LOAD_TIMEOUT_MS);
  }, [currentMedia, handleMediaFailure]);

  const showBufferingSoon = useCallback(() => {
    if (bufferingTimerRef.current) {
      window.clearTimeout(bufferingTimerRef.current);
    }
    bufferingTimerRef.current = window.setTimeout(() => {
      const node = videoRef.current;
      if (!desiredPlayingRef.current || node?.paused) return;
      if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
      setLoadState("loading");
      setShowLoadStatus(true);
    }, PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS);
  }, []);

  const preloadMediaItem = useCallback((media: VideoMediaItem | null | undefined, full = false) => {
    if (!media) return;

    const proxiedUrl = mediaProxyUrl(media.url, getMediaProxyType(media));
    const key = `${media.type}::${proxiedUrl}`;
    if (!proxiedUrl) return;

    const existingFullPreload = preloadedMediaRef.current.get(key);
    if (existingFullPreload || (!full && preloadedMediaRef.current.has(key))) return;
    preloadedMediaRef.current.set(key, full);

    if (media.type === "image") {
      const image = new Image();
      image.decoding = "async";
      image.loading = "eager";
      image.src = proxiedUrl;
      preloadedNodesRef.current.push(image);
    } else {
      const video = document.createElement("video");
      video.preload = full ? "auto" : "metadata";
      video.muted = true;
      video.playsInline = true;
      video.src = proxiedUrl;
      video.load();
      preloadedNodesRef.current.push(video);
    }

    while (preloadedNodesRef.current.length > MAX_PRELOADED_MEDIA_NODES) {
      const removed = preloadedNodesRef.current.shift();
      if (removed instanceof HTMLVideoElement) {
        releaseMediaElement(removed);
      } else if (removed) {
        removed.removeAttribute("src");
      }
    }
  }, []);

  const releasePreloadedMedia = useCallback(() => {
    preloadedMediaRef.current.clear();
    for (const node of preloadedNodesRef.current) {
      if (node instanceof HTMLVideoElement) {
        releaseMediaElement(node);
      } else {
        node.removeAttribute("src");
      }
    }
    preloadedNodesRef.current = [];
  }, []);

  const preloadVideoAtIndex = useCallback((index: number, full = false) => {
    const video = videos[index];
    if (!video) return;
    const firstMedia = collectVideoMedia(video)[0];
    preloadMediaItem(firstMedia, full);
  }, [preloadMediaItem, videos]);

  const releasePlayerMediaResources = useCallback(() => {
    desiredPlayingRef.current = false;
    playingRef.current = false;
    mediaSwitchingRef.current = false;
    qualitySwitchingRef.current = false;
    clearLoadTimers();
    stopVideoProgressLoop();
    releaseMediaElement(videoRef.current);
    releaseScopedMediaElements(playerRootRef.current);
    releaseBgm();
    releasePreloadedMedia();
  }, [clearLoadTimers, releaseBgm, releasePreloadedMedia, stopVideoProgressLoop]);

  const closePlayer = useCallback(() => {
    wasOpenRef.current = false;
    releasePlayerMediaResources();
    setPlaying(false);
    setShowLoadStatus(false);
    onClose();
  }, [onClose, releasePlayerMediaResources]);

  useEffect(() => {
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      playerRootRef.current?.focus({ preventScroll: true });
    }, 0);

    const safeIndex = Math.min(Math.max(initialIndex, 0), Math.max(videos.length - 1, 0));
    const initialMediaCount = collectVideoMedia(videos[safeIndex]).length;
    const safeMediaIndex = Math.min(
      Math.max(initialMediaIndex, 0),
      Math.max(initialMediaCount - 1, 0)
    );
    desiredPlayingRef.current = true;
    mediaSwitchingRef.current = false;
    setMediaTransitionDirection(0);
    setCurrentIndex(safeIndex);
    setMediaIndex(safeMediaIndex);
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(false);
    return () => window.clearTimeout(focusTimer);
  }, [initialIndex, initialMediaIndex, initialVideoKey, open]);

  useEffect(() => {
    setOpenPanel(null);
    setComments([]);
    setCommentsError("");
    setCommentsCursor(0);
    setCommentsHasMore(false);
    setCommentsTotal(0);
    setCommentsLoadedAwemeId("");
    setCommentReplies({});
    setExpandedCommentReplyIds(new Set());
  }, [currentVideo?.aweme_id]);

  useEffect(() => {
    if (openPanel !== "share") return;
    void loadShareFriends();
  }, [loadShareFriends, openPanel]);

  useEffect(() => {
    if (!commentsOpen || !currentVideo?.aweme_id || commentsLoadedAwemeId === currentVideo.aweme_id) return;
    void loadComments("initial");
  }, [commentsLoadedAwemeId, commentsOpen, currentVideo?.aweme_id, loadComments]);

  useEffect(() => {
    return () => {
      if (mediaSwitchReleaseRef.current) {
        window.clearTimeout(mediaSwitchReleaseRef.current);
      }
      if (qualitySwitchReleaseRef.current) {
        window.clearTimeout(qualitySwitchReleaseRef.current);
      }
      if (panelCloseTimerRef.current) {
        window.clearTimeout(panelCloseTimerRef.current);
      }
      if (commentsHoverCloseTimerRef.current) {
        window.clearTimeout(commentsHoverCloseTimerRef.current);
      }
      if (wheelResetTimerRef.current) {
        window.clearTimeout(wheelResetTimerRef.current);
      }
      if (navigationNoticeTimerRef.current) {
        window.clearTimeout(navigationNoticeTimerRef.current);
      }
      clearLoadTimers();
      stopVideoProgressLoop();
      releaseBgm();
      releasePreloadedMedia();
      releaseMediaElement(videoRef.current);
      releaseScopedMediaElements(playerRootRef.current);
    };
  }, [clearLoadTimers, releaseBgm, releasePreloadedMedia, stopVideoProgressLoop]);

  useEffect(() => {
    if (open) return;
    clearCommentsHoverCloseTimer();
    commentsPanelStickyRef.current = false;
    setCommentsOpen(false);
    setPlaying(false);
    setShowLoadStatus(false);
    releasePlayerMediaResources();
  }, [clearCommentsHoverCloseTimer, open, releasePlayerMediaResources]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  useEffect(() => {
    if (!open || videos.length === 0) return;
    if (currentIndex >= videos.length) {
      goToVideo(videos.length - 1);
    }
  }, [currentIndex, goToVideo, open, videos.length]);

  useEffect(() => {
    if (mediaIndex < mediaItems.length) return;
    setMediaIndex(0);
  }, [mediaIndex, mediaItems.length]);

  useEffect(() => {
    pendingQualitySeekRef.current = null;
    setSelectedQualityKey("auto");
  }, [currentMedia?.url, currentVideo?.aweme_id, mediaIndex]);

  useEffect(() => {
    if (qualityOptions.length === 0) {
      if (selectedQualityKey !== "auto") setSelectedQualityKey("auto");
      return;
    }
    if (qualityOptions.some((option) => option.key === selectedQualityKey)) return;
    setSelectedQualityKey("auto");
  }, [qualityOptions, selectedQualityKey]);

  useEffect(() => {
    autoRetryCountRef.current = 0;
  }, [currentMedia?.url, currentVideo?.aweme_id, mediaIndex, selectedQualityKey]);

  useEffect(() => {
    bgmManuallyPausedRef.current = false;
  }, [currentVideo?.aweme_id, musicUrl]);

  useEffect(() => {
    imageAdvanceQueued.current = false;
    setShowLoadStatus(false);
    clearLoadTimers();

    if (!currentMedia || currentMedia.type === "image") {
      setCurrentTime(0);
      setDuration(currentMedia?.type === "image" ? IMAGE_DURATION_SECONDS : 0);
    }
    progressSampleRef.current = 0;
    setLoadState(currentMedia ? "loading" : "error");
    setPlaying(Boolean(currentMedia && desiredPlayingRef.current));

    if (currentMedia && isVideoLikeMedia(currentMedia)) {
      loadStatusTimerRef.current = window.setTimeout(() => {
        const node = videoRef.current;
        if (node && node.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
        setShowLoadStatus(true);
      }, PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS);
      scheduleLoadTimeout();
      if (mediaItems.length > 1) {
        const nextIndex = (mediaIndex + 1) % mediaItems.length;
        preloadMediaItem(mediaItems[nextIndex], false);
      }
    }
  }, [clearLoadTimers, currentMedia, mediaIndex, mediaItems, mediaKey, preloadMediaItem, scheduleLoadTimeout]);

  useEffect(() => {
    if (!open || !currentVideo || mediaItems.length > 0) return;
    void refreshCurrentVideoDetail().then((refreshed) => {
      if (refreshed) return;
      setLoadState("error");
      setShowLoadStatus(true);
    });
  }, [currentVideo, mediaItems.length, open, refreshCurrentVideoDetail]);

  useEffect(() => {
    if (!open || !onLoadMore || videos.length === 0) return;
    const remaining = videos.length - currentIndex - 1;
    if (remaining > LOAD_MORE_THRESHOLD) return;
    if (loadMoreRequestedForLength.current === videos.length) return;
    loadMoreRequestedForLength.current = videos.length;
    onLoadMore();
  }, [currentIndex, onLoadMore, open, videos.length]);

  useEffect(() => {
    if (!open || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    if (duration <= 0 || currentTime <= 0) return;
    if (duration - currentTime > PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS) return;
    preloadVideoAtIndex(currentIndex + 1, false);
  }, [currentIndex, currentMedia, currentTime, duration, open, preloadVideoAtIndex]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      prewarmVideoForPlayback(videos[currentIndex + 1]);
      prewarmVideoForPlayback(videos[currentIndex - 1]);
    }, loadState === "ready" ? 160 : 700);
    return () => window.clearTimeout(timer);
  }, [currentIndex, loadState, open, videos]);

  useEffect(() => {
    releasePreloadedMedia();
  }, [currentVideo?.aweme_id, releasePreloadedMedia]);

  useEffect(() => {
    if (!open || mediaItems.length <= 1 || loadState !== "ready") return;

    const orderedIndexes = Array.from(
      new Set([
        (mediaIndex + 1) % mediaItems.length,
        (mediaIndex - 1 + mediaItems.length) % mediaItems.length,
      ])
    ).filter((index) => index !== mediaIndex);
    let cancelled = false;
    const timers: number[] = [];

    orderedIndexes.forEach((index, order) => {
      const timer = window.setTimeout(() => {
        if (cancelled) return;
        preloadMediaItem(mediaItems[index], false);
      }, order * 140);
      timers.push(timer);
    });

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [loadState, mediaIndex, mediaItems, open, preloadMediaItem]);

  useEffect(() => {
    if (!open || !currentMedia || !isVideoLikeMedia(currentMedia)) return;
    const frame = window.requestAnimationFrame(() => {
      const node = videoRef.current;
      if (!node || !desiredPlayingRef.current) return;
      resumeVideoIfDesired(node);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentMedia, mediaKey, open, resumeVideoIfDesired]);

  useEffect(() => {
    const shouldKeepBgmPlaying = Boolean(
      open &&
        currentMedia &&
        shouldUseBgmForCurrentMedia &&
        desiredPlayingRef.current &&
        loadState !== "error"
    );

    if (shouldKeepBgmPlaying) {
      playBgm();
      return;
    }

    pauseBgm();
  }, [currentMedia, loadState, open, pauseBgm, playBgm, playing, shouldUseBgmForCurrentMedia]);

  useEffect(() => {
    const audio = bgmRef.current;
    if (!audio) return;

    const handlePlay = () => setBgmPlaying(true);
    const handlePause = () => setBgmPlaying(false);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("ended", handlePause);
    audio.addEventListener("emptied", handlePause);
    return () => {
      audio.removeEventListener("play", handlePlay);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("ended", handlePause);
      audio.removeEventListener("emptied", handlePause);
    };
  }, []);

  useEffect(() => {
    const nextVolume = effectiveVolume / 100;
    const video = videoRef.current;
    if (video) {
      video.volume = nextVolume;
      video.muted = shouldUseBgmForCurrentMedia || muted || volume === 0;
      applyPlaybackRateToNode(video, playbackRateRef.current);
    }

    const audio = bgmRef.current;
    if (audio) {
      audio.volume = nextVolume;
      audio.muted = muted || volume === 0;
      applyPlaybackRateToNode(audio, playbackRateRef.current);
    }
  }, [effectiveVolume, mediaKey, muted, shouldUseBgmForCurrentMedia, volume]);

  useEffect(() => {
    syncPlaybackRate(playbackRate);
    const frame = window.requestAnimationFrame(() => syncPlaybackRate(playbackRate));
    const timer = window.setTimeout(() => syncPlaybackRate(playbackRate), 160);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [mediaKey, playbackRate, syncPlaybackRate]);

  useEffect(() => {
    stopVideoProgressLoop();
    return stopVideoProgressLoop;
  }, [mediaKey, stopVideoProgressLoop]);

  useEffect(() => {
    if (!open || currentMedia?.type !== "image" || !playing) return;

    let frame = 0;
    let last = performance.now();
    const tick = (timestamp: number) => {
      const delta = Math.max(0, timestamp - last) / 1000;
      last = timestamp;

      setCurrentTime((value) => {
        const next = Math.min(IMAGE_DURATION_SECONDS, value + delta * playbackRateRef.current);
        if (next >= IMAGE_DURATION_SECONDS && !imageAdvanceQueued.current) {
          imageAdvanceQueued.current = true;
          requestAdvanceMediaSequence();
        }
        return next;
      });

      if (!imageAdvanceQueued.current) {
        frame = window.requestAnimationFrame(tick);
      }
    };

    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [currentMedia?.type, mediaKey, open, playing, requestAdvanceMediaSequence]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (event: KeyboardEvent) => {
      const key = event.key;
      const lowerKey = key.toLowerCase();
      const isEditableTarget = isKeyboardInputTarget(event.target);
      let handled = true;

      if (key === "Escape") {
        closePlayer();
      } else if (isEditableTarget) {
        handled = false;
      } else if (key === "ArrowUp" || lowerKey === "k") {
        playPrevVideo();
      } else if (key === "ArrowDown" || lowerKey === "j") {
        playNextVideo();
      } else if (key === "ArrowLeft") {
        playPrevMedia();
      } else if (key === "ArrowRight") {
        playNextMedia();
      } else if (key === " ") {
        togglePlay();
      } else {
        handled = false;
      }

      if (!handled) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", handleKey, true);
    return () => window.removeEventListener("keydown", handleKey, true);
  }, [closePlayer, open, playNextMedia, playNextVideo, playPrevMedia, playPrevVideo, togglePlay]);

  const handleWheel = useCallback((event: ReactWheelEvent) => {
    event.preventDefault();
    if (wheelLocked.current) return;

    const normalizedDeltaY = normalizeWheelDelta(event);
    if (normalizedDeltaY === 0) return;

    const previousDelta = wheelAccumulatedDeltaRef.current;
    if (previousDelta !== 0 && Math.sign(previousDelta) !== Math.sign(normalizedDeltaY)) {
      wheelAccumulatedDeltaRef.current = 0;
    }
    wheelAccumulatedDeltaRef.current += normalizedDeltaY;

    if (wheelResetTimerRef.current) {
      window.clearTimeout(wheelResetTimerRef.current);
    }
    wheelResetTimerRef.current = window.setTimeout(() => {
      wheelAccumulatedDeltaRef.current = 0;
      wheelResetTimerRef.current = null;
    }, WHEEL_IDLE_RESET_MS);

    if (Math.abs(wheelAccumulatedDeltaRef.current) < WHEEL_VIDEO_SWITCH_THRESHOLD) return;

    const shouldPlayNext = wheelAccumulatedDeltaRef.current > 0;
    wheelAccumulatedDeltaRef.current = 0;
    wheelLocked.current = true;
    window.setTimeout(() => {
      wheelLocked.current = false;
    }, WHEEL_VIDEO_SWITCH_LOCK_MS);

    if (shouldPlayNext) playNextVideo();
    else playPrevVideo();
  }, [playNextVideo, playPrevVideo]);

  const handleTouchStart = (event: ReactTouchEvent) => {
    touchStart.current = {
      x: event.touches[0]?.clientX || 0,
      y: event.touches[0]?.clientY || 0,
    };
  };

  const handleTouchEnd = (event: ReactTouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    const deltaX = touchStart.current.x - touch.clientX;
    const deltaY = touchStart.current.y - touch.clientY;

    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 54) {
      if (deltaX > 0) playNextMedia();
      else playPrevMedia();
      return;
    }

    if (Math.abs(deltaY) > 64) {
      if (deltaY > 0) playNextVideo();
      else playPrevVideo();
    }
  };

  return (
    <AnimatePresence>
      {open && currentVideo && (
        <motion.div
          ref={playerRootRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex flex-col overflow-hidden bg-black text-white"
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div
            className="absolute inset-x-0 top-0 z-30 flex items-center bg-gradient-to-b from-black/70 to-transparent px-5 py-4"
            onClick={(event) => event.stopPropagation()}
          >
	            <button
	              onClick={closePlayer}
	              className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-[background-color,transform] hover:bg-white/20 active:scale-[0.96]"
	              aria-label="关闭播放器"
	            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div
            className="relative flex min-h-0 flex-1 items-center justify-center"
            onClick={(event) => event.stopPropagation()}
          >
            <motion.div
              key={mediaKey}
              custom={mediaTransitionDirection}
              variants={mediaMotionVariants}
              initial="enter"
              animate="center"
              transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
              className="absolute inset-0 flex items-center justify-center"
              style={{ willChange: "transform, opacity" }}
            >
                {currentMedia && isVideoLikeMedia(currentMedia) && (
                  <video
                    ref={setVideoElementRef}
                    src={currentMediaSrc}
	                    className="pointer-events-none h-full max-h-full w-full max-w-full object-contain"
                    autoPlay={shouldAutoPlayCurrentMedia}
                    loop={!hasMultipleMedia}
                    playsInline
                    muted={shouldUseBgmForCurrentMedia || muted || volume === 0}
	                    preload="metadata"
	                    onPointerDown={handleSurfacePointerDown}
	                    onPointerUp={handleSurfacePointerUp}
	                    onPointerCancel={handleSurfacePointerCancel}
	                    onMouseDown={handleSurfaceMouseDown}
	                    onMouseUp={handleSurfaceMouseUp}
	                    onTouchStart={handleSurfaceTouchStart}
	                    onTouchEnd={handleSurfaceTouchEnd}
	                    onTouchCancel={handleSurfaceTouchEnd}
	                    onClick={handleSurfaceClick}
	                    onLoadStart={scheduleLoadTimeout}
	                    onWaiting={showBufferingSoon}
	                    onStalled={showBufferingSoon}
                    onLoadedMetadata={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
                      restorePendingQualitySeek(event.currentTarget);
                      syncVideoProgress(event.currentTarget);
                      event.currentTarget.volume = effectiveVolume / 100;
                      event.currentTarget.muted = shouldUseBgmForCurrentMedia || muted || volume === 0;
                      if (event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                        markMediaReady();
                      }
                      resumeVideoIfDesired(event.currentTarget);
                    }}
                    onLoadedData={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
                      syncVideoProgress(event.currentTarget);
                      markMediaReady();
                      resumeVideoIfDesired(event.currentTarget);
                    }}
                    onDurationChange={(event) => {
                      syncVideoProgress(event.currentTarget);
                    }}
                    onCanPlay={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
                      restorePendingQualitySeek(event.currentTarget);
                      syncVideoProgress(event.currentTarget);
                      markMediaReady();
                      releaseMediaSwitchSoon();
                      resumeVideoIfDesired(event.currentTarget);
                    }}
                    onTimeUpdate={(event) => {
                      syncVideoProgress(event.currentTarget);
                      if (loadState !== "ready" && event.currentTarget.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
                        markMediaReady();
                      }
                    }}
                    onSeeking={(event) => syncVideoProgress(event.currentTarget)}
                    onSeeked={(event) => syncVideoProgress(event.currentTarget)}
		                    onPlay={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
		                      desiredPlayingRef.current = true;
		                      playingRef.current = true;
		                      syncVideoProgress(event.currentTarget);
	                      setPlaying(true);
	                      startVideoProgressLoop();
	                    }}
		                    onPlaying={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
	                      qualitySwitchingRef.current = false;
                      if (qualitySwitchReleaseRef.current) {
                        window.clearTimeout(qualitySwitchReleaseRef.current);
                        qualitySwitchReleaseRef.current = null;
                      }
	                      playingRef.current = true;
	                      syncVideoProgress(event.currentTarget);
	                      if (loadState !== "ready") {
	                        markMediaReady();
                      }
                      setPlaying(true);
                      startVideoProgressLoop();
                    }}
		                    onPause={(event) => {
	                      stopVideoProgressLoop();
                      if (qualitySwitchingRef.current && desiredPlayingRef.current) {
                        window.setTimeout(() => resumeVideoIfDesired(event.currentTarget), 80);
                        return;
                      }
	                      if (!mediaSwitchingRef.current) {
                        clearLoadTimers();
	                        playingRef.current = false;
	                        setPlaying(false);
	                        desiredPlayingRef.current = false;
                        setShowLoadStatus(false);
                        setLoadState("ready");
	                      }
		                    }}
                    onRateChange={(event) => {
                      applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current);
                    }}
                    onEnded={() => {
                      stopVideoProgressLoop();
                      advanceMediaSequence();
                    }}
                    onError={() => {
                      void handleMediaFailure();
                    }}
                  />
                )}

                {currentMedia?.type === "image" && (
                  <img
	                    src={currentMediaSrc}
	                    alt={currentVideo.desc || "图片"}
	                    className="pointer-events-none max-h-full max-w-full object-contain"
	                    onPointerDown={handleSurfacePointerDown}
	                    onPointerUp={handleSurfacePointerUp}
	                    onPointerCancel={handleSurfacePointerCancel}
	                    onMouseDown={handleSurfaceMouseDown}
	                    onMouseUp={handleSurfaceMouseUp}
	                    onTouchStart={handleSurfaceTouchStart}
	                    onTouchEnd={handleSurfaceTouchEnd}
	                    onTouchCancel={handleSurfaceTouchEnd}
	                    onClick={handleSurfaceClick}
	                    onLoad={() => {
                      markMediaReady();
                      releaseMediaSwitchSoon();
                      if (desiredPlayingRef.current) {
                        setPlaying(true);
                      }
                    }}
                    onError={() => {
                      void handleMediaFailure();
                    }}
                  />
                )}

                {!currentMedia && (
                  <PlayerStatus
                    title="没有可播放的媒体"
                    message="当前作品没有返回视频或图片地址。"
                    onRetry={retryCurrentMedia}
                    state="error"
                  />
	                )}
            </motion.div>

            <div
              ref={surfaceHitRef}
              role="button"
              tabIndex={0}
              className="absolute inset-0 z-10 cursor-default bg-black/[0.001]"
              aria-label={playing ? "暂停" : "播放"}
              onClick={handleSurfaceClick}
            />

            {loadState === "loading" && showLoadStatus && currentMedia && isVideoLikeMedia(currentMedia) && (
              <PlayerStatus title="正在加载媒体..." message="正在通过本地代理拉取播放地址" />
            )}
            {loadState === "error" && currentMedia && (
              <PlayerStatus
                title="媒体加载失败"
                message="可以重试，或打开详情复制原始媒体链接。"
                state="error"
                onRetry={retryCurrentMedia}
              />
            )}

            {!playing && loadState === "ready" && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-white/20 bg-white/15 shadow-[0_18px_52px_rgba(0,0,0,0.4)] backdrop-blur-md">
                  <Play className="ml-1 h-8 w-8 fill-white" />
                </div>
              </div>
            )}

            <AnimatePresence initial={false}>
              {navigationNotice && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }}
                  transition={{ duration: 0.16 }}
                  className="pointer-events-none absolute left-1/2 top-[44%] z-20 -translate-x-1/2 rounded-full bg-black/58 px-4 py-2 text-[0.82rem] font-semibold text-white shadow-[0_12px_32px_rgba(0,0,0,0.35)] backdrop-blur-md"
                >
                  {navigationNotice}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div
            className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-2 pt-20 text-white"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <button
                type="button"
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-full py-0.5 pr-2 transition-[background-color,opacity,transform]",
                  canOpenAuthor
                    ? "cursor-pointer hover:bg-white/10 active:scale-[0.98]"
                    : "cursor-default opacity-75"
                )}
                disabled={!canOpenAuthor}
                title={canOpenAuthor ? "进入作者主页" : "作者信息不可用"}
                aria-label={canOpenAuthor ? `进入 ${authorName} 主页` : "作者信息不可用"}
	                    onClick={(event) => {
	                      event.stopPropagation();
	                      if (!currentVideo || !canOpenAuthor) return;
	                      releasePlayerMediaResources();
	                      onAuthor?.(currentVideo);
	                    }}
              >
                <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full border-2 border-white/30 bg-white/10">
                  {authorAvatar ? (
                    <img
                      src={mediaProxyUrl(authorAvatar, "image")}
                      alt={authorName}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-accent text-[0.72rem] font-bold text-white">
                      {authorName.slice(0, 1)}
                    </div>
                  )}
                </div>
                <span className="truncate text-[0.88rem] font-semibold drop-shadow-md">@{authorName}</span>
              </button>

              <div className="flex min-w-0 max-w-[66vw] items-center gap-1 overflow-visible pb-0.5">
                <InlinePlayerButton
                  label="点赞"
                  count={likeCount}
                  active={liked}
                  activeClassName="fill-accent text-accent"
                  disabled={relationSubmitting !== null}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleLike();
                  }}
                >
                  {relationSubmitting === "like" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Heart className={cn("h-4 w-4", liked && "fill-accent text-accent")} />
                  )}
                </InlinePlayerButton>

                <InlinePlayerButton
                  label="收藏"
                  count={favoriteCount}
                  active={favorited}
                  activeClassName="fill-warning text-warning"
                  disabled={relationSubmitting !== null}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleCollect();
                  }}
                >
                  {relationSubmitting === "collect" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Star className={cn("h-4 w-4", favorited && "fill-warning text-warning")} />
                  )}
                </InlinePlayerButton>

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => openPanelOnPointerEnter("volume", event)}
                  onPointerLeave={(event) => closePanelOnPointerLeave("volume", event)}
                  onMouseEnter={() => openToolPanel("volume")}
                  onMouseLeave={() => schedulePanelClose("volume")}
                >
                  <PlayerIconButton
                    label="音量"
                    onClick={(event) => togglePanel("volume", event)}
                    onPointerDown={(event) => openPanelOnPointerDown("volume", event)}
                    active={openPanel === "volume"}
                  >
                    {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                  </PlayerIconButton>
                  <AnimatePresence>
                    {openPanel === "volume" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.16 }}
                        className="absolute bottom-9 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-[#141414]/95 px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                        onPointerEnter={(event) => openPanelOnPointerEnter("volume", event)}
                        onPointerLeave={(event) => closePanelOnPointerLeave("volume", event)}
                        onMouseEnter={() => openToolPanel("volume")}
                        onMouseLeave={() => schedulePanelClose("volume")}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        <button
                          type="button"
                          onClick={toggleMute}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:text-white/70"
                          aria-label={muted ? "取消静音" : "静音"}
                        >
                          {muted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={effectiveVolume}
                          onChange={(event) => handleVolumeChange(Number(event.currentTarget.value))}
                          className="h-1 w-[100px] cursor-pointer accent-accent"
                          aria-label="音量"
                        />
                        <span className="min-w-9 text-center text-[0.78rem] font-medium tabular-nums text-white/90">
                          {effectiveVolume}
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => openPanelOnPointerEnter("rate", event)}
                  onPointerLeave={(event) => closePanelOnPointerLeave("rate", event)}
                  onMouseEnter={() => openToolPanel("rate")}
                  onMouseLeave={() => schedulePanelClose("rate")}
                >
                  <PlayerIconButton
                    label="倍速"
                    onClick={(event) => togglePanel("rate", event)}
                    onPointerDown={(event) => openPanelOnPointerDown("rate", event)}
                    active={openPanel === "rate"}
                  >
                    <span className="text-[0.78rem] font-semibold tabular-nums">{playbackRate}x</span>
                  </PlayerIconButton>
                  <AnimatePresence>
                    {openPanel === "rate" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.16 }}
                        className="absolute bottom-9 left-1/2 z-40 flex max-w-[200px] -translate-x-1/2 flex-wrap items-center justify-center gap-1 rounded-xl bg-[#141414]/95 p-2 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                        onPointerEnter={(event) => openPanelOnPointerEnter("rate", event)}
                        onPointerLeave={(event) => closePanelOnPointerLeave("rate", event)}
                        onMouseEnter={() => openToolPanel("rate")}
                        onMouseLeave={() => schedulePanelClose("rate")}
                        onClick={(event) => event.stopPropagation()}
                      >
                        {PLAYBACK_RATES.map((rate) => (
                          <button
                            key={rate}
                            type="button"
                            onClick={(event) => handlePlaybackRateChange(rate, event)}
                            className={cn(
                              "rounded-lg px-2.5 py-1.5 text-[0.72rem] font-medium text-white/70 transition-colors hover:bg-white/12 hover:text-white",
                              rate === playbackRate && "bg-accent/20 text-accent"
                            )}
                          >
                            {rate}x
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {showQualityControl && (
                  <div
                    className="relative shrink-0"
                    onPointerEnter={(event) => openPanelOnPointerEnter("quality", event)}
                    onPointerLeave={(event) => closePanelOnPointerLeave("quality", event)}
                    onMouseEnter={() => openToolPanel("quality")}
                    onMouseLeave={() => schedulePanelClose("quality")}
                  >
                    <PlayerIconButton
                      label={`画质 ${activeQualityOption?.label || "自动"}`}
                      onClick={(event) => togglePanel("quality", event)}
                      onPointerDown={(event) => openPanelOnPointerDown("quality", event)}
                      active={openPanel === "quality"}
                    >
                      <Gauge className="h-4 w-4" />
                    </PlayerIconButton>
                    <AnimatePresence>
                      {openPanel === "quality" && (
                        <motion.div
                          initial={{ opacity: 0, y: 6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 6 }}
                          transition={{ duration: 0.16 }}
                          className="absolute bottom-9 left-1/2 z-40 flex w-[160px] -translate-x-1/2 flex-col gap-1 rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                          onPointerEnter={(event) => openPanelOnPointerEnter("quality", event)}
                          onPointerLeave={(event) => closePanelOnPointerLeave("quality", event)}
                          onMouseEnter={() => openToolPanel("quality")}
                          onMouseLeave={() => schedulePanelClose("quality")}
                          onClick={(event) => event.stopPropagation()}
                          onWheel={(event) => event.stopPropagation()}
                        >
                          <div className="flex items-center justify-between px-1.5 pb-1">
                            <span className="text-[0.68rem] font-semibold uppercase tracking-wider text-white/45">
                              画质
                            </span>
                            <span className="text-[0.68rem] font-bold tabular-nums text-accent">
                              {activeQualityOption?.label || "自动"}
                            </span>
                          </div>
                          {qualityOptions.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              onClick={(event) => handleQualityChange(option.key, event)}
                              className={cn(
                                "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left transition-colors hover:bg-white/12",
                                option.key === activeQualityOption?.key && "bg-accent/18 text-accent"
                              )}
                            >
                              <span className="min-w-0 flex-1 text-[0.78rem] font-bold tabular-nums">
                                {option.label}
                              </span>
                              {option.key === activeQualityOption?.key && (
                                <Check className="h-3.5 w-3.5 shrink-0" />
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") openCommentsPanel(event);
                  }}
                  onMouseEnter={() => openCommentsPanel()}
                  onPointerLeave={(event) => {
                    if (event.pointerType !== "touch") scheduleTransientCommentsClose(event);
                  }}
                  onMouseLeave={() => scheduleTransientCommentsClose()}
                >
                  <PlayerIconButton
                    label="评论区"
                    onClick={(event) => {
                      event.stopPropagation();
	                      clearPanelCloseTimer();
	                      setOpenPanel(null);
	                      if (commentsOpen) {
	                        closeCommentsPanel(event);
	                      } else {
	                        openCommentsPanel(event, { sticky: true });
	                      }
	                    }}
                    active={commentsOpen}
                  >
                    <MessageCircle className="h-4 w-4" />
                  </PlayerIconButton>
                  <AnimatePresence>
                    {commentsOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 8, scale: 0.985 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.985 }}
                        transition={{ duration: 0.18 }}
                        className="fixed bottom-20 right-3 z-50 flex w-[min(380px,calc(100vw-24px))] max-h-[min(520px,72vh)] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#111111]/80 shadow-[0_18px_60px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:right-5"
                        onPointerEnter={markCommentsPanelSticky}
                        onMouseEnter={() => markCommentsPanelSticky()}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.08] px-3">
                          <div className="min-w-0 flex-1">
                            <div className="text-[0.78rem] font-semibold text-white/90">评论区</div>
                            <div className="text-[0.64rem] text-white/42">
                              {formatNumber(commentsTotal || currentVideo?.statistics?.comment_count || comments.length || 0)} 条评论
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-label="关闭评论区"
                            onClick={closeCommentsPanel}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white/55 transition-colors hover:bg-white/[0.08] hover:text-white"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <div className="share-friends-scroll min-h-0 flex-1 overflow-y-auto p-2" onScroll={handleCommentsScroll}>
                          {commentsLoading && comments.length === 0 ? (
                            <div className="flex h-32 items-center justify-center gap-2 text-[0.74rem] text-white/58">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              正在获取评论
                            </div>
                          ) : commentsError && comments.length === 0 ? (
                            <div className="rounded-lg bg-white/[0.06] px-3 py-3 text-[0.74rem] leading-5 text-white/62">
                              {commentsError}
                            </div>
                          ) : comments.length === 0 ? (
                            <div className="rounded-lg bg-white/[0.06] px-3 py-3 text-[0.74rem] text-white/55">
                              暂无评论
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              {comments.map((comment) => {
                                const avatar = comment.user?.avatar_thumb || "";
                                const replyState = commentReplies[comment.cid];
                                const replies = replyState?.items || [];
                                const repliesExpanded = expandedCommentReplyIds.has(comment.cid);
                                const commentLiked = Number(comment.user_digged || 0) > 0;
                                const commentDigging = commentDiggingIds.has(comment.cid);
                                return (
                                  <div key={comment.cid} className="flex gap-2 rounded-lg px-1.5 py-2 transition-colors hover:bg-white/[0.04]">
                                    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                                      {avatar ? (
                                        <img
                                          src={mediaProxyUrl(avatar, "image")}
                                          alt={comment.user?.nickname || ""}
                                          className="h-full w-full object-cover"
                                        />
                                      ) : (
                                        <div className="flex h-full w-full items-center justify-center bg-accent/25 text-[0.72rem] font-bold text-white">
                                          {(comment.user?.nickname || "?").slice(0, 1)}
                                        </div>
                                      )}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="truncate text-[0.72rem] font-semibold text-white/72">
                                          {comment.user?.nickname || "抖音用户"}
                                        </span>
                                        <span className="shrink-0 text-[0.62rem] text-white/32">
                                          {formatCommentTime(comment.create_time)}
                                        </span>
                                      </div>
                                      {comment.text ? (
                                        <div className="mt-0.5 whitespace-pre-wrap break-words text-[0.76rem] leading-5 text-white/90">
                                          {comment.text}
                                        </div>
                                      ) : comment.sticker_url ? (
                                        <img
                                          src={mediaProxyUrl(comment.sticker_url, "image")}
                                          alt="评论表情"
                                          className="mt-1 max-h-20 max-w-24 rounded-md object-contain"
                                        />
                                      ) : (
                                        <div className="mt-0.5 text-[0.76rem] leading-5 text-white/62">[表情]</div>
                                      )}
                                      <div className="mt-1 flex items-center gap-3 text-[0.62rem] text-white/36">
                                        {comment.ip_label && <span>IP {comment.ip_label}</span>}
                                        <button
                                          type="button"
                                          disabled={commentDigging}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void toggleCommentLike(comment, 1);
                                          }}
                                          className={cn(
                                            "flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-white/[0.06]",
                                            commentLiked ? "text-red-400" : "text-white/36 hover:text-white/70",
                                            commentDigging && "cursor-wait opacity-70"
                                          )}
                                        >
                                          <Heart className={cn("h-3 w-3", commentLiked && "fill-current")} />
                                          <span>{comment.digg_count > 0 ? formatNumber(comment.digg_count) : "赞"}</span>
                                        </button>
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            setCommentReplyTarget({
                                              replyId: comment.cid,
                                              replyToReplyId: "0",
                                              nickname: comment.user?.nickname || "抖音用户",
                                            });
                                          }}
                                          className="rounded-md px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                                        >
                                          回复
                                        </button>
                                        {comment.reply_comment_total > 0 && <span>{formatNumber(comment.reply_comment_total)} 回复</span>}
                                      </div>
                                      {comment.reply_comment_total > 0 && (
                                        <button
                                          type="button"
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            toggleCommentReplies(comment);
                                          }}
                                          className="mt-1.5 flex h-6 items-center rounded-md px-1.5 text-[0.64rem] font-semibold text-white/42 transition-colors hover:bg-white/[0.06] hover:text-white/70"
                                        >
                                          {repliesExpanded ? "收起回复" : `展开 ${formatNumber(comment.reply_comment_total)} 条回复`}
                                        </button>
                                      )}
                                      {repliesExpanded && (replies.length > 0 || replyState?.loading || replyState?.error) && (
                                        <div className="mt-2 space-y-2 border-l border-white/[0.08] pl-2.5">
                                          {replies.map((reply) => {
                                            const replyAvatar = reply.user?.avatar_thumb || "";
                                            const replyLiked = Number(reply.user_digged || 0) > 0;
                                            const replyDigging = commentDiggingIds.has(reply.cid);
                                            return (
                                              <div key={reply.cid} className="flex gap-2">
                                                <div className="h-6 w-6 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                                                  {replyAvatar ? (
                                                    <img
                                                      src={mediaProxyUrl(replyAvatar, "image")}
                                                      alt={reply.user?.nickname || ""}
                                                      className="h-full w-full object-cover"
                                                    />
                                                  ) : (
                                                    <div className="flex h-full w-full items-center justify-center bg-white/[0.08] text-[0.58rem] font-bold text-white/70">
                                                      {(reply.user?.nickname || "?").slice(0, 1)}
                                                    </div>
                                                  )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                  <div className="flex min-w-0 items-center gap-1.5">
                                                    <span className="truncate text-[0.68rem] font-semibold text-white/58">
                                                      {reply.user?.nickname || "抖音用户"}
                                                    </span>
                                                    <span className="shrink-0 text-[0.58rem] text-white/28">
                                                      {formatCommentTime(reply.create_time)}
                                                    </span>
                                                  </div>
                                                  {reply.text ? (
                                                    <div className="mt-0.5 whitespace-pre-wrap break-words text-[0.7rem] leading-4 text-white/78">
                                                      {reply.text}
                                                    </div>
                                                  ) : reply.sticker_url ? (
                                                    <img
                                                      src={mediaProxyUrl(reply.sticker_url, "image")}
                                                      alt="回复表情"
                                                      className="mt-1 max-h-16 max-w-20 rounded-md object-contain"
                                                    />
                                                  ) : (
                                                    <div className="mt-0.5 text-[0.7rem] leading-4 text-white/50">[表情]</div>
                                                  )}
                                                  <div className="mt-1 flex items-center gap-2 text-[0.58rem] text-white/30">
                                                    {reply.ip_label && <span>IP {reply.ip_label}</span>}
                                                    <button
                                                      type="button"
                                                      disabled={replyDigging}
                                                      onClick={(event) => {
                                                        event.stopPropagation();
                                                        void toggleCommentLike(reply, 2);
                                                      }}
                                                      className={cn(
                                                        "flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-white/[0.06]",
                                                        replyLiked ? "text-red-400" : "text-white/30 hover:text-white/62",
                                                        replyDigging && "cursor-wait opacity-70"
                                                      )}
                                                    >
                                                      <Heart className={cn("h-2.5 w-2.5", replyLiked && "fill-current")} />
                                                      <span>{reply.digg_count > 0 ? formatNumber(reply.digg_count) : "赞"}</span>
                                                    </button>
                                                    <button
                                                      type="button"
                                                      onClick={(event) => {
                                                        event.stopPropagation();
                                                        setCommentReplyTarget({
                                                          replyId: comment.cid,
                                                          replyToReplyId: reply.cid,
                                                          nickname: reply.user?.nickname || "抖音用户",
                                                        });
                                                      }}
                                                      className="rounded-md px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-white/62"
                                                    >
                                                      回复
                                                    </button>
                                                  </div>
                                                </div>
                                              </div>
                                            );
                                          })}
                                          {replyState?.error && (
                                            <div className="text-[0.62rem] text-white/42">{replyState.error}</div>
                                          )}
                                          {(replyState?.hasMore || replyState?.loading) && (
                                            <button
                                              type="button"
                                              onClick={(event) => {
                                                event.stopPropagation();
                                                void loadCommentReplies(comment, "more");
                                              }}
                                              disabled={replyState?.loading}
                                              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[0.64rem] font-semibold text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white/70 disabled:cursor-wait disabled:opacity-60"
                                            >
                                              {replyState?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                              {replyState?.loading ? "正在加载回复" : "查看更多回复"}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              {(commentsHasMore || commentsLoading) && (
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void loadComments("more");
                                  }}
                                  disabled={commentsLoading}
                                  className="mt-1 flex h-8 w-full items-center justify-center gap-2 rounded-lg bg-white/[0.06] text-[0.72rem] font-semibold text-white/68 transition-colors hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-60"
                                >
                                  {commentsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                                  {commentsLoading ? "正在加载" : "加载更多"}
                                </button>
                              )}
                              {commentsError && (
                                <div className="rounded-lg bg-white/[0.06] px-2 py-2 text-[0.68rem] text-white/55">
                                  {commentsError}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 border-t border-white/[0.08] p-2">
                          {commentReplyTarget && (
                            <div className="mb-1.5 flex items-center gap-2 rounded-lg bg-white/[0.05] px-2 py-1 text-[0.64rem] text-white/48">
                              <span className="min-w-0 flex-1 truncate">回复 {commentReplyTarget.nickname}</span>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setCommentReplyTarget(null);
                                }}
                                className="rounded px-1 text-white/45 transition-colors hover:bg-white/[0.08] hover:text-white/80"
                              >
                                取消
                              </button>
                            </div>
                          )}
                          <form
                            className="flex items-end gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void submitComment();
                            }}
                          >
                            <textarea
                              value={commentDraft}
                              onChange={(event) => setCommentDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  void submitComment();
                                }
                              }}
                              placeholder={commentReplyTarget ? `回复 ${commentReplyTarget.nickname}` : "写评论..."}
                              rows={1}
                              className="share-friends-scroll min-h-9 max-h-20 flex-1 resize-none rounded-lg border border-white/[0.08] bg-white/[0.06] px-2.5 py-2 text-[0.74rem] leading-5 text-white outline-none placeholder:text-white/30 focus:border-white/18"
                            />
                            <button
                              type="submit"
                              aria-label="发表评论"
                              title="发表评论"
                              disabled={!commentDraft.trim() || commentSubmitting || !currentAwemeId}
                              onClick={(event) => {
                                event.stopPropagation();
                              }}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:bg-white/[0.08] disabled:text-white/30"
                            >
                              {commentSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                            </button>
                          </form>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => openPanelOnPointerEnter("share", event)}
                  onPointerLeave={(event) => closePanelOnPointerLeave("share", event)}
                  onMouseEnter={() => openToolPanel("share")}
                  onMouseLeave={() => schedulePanelClose("share")}
                >
                  <PlayerIconButton
                    label="分享"
                    onClick={(event) => togglePanel("share", event)}
                    onPointerDown={(event) => openPanelOnPointerDown("share", event)}
                    active={openPanel === "share"}
                  >
                    <Share2 className="h-4 w-4" />
                  </PlayerIconButton>
                  <AnimatePresence>
                    {openPanel === "share" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.16 }}
                        className="absolute bottom-9 right-0 z-40 w-[268px] overflow-hidden rounded-xl bg-[#141414]/95 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                        onPointerEnter={(event) => openPanelOnPointerEnter("share", event)}
                        onPointerLeave={(event) => closePanelOnPointerLeave("share", event)}
                        onMouseEnter={() => openToolPanel("share")}
                        onMouseLeave={() => schedulePanelClose("share")}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        <div className="border-b border-white/[0.08] px-3 py-2">
                          <div className="text-[0.74rem] font-semibold text-white/85">分享给好友</div>
                          <div className="mt-0.5 text-[0.66rem] text-white/42">点击好友即可发送</div>
                        </div>
                        <div className="share-friends-scroll max-h-[320px] overflow-y-auto p-1.5">
                          {shareFriendsLoading ? (
                            <div className="flex h-20 items-center justify-center gap-2 text-[0.72rem] text-white/60">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              正在获取好友
                            </div>
                          ) : shareFriendsError ? (
                            <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] leading-5 text-white/60">
                              {shareFriendsError}
                            </div>
                          ) : shareFriends.length === 0 ? (
                            <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] text-white/55">
                              暂无可分享好友
                            </div>
                          ) : (
                            shareFriends.slice(0, 20).map((friend) => {
                              const avatar = friend.avatar_thumb || friend.avatar_medium;
                              const subtitle = friend.unique_id || friend.short_id || friend.uid;
                              const friendKey = friend.sec_uid || friend.uid;
                              const sending = shareSendingFriendKey === friendKey;
                              const sent = shareSentFriendKeys.has(friendKey);
                              return (
                                <button
                                  key={friendKey}
                                  type="button"
                                  onClick={(event) => handleShareFriendClick(friend, event)}
                                  disabled={Boolean(shareSendingFriendKey)}
                                  className="flex h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-white/[0.08] disabled:cursor-default disabled:opacity-70"
                                >
                                  <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                                    {avatar ? (
                                      <img
                                        src={mediaProxyUrl(avatar, "image")}
                                        alt={friend.nickname}
                                        className="h-full w-full object-cover"
                                      />
                                    ) : (
                                      <div className="flex h-full w-full items-center justify-center bg-accent/30 text-[0.72rem] font-bold text-white">
                                        {friend.nickname.slice(0, 1)}
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[0.78rem] font-semibold text-white/90">
                                      {friend.nickname}
                                    </div>
                                    {subtitle && (
                                      <div className="truncate text-[0.66rem] text-white/42">
                                        {subtitle}
                                      </div>
                                    )}
                                  </div>
                                  {sending ? (
                                    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-white/60" />
                                  ) : sent ? (
                                    <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                                  ) : friend.is_recent_share && (
                                    <span className="shrink-0 rounded-full bg-accent/18 px-1.5 py-0.5 text-[0.62rem] font-semibold text-accent">
                                      最近
                                    </span>
                                  )}
                                </button>
                              );
                            })
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => openPanelOnPointerEnter("download", event)}
                  onPointerLeave={(event) => closePanelOnPointerLeave("download", event)}
                  onMouseEnter={() => openToolPanel("download")}
                  onMouseLeave={() => schedulePanelClose("download")}
                >
                  <PlayerIconButton
                    label={downloadSubmitting ? "正在加入下载" : "下载作品"}
                    onClick={handleDownloadCurrent}
                    active={openPanel === "download" || downloadSubmitting}
                    disabled={!onDownload || downloadSubmitting}
                  >
                    {downloadSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  </PlayerIconButton>
                  <AnimatePresence>
                    {openPanel === "download" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.16 }}
                        className="absolute bottom-9 right-0 z-40 w-[160px] rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                        onPointerEnter={(event) => openPanelOnPointerEnter("download", event)}
                        onPointerLeave={(event) => closePanelOnPointerLeave("download", event)}
                        onMouseEnter={() => openToolPanel("download")}
                        onMouseLeave={() => schedulePanelClose("download")}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        <div className="flex flex-col gap-1">
                          <button
                            type="button"
                            disabled={!onDownload || downloadSubmitting}
                            onClick={handleDownloadCurrent}
                            className="flex h-8 items-center justify-center gap-1 rounded-md bg-accent/18 text-[0.72rem] font-semibold text-accent transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-45"
                          >
                            {downloadSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                            {downloadSubmitting ? "正在加入" : "下载作品"}
                          </button>
                          <button
                            type="button"
                            onClick={copyCurrentMediaUrl}
                            className="flex h-8 items-center justify-center rounded-md bg-white/[0.08] text-[0.72rem] font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                          >
                            复制播放地址
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <div
                  className="relative shrink-0"
                  onPointerEnter={(event) => openPanelOnPointerEnter("music", event)}
                  onPointerLeave={(event) => closePanelOnPointerLeave("music", event)}
                  onMouseEnter={() => openToolPanel("music")}
                  onMouseLeave={() => schedulePanelClose("music")}
                >
                  <PlayerIconButton
                    label="背景音乐"
                    onClick={(event) => togglePanel("music", event)}
                    onPointerDown={(event) => openPanelOnPointerDown("music", event)}
                    active={openPanel === "music"}
                  >
                    <Music className="h-4 w-4" />
                  </PlayerIconButton>
                  <AnimatePresence>
                    {openPanel === "music" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.16 }}
                        className="absolute bottom-9 right-0 z-40 w-[160px] rounded-xl bg-[#141414]/95 p-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.4)] backdrop-blur-xl"
                        onPointerEnter={(event) => openPanelOnPointerEnter("music", event)}
                        onPointerLeave={(event) => closePanelOnPointerLeave("music", event)}
                        onMouseEnter={() => openToolPanel("music")}
                        onMouseLeave={() => schedulePanelClose("music")}
                        onClick={(event) => event.stopPropagation()}
                        onWheel={(event) => event.stopPropagation()}
                      >
                        {musicUrl ? (
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={toggleBgm}
                              className="flex h-8 items-center justify-center gap-1 rounded-md bg-accent/18 text-[0.72rem] font-semibold text-accent transition-colors hover:bg-accent/25"
                            >
                              {bgmPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
                              {bgmPlaying ? "暂停 BGM" : "播放 BGM"}
                            </button>
                            <a
                              href={bgmProxyUrl}
                              download
                              className="flex h-8 items-center justify-center gap-1 rounded-md bg-white/[0.08] text-[0.72rem] font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <Download className="h-3.5 w-3.5" />
                              下载
                            </a>
                          </div>
                        ) : (
                          <div className="rounded-md bg-white/[0.06] px-2 py-2 text-[0.72rem] text-white/55">
                            当前作品没有返回音频地址
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {onShowDetail && (
                  <PlayerIconButton
                    label="查看详情"
	                    onClick={(event) => {
	                      event.stopPropagation();
	                      releasePlayerMediaResources();
	                      onShowDetail(currentVideo);
	                    }}
                  >
                    <Info className="h-4 w-4" />
                  </PlayerIconButton>
                )}
              </div>
            </div>

            <div className="mt-0.5">
	              <ProgressBar
	                duration={duration}
	                currentTime={currentTime}
	                progressPct={progressPct}
	                mediaItems={mediaItems}
	                mediaIndex={activeMediaIndex}
	                previewSrc={currentMedia && isVideoLikeMedia(currentMedia) ? currentMediaSrc : ""}
	                onSeek={handleSeek}
	                onSelectMedia={switchToMedia}
	              />

              <p className="mt-1 line-clamp-2 text-[0.82rem] leading-[1.32] text-white/90 drop-shadow-md">
                {currentVideo.desc || "无描述"}
              </p>
            </div>
          </div>

          <audio
            ref={bgmRef}
            className="hidden"
            onLoadedMetadata={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onCanPlay={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onPlay={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
            onRateChange={(event) => applyPlaybackRateToNode(event.currentTarget, playbackRateRef.current)}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ProgressBar({
  duration,
  currentTime,
  progressPct,
  mediaItems,
  mediaIndex,
  previewSrc,
  onSeek,
  onSelectMedia,
}: {
  duration: number;
  currentTime: number;
  progressPct: number;
  mediaItems: VideoMediaItem[];
  mediaIndex: number;
  previewSrc?: string;
  onSeek: (time: number) => void;
  onSelectMedia: (index: number) => void;
}) {
  const pointerDraggingRef = useRef(false);
  const mouseDraggingRef = useRef(false);
  const touchDraggingRef = useRef(false);
  const [hoverPreview, setHoverPreview] = useState({
    visible: false,
    x: 0,
    width: 0,
    time: 0,
  });

  const updateHoverPreview = useCallback((target: HTMLDivElement, clientX: number, visible = true) => {
    if (!duration) {
      setHoverPreview((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;

    const rawX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rawX / rect.width;

    setHoverPreview({
      visible,
      x: rawX,
      width: rect.width,
      time: ratio * duration,
    });
  }, [duration]);

  const previewX = hoverPreview.width > 0
    ? Math.min(
        Math.max(hoverPreview.x, PROGRESS_PREVIEW_WIDTH / 2),
        Math.max(PROGRESS_PREVIEW_WIDTH / 2, hoverPreview.width - PROGRESS_PREVIEW_WIDTH / 2)
      )
    : hoverPreview.x;

  const hideHoverPreview = useCallback(() => {
    if (pointerDraggingRef.current || mouseDraggingRef.current || touchDraggingRef.current) return;
    setHoverPreview((current) => current.visible ? { ...current, visible: false } : current);
  }, []);

  const seekFromClientX = useCallback((target: HTMLDivElement, clientX: number) => {
    if (!duration) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  const handleSeekPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    pointerDraggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateHoverPreview(event.currentTarget, event.clientX);
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      updateHoverPreview(event.currentTarget, event.clientX);
    }
    if (!pointerDraggingRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerDraggingRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, event.clientX);
    pointerDraggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (event.pointerType !== "touch") {
      updateHoverPreview(event.currentTarget, event.clientX);
    } else {
      hideHoverPreview();
    }
  }, [hideHoverPreview, seekFromClientX, updateHoverPreview]);

  const handleSeekClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (pointerDraggingRef.current || mouseDraggingRef.current) return;
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX]);

  const handleSeekMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    event.stopPropagation();
    event.preventDefault();
    const target = event.currentTarget;
    mouseDraggingRef.current = true;
    updateHoverPreview(target, event.clientX);
    seekFromClientX(target, event.clientX);

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateHoverPreview(target, moveEvent.clientX);
      seekFromClientX(target, moveEvent.clientX);
    };
    const handleUp = (upEvent: MouseEvent) => {
      upEvent.preventDefault();
      seekFromClientX(target, upEvent.clientX);
      mouseDraggingRef.current = false;
      updateHoverPreview(target, upEvent.clientX);
      ownerWindow.removeEventListener("mousemove", handleMove);
      ownerWindow.removeEventListener("mouseup", handleUp);
    };

    ownerWindow.addEventListener("mousemove", handleMove);
    ownerWindow.addEventListener("mouseup", handleUp);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    touchDraggingRef.current = true;
    seekFromClientX(event.currentTarget, touch.clientX);
  }, [seekFromClientX]);

  const handleSeekTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!touchDraggingRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, touch.clientX);
  }, [seekFromClientX]);

  const handleSeekTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!touchDraggingRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, touch.clientX);
    touchDraggingRef.current = false;
  }, [seekFromClientX]);

  if (mediaItems.length > 1) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {mediaItems.map((item, index) => {
            const fill = index < mediaIndex ? 100 : index === mediaIndex ? progressPct : 0;
            return (
              <button
                key={`${item.type}-${item.url}-${index}`}
                className="relative h-1.5 min-w-[18px] flex-1 overflow-hidden rounded-full bg-white/18"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectMedia(index);
                }}
                aria-label={`切换到第 ${index + 1} 个媒体`}
              >
                <span
                  className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-gradient-to-r from-white/90 to-accent transition-transform duration-100 ease-linear"
                  style={{ transform: `scaleX(${fill / 100})` }}
                />
              </button>
            );
          })}
        </div>
        <TimeLabel currentTime={currentTime} duration={duration} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div
        data-player-control="true"
        className="group relative flex h-6 flex-1 cursor-pointer touch-none select-none items-center"
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") {
            updateHoverPreview(event.currentTarget, event.clientX);
          }
        }}
        onPointerDown={handleSeekPointerDown}
        onPointerMove={handleSeekPointerMove}
        onPointerLeave={hideHoverPreview}
        onPointerUp={handleSeekPointerEnd}
        onPointerCancel={handleSeekPointerEnd}
        onClick={handleSeekClick}
        onMouseDown={handleSeekMouseDown}
        onTouchStart={handleSeekTouchStart}
        onTouchMove={handleSeekTouchMove}
        onTouchEnd={handleSeekTouchEnd}
        onTouchCancel={handleSeekTouchEnd}
      >
        <div
          className={cn(
            "absolute left-0 right-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full transition-[height,background-color] duration-150",
            hoverPreview.visible ? "h-1.5 bg-white/28" : "h-[2px] bg-white/10"
          )}
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-full origin-left rounded-full transition-[background-color,transform] duration-100 ease-linear",
              hoverPreview.visible ? "bg-accent" : "bg-accent/80"
            )}
            style={{ transform: `scaleX(${progressPct / 100})` }}
          />
        </div>
        <div
          className={cn(
            "absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-md transition-opacity",
            hoverPreview.visible ? "opacity-100" : "opacity-0"
          )}
          style={{ left: `calc(${progressPct}% - 6px)` }}
        />
        {duration > 0 && previewSrc && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-full z-50 mb-3 transition-[opacity,transform] duration-150",
              hoverPreview.visible ? "opacity-100" : "opacity-0"
            )}
            style={{
              left: hoverPreview.visible ? previewX : 0,
              transform: `translateX(-50%) translateY(${hoverPreview.visible ? "0" : "6px"})`,
            }}
          >
            <div
              className="relative overflow-hidden rounded-[8px] border border-white/14 bg-black/90 shadow-[0_14px_36px_rgba(0,0,0,0.42)]"
              style={{
                width: PROGRESS_PREVIEW_WIDTH,
                height: PROGRESS_PREVIEW_HEIGHT,
              }}
            >
              <ProgressFramePreview
                src={previewSrc || ""}
                time={hoverPreview.time}
                duration={duration}
                visible={hoverPreview.visible}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/78 to-transparent px-2 pb-1.5 pt-5">
                <span className="rounded-full bg-black/72 px-2 py-0.5 text-[0.68rem] font-bold tabular-nums text-white shadow-[0_8px_18px_rgba(0,0,0,0.28)]">
                  {formatDuration(hoverPreview.time)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
      <TimeLabel currentTime={currentTime} duration={duration} />
    </div>
  );
}

function ProgressFramePreview({
  src,
  time,
  duration,
  visible,
}: {
  src: string;
  time: number;
  duration: number;
  visible: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestTimeRef = useRef(time);
  const latestVisibleRef = useRef(visible);
  const thumbnailCacheRef = useRef<Array<{ time: number; dataUrl: string }>>([]);
  const pendingSeekFrameRef = useRef<number | null>(null);
  const pendingDrawFrameRef = useRef<number | null>(null);
  const sampleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const samplingCancelledRef = useRef(false);
  const lastExactTimeRef = useRef(-1);
  const [fallbackFrame, setFallbackFrame] = useState<string>("");
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    latestTimeRef.current = time;
  }, [time]);

  useEffect(() => {
    latestVisibleRef.current = visible;
  }, [visible]);

  const nearestFallbackFrame = useCallback((targetTime: number) => {
    let best = "";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cached of thumbnailCacheRef.current) {
      const distance = Math.abs(cached.time - targetTime);
      if (distance < bestDistance) {
        best = cached.dataUrl;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  const drawPreviewFrame = useCallback(() => {
    const node = videoRef.current;
    const canvas = canvasRef.current;
    if (!node || !canvas || !node.videoWidth || !node.videoHeight || node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvasWidth = Math.round(PROGRESS_PREVIEW_WIDTH * dpr);
    const canvasHeight = Math.round(PROGRESS_PREVIEW_HEIGHT * dpr);
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;

    const sourceAspect = node.videoWidth / node.videoHeight;
    const targetAspect = canvasWidth / canvasHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = node.videoWidth;
    let sourceHeight = node.videoHeight;

    if (sourceAspect > targetAspect) {
      sourceWidth = node.videoHeight * targetAspect;
      sourceX = (node.videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = node.videoWidth / targetAspect;
      sourceY = (node.videoHeight - sourceHeight) / 2;
    }

    try {
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.drawImage(
        node,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvasWidth,
        canvasHeight
      );
      setFrameReady(true);
      lastExactTimeRef.current = node.currentTime;
      return true;
    } catch {
      return false;
    }
  }, []);

  const capturePreviewDataUrl = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !drawPreviewFrame()) return "";
    try {
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
      return "";
    }
  }, [drawPreviewFrame]);

  const requestPreviewDraw = useCallback(() => {
    if (pendingDrawFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingDrawFrameRef.current);
    }
    pendingDrawFrameRef.current = window.requestAnimationFrame(() => {
      pendingDrawFrameRef.current = null;
      drawPreviewFrame();
    });
  }, [drawPreviewFrame]);

  const seekPreview = useCallback((targetTime: number) => {
    const node = videoRef.current;
    if (!node || !src) return;
    const fallback = nearestFallbackFrame(targetTime);
    if (fallback) {
      setFallbackFrame(fallback);
      if (Math.abs(lastExactTimeRef.current - targetTime) > 0.35) {
        setFrameReady(false);
      }
    }
    if (node.readyState < HTMLMediaElement.HAVE_METADATA) {
      try {
        node.load();
      } catch {
        // Loading the preview node is opportunistic.
      }
      return;
    }

    const duration = finiteMediaTime(node.duration);
    const safeTime = duration > 0
      ? Math.min(Math.max(0, targetTime), Math.max(0, duration - 0.05))
      : Math.max(0, targetTime);
    try {
      if (Math.abs(node.currentTime - safeTime) > 0.15) {
        node.currentTime = safeTime;
        return;
      }
      requestPreviewDraw();
    } catch {
      // Preview seeking is best-effort; the main player owns actual playback.
    }
  }, [nearestFallbackFrame, requestPreviewDraw, src]);

  useEffect(() => {
    if (pendingSeekFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSeekFrameRef.current);
    }
    pendingSeekFrameRef.current = window.requestAnimationFrame(() => {
      pendingSeekFrameRef.current = null;
      seekPreview(latestTimeRef.current);
    });
    return () => {
      if (pendingSeekFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingSeekFrameRef.current);
        pendingSeekFrameRef.current = null;
      }
    };
  }, [seekPreview, time]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node || !src) return;

    setFrameReady(false);
    setFallbackFrame("");
    thumbnailCacheRef.current = [];
    samplingCancelledRef.current = false;
    let playFallbackTimer: ReturnType<typeof window.setTimeout> | null = null;

    const handleLoadedMetadata = () => seekPreview(latestTimeRef.current);
    const triggerMutedDecode = () => {
      if (drawPreviewFrame()) return;
      const playResult = node.play();
      if (playResult && typeof playResult.then === "function") {
        playResult
          .then(() => {
            node.pause();
            requestPreviewDraw();
          })
          .catch(() => {
            requestPreviewDraw();
          });
      }
    };

    node.muted = true;
    node.playsInline = true;

    node.addEventListener("loadedmetadata", handleLoadedMetadata);
    node.addEventListener("loadeddata", requestPreviewDraw);
    node.addEventListener("canplay", requestPreviewDraw);
    node.addEventListener("seeked", requestPreviewDraw);
    node.addEventListener("timeupdate", requestPreviewDraw);

    if (node.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekPreview(latestTimeRef.current);
    } else {
      try {
        node.load();
      } catch {
        // Loading the preview node is opportunistic.
      }
    }

    playFallbackTimer = window.setTimeout(triggerMutedDecode, 180);

    return () => {
      samplingCancelledRef.current = true;
      if (playFallbackTimer !== null) {
        window.clearTimeout(playFallbackTimer);
      }
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      if (pendingDrawFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingDrawFrameRef.current);
        pendingDrawFrameRef.current = null;
      }
      node.removeEventListener("loadedmetadata", handleLoadedMetadata);
      node.removeEventListener("loadeddata", requestPreviewDraw);
      node.removeEventListener("canplay", requestPreviewDraw);
      node.removeEventListener("seeked", requestPreviewDraw);
      node.removeEventListener("timeupdate", requestPreviewDraw);
      releaseMediaElement(node);
    };
  }, [drawPreviewFrame, requestPreviewDraw, seekPreview, src]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node || !src || duration <= 0) return;
    if (thumbnailCacheRef.current.length > 0) return;

    samplingCancelledRef.current = false;
    const sampleTimes = PROGRESS_PREVIEW_SAMPLE_RATIOS
      .map((ratio) => Math.min(Math.max(0.05, duration * ratio), Math.max(0.05, duration - 0.08)));
    let index = 0;

    const runNextSample = () => {
      if (samplingCancelledRef.current || latestVisibleRef.current || index >= sampleTimes.length) {
        return;
      }
      if (node.readyState < HTMLMediaElement.HAVE_METADATA) {
        sampleTimerRef.current = window.setTimeout(runNextSample, 180);
        return;
      }

      const sampleTime = sampleTimes[index];
      index += 1;

      const handleSeeked = () => {
        node.removeEventListener("seeked", handleSeeked);
        if (!samplingCancelledRef.current && !latestVisibleRef.current) {
          const dataUrl = capturePreviewDataUrl();
          if (dataUrl) {
            thumbnailCacheRef.current.push({ time: sampleTime, dataUrl });
          }
        }
        sampleTimerRef.current = window.setTimeout(runNextSample, 160);
      };

      try {
        node.addEventListener("seeked", handleSeeked, { once: true });
        node.currentTime = sampleTime;
      } catch {
        node.removeEventListener("seeked", handleSeeked);
        sampleTimerRef.current = window.setTimeout(runNextSample, 160);
      }
    };

    sampleTimerRef.current = window.setTimeout(runNextSample, 260);
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, [capturePreviewDataUrl, duration, src]);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-[0.72rem] font-medium text-white/55">
        暂无预览
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative h-full w-full bg-black transition-opacity duration-100",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <canvas
        ref={canvasRef}
        className={cn("relative z-10 h-full w-full transition-opacity duration-75", frameReady ? "opacity-100" : "opacity-0")}
      />
      {fallbackFrame && (
        <img
          src={fallbackFrame}
          alt=""
          aria-hidden="true"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-75",
            frameReady ? "opacity-0" : "opacity-100"
          )}
          draggable={false}
        />
      )}
      {!frameReady && !fallbackFrame && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/[0.04] text-[0.72rem] font-medium text-white/55">
          正在预览
        </div>
      )}
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        muted
        playsInline
        crossOrigin="anonymous"
        aria-hidden="true"
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
    </div>
  );
}

function TimeLabel({ currentTime, duration }: { currentTime: number; duration: number }) {
  return (
    <div className="shrink-0 text-[0.68rem] font-medium tabular-nums text-white/72">
      {formatDuration(currentTime)} / {formatDuration(duration)}
    </div>
  );
}

function InlinePlayerButton({
  children,
  label,
  count,
  active,
  activeClassName,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  count: number;
  active?: boolean;
  activeClassName?: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white transition-[background-color,transform,color,opacity] hover:scale-[1.08] hover:bg-white/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100",
          active && activeClassName
        )}
        aria-label={label}
        title={label}
      >
        {children}
      </button>
      <span className="text-[0.78rem] font-medium tabular-nums text-white/85 drop-shadow-md">
        {formatNumber(count)}
      </span>
    </div>
  );
}

function PlayerIconButton({
  children,
  label,
  active,
  disabled,
  onClick,
  onPointerDown,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white transition-[background-color,color] hover:bg-white/10 active:bg-white/15",
        active && "bg-white/10",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent active:bg-transparent"
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function PlayerStatus({
  title,
  message,
  state = "loading",
  onRetry,
}: {
  title: string;
  message: string;
  state?: "loading" | "error";
  onRetry?: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className="absolute left-1/2 top-1/2 z-20 flex w-[min(360px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-[14px] border border-white/12 bg-black/45 px-5 py-4 text-center backdrop-blur-xl">
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full",
          state === "error" ? "bg-warning-soft text-warning" : "bg-white/10 text-white"
        )}
      >
        {state === "error" ? <Info className="h-5 w-5" /> : <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/25 border-t-white" />}
      </div>
      <div className="text-[0.9rem] font-semibold">{title}</div>
      <div className="text-[0.78rem] leading-relaxed text-white/68">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 h-8 rounded-[8px] border border-white/16 bg-white/10 px-3 text-[0.78rem] text-white transition-colors hover:bg-white/18"
        >
          重试
        </button>
      )}
    </div>
  );
}

function resolveMediaDirection(currentIndex: number, nextIndex: number, total: number): number {
  if (total <= 1 || currentIndex === nextIndex) return 0;
  const forwardDistance = (nextIndex - currentIndex + total) % total;
  const backwardDistance = (currentIndex - nextIndex + total) % total;
  return forwardDistance <= backwardDistance ? 1 : -1;
}

function normalizeWheelDelta(event: ReactWheelEvent): number {
  if (event.deltaMode === 1) return event.deltaY * 16;
  if (event.deltaMode === 2) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function isKeyboardInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}
