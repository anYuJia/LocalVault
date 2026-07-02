import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { CheckSquare, Download, Grid3x3, Loader2, RefreshCw, Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { VideoGridSkeleton, VirtualVideoGrid } from "./virtual-video-grid";
import { VideoDetailModal } from "@/components/modals/video-detail";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import { useDownloadStore, useLogStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import { formatNumber } from "@/lib/utils";
import { downloadUserVideos, type VideoInfo } from "@/lib/tauri";
import { videoAuthorToUserInfo } from "@/lib/video-author";

export function VideoGrid() {
  const currentUser = useSearchStore((s) => s.currentUser);
  const videos = useSearchStore((s) => s.videos);
  const loadingVideos = useSearchStore((s) => s.loadingVideos);
  const loadingMore = useSearchStore((s) => s.loadingMore);
  const hasMore = useSearchStore((s) => s.hasMore);
  const openUser = useSearchStore((s) => s.openUser);
  const loadVideos = useSearchStore((s) => s.loadVideos);
  const loadMore = useSearchStore((s) => s.loadMore);
  const { downloadVideo, downloadBatch } = useDownloads();
  const addLog = useLogStore((s) => s.addLog);
  const updateTask = useDownloadStore((s) => s.updateTask);
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);

  const showPlaceholder = currentUser && !loadingVideos && videos.length === 0;
  const totalVideosCount = currentUser?.aweme_count || videos.length;
  const openPlayer = (video: VideoInfo) => {
    if (selectMode) {
      toggleSelected(video.aweme_id);
      return;
    }
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };
  const openAuthor = async (video: VideoInfo) => {
    const userInfo = videoAuthorToUserInfo(video);
    if (!userInfo || authorLoadingId) return;
    setAuthorLoadingId(video.aweme_id);
    try {
      await openUser(userInfo);
    } finally {
      setAuthorLoadingId(null);
    }
  };
  const selectedVideos = videos.filter((video) => selectedIds.has(video.aweme_id));
  const toggleSelected = (awemeId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(awemeId)) next.delete(awemeId);
      else next.add(awemeId);
      return next;
    });
  };
  const toggleSelectMode = () => {
    setSelectMode((value) => {
      if (value) setSelectedIds(new Set());
      return !value;
    });
  };
  const handleDownloadAll = async () => {
    if (!currentUser || videos.length === 0) return;

    if (selectedVideos.length > 0) {
      await downloadBatch(selectedVideos, currentUser.nickname || "搜索作品");
      return;
    }

    try {
      addLog(`开始下载 ${currentUser.nickname} 的全部作品`, "info");
      const result = await downloadUserVideos(
        currentUser.sec_uid,
        currentUser.nickname,
        currentUser.aweme_count || videos.length
      );
      if (!result.success) {
        throw new Error(result.message || "批量下载启动失败");
      }
      if (result.task_id) {
        const totalVideos = result.total_videos ?? currentUser.aweme_count ?? videos.length;
        updateTask({
          id: result.task_id,
          filename: `${result.nickname || currentUser.nickname || "用户"} 全部作品`,
          progress: 0,
          status: "downloading",
          isBatch: true,
          mediaCount: totalVideos,
          fileTotal: totalVideos,
          fileIndex: 0,
          startTime: Date.now(),
          speed: 0,
        });
      }
      addLog(result.message || `开始下载 ${currentUser.nickname} 的全部作品`, "success");
    } catch (error) {
      addLog(error instanceof Error ? error.message : "批量下载启动失败", "error");
    }
  };

  useEffect(() => {
    const validIds = new Set(videos.map((video) => video.aweme_id));
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [videos]);


  if (!currentUser) return null;

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Grid3x3 className="w-4 h-4 text-success" />
            <h3 className="text-[0.9rem] font-semibold text-text">作品列表</h3>
            <Badge variant="secondary">
              {loadingVideos && videos.length === 0
                ? "加载中..."
                : `${formatNumber(totalVideosCount)} 个作品`}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadVideos()}
              disabled={loadingVideos}
            >
              {loadingVideos ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              重新加载
            </Button>
            <Button
              variant={selectMode ? "default" : "outline"}
              size="sm"
              onClick={toggleSelectMode}
              disabled={videos.length === 0}
            >
              {selectMode ? <CheckSquare className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
              {selectMode ? "退出选择" : "选择作品"}
            </Button>
            <Button
              variant={selectedVideos.length > 0 ? "success-outline" : "default"}
              size="sm"
              onClick={() => void handleDownloadAll()}
              disabled={videos.length === 0}
            >
              <Download className="w-3.5 h-3.5" />
              {selectedVideos.length > 0 ? `下载选中 (${selectedVideos.length})` : "下载全部"}
            </Button>
          </div>
        </div>

        {loadingVideos && videos.length === 0 ? (
          <VideoGridSkeleton />
        ) : showPlaceholder ? (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center justify-center min-h-[400px] rounded-[var(--radius-xl)] bg-surface-solid/40 border border-border/50 p-12 text-center"
          >
            <div className="w-16 h-16 rounded-[20px] bg-accent-soft flex items-center justify-center mb-6">
              <Sparkles className="w-8 h-8 text-accent" />
            </div>
            <h3 className="text-[1.1rem] font-bold text-text mb-2">
              开启你的精彩发现
            </h3>
            <p className="text-[0.82rem] text-text-muted mb-8 max-w-[280px] leading-relaxed">
              尚未加载作品列表。点击下方按钮或从用户卡片中进入以开始浏览。
            </p>
            <Button
              variant="default"
              size="lg"
              className="gap-2 rounded-[14px] px-8"
              onClick={() => void loadVideos()}
            >
              <Grid3x3 className="w-4 h-4" />
              立即加载作品
            </Button>
          </motion.div>
        ) : (
          <>
            <VirtualVideoGrid
              videos={videos}
              onSelect={openPlayer}
              onDetail={setDetailVideo}
              onDownload={(item) => void downloadVideo(item)}
              onAuthor={(item) => void openAuthor(item)}
              authorLoadingId={authorLoadingId}
              selectedIds={selectedIds}
              hasMore={hasMore}
              loadingMore={loadingMore || loadingVideos}
              onLoadMore={() => void loadMore()}
            />

            <div className="h-px w-full" aria-hidden="true" />

            {hasMore && (
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
                  {loadingMore ? "加载中..." : "加载更多"}
                </Button>
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
        onLoadMore={hasMore ? () => void loadMore() : undefined}
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
