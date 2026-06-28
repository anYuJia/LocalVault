import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Download,
  Heart,
  ListVideo,
  Loader2,
  RefreshCw,
  Star,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { VideoCard } from "@/components/search/video-card";
import { VideoDetailModal } from "@/components/modals/video-detail";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import {
  getCollectedMixes,
  getCollectedVideos,
  getErrorMessage,
  getMixVideos,
  type CollectedMixItem,
  type VideoInfo,
} from "@/lib/tauri";
import { requestVerifyRecovery } from "@/lib/verify-recovery";
import {
  loadCollectedMixesCache,
  loadCollectedVideosCache,
  saveCollectedMixesCache,
  saveCollectedVideosCache,
} from "@/lib/collected-cache";
import { videoAuthorToUserInfo } from "@/lib/video-author";
import { cn } from "@/lib/utils";
import {
  ORIGINAL_VIDEO_GRID_CLASS,
  PAGE_SIZE,
  uniqueMixes,
  uniqueVideos,
  type CollectedTab,
} from "./collected-utils";
import {
  EmptyState,
  ErrorState,
  InlineWarning,
  LoadingGrid,
  LoadMoreFooter,
  MixCard,
  MixSkeletonGrid,
} from "./collected-components";

export function CollectedView() {
  const [tab, setTab] = useState<CollectedTab>("videos");

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-accent" />
          <h3 className="text-[0.9rem] font-semibold text-text">收藏视频</h3>
        </div>

        <div className="flex items-center gap-2 rounded-[14px] border border-border bg-surface p-1">
          {[
            { key: "videos" as const, label: "收藏视频", icon: Heart },
            { key: "mixes" as const, label: "收藏合集", icon: ListVideo },
          ].map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "relative flex h-9 cursor-pointer items-center gap-2 overflow-hidden rounded-[10px] px-3 text-[0.78rem] font-semibold transition-[color,opacity]",
                tab === key ? "text-accent" : "text-text-muted hover:bg-surface-raised hover:text-text"
              )}
            >
              {tab === key && (
                <motion.div
                  layoutId="collected-tab-active"
                  className="absolute inset-0 rounded-[10px] bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-ring)]"
                  transition={{ type: "spring", duration: 0.28, bounce: 0 }}
                />
              )}
              <Icon className="relative h-3.5 w-3.5" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === "videos" ? <CollectedVideosPanel /> : <CollectedMixesPanel />}
    </div>
  );
}

function CollectedVideosPanel() {
  const { downloadVideo, downloadBatch } = useDownloads();
  const addLog = useLogStore((s) => s.addLog);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const currentSecUid = useAppStore((s) => s.currentSecUid);
  const openUser = useSearchStore((s) => s.openUser);
  const [videos, setVideos] = useState<VideoInfo[]>(() => {
    const scope = useAppStore.getState().currentSecUid;
    return scope ? loadCollectedVideosCache(scope) : [];
  });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const loadVideos = useCallback(async (reset = false) => {
    if (loading || loadingMore) return;
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const result = await getCollectedVideos(reset ? 0 : cursor, PAGE_SIZE);
      if (!result.success) {
        const message = result.message || "获取收藏视频失败";
        if (result.need_login) {
          setVideos([]);
          setError(message);
          setInitialized(true);
          setCursor(0);
          setHasMore(false);
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "收藏视频需要验证",
            onResume: () => void loadVideos(reset),
          });
        }
        setError(message);
        setInitialized(true);
        setHasMore(false);
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }

      const incoming = result.data || [];
      setVideos((current) => {
        const next = reset ? incoming : uniqueVideos(current, incoming);
        saveCollectedVideosCache(next, currentSecUid);
        return next;
      });
      setCursor(result.cursor || 0);
      setHasMore(result.has_more ?? incoming.length > 0);
      setInitialized(true);
    } catch (err) {
      const message = getErrorMessage(err, "获取收藏视频失败");
      setError(message);
      setInitialized(true);
      setHasMore(false);
      addLog(message, "error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [addLog, currentSecUid, cursor, loading, loadingMore]);

  useEffect(() => {
    if (!initialized && !loading) void loadVideos(true);
  }, [initialized, loadVideos, loading]);

  useEffect(() => {
    setVideos(currentSecUid ? loadCollectedVideosCache(currentSecUid) : []);
    setInitialized(false);
    setCursor(0);
    setHasMore(true);
    setError(null);
  }, [currentSecUid]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore || videos.length === 0) return;
    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadVideos(false);
      },
      { root: null, rootMargin: "520px 0px", threshold: 0.01 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadVideos, loading, loadingMore, videos.length]);

  const openPlayer = (video: VideoInfo) => {
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };

  const openAuthor = async (video: VideoInfo) => {
    const user = videoAuthorToUserInfo(video);
    if (!user || authorLoadingId) return;
    setAuthorLoadingId(video.aweme_id);
    try {
      await openUser(user);
    } finally {
      setAuthorLoadingId(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Badge variant="secondary">{videos.length} 个视频</Badge>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadVideos(true)} disabled={loading || loadingMore}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
          <Button variant="default" size="sm" onClick={() => void downloadBatch(videos, "收藏视频")} disabled={videos.length === 0}>
            <Download className="h-3.5 w-3.5" />
            下载当前列表
          </Button>
        </div>
      </div>

      {loading && videos.length === 0 ? (
        <LoadingGrid />
      ) : error && videos.length === 0 ? (
        <ErrorState message={error} />
      ) : videos.length === 0 ? (
        <EmptyState
          title="暂无收藏视频"
          description={cookieLoggedIn ? "这个账号还没有收藏任何视频" : "需要登录抖音账号后才能读取收藏列表"}
          loggedIn={cookieLoggedIn}
        />
      ) : (
        <>
          {error && <InlineWarning message={error} />}
          <motion.div
            className={ORIGINAL_VIDEO_GRID_CLASS}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            {videos.map((video, index) => (
              <VideoCard
                key={video.aweme_id}
                video={video}
                index={index}
                animate={false}
                onSelect={openPlayer}
                onDetail={setDetailVideo}
                onDownload={(item) => void downloadVideo(item)}
                onAuthor={(item) => void openAuthor(item)}
                authorLoading={authorLoadingId === video.aweme_id}
              />
            ))}
          </motion.div>

          <div ref={loadMoreRef} className="h-px w-full" aria-hidden="true" />
          <LoadMoreFooter hasMore={hasMore} loadingMore={loadingMore} label="收藏视频" onLoadMore={() => void loadVideos(false)} />
        </>
      )}

      <FullscreenPlayer
        key={playerIndex ?? "closed"}
        videos={videos}
        initialIndex={playerIndex ?? 0}
        open={playerIndex !== null}
        onClose={() => setPlayerIndex(null)}
        onDownload={(video) => downloadVideo(video)}
        onLoadMore={hasMore && !loadingMore ? () => void loadVideos(false) : undefined}
        onShowDetail={(video) => {
          setPlayerIndex(null);
          setDetailVideo(video);
        }}
        onAuthor={(video) => {
          setPlayerIndex(null);
          void openAuthor(video);
        }}
      />

      <VideoDetailModal
        video={detailVideo}
        open={Boolean(detailVideo)}
        onOpenChange={(open) => {
          if (!open) setDetailVideo(null);
        }}
        onDownload={(video) => downloadVideo(video)}
      />
    </>
  );
}

function CollectedMixesPanel() {
  const addLog = useLogStore((s) => s.addLog);
  const currentSecUid = useAppStore((s) => s.currentSecUid);
  const [mixes, setMixes] = useState<CollectedMixItem[]>(() => {
    const scope = useAppStore.getState().currentSecUid;
    return scope ? loadCollectedMixesCache(scope) : [];
  });
  const [selectedMix, setSelectedMix] = useState<CollectedMixItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const loadMixes = useCallback(async (reset = false) => {
    if (loading || loadingMore) return;
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const result = await getCollectedMixes(reset ? 0 : cursor, PAGE_SIZE);
      if (!result.success) {
        const message = result.message || "获取收藏合集失败";
        if (result.need_login) {
          setMixes([]);
          setError(message);
          setInitialized(true);
          setCursor(0);
          setHasMore(false);
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "收藏合集需要验证",
            onResume: () => void loadMixes(reset),
          });
        }
        setError(message);
        setInitialized(true);
        setHasMore(false);
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }
      const incoming = result.data || [];
      setMixes((current) => {
        const next = reset ? incoming : uniqueMixes(current, incoming);
        saveCollectedMixesCache(next, currentSecUid);
        return next;
      });
      setCursor(result.cursor || 0);
      setHasMore(result.has_more ?? incoming.length > 0);
      setInitialized(true);
    } catch (err) {
      const message = getErrorMessage(err, "获取收藏合集失败");
      setError(message);
      setInitialized(true);
      setHasMore(false);
      addLog(message, "error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [addLog, currentSecUid, cursor, loading, loadingMore]);

  useEffect(() => {
    if (!initialized && !loading && !selectedMix) void loadMixes(true);
  }, [initialized, loadMixes, loading, selectedMix]);

  useEffect(() => {
    setMixes(currentSecUid ? loadCollectedMixesCache(currentSecUid) : []);
    setSelectedMix(null);
    setInitialized(false);
    setCursor(0);
    setHasMore(true);
    setError(null);
  }, [currentSecUid]);

  useEffect(() => {
    if (selectedMix || !hasMore || loading || loadingMore || mixes.length === 0) return;
    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMixes(false);
      },
      { root: null, rootMargin: "520px 0px", threshold: 0.01 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMixes, loading, loadingMore, mixes.length, selectedMix]);

  if (selectedMix) {
    return <MixVideosPanel mix={selectedMix} onBack={() => setSelectedMix(null)} />;
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-2">
        <Badge variant="secondary">{mixes.length} 个合集</Badge>
        <Button variant="outline" size="sm" onClick={() => void loadMixes(true)} disabled={loading || loadingMore}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          刷新
        </Button>
      </div>

      {loading && mixes.length === 0 ? (
        <MixSkeletonGrid />
      ) : error && mixes.length === 0 ? (
        <ErrorState message={error} />
      ) : mixes.length === 0 ? (
        <EmptyState title="暂无收藏合集" description="收藏合集会显示在这里" />
      ) : (
        <>
          {error && <InlineWarning message={error} />}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
            {mixes.map((mix) => (
              <MixCard key={mix.mix_id} mix={mix} onOpen={() => setSelectedMix(mix)} />
            ))}
          </div>
          <div ref={loadMoreRef} className="h-px w-full" aria-hidden="true" />
          <LoadMoreFooter hasMore={hasMore} loadingMore={loadingMore} label="收藏合集" onLoadMore={() => void loadMixes(false)} />
        </>
      )}
    </div>
  );
}

function MixVideosPanel({ mix, onBack }: { mix: CollectedMixItem; onBack: () => void }) {
  const { downloadVideo, downloadBatch } = useDownloads();
  const addLog = useLogStore((s) => s.addLog);
  const openUser = useSearchStore((s) => s.openUser);
  const [videos, setVideos] = useState<VideoInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const loadVideos = useCallback(async (reset = false) => {
    if (loading || loadingMore) return;
    if (reset) {
      setLoading(true);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const result = await getMixVideos(mix.mix_id, reset ? 0 : cursor, PAGE_SIZE);
      if (!result.success) {
        const message = result.message || "获取合集视频失败";
        if (result.need_login) {
          setError(message);
          setInitialized(true);
          setHasMore(false);
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "合集视频需要验证",
            onResume: () => void loadVideos(reset),
          });
        }
        setError(message);
        setInitialized(true);
        addLog(message, result.need_verify ? "warning" : "error");
        return;
      }
      const incoming = result.data || [];
      setVideos((current) => (reset ? incoming : uniqueVideos(current, incoming)));
      setCursor(result.cursor || 0);
      setHasMore(result.has_more ?? incoming.length > 0);
      setInitialized(true);
    } catch (err) {
      const message = getErrorMessage(err, "获取合集视频失败");
      setError(message);
      setInitialized(true);
      addLog(message, "error");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [addLog, cursor, loading, loadingMore, mix.mix_id]);

  useEffect(() => {
    if (!initialized && !loading) void loadVideos(true);
  }, [initialized, loadVideos, loading]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore || videos.length === 0) return;
    const node = loadMoreRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadVideos(false);
      },
      { root: null, rootMargin: "520px 0px", threshold: 0.01 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadVideos, loading, loadingMore, videos.length]);

  const openPlayer = (video: VideoInfo) => {
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };

  const openAuthor = async (video: VideoInfo) => {
    const user = videoAuthorToUserInfo(video);
    if (!user || authorLoadingId) return;
    setAuthorLoadingId(video.aweme_id);
    try {
      await openUser(user);
    } finally {
      setAuthorLoadingId(null);
    }
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack} className="shrink-0">
            <ArrowLeft className="h-3.5 w-3.5" />
            返回
          </Button>
          <ListVideo className="h-4 w-4 shrink-0 text-accent" />
          <h4 className="truncate text-[0.88rem] font-semibold text-text">{mix.mix_name || "收藏合集"}</h4>
          <Badge variant="secondary">{videos.length} 个视频</Badge>
        </div>
        <Button variant="default" size="sm" onClick={() => void downloadBatch(videos, mix.mix_name || "收藏合集")} disabled={videos.length === 0}>
          <Download className="h-3.5 w-3.5" />
          下载当前合集
        </Button>
      </div>

      {loading && videos.length === 0 ? (
        <LoadingGrid />
      ) : error && videos.length === 0 ? (
        <ErrorState message={error} />
      ) : videos.length === 0 ? (
        <EmptyState title="合集内暂无视频" description="该合集没有返回可下载的视频" />
      ) : (
        <>
          <motion.div
            className={ORIGINAL_VIDEO_GRID_CLASS}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
          >
            {videos.map((video, index) => (
              <VideoCard
                key={video.aweme_id}
                video={video}
                index={index}
                animate={false}
                onSelect={openPlayer}
                onDetail={setDetailVideo}
                onDownload={(item) => void downloadVideo(item)}
                onAuthor={(item) => void openAuthor(item)}
                authorLoading={authorLoadingId === video.aweme_id}
              />
            ))}
          </motion.div>
          <div ref={loadMoreRef} className="h-px w-full" aria-hidden="true" />
          <LoadMoreFooter hasMore={hasMore} loadingMore={loadingMore} label="合集视频" onLoadMore={() => void loadVideos(false)} />
        </>
      )}

      <FullscreenPlayer
        key={playerIndex ?? "closed"}
        videos={videos}
        initialIndex={playerIndex ?? 0}
        open={playerIndex !== null}
        onClose={() => setPlayerIndex(null)}
        onDownload={(video) => downloadVideo(video)}
        onLoadMore={hasMore && !loadingMore ? () => void loadVideos(false) : undefined}
        onShowDetail={(video) => {
          setPlayerIndex(null);
          setDetailVideo(video);
        }}
        onAuthor={(video) => {
          setPlayerIndex(null);
          void openAuthor(video);
        }}
      />

      <VideoDetailModal
        video={detailVideo}
        open={Boolean(detailVideo)}
        onOpenChange={(open) => {
          if (!open) setDetailVideo(null);
        }}
        onDownload={(video) => downloadVideo(video)}
      />
    </>
  );
}

