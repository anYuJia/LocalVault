import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  VideoCard,
  VIDEO_CARD_BODY_CLASS,
  VIDEO_CARD_COVER_CLASS,
  VIDEO_CARD_GRID_CLASS,
  VIDEO_CARD_HEIGHT_CLASS,
} from "@/components/search/video-card";
import { Sparkles, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRecommended } from "@/hooks/use-recommended";
import { useDownloads } from "@/hooks/use-downloads";
import { VideoDetailModal } from "@/components/modals/video-detail";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import { useSearchStore } from "@/stores/search-store";
import { useRecommendedStore } from "@/stores/recommended-store";
import type { RecommendedFeedType, VideoInfo } from "@/lib/tauri";
import { videoAuthorToUserInfo } from "@/lib/video-author";

const ORIGINAL_VIDEO_GRID_CLASS = VIDEO_CARD_GRID_CLASS;
const FEED_PRELOAD_ROOT_MARGIN = "1800px 0px";

export function RecommendedFeed() {
  const {
    feedType,
    videos,
    loading,
    loadingMore,
    hasMore,
    initialized,
    setFeedType,
    loadFeed,
    loadMore,
    refresh,
  } = useRecommended();
  const { downloadVideo } = useDownloads();
  const openUser = useSearchStore((s) => s.openUser);
  const updateRecommendedVideo = useRecommendedStore((s) => s.updateVideo);
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const openPlayer = (video: VideoInfo) => {
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };

  const handleFeedTypeChange = (value: string) => {
    const nextFeedType = value as RecommendedFeedType;
    if (nextFeedType === feedType) return;
    setPlayerIndex(null);
    setDetailVideo(null);
    setFeedType(nextFeedType);
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

  useEffect(() => {
    if (!initialized && videos.length === 0 && !loading) {
      void loadFeed();
    }
  }, [feedType, initialized, loadFeed, videos.length, loading]);

  useEffect(() => {
    if (!hasMore || loading || loadingMore || videos.length === 0) return;

    const node = loadMoreRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      {
        root: null,
        rootMargin: FEED_PRELOAD_ROOT_MARGIN,
        threshold: 0.01,
      }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loading, loadingMore, videos.length]);

  return (
    <>
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-accent" />
          <h3 className="text-[0.9rem] font-semibold text-text">推荐视频</h3>
          {videos.length > 0 && (
            <span className="text-[0.72rem] text-text-muted">{videos.length} 个</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Tabs value={feedType} onValueChange={handleFeedTypeChange}>
            <TabsList className="h-9">
              <TabsTrigger value="featured" className="h-8 px-3">
                精选
              </TabsTrigger>
              <TabsTrigger value="recommended" className="h-8 px-3">
                推荐
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
              style={{ willChange: loading ? "transform" : undefined }}
            />
            刷新
          </Button>
        </div>
      </div>

      {loading && videos.length === 0 ? (
        <RecommendedSkeletonGrid />
      ) : videos.length === 0 ? (
        <motion.div
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-20 text-center"
        >
          <div className="w-16 h-16 rounded-[20px] bg-accent/10 border border-accent/15 flex items-center justify-center mb-4">
            <Sparkles className="w-7 h-7 text-accent" />
          </div>
          <p className="text-[0.9rem] text-text-secondary mb-1">暂无推荐内容</p>
          <p className="text-[0.8rem] text-text-muted">需要配置 Cookie 后才能获取推荐视频</p>
        </motion.div>
      ) : (
        <>
          <motion.div
            className={ORIGINAL_VIDEO_GRID_CLASS}
            initial={false}
            animate="show"
            variants={{ hidden: {}, show: { transition: { staggerChildren: 0.04 } } }}
          >
            {videos.map((video, i) => (
              <VideoCard
                key={video.aweme_id}
                video={video}
                index={i}
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

          {hasMore ? (
            <div className="flex justify-center mt-6">
              <Button
                variant="outline"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="gap-2"
              >
                {loadingMore ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {loadingMore ? "正在预加载..." : "继续下滑自动预加载"}
              </Button>
            </div>
          ) : (
            <div className="mt-6 text-center text-[0.76rem] text-text-muted">
              已加载全部推荐视频
            </div>
          )}
        </>
      )}
    </div>
      <FullscreenPlayer
        key={playerIndex ?? "closed"}
        videos={videos}
        initialIndex={playerIndex ?? 0}
        open={playerIndex !== null}
        onClose={() => setPlayerIndex(null)}
        onDownload={(video) => downloadVideo(video)}
        onLoadMore={hasMore && !loadingMore ? () => void loadMore() : undefined}
        onShowDetail={(video) => {
          setPlayerIndex(null);
          setDetailVideo(video);
        }}
        onAuthor={(video) => {
          setPlayerIndex(null);
          void openAuthor(video);
        }}
        onVideoUpdate={updateRecommendedVideo}
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

function RecommendedSkeletonGrid() {
  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1 }}
      className={ORIGINAL_VIDEO_GRID_CLASS}
      aria-label="正在加载推荐内容"
    >
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className={`${VIDEO_CARD_HEIGHT_CLASS} overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70 shadow-[var(--shadow-sm)]`}
        >
          <div className={`${VIDEO_CARD_COVER_CLASS} bg-white/[0.05] animate-pulse`} />
          <div className={`${VIDEO_CARD_BODY_CLASS} p-3`}>
            <div className="mb-2 h-4 rounded bg-white/[0.06] animate-pulse" />
            <div className="mb-3 h-3 w-2/3 rounded bg-white/[0.05] animate-pulse" />
            <div className="grid grid-cols-3 gap-1.5">
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </motion.div>
  );
}
