import { create } from "zustand";
import { getRecommended, type VideoInfo } from "@/lib/tauri";
import type { RecommendedFeedType } from "@/lib/contracts";
import { requestVerifyRecovery } from "@/lib/verify-recovery";
import { useLogStore } from "@/stores/app-store";
import { readAiAutomationConfig, rememberAutomationKey, runVideoAutomation } from "@/lib/ai-automation";

const PAGE_SIZE = 20;
const FEED_TYPE_STORAGE_KEY = "dy_recommended_feed_type";
const DEFAULT_FEED_TYPE: RecommendedFeedType = "featured";
let latestFeedRequestId = 0;
let latestLoadMoreRequestId = 0;
const automatedVideoIds = new Set<string>();

interface RecommendedFeedCache {
  videos: VideoInfo[];
  cursor: number;
  hasMore: boolean;
  initialized: boolean;
}

type RecommendedFeeds = Record<RecommendedFeedType, RecommendedFeedCache>;

interface RecommendedStoreState {
  feedType: RecommendedFeedType;
  feeds: RecommendedFeeds;
  videos: VideoInfo[];
  loading: boolean;
  loadingMore: boolean;
  cursor: number;
  hasMore: boolean;
  error: string | null;
  initialized: boolean;
  setFeedType: (feedType: RecommendedFeedType) => void;
  loadFeed: (count?: number, force?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>;
  updateVideo: (video: VideoInfo) => void;
}

const emptyFeed = (): RecommendedFeedCache => ({
  videos: [],
  cursor: 0,
  hasMore: true,
  initialized: false,
});

const createFeeds = (): RecommendedFeeds => ({
  featured: emptyFeed(),
  recommended: emptyFeed(),
});

function normalizeRecommendedFeedType(value: unknown): RecommendedFeedType {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "recommended" || normalized === "recommend" || normalized === "tab" || normalized === "home"
    ? "recommended"
    : "featured";
}

function readStoredFeedType(): RecommendedFeedType {
  try {
    if (typeof window === "undefined") return DEFAULT_FEED_TYPE;
    return normalizeRecommendedFeedType(window.localStorage.getItem(FEED_TYPE_STORAGE_KEY));
  } catch {
    return DEFAULT_FEED_TYPE;
  }
}

function writeStoredFeedType(feedType: RecommendedFeedType) {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(FEED_TYPE_STORAGE_KEY, feedType);
    }
  } catch {
    // Local storage may be unavailable in restricted browser contexts.
  }
}

function feedLabel(feedType: RecommendedFeedType) {
  return feedType === "recommended" ? "推荐" : "精选";
}

const uniqueVideos = (existing: VideoInfo[], incoming: VideoInfo[]) => {
  const seen = new Set(existing.flatMap(getRecommendedVideoKeys).filter(Boolean));
  const next = [...existing];
  for (const video of incoming) {
    const keys = getRecommendedVideoKeys(video);
    if (keys.length === 0 || keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    next.push(video);
  }
  return next;
};

function getRecommendedVideoKeys(video: VideoInfo | null | undefined): string[] {
  if (!video) return [];
  return Array.from(new Set([
    video.aweme_id,
    video.video?.play_addr,
    video.video?.download_addr,
    video.media_urls?.[0]?.url,
    `${video.author?.sec_uid || video.author?.uid || ""}:${video.desc || ""}:${video.create_time || ""}`,
  ].map((value) => String(value || "").trim()).filter(Boolean)));
}

async function runRecommendedAutomation(videos: VideoInfo[], source: string) {
  const config = await readAiAutomationConfig();
  if (!config?.auto_monitor_feed || (!config.auto_like && !config.auto_collect)) return;

  const addLog = useLogStore.getState().addLog;
  let handled = 0;
  let changed = 0;
  for (const video of videos) {
    if (!video?.aweme_id || !rememberAutomationKey(automatedVideoIds, video.aweme_id)) continue;
    if (handled >= config.auto_max_actions_per_run) break;
    handled += 1;
    try {
      const result = await runVideoAutomation(video, config);
      if (result.actions.length > 0) {
        changed += result.actions.length;
        useRecommendedStore.getState().updateVideo(result.video);
        addLog(`后台${source}自动处理视频：${result.actions.join("、")} · ${video.desc || video.aweme_id}`, "success");
      }
    } catch (error) {
      addLog(error instanceof Error ? error.message : "后台视频自动处理失败", "warning");
    }
  }
  if (changed > 0) {
    addLog(`后台${source}自动处理完成：${changed} 个动作`, "info");
  }
}

const initialFeedType = readStoredFeedType();
const initialFeeds = createFeeds();
const initialFeed = initialFeeds[initialFeedType];

export const useRecommendedStore = create<RecommendedStoreState>((set, get) => ({
  feedType: initialFeedType,
  feeds: initialFeeds,
  videos: initialFeed.videos,
  loading: false,
  loadingMore: false,
  cursor: initialFeed.cursor,
  hasMore: initialFeed.hasMore,
  error: null,
  initialized: initialFeed.initialized,

  setFeedType: (nextFeedType) => {
    const feedType = normalizeRecommendedFeedType(nextFeedType);
    const state = get();
    if (state.feedType === feedType) return;

    latestFeedRequestId += 1;
    latestLoadMoreRequestId += 1;
    writeStoredFeedType(feedType);

    const feeds = {
      ...state.feeds,
      [state.feedType]: {
        videos: state.videos,
        cursor: state.cursor,
        hasMore: state.hasMore,
        initialized: state.initialized,
      },
    };
    const nextFeed = feeds[feedType] || emptyFeed();

    set({
      feedType,
      feeds,
      videos: nextFeed.videos,
      cursor: nextFeed.cursor,
      hasMore: nextFeed.hasMore,
      initialized: nextFeed.initialized,
      loading: false,
      loadingMore: false,
      error: null,
    });
  },

  loadFeed: async (count = PAGE_SIZE, force = false) => {
    const state = get();
    const feedType = state.feedType;
    const currentFeed = state.feeds[feedType] || emptyFeed();
    if (state.loading || state.loadingMore) return;
    if (!force && currentFeed.initialized && currentFeed.videos.length > 0) return;

    const addLog = useLogStore.getState().addLog;
    const shouldKeepVideos = currentFeed.videos.length > 0;
    const requestId = ++latestFeedRequestId;
    latestLoadMoreRequestId += 1;

    set({
      loading: true,
      error: null,
      videos: shouldKeepVideos ? currentFeed.videos : [],
      cursor: shouldKeepVideos ? currentFeed.cursor : 0,
      hasMore: shouldKeepVideos ? currentFeed.hasMore : true,
      initialized: currentFeed.initialized,
    });

    addLog(`${shouldKeepVideos ? "刷新" : "加载"}${feedLabel(feedType)}视频...`, "info");

    try {
      const result = await getRecommended(0, count, feedType);
      if (requestId !== latestFeedRequestId) return;

      if (!result.success) {
        const message = result.message || "加载推荐视频失败";
        if (result.need_login) {
          set((current) => ({
            feeds: {
              ...current.feeds,
              [feedType]: {
                ...(current.feeds[feedType] || emptyFeed()),
                initialized: true,
              },
            },
            loading: false,
            error: message,
            initialized: true,
            ...(current.videos.length > 0 ? {} : { videos: [] }),
          }));
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "推荐视频需要验证",
            onResume: () => {
              get().setFeedType(feedType);
              void get().loadFeed(count, true);
            },
          });
        }
        set((current) => ({
          feeds: {
            ...current.feeds,
            [feedType]: {
              ...(current.feeds[feedType] || emptyFeed()),
              initialized: true,
            },
          },
          loading: false,
          error: message,
          initialized: true,
          ...(current.videos.length > 0 ? {} : { videos: [] }),
        }));
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }

      const videos = uniqueVideos([], result.videos || []);
      const nextFeed: RecommendedFeedCache = {
        videos,
        cursor: result.cursor || 0,
        hasMore: result.has_more ?? videos.length > 0,
        initialized: true,
      };
      set((current) => {
        const feeds = { ...current.feeds, [feedType]: nextFeed };
        if (current.feedType !== feedType) return { feeds };
        return {
          feeds,
          videos: nextFeed.videos,
          loading: false,
          loadingMore: false,
          cursor: nextFeed.cursor,
          hasMore: nextFeed.hasMore,
          error: null,
          initialized: true,
        };
      });
      addLog(`已加载 ${videos.length} 个${feedLabel(feedType)}视频`, "success");
      void runRecommendedAutomation(videos, feedLabel(feedType));
    } catch (error) {
      if (requestId !== latestFeedRequestId) return;
      const message = error instanceof Error ? error.message : "加载推荐视频失败";
      set((current) => ({
        feeds: {
          ...current.feeds,
          [feedType]: {
            ...(current.feeds[feedType] || emptyFeed()),
            initialized: true,
          },
        },
        loading: false,
        error: message,
        initialized: true,
        ...(current.videos.length > 0 ? {} : { videos: [] }),
      }));
      addLog(message, "error");
    }
  },

  loadMore: async () => {
    const state = get();
    const feedType = state.feedType;
    const currentFeed = state.feeds[feedType] || emptyFeed();
    if (state.loading || state.loadingMore || !currentFeed.hasMore) return;

    const requestId = ++latestLoadMoreRequestId;
    const cursor = currentFeed.cursor;
    set({ loadingMore: true, error: null });

    try {
      const result = await getRecommended(cursor, PAGE_SIZE, feedType);
      if (requestId !== latestLoadMoreRequestId) return;

      if (!result.success) {
        if (result.need_login) {
          set({ loadingMore: false, error: result.message || "请登录后获取推荐视频" });
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message: result.message || "加载更多推荐视频失败",
            title: "推荐视频需要验证",
            onResume: () => {
              get().setFeedType(feedType);
              void get().loadMore();
            },
          });
        }
        set({ loadingMore: false, error: result.message || "加载更多失败" });
        return;
      }

      set((current) => {
        const feed = current.feeds[feedType] || emptyFeed();
        const baseVideos = current.feedType === feedType ? current.videos : feed.videos;
        const nextVideos = uniqueVideos(baseVideos, result.videos || []);
        const addedCount = nextVideos.length - baseVideos.length;
        const nextFeed: RecommendedFeedCache = {
          videos: nextVideos,
          cursor: result.cursor || feed.cursor,
          hasMore: addedCount > 0 && (result.has_more ?? ((result.videos?.length || 0) > 0)),
          initialized: true,
        };
        const feeds = { ...current.feeds, [feedType]: nextFeed };
        if (current.feedType !== feedType) return { feeds };
        return {
          feeds,
          loadingMore: false,
          videos: nextVideos,
          cursor: nextFeed.cursor,
          hasMore: nextFeed.hasMore,
          error: null,
          initialized: true,
        };
      });
      void runRecommendedAutomation(result.videos || [], `${feedLabel(feedType)}加载更多`);
    } catch (error) {
      if (requestId !== latestLoadMoreRequestId) return;
      set({
        loadingMore: false,
        error: error instanceof Error ? error.message : "加载更多失败",
      });
    }
  },

  refresh: async () => {
    await get().loadFeed(PAGE_SIZE, true);
  },

  updateVideo: (video) => {
    if (!video?.aweme_id) return;
    const updateList = (items: VideoInfo[]) => items.map((item) => (
      item.aweme_id === video.aweme_id
        ? {
            ...item,
            ...video,
            statistics: {
              ...item.statistics,
              ...video.statistics,
            },
          }
        : item
    ));
    set((current) => ({
      videos: updateList(current.videos),
      feeds: {
        featured: {
          ...current.feeds.featured,
          videos: updateList(current.feeds.featured.videos),
        },
        recommended: {
          ...current.feeds.recommended,
          videos: updateList(current.feeds.recommended.videos),
        },
      },
    }));
  },
}));
