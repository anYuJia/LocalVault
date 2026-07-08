import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Check,
  Download,
  Gauge,
  Heart,
  Info,
  ListVideo,
  Loader2,
  MessageCircle,
  Music,
  Pause,
  Play,
  Send,
  Share2,
  Sparkles,
  Star,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn, formatNumber } from "@/lib/utils";
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
  suggestAiInteraction,
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
import { readAiAutomationConfig, rememberAutomationKey, shouldAutomateText } from "@/lib/ai-automation";
import {
  InlinePlayerButton,
  PlayerIconButton,
  PlayerStatus,
  ProgressBar,
  TimeLabel,
} from "./player-components";
import {
  IMAGE_DURATION_SECONDS,
  LOAD_MORE_THRESHOLD,
  MAX_PRELOADED_MEDIA_NODES,
  PLAYBACK_RATES,
  PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS,
  PLAYER_NEXT_VIDEO_PRELOAD_AHEAD_SECONDS,
  PLAYER_PANEL_CLOSE_DELAY_MS,
  PLAYER_VIDEO_INITIAL_STATUS_DELAY_MS,
  PLAYER_VIDEO_LOAD_TIMEOUT_MS,
  PLAYER_VIDEO_MAX_AUTO_RETRIES,
  PLAYER_VIDEO_REBUFFER_STATUS_DELAY_MS,
  SESSION_CACHE_BUSTER,
  WHEEL_IDLE_RESET_MS,
  WHEEL_VIDEO_SWITCH_LOCK_MS,
  WHEEL_VIDEO_SWITCH_THRESHOLD,
  applyPlaybackRateToNode,
  finiteMediaTime,
  formatCommentTime,
  getDocumentVideoNode,
  isKeyboardInputTarget,
  mediaMotionVariants,
  normalizeWheelDelta,
  playerMediaProxyUrl,
  readMediaDuration,
  releaseMediaElement,
  releaseScopedMediaElements,
  resolveMediaDirection,
  type CommentRepliesState,
  type CommentReplyTarget,
  type PlayerPanel,
} from "./player-utils";

const AUTO_PLAY_NEXT_VIDEO_STORAGE_KEY = "player_auto_play_next_video";
const AI_COMMENT_CONTEXT_CHAR_LIMIT = 900;

function trimAiText(value: string, limit = AI_COMMENT_CONTEXT_CHAR_LIMIT) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(-limit) : text;
}

function normalizeAiSuggestions(draft: string, suggestions?: string[]) {
  const items = suggestions && suggestions.length > 0 ? suggestions : [draft];
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, 3);
}

function getAiAutoSendDelayMs(value?: number) {
  const delay = Number(value ?? 0);
  if (!Number.isFinite(delay)) return 0;
  return Math.max(0, Math.min(10000, Math.trunc(delay)));
}

function formatAiAutoBlockHint(reasons?: string[]) {
  const items = (reasons || []).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? `自动发送已阻止：${items.join("，")}` : "";
}

function waitForAiAutoSend(delayMs: number) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

function readStoredAutoPlayNextVideo(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(AUTO_PLAY_NEXT_VIDEO_STORAGE_KEY) === "true";
}

function buildAudioDownloadVideo(video: VideoInfo, audioUrl: string): VideoInfo {
  const title = video.music?.title || video.desc || video.aweme_id;
  return {
    ...video,
    desc: title ? `${title} 音频` : "背景音乐",
    media_type: "audio",
    raw_media_type: "audio",
    media_urls: [{ type: "audio", url: audioUrl }],
    video: {
      ...video.video,
      audio_addr: audioUrl,
      play_addr: "",
      play_addr_h264: null,
      play_addr_lowbr: null,
      download_addr: null,
    },
  };
}

export interface FullscreenPlayerProps {
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
  openComments?: boolean;
  initialComment?: {
    cid: string;
    root_cid?: string;
    is_sub?: boolean;
    text: string;
    digg_count: number;
    create_time: number;
    user: { uid: string; nickname: string; sec_uid: string; avatar: string };
    reply_to_user?: { uid: string; nickname: string; sec_uid: string; avatar: string } | null;
    reply_to_text?: string;
  } | null;
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
  openComments = false,
  initialComment = null,
}: FullscreenPlayerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [mediaTransition, setMediaTransition] = useState({ index: 0, direction: 0 });
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
  const [bgmDownloadSubmitting, setBgmDownloadSubmitting] = useState(false);
  const [autoPlayNextVideo, setAutoPlayNextVideo] = useState(readStoredAutoPlayNextVideo);
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
  const [commentAiSuggesting, setCommentAiSuggesting] = useState(false);
  const [commentAiSuggestions, setCommentAiSuggestions] = useState<string[]>([]);
  const [commentAiHint, setCommentAiHint] = useState("");
  const [commentReplyTarget, setCommentReplyTarget] = useState<CommentReplyTarget>(null);
  // 通知跳转定位：高亮目标 cid + 定位失败提示。
  const [highlightCid, setHighlightCid] = useState("");
  const [locatePrompt, setLocatePrompt] = useState<"" | "deleted" | "not_in_first_pages">("");
  const commentItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const replyItemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const locateDoneRef = useRef(false);
  const locatePageRef = useRef(0);
  const autoRepliedCommentIdsRef = useRef<Set<string>>(new Set());
  const [videoOverrides, setVideoOverrides] = useState<Record<string, VideoInfo>>({});
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
  const mediaAdvanceSeqRef = useRef(0);
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
  const preloadedReadyRef = useRef(new Set<string>());
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
  const mediaIndex = mediaTransition.index;
  const mediaTransitionDirection = mediaTransition.direction;
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
    videoRef.current = node;
  }, []);

  const goToVideo = useCallback((index: number) => {
    if (index < 0 || index >= videos.length) return;
    mediaAdvanceSeqRef.current += 1;
    desiredPlayingRef.current = true;
    mediaSwitchingRef.current = false;
    clearLoadTimers();
    stopVideoProgressLoop();
    releaseMediaElement(videoRef.current);
    setCurrentIndex(index);
    setMediaTransition({ index: 0, direction: 0 });
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
    if (!awemeId || relationSubmitting) return false;

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
      return true;
    } catch (error) {
      setLiked(previousLiked);
      patchCurrentVideoRelation(awemeId, {
        is_liked: previousLiked,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "点赞失败");
      return false;
    } finally {
      setRelationSubmitting(null);
    }
  }, [currentVideo, likeBaseCount, liked, patchCurrentVideoRelation, relationSubmitting, showNavigationNotice]);

  const toggleCollect = useCallback(async () => {
    const awemeId = currentVideo?.aweme_id;
    if (!awemeId || relationSubmitting) return false;

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
      return true;
    } catch (error) {
      setFavorited(previousCollected);
      patchCurrentVideoRelation(awemeId, {
        is_collected: previousCollected,
        statistics: currentVideo.statistics,
      });
      showNavigationNotice(error instanceof Error ? error.message : "收藏失败");
      return false;
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

  const rememberPreloadedNode = useCallback((node: HTMLImageElement | HTMLVideoElement) => {
    preloadedNodesRef.current.push(node);
    while (preloadedNodesRef.current.length > MAX_PRELOADED_MEDIA_NODES) {
      const removed = preloadedNodesRef.current.shift();
      if (removed instanceof HTMLVideoElement) {
        releaseMediaElement(removed);
      } else if (removed) {
        removed.removeAttribute("src");
      }
    }
  }, []);

  const resolvePreloadTarget = useCallback((media: VideoMediaItem | null | undefined) => {
    if (!media) return null;
    const mediaType = getMediaProxyType(media);
    const proxiedUrl = playerMediaProxyUrl(media.url, mediaType, reloadKey);
    if (!proxiedUrl) return null;
    return {
      key: `${media.type}::${proxiedUrl}`,
      url: proxiedUrl,
    };
  }, [reloadKey]);

  const waitForMediaReady = useCallback((media: VideoMediaItem | null | undefined) => {
    const target = resolvePreloadTarget(media);
    if (!target || !media) return Promise.resolve();
    if (preloadedReadyRef.current.has(target.key)) return Promise.resolve();

    return new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof window.setTimeout>;

      if (media.type === "image") {
        const image = new Image();
        image.decoding = "async";
        image.loading = "eager";

        const finish = () => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          if (image.naturalWidth > 0) {
            preloadedReadyRef.current.add(target.key);
          }
          rememberPreloadedNode(image);
          resolve();
        };

        image.onload = () => {
          if (typeof image.decode === "function") {
            void image.decode().catch(() => undefined).finally(finish);
            return;
          }
          finish();
        };
        image.onerror = finish;
        timer = window.setTimeout(finish, PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS);
        image.src = target.url;
        if (image.complete && image.naturalWidth > 0) finish();
        return;
      }

      const video = document.createElement("video");
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;

      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("canplay", finish);
        video.removeEventListener("error", finish);
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          preloadedReadyRef.current.add(target.key);
        }
        rememberPreloadedNode(video);
        resolve();
      };

      video.addEventListener("loadeddata", finish);
      video.addEventListener("canplay", finish);
      video.addEventListener("error", finish);
      timer = window.setTimeout(finish, PLAYER_MEDIA_ADVANCE_PRELOAD_TIMEOUT_MS);
      video.src = target.url;
      video.load();
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish();
    });
  }, [rememberPreloadedNode, resolvePreloadTarget]);

  const releaseMediaSwitchSoon = useCallback(() => {
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    mediaSwitchReleaseRef.current = window.setTimeout(() => {
      mediaSwitchingRef.current = false;
      mediaSwitchReleaseRef.current = null;
    }, 650);
  }, []);

  const switchToMedia = useCallback((index: number, explicitDirection?: number) => {
    if (mediaItems.length === 0) return;
    mediaAdvanceSeqRef.current += 1;
    const safeIndex = ((index % mediaItems.length) + mediaItems.length) % mediaItems.length;
    const direction = explicitDirection ?? resolveMediaDirection(mediaIndex, index, mediaItems.length);
    const shouldKeepPlaying = desiredPlayingRef.current || playing;
    desiredPlayingRef.current = shouldKeepPlaying;
    mediaSwitchingRef.current = true;
    if (mediaSwitchReleaseRef.current) {
      window.clearTimeout(mediaSwitchReleaseRef.current);
    }
    setMediaTransition({ index: safeIndex, direction });
    setCurrentTime(0);
    setDuration(0);
    progressSampleRef.current = 0;
    setPlaying(shouldKeepPlaying);
  }, [mediaIndex, mediaItems.length, playing]);

  const playNextMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex + 1, 1);
      return;
    }
    playNextVideo();
  }, [mediaIndex, mediaItems.length, playNextVideo, switchToMedia]);

  const playPrevMedia = useCallback(() => {
    if (mediaItems.length > 1) {
      switchToMedia(mediaIndex - 1, -1);
      return;
    }
    playPrevVideo();
  }, [mediaIndex, mediaItems.length, playPrevVideo, switchToMedia]);

  const advanceMediaSequence = useCallback(() => {
    if (mediaItems.length === 0) return;
    desiredPlayingRef.current = true;
    if (mediaItems.length > 1) {
      const hasNextMedia = mediaIndex < mediaItems.length - 1;
      if (!hasNextMedia && autoPlayNextVideo && videos.length > 1) {
        playNextVideo();
        return;
      }
      const nextIndex = hasNextMedia ? mediaIndex + 1 : 0;
      const nextMedia = mediaItems[nextIndex];
      const nextTarget = resolvePreloadTarget(nextMedia);
      if (nextTarget && preloadedReadyRef.current.has(nextTarget.key)) {
        switchToMedia(nextIndex, 1);
        return;
      }
      const requestSeq = ++mediaAdvanceSeqRef.current;
      mediaSwitchingRef.current = true;
      setPlaying(true);
      void waitForMediaReady(nextMedia).then(() => {
        if (requestSeq !== mediaAdvanceSeqRef.current) return;
        switchToMedia(nextIndex, 1);
      });
      return;
    }
    if (autoPlayNextVideo && videos.length > 1) {
      playNextVideo();
      return;
    }
    imageAdvanceQueued.current = false;
    setCurrentTime(0);
    setDuration(IMAGE_DURATION_SECONDS);
    setPlaying(true);
    setReloadKey((value) => value + 1);
  }, [autoPlayNextVideo, mediaIndex, mediaItems, playNextVideo, resolvePreloadTarget, switchToMedia, videos.length, waitForMediaReady]);

  const toggleAutoPlayNextVideo = useCallback(() => {
    setAutoPlayNextVideo((current) => {
      const next = !current;
      window.localStorage.setItem(AUTO_PLAY_NEXT_VIDEO_STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const requestAdvanceMediaSequence = useCallback(() => {
    window.requestAnimationFrame(() => {
      advanceMediaSequence();
    });
  }, [advanceMediaSequence]);

  const togglePlay = useCallback(() => {
    if (!currentMedia) return;
    if (!isVideoLikeMedia(currentMedia)) {
      setPlaying((value) => {
        const nextPlaying = !value;
        if (!nextPlaying) {
          mediaAdvanceSeqRef.current += 1;
        }
        desiredPlayingRef.current = nextPlaying;
        return nextPlaying;
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
      mediaAdvanceSeqRef.current += 1;
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
      const next: CommentRepliesState = {};
      let anyChanged = false;
      for (const [cid, state] of Object.entries(prev)) {
        let itemsChanged = false;
        const nextItems = state.items.map((reply) => {
          if (reply.cid !== commentId) return reply;
          itemsChanged = true;
          return updater(reply);
        });
        if (itemsChanged) {
          anyChanged = true;
          next[cid] = { ...state, items: nextItems };
        } else {
          next[cid] = state;
        }
      }
      return anyChanged ? next : prev;
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

  const publishCommentText = useCallback(async (value: string, successNotice = "评论已发布") => {
    const text = value.trim();
    if (commentSubmitting) return false;
    if (!text) {
      showNavigationNotice("请输入评论内容");
      return false;
    }
    if (!currentAwemeId) {
      showNavigationNotice("缺少视频ID，无法发表评论");
      return false;
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
      showNavigationNotice(successNotice);
      return true;
    } catch (error) {
      showNavigationNotice(error instanceof Error ? error.message : "发表评论失败");
      return false;
    } finally {
      setCommentSubmitting(false);
    }
  }, [
    commentReplyTarget,
    commentSubmitting,
    currentAwemeId,
    loadCommentReplies,
    loadComments,
    showNavigationNotice,
    updateCommentById,
  ]);

  const submitComment = useCallback(async () => {
    await publishCommentText(commentDraft);
  }, [commentDraft, publishCommentText]);

  const suggestCommentDraft = useCallback(async () => {
    if (!currentVideo || commentAiSuggesting) return;
    const contextLines = [
      currentVideo.desc ? `视频文案：${currentVideo.desc}` : "",
      currentVideo.author?.nickname ? `作者：${currentVideo.author.nickname}` : "",
      commentReplyTarget?.nickname ? `正在回复：${commentReplyTarget.nickname}` : "",
      comments.slice(0, 5).map((comment) => `${comment.user?.nickname || "用户"}：${comment.text || ""}`).join("\n"),
    ].filter(Boolean);

    setCommentAiSuggesting(true);
    setCommentAiHint("正在生成 AI 评论候选...");
    try {
      const result = await suggestAiInteraction({
        target: "comment",
        context: trimAiText(contextLines.join("\n")),
        incoming_text: trimAiText(currentVideo.desc || "", 360),
        author_name: commentReplyTarget?.nickname || currentVideo.author?.nickname || "",
        tone: "friendly",
        language: "zh-CN",
        max_suggestions: 3,
      });
      const suggestions = normalizeAiSuggestions(result.draft || "", result.suggestions);
      setCommentAiSuggestions(suggestions);
      const autoBlockHint = formatAiAutoBlockHint(result.auto_block_reasons);
      if (suggestions.length === 0) {
        setCommentAiHint("暂时没有生成可用建议，请稍后再试");
      } else if (result.actions?.send_comment) {
        const autoMessages: string[] = [];
        if (result.actions?.like && !liked && await toggleLike()) {
          autoMessages.push("已自动点赞");
        }
        if (result.actions?.collect && !favorited && await toggleCollect()) {
          autoMessages.push("已自动收藏");
        }
        const delayMs = getAiAutoSendDelayMs(result.auto_send_delay_ms);
        if (delayMs > 0) {
          setCommentAiHint(`${autoMessages.length > 0 ? `${autoMessages.join("，")}；` : ""}将在 ${(delayMs / 1000).toFixed(1)} 秒后自动发布 AI 评论`);
          await waitForAiAutoSend(delayMs);
        }
        if (await publishCommentText(suggestions[0], "AI 评论已自动发布")) {
          autoMessages.push("已自动发布评论");
        } else if (!commentDraft.trim()) {
          setCommentDraft(suggestions[0]);
          autoMessages.push("自动发布失败，已保留 AI 草稿");
        } else {
          autoMessages.push("自动发布失败，原草稿未覆盖");
        }
        setCommentAiHint(autoMessages.join("，"));
      } else if (commentDraft.trim()) {
        const autoMessages: string[] = [];
        if (result.actions?.like && !liked && await toggleLike()) {
          autoMessages.push("已自动点赞");
        }
        if (result.actions?.collect && !favorited && await toggleCollect()) {
          autoMessages.push("已自动收藏");
        }
        setCommentAiHint(autoBlockHint || "已生成 AI 候选，点击下方短句可替换当前草稿");
        if (autoMessages.length > 0) {
          setCommentAiHint(`${autoMessages.join("，")}；${autoBlockHint || "已生成 AI 候选，点击下方短句可替换当前草稿"}`);
        }
      } else {
        const autoMessages: string[] = [];
        if (result.actions?.like && !liked && await toggleLike()) {
          autoMessages.push("已自动点赞");
        }
        if (result.actions?.collect && !favorited && await toggleCollect()) {
          autoMessages.push("已自动收藏");
        }
        setCommentDraft(suggestions[0]);
        const manualHint = autoBlockHint || "已填入 AI 草稿，可继续编辑后手动发布";
        setCommentAiHint(autoMessages.length > 0 ? `${autoMessages.join("，")}；${manualHint}` : manualHint);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成评论建议失败";
      setCommentAiHint(message);
      showNavigationNotice(message);
    } finally {
      setCommentAiSuggesting(false);
    }
  }, [commentAiSuggesting, commentDraft, commentReplyTarget, comments, currentVideo, favorited, liked, publishCommentText, showNavigationNotice, toggleCollect, toggleLike]);

  const runCommentsAutomation = useCallback(async () => {
    if (!currentAwemeId || !currentVideo || comments.length === 0 || commentSubmitting) return;
    const config = await readAiAutomationConfig();
    if (!config?.auto_monitor_comments || !config.auto_send_comments) return;

    let handled = 0;
    for (const comment of comments) {
      if (!comment?.cid || autoRepliedCommentIdsRef.current.has(comment.cid)) continue;
      if (handled >= config.auto_max_actions_per_run) break;
      const matchText = [
        currentVideo.desc,
        currentVideo.author?.nickname,
        comment.user?.nickname,
        comment.text,
      ].filter(Boolean).join(" ");
      if (!shouldAutomateText(matchText, config, "comment")) continue;
      if (!rememberAutomationKey(autoRepliedCommentIdsRef.current, comment.cid)) continue;

      handled += 1;
      try {
        const result = await suggestAiInteraction({
          target: "comment",
          context: trimAiText([
            currentVideo.desc ? `视频文案：${currentVideo.desc}` : "",
            currentVideo.author?.nickname ? `作者：${currentVideo.author.nickname}` : "",
            `正在回复：${comment.user?.nickname || "用户"}`,
            comments.slice(0, 5).map((item) => `${item.user?.nickname || "用户"}：${item.text || ""}`).join("\n"),
          ].filter(Boolean).join("\n")),
          incoming_text: trimAiText(comment.text || "", 360),
          author_name: comment.user?.nickname || "",
          tone: "friendly",
          language: "zh-CN",
          max_suggestions: 3,
        });
        const suggestions = normalizeAiSuggestions(result.draft || "", result.suggestions);
        if (!result.actions?.send_comment || suggestions.length === 0) continue;
        const delayMs = getAiAutoSendDelayMs(result.auto_send_delay_ms);
        await waitForAiAutoSend(delayMs);
        const published = await publishComment(
          currentAwemeId,
          suggestions[0],
          comment.cid,
          "0"
        );
        if (published.success) {
          showNavigationNotice(`已自动回复 ${comment.user?.nickname || "评论"}`);
          if (published.comment?.cid) {
            setExpandedCommentReplyIds((prev) => new Set(prev).add(comment.cid));
            setCommentReplies((prev) => {
              const current = prev[comment.cid] || {
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
                [comment.cid]: {
                  ...current,
                  items: [published.comment!, ...current.items],
                  total: current.total + 1,
                  loaded: true,
                },
              };
            });
            updateCommentById(comment.cid, (item) => ({
              ...item,
              reply_comment_total: Number(item.reply_comment_total || 0) + 1,
            }));
          } else {
            void loadCommentReplies(comment, "initial");
          }
        } else {
          showNavigationNotice(published.message || "评论区自动回复失败");
        }
      } catch (error) {
        showNavigationNotice(error instanceof Error ? error.message : "评论区自动回复失败");
      }
    }
  }, [commentSubmitting, comments, currentAwemeId, currentVideo, loadCommentReplies, showNavigationNotice, updateCommentById]);

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

  useEffect(() => {
    if (openPanel) {
      clearCommentsHoverCloseTimer();
      commentsPanelStickyRef.current = false;
      setCommentsOpen(false);
    }
  }, [openPanel, clearCommentsHoverCloseTimer]);

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

  const handleDownloadBgm = useCallback(async (event: ReactMouseEvent) => {
    event.stopPropagation();
    clearPanelCloseTimer();
    setOpenPanel(null);
    if (!musicUrl || !currentVideo || !onDownload || bgmDownloadSubmitting) return;

    setBgmDownloadSubmitting(true);
    try {
      await Promise.resolve(onDownload(buildAudioDownloadVideo(currentVideo, musicUrl)));
    } catch (error) {
      console.warn("BGM download failed", error);
    } finally {
      setBgmDownloadSubmitting(false);
    }
  }, [bgmDownloadSubmitting, clearPanelCloseTimer, currentVideo, musicUrl, onDownload, setOpenPanel]);

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
      setMediaTransition({ index: 0, direction: 0 });
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
    const target = resolvePreloadTarget(media);
    if (!target || !media) return;

    const existingFullPreload = preloadedMediaRef.current.get(target.key);
    if (existingFullPreload || (!full && preloadedMediaRef.current.has(target.key))) return;
    preloadedMediaRef.current.set(target.key, full);

    if (media.type === "image") {
      const image = new Image();
      image.decoding = "async";
      image.loading = "eager";
      image.onload = () => {
        if (image.naturalWidth > 0) {
          preloadedReadyRef.current.add(target.key);
        }
      };
      image.src = target.url;
      if (image.complete && image.naturalWidth > 0) {
        preloadedReadyRef.current.add(target.key);
      }
      rememberPreloadedNode(image);
    } else {
      const video = document.createElement("video");
      video.preload = full ? "auto" : "metadata";
      video.muted = true;
      video.playsInline = true;
      const markReady = () => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          preloadedReadyRef.current.add(target.key);
        }
      };
      video.addEventListener("loadeddata", markReady, { once: true });
      video.addEventListener("canplay", markReady, { once: true });
      video.src = target.url;
      video.load();
      markReady();
      rememberPreloadedNode(video);
    }
  }, [rememberPreloadedNode, resolvePreloadTarget]);

  const releasePreloadedMedia = useCallback(() => {
    preloadedMediaRef.current.clear();
    preloadedReadyRef.current.clear();
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
    mediaAdvanceSeqRef.current += 1;
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
    setCurrentIndex(safeIndex);
    setMediaTransition({ index: safeMediaIndex, direction: 0 });
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
    if (!commentsOpen || commentsLoading || comments.length === 0) return;
    void runCommentsAutomation();
  }, [comments, commentsLoading, commentsOpen, runCommentsAutomation]);

  // 通知跳转：打开时强制展开评论区（降级类型 41/45 也展开）。
  useEffect(() => {
    if (!open) return;
    if (openComments || initialComment) {
      setCommentsOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // 通知跳转：用 insert_ids=cid 拉评论列表，目标评论会被插入返回。
  // cid 在根列表 → 置顶高光根评论；cid 在某根评论的 sub_comments → 展开该根评论高光子评论。
  // 不等 commentsLoadedAwemeId——抢先调 insert_ids 一步到位，省掉自动拉取的普通请求，
  // 避免普通+insert_ids 两次串行请求导致进入慢。
  useEffect(() => {
    if (!initialComment || locateDoneRef.current) return;
    if (locatePageRef.current > 0) return; // 仅拉一次
    locatePageRef.current = 1;
    const { cid, root_cid, is_sub, text, digg_count, create_time, user, reply_to_user } = initialComment;
    // 立即占位标记已加载，阻止自动拉取 effect 并发跑普通请求（与 insert_ids 串行浪费）。
    if (currentVideo?.aweme_id) {
      setCommentsLoadedAwemeId(currentVideo.aweme_id);
      setCommentsLoading(true);
    }

    const highlight = (targetCid: string) => {
      setHighlightCid(targetCid);
      window.setTimeout(() => setHighlightCid((cur) => (cur === targetCid ? "" : cur)), 2400);
      window.requestAnimationFrame(() => {
        const node = commentItemRefs.current.get(targetCid) || replyItemRefs.current.get(targetCid);
        if (node) node.scrollIntoView({ block: "center" });
      });
    };

    void (async () => {
      try {
        const targetRootCid = root_cid || cid;
        const result = await getComments(currentVideo!.aweme_id, 20, 0, targetRootCid);
        if (!result.success || !result.comments) {
          locateDoneRef.current = true;
          setLocatePrompt("deleted");
          return;
        }
        setCommentsLoading(false);
        // cid 在根列表 → 置顶高光。
        const asRoot = result.comments.find((c) => c.cid === cid);
        if (asRoot) {
          const ordered = [asRoot, ...result.comments.filter((c) => c.cid !== cid)];
          setComments(ordered);
          setCommentsCursor(Number(result.cursor || 0));
          setCommentsHasMore(Boolean(result.has_more));
          setCommentsTotal(Number(result.total || 0));
          setCommentsLoadedAwemeId(currentVideo!.aweme_id);
          locateDoneRef.current = true;
          highlight(cid);
          return;
        }
        const rootComment = result.comments.find((c) => c.cid === targetRootCid);
        if (rootComment && is_sub) {
          const repliesResult = await getCommentReplies(currentVideo!.aweme_id, rootComment.cid, 20, 0);
          const replies = Array.isArray(repliesResult.comments) ? repliesResult.comments : [];
          const targetReply = replies.find((reply) => reply.cid === cid);
          const visibleReplies = targetReply
            ? [targetReply, ...replies.filter((reply) => reply.cid !== cid)]
            : replies;
          setComments([rootComment, ...result.comments.filter((c) => c.cid !== rootComment.cid)]);
          setCommentsCursor(Number(result.cursor || 0));
          setCommentsHasMore(Boolean(result.has_more));
          setCommentsTotal(Number(result.total || 0));
          setCommentsLoadedAwemeId(currentVideo!.aweme_id);
          setCommentReplies((prev) => ({
            ...prev,
            [rootComment.cid]: {
              items: visibleReplies,
              cursor: Number(repliesResult.cursor || 0),
              hasMore: Boolean(repliesResult.has_more),
              loading: false,
              error: "",
              total: Number(repliesResult.total || rootComment.reply_comment_total || visibleReplies.length || 0),
              loaded: true,
            },
          }));
          setExpandedCommentReplyIds((prev) => new Set(prev).add(rootComment.cid));
          locateDoneRef.current = true;
          if (targetReply) {
            highlight(cid);
          } else {
            setLocatePrompt("not_in_first_pages");
            highlight(rootComment.cid);
          }
          return;
        }
        // cid 在某根评论的 sub_comments → 展开该根评论高光子评论。
        const host = result.comments.find((c) => (c.sub_comments || []).some((s) => s.cid === cid));
        if (host) {
          const subReplies = (host.sub_comments || []) as CommentInfo[];
          const ordered = [
            ...subReplies.filter((r) => r.cid === cid),
            ...subReplies.filter((r) => r.cid !== cid),
          ];
          const hostOrdered = [host, ...result.comments.filter((c) => c.cid !== host.cid)];
          setComments(hostOrdered);
          setCommentsCursor(Number(result.cursor || 0));
          setCommentsHasMore(Boolean(result.has_more));
          setCommentsTotal(Number(result.total || 0));
          setCommentsLoadedAwemeId(currentVideo!.aweme_id);
          setCommentReplies((prev) => ({
            ...prev,
            [host.cid]: {
              items: ordered,
              cursor: 0,
              hasMore: false,
              loading: false,
              error: "",
              total: subReplies.length,
              loaded: true,
            },
          }));
          setExpandedCommentReplyIds((prev) => new Set(prev).add(host.cid));
          locateDoneRef.current = true;
          highlight(cid);
          return;
        }
        // 兜底：评论已删或接口未返回，用通知数据构造置顶。
        const pinned: CommentInfo = {
          cid,
          text,
          create_time,
          digg_count,
          user_digged: 0,
          reply_comment_total: 0,
          sub_comments: null,
          reply_id: is_sub ? targetRootCid : "",
          reply_to_reply_id: is_sub ? cid : "",
          reply_to_user_id: reply_to_user?.uid || "",
          reply_to_user_name: reply_to_user?.nickname || "",
          user: { uid: user.uid, nickname: user.nickname, sec_uid: user.sec_uid, avatar_thumb: user.avatar },
        };
        setComments((prev) => [pinned, ...prev]);
        locateDoneRef.current = true;
        setLocatePrompt("deleted");
        highlight(cid);
      } catch {
        locateDoneRef.current = true;
        setLocatePrompt("deleted");
      } finally {
        setCommentsLoading(false);
      }
    })();
  }, [initialComment, commentsLoadedAwemeId, currentVideo?.aweme_id]);

  // 评论项 ref 回调工厂：el 为 null 时清理 stale 条目。
  const registerCommentRef = useCallback((cid: string) => (el: HTMLDivElement | null) => {
    if (el) commentItemRefs.current.set(cid, el);
    else commentItemRefs.current.delete(cid);
  }, []);
  const registerReplyRef = useCallback((cid: string) => (el: HTMLDivElement | null) => {
    if (el) replyItemRefs.current.set(cid, el);
    else replyItemRefs.current.delete(cid);
  }, []);

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
    // 重置通知跳转定位状态（remount 也会重置，这里覆盖同实例复用情况）。
    locateDoneRef.current = false;
    locatePageRef.current = 0;
    setLocatePrompt("");
    setHighlightCid("");
    commentItemRefs.current.clear();
    replyItemRefs.current.clear();
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
    setMediaTransition({ index: 0, direction: 0 });
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
        preloadMediaItem(mediaItems[nextIndex], true);
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
        preloadMediaItem(mediaItems[index], true);
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

    if (
      mediaSwitchingRef.current &&
      bgmDesiredPlayingRef.current &&
      open &&
      currentMedia &&
      musicUrl &&
      loadState !== "error"
    ) {
      return;
    }

    pauseBgm();
  }, [currentMedia, loadState, musicUrl, open, pauseBgm, playBgm, playing, shouldUseBgmForCurrentMedia]);

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
    // 单图作品且不自动播放下一个视频时，静止显示——不推进进度循环，
    // 否则到 IMAGE_DURATION_SECONDS 会触发 reloadKey 自增导致图片重新加载
    // 闪烁、进度条在 1/3↔2/3 间来回跳。
    const isSingleStaticImage =
      currentMedia?.type === "image" && mediaItems.length <= 1 && !(autoPlayNextVideo && videos.length > 1);
    if (!open || currentMedia?.type !== "image" || !playing || isSingleStaticImage) return;

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
  }, [currentMedia?.type, mediaKey, open, playing, requestAdvanceMediaSequence, mediaItems.length, autoPlayNextVideo, videos.length]);

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
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
            onClick={(event) => event.stopPropagation()}
          >
            <AnimatePresence initial={false} custom={mediaTransitionDirection}>
              <motion.div
                key={mediaKey}
                custom={mediaTransitionDirection}
                variants={mediaMotionVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="absolute inset-0 flex items-center justify-center"
                style={{ backfaceVisibility: "hidden", contain: "layout paint", willChange: "transform" }}
              >
                {currentMedia && isVideoLikeMedia(currentMedia) && (
                  <video
                    ref={setVideoElementRef}
                    src={currentMediaSrc}
	                    className="pointer-events-none h-full max-h-full w-full max-w-full object-contain"
                    autoPlay={shouldAutoPlayCurrentMedia}
                    loop={!hasMultipleMedia && !autoPlayNextVideo}
                    playsInline
                    muted={shouldUseBgmForCurrentMedia || muted || volume === 0}
	                    preload={hasMultipleMedia ? "auto" : "metadata"}
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
                      if ((mediaSwitchingRef.current || event.currentTarget.ended) && desiredPlayingRef.current) {
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
                      desiredPlayingRef.current = true;
                      mediaSwitchingRef.current = true;
                      setPlaying(true);
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
            </AnimatePresence>

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
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 6 }}
                  transition={{ duration: 0.15 }}
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
                  label={autoPlayNextVideo ? "关闭自动播放下一条" : "自动播放下一条"}
                  active={autoPlayNextVideo}
                  activeClassName="text-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleAutoPlayNextVideo();
                  }}
                >
                  <ListVideo className={cn("h-4 w-4", autoPlayNextVideo && "text-accent")} />
                </InlinePlayerButton>

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
                          {locatePrompt && (
                            <div className="mb-1.5 flex items-center justify-between gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[0.72rem] text-warning">
                              <span>{locatePrompt === "deleted" ? "该评论可能已被删除" : "未在前 60 条评论中找到，可在评论区手动查找"}</span>
                              <button
                                type="button"
                                onClick={() => setLocatePrompt("")}
                                className="shrink-0 text-warning/70 hover:text-warning"
                              >
                                ×
                              </button>
                            </div>
                          )}
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
                                  <div
                                    key={comment.cid}
                                    ref={registerCommentRef(comment.cid)}
                                    data-cid={comment.cid}
                                    className={cn(
                                      "flex gap-2 rounded-lg px-1.5 py-2 transition-colors hover:bg-white/[0.04]",
                                      highlightCid === comment.cid && "bg-accent-soft/50 border-l-2 border-l-accent"
                                    )}
                                  >
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
                                            const replyToName =
                                              reply.reply_to_user_name &&
                                              reply.reply_to_user_name !== comment.user?.nickname &&
                                              reply.reply_to_user_name !== reply.user?.nickname
                                                ? reply.reply_to_user_name
                                                : "";
                                            return (
                                              <div
                                                key={reply.cid}
                                                ref={registerReplyRef(reply.cid)}
                                                data-reply-cid={reply.cid}
                                                className={cn(
                                                  "flex gap-2",
                                                  highlightCid === reply.cid && "bg-accent-soft/50 border-l-2 border-l-accent rounded-lg"
                                                )}
                                              >
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
                                                    {replyToName && (
                                                      <>
                                                        <span className="shrink-0 text-[0.58rem] text-white/26">回复</span>
                                                        <span className="truncate text-[0.66rem] font-semibold text-accent/80">
                                                          @{replyToName}
                                                        </span>
                                                      </>
                                                    )}
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
                            className="space-y-1.5"
                            onSubmit={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void submitComment();
                            }}
                          >
                            <div className="flex items-end gap-2">
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
                                type="button"
                                aria-label="AI 生成评论草稿"
                                title={commentDraft.trim() ? "AI 生成候选评论，不会自动发布" : "AI 生成评论草稿"}
                                disabled={!currentAwemeId || commentAiSuggesting}
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void suggestCommentDraft();
                                }}
                                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.06] text-white/72 transition-colors hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:bg-white/[0.04] disabled:text-white/28"
                              >
                                {commentAiSuggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                              </button>
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
                            </div>
                            {(commentAiHint || commentAiSuggestions.length > 1) && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                {commentAiHint && <span className="mr-1 text-[0.66rem] text-white/42">{commentAiHint}</span>}
                                {commentAiSuggestions.map((suggestion, index) => (
                                  <button
                                    key={`${suggestion}-${index}`}
                                    type="button"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setCommentDraft(suggestion);
                                      setCommentAiHint("已替换为选中的 AI 草稿");
                                    }}
                                    className="max-w-full truncate rounded-full border border-white/[0.08] bg-white/[0.06] px-2 py-0.5 text-[0.64rem] text-white/68 transition-colors hover:bg-white/[0.1] hover:text-white"
                                    title={suggestion}
                                  >
                                    候选 {index + 1}
                                  </button>
                                ))}
                              </div>
                            )}
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
                            <button
                              type="button"
                              disabled={bgmDownloadSubmitting || !bgmProxyUrl || !onDownload}
                              className="flex h-8 items-center justify-center gap-1 rounded-md bg-white/[0.08] text-[0.72rem] font-semibold text-white/80 transition-colors hover:bg-white/15 hover:text-white"
                              onClick={handleDownloadBgm}
                            >
                              {bgmDownloadSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                              {bgmDownloadSubmitting ? "加入中" : "下载"}
                            </button>
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
