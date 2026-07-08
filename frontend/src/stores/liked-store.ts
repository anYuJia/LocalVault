import { create } from "zustand";
import {
  getErrorMessage,
  getLikedAuthors,
  getLikedVideos,
  type UserInfo,
  type VideoInfo,
} from "@/lib/tauri";
import { requestVerifyRecovery } from "@/lib/verify-recovery";
import {
  loadLikedAuthorsCache,
  loadLikedVideosCache,
  saveLikedAuthorsCache,
  saveLikedVideosCache,
} from "@/lib/liked-cache";
import { useAppStore, useLogStore } from "@/stores/app-store";

const DEFAULT_COUNT = 20;
let latestVideosRequestId = 0;
let latestLoadMoreVideosRequestId = 0;

const uniqueVideos = (existing: VideoInfo[], incoming: VideoInfo[]) => {
  const seen = new Set(existing.map((video) => video.aweme_id));
  const next = [...existing];
  for (const video of incoming) {
    if (!video?.aweme_id || seen.has(video.aweme_id)) continue;
    seen.add(video.aweme_id);
    next.push(video);
  }
  return next;
};

interface LikedStoreState {
  videos: VideoInfo[];
  authors: UserInfo[];
  loadingVideos: boolean;
  loadingMoreVideos: boolean;
  loadingAuthors: boolean;
  videosLoaded: boolean;
  authorsLoaded: boolean;
  videosCursor: number;
  videosHasMore: boolean;
  videosError: string | null;
  authorsError: string | null;
  resetVideosForCurrentAccount: () => void;
  loadVideos: (force?: boolean, count?: number) => Promise<void>;
  loadMoreVideos: () => Promise<void>;
  loadAuthors: (force?: boolean, count?: number) => Promise<void>;
}

export const useLikedStore = create<LikedStoreState>((set, get) => ({
  videos: [],
  authors: [],
  loadingVideos: false,
  loadingMoreVideos: false,
  loadingAuthors: false,
  videosLoaded: false,
  authorsLoaded: false,
  videosCursor: 0,
  videosHasMore: true,
  videosError: null,
  authorsError: null,

  resetVideosForCurrentAccount: () => {
    const cacheScope = useAppStore.getState().currentSecUid;
    const cachedVideos = cacheScope ? loadLikedVideosCache(cacheScope) : [];
    latestVideosRequestId += 1;
    latestLoadMoreVideosRequestId += 1;
    set({
      videos: cachedVideos,
      loadingVideos: false,
      loadingMoreVideos: false,
      videosLoaded: false,
      videosCursor: 0,
      videosHasMore: true,
      videosError: null,
    });
  },

  loadVideos: async (force = false, count = DEFAULT_COUNT) => {
    const state = get();
    if (state.loadingVideos || state.loadingMoreVideos) return;
    if (!force && state.videosLoaded && state.videos.length > 0) return;

    const addLog = useLogStore.getState().addLog;
    const cacheScope = useAppStore.getState().currentSecUid;
    const cachedVideos = cacheScope ? loadLikedVideosCache(cacheScope) : [];
    const requestId = ++latestVideosRequestId;
    latestLoadMoreVideosRequestId += 1;
    set({
      loadingVideos: true,
      loadingMoreVideos: false,
      videosError: null,
      ...(state.videos.length > 0
        ? {}
        : cachedVideos.length > 0
          ? { videos: cachedVideos, videosCursor: 0, videosHasMore: true }
          : { videos: [], videosCursor: 0, videosHasMore: true }),
    });
    addLog("加载点赞视频...", "info");

    try {
      const result = await getLikedVideos(count, "", 0);
      if (requestId !== latestVideosRequestId) return;

      if (!result.success) {
        const message = result.message || "获取点赞视频失败";
        if (result.need_login) {
          set({
            videos: [],
            loadingVideos: false,
            videosLoaded: true,
            videosCursor: 0,
            videosHasMore: false,
            videosError: message,
          });
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "点赞视频需要验证",
            onResume: () => void get().loadVideos(true, count),
          });
        }
        if (cachedVideos.length > 0) {
          set({
            videos: cachedVideos,
            loadingVideos: false,
            videosLoaded: true,
            videosCursor: 0,
            videosHasMore: false,
            videosError: null,
          });
          addLog(`点赞视频请求失败，已回退到本地缓存（${cachedVideos.length} 条）`, "warning");
          return;
        }
        set({
          loadingVideos: false,
          videosLoaded: true,
          videosHasMore: false,
          videosError: message,
        });
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }

      const videos = result.data || [];
      saveLikedVideosCache(videos, cacheScope);
      set({
        videos,
        loadingVideos: false,
        loadingMoreVideos: false,
        videosLoaded: true,
        videosCursor: result.cursor || 0,
        videosHasMore: result.has_more ?? videos.length > 0,
        videosError: null,
      });
      addLog(`已加载 ${videos.length} 个点赞视频`, "success");
    } catch (error) {
      if (requestId !== latestVideosRequestId) return;

      if (cachedVideos.length > 0) {
        set({
          videos: cachedVideos,
          loadingVideos: false,
          videosLoaded: true,
          videosCursor: 0,
          videosHasMore: false,
          videosError: null,
        });
        addLog(`点赞视频请求异常，已回退到本地缓存（${cachedVideos.length} 条）`, "warning");
        return;
      }

      const message = getErrorMessage(error, "获取点赞视频失败");
      set({
        loadingVideos: false,
        videosLoaded: true,
        videosHasMore: false,
        videosError: message,
      });
      addLog(message, "error");
    }
  },

  loadMoreVideos: async () => {
    const state = get();
    if (state.loadingVideos || state.loadingMoreVideos || !state.videosHasMore) return;

    const addLog = useLogStore.getState().addLog;
    const requestId = ++latestLoadMoreVideosRequestId;
    const cursor = state.videosCursor;
    set({ loadingMoreVideos: true, videosError: null });

    try {
      const result = await getLikedVideos(DEFAULT_COUNT, "", cursor);
      if (requestId !== latestLoadMoreVideosRequestId) return;

      if (!result.success) {
        const message = result.message || "加载更多点赞视频失败";
        if (result.need_login) {
          set({ loadingMoreVideos: false, videosError: message });
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "点赞视频需要验证",
            onResume: () => void get().loadMoreVideos(),
          });
        }
        set({ loadingMoreVideos: false, videosError: message });
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }

      const incoming = result.data || [];
      const currentVideos = get().videos;
      const nextVideos = uniqueVideos(currentVideos, incoming);
      const addedCount = nextVideos.length - currentVideos.length;
      const cacheScope = useAppStore.getState().currentSecUid;
      saveLikedVideosCache(nextVideos, cacheScope);

      set((current) => ({
        loadingMoreVideos: false,
        videos: nextVideos,
        videosLoaded: true,
        videosCursor: result.cursor || current.videosCursor,
        videosHasMore: addedCount > 0 && (result.has_more ?? incoming.length > 0),
        videosError: null,
      }));

      if (addedCount > 0) {
        addLog(`已继续加载 ${addedCount} 个点赞视频`, "success");
      }
    } catch (error) {
      if (requestId !== latestLoadMoreVideosRequestId) return;
      const message = getErrorMessage(error, "加载更多点赞视频失败");
      set({ loadingMoreVideos: false, videosError: message });
      addLog(message, "error");
    }
  },

  loadAuthors: async (force = false, count = DEFAULT_COUNT) => {
    const state = get();
    if (state.loadingAuthors) return;
    if (!force && state.authorsLoaded && state.authors.length > 0) return;

    const addLog = useLogStore.getState().addLog;
    const cachedAuthors = loadLikedAuthorsCache();
    set({
      loadingAuthors: true,
      authorsError: null,
      ...(state.authors.length > 0 ? {} : cachedAuthors.length > 0 ? { authors: cachedAuthors } : { authors: [] }),
    });
    addLog("加载点赞作者...", "info");

    try {
      const result = await getLikedAuthors(count);
      if (!result.success) {
        const message = result.message || "获取点赞作者失败";
        if (result.need_login) {
          set({
            loadingAuthors: false,
            authorsLoaded: true,
            authorsError: message,
          });
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "点赞作者需要验证",
            onResume: () => void get().loadAuthors(true, count),
          });
        }
        if (cachedAuthors.length > 0) {
          set({
            authors: cachedAuthors,
            loadingAuthors: false,
            authorsLoaded: true,
            authorsError: null,
          });
          addLog(`点赞作者请求失败，已回退到本地缓存（${cachedAuthors.length} 条）`, "warning");
          return;
        }
        set({
          loadingAuthors: false,
          authorsLoaded: true,
          authorsError: message,
        });
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }

      const authors = result.data || [];
      saveLikedAuthorsCache(authors);
      set({
        authors,
        loadingAuthors: false,
        authorsLoaded: true,
        authorsError: null,
      });
      addLog(`已加载 ${authors.length} 个点赞作者`, "success");
    } catch (error) {
      if (cachedAuthors.length > 0) {
        set({
          authors: cachedAuthors,
          loadingAuthors: false,
          authorsLoaded: true,
          authorsError: null,
        });
        addLog(`点赞作者请求异常，已回退到本地缓存（${cachedAuthors.length} 条）`, "warning");
        return;
      }

      const message = getErrorMessage(error, "获取点赞作者失败");
      set({
        loadingAuthors: false,
        authorsLoaded: true,
        authorsError: message,
      });
      addLog(message, "error");
    }
  },
}));
