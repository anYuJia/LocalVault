import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import {
  Download,
  Heart,
  Loader2,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ErrorState as SharedErrorState, LoginRequiredState } from "@/components/common/page-state";
import { Surface, surfaceClassName } from "@/components/common/surface";
import { useToastStore } from "@/components/ui/toast";
import { useLikedStore } from "@/stores/liked-store";
import {
  VIDEO_CARD_BODY_CLASS,
  VIDEO_CARD_COVER_CLASS,
  VIDEO_CARD_GRID_CLASS,
  VIDEO_CARD_HEIGHT_CLASS,
} from "@/components/search/video-card";
import { VirtualVideoGrid } from "@/components/search/virtual-video-grid";
import { VideoDetailModal } from "@/components/modals/video-detail";
import { FullscreenPlayer } from "@/components/player/lazy-fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import { useAppStore, useDownloadStore, useLogStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import { downloadUserVideos, mediaProxyUrl, type UserInfo, type VideoInfo } from "@/lib/tauri";
import { videoAuthorToUserInfo } from "@/lib/video-author";
import { cn, formatNumber } from "@/lib/utils";

type LikedTab = "videos" | "authors";
const ORIGINAL_VIDEO_GRID_CLASS = VIDEO_CARD_GRID_CLASS;

export function LikedView() {
  const [tab, setTab] = useState<LikedTab>("videos");
  const videos = useLikedStore((s) => s.videos);
  const authors = useLikedStore((s) => s.authors);
  const loadingVideos = useLikedStore((s) => s.loadingVideos);
  const loadingMoreVideos = useLikedStore((s) => s.loadingMoreVideos);
  const loadingAuthors = useLikedStore((s) => s.loadingAuthors);
  const videosHasMore = useLikedStore((s) => s.videosHasMore);
  const videosError = useLikedStore((s) => s.videosError);
  const authorsError = useLikedStore((s) => s.authorsError);
  const loadVideos = useLikedStore((s) => s.loadVideos);
  const loadMoreVideos = useLikedStore((s) => s.loadMoreVideos);
  const loadAuthors = useLikedStore((s) => s.loadAuthors);
  const resetVideosForCurrentAccount = useLikedStore((s) => s.resetVideosForCurrentAccount);
  const currentSecUid = useAppStore((s) => s.currentSecUid);
  const { downloadVideo, downloadBatch } = useDownloads();
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);
  const openUser = useSearchStore((s) => s.openUser);

  const openPlayer = (video: VideoInfo) => {
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };

  const handleGoToAuthor = async (video: VideoInfo) => {
    const userInfo = videoAuthorToUserInfo(video);
    if (!userInfo || authorLoadingId) return;
    setAuthorLoadingId(video.aweme_id);
    try {
      await openUser(userInfo);
    } finally {
      setAuthorLoadingId(null);
    }
  };

  useEffect(() => {
    resetVideosForCurrentAccount();
  }, [currentSecUid, resetVideosForCurrentAccount]);

  useEffect(() => {
    if (tab === "videos") {
      void loadVideos();
    } else {
      void loadAuthors();
    }
  }, [tab, loadAuthors, loadVideos, currentSecUid]);

  return (
    <>
      <div>
        <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <Heart className="w-4 h-4 text-accent" />
            <h3 className="text-[0.9rem] font-semibold text-text">点赞内容</h3>
            <Badge variant="secondary">
              {tab === "videos" ? `${videos.length} 个视频` : `${authors.length} 个作者`}
            </Badge>
          </div>

          <div className="flex items-center gap-2 rounded-[14px] bg-surface p-1 border border-border">
            {[
              { key: "videos" as const, label: "点赞视频", icon: Heart },
              { key: "authors" as const, label: "点赞作者", icon: Users },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={cn(
                  "relative flex h-9 items-center gap-2 overflow-hidden rounded-[10px] px-3 text-[0.78rem] font-semibold cursor-pointer transition-[color,opacity]",
                  tab === key
                    ? "text-accent"
                    : "text-text-muted hover:text-text hover:bg-surface-raised"
                )}
              >
                {tab === key && (
                  <motion.div
                    layoutId="liked-tab-active"
                    className="absolute inset-0 rounded-[10px] bg-accent-soft shadow-[inset_0_0_0_1px_var(--color-accent-ring)]"
                    transition={{ type: "spring", duration: 0.28, bounce: 0 }}
                  />
                )}
                <Icon className="relative w-3.5 h-3.5" />
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
        </div>

        {tab === "videos" ? (
          <LikedVideosPanel
            videos={videos}
            loading={loadingVideos}
            loadingMore={loadingMoreVideos}
            hasMore={videosHasMore}
            error={videosError}
            onRefresh={() => void loadVideos(true)}
            onLoadMore={() => void loadMoreVideos()}
            onSelect={openPlayer}
            onDetail={setDetailVideo}
            onDownload={(video) => downloadVideo(video)}
            onAuthor={handleGoToAuthor}
            authorLoadingId={authorLoadingId}
            onDownloadAll={() => void downloadBatch(videos, "点赞视频")}
          />
        ) : (
          <LikedAuthorsPanel
            authors={authors}
            loading={loadingAuthors}
            error={authorsError}
            onRefresh={() => void loadAuthors(true)}
          />
        )}
      </div>

      <FullscreenPlayer
        key={playerIndex ?? "closed"}
        videos={videos}
        initialIndex={playerIndex ?? 0}
        open={playerIndex !== null}
        onClose={() => setPlayerIndex(null)}
        onDownload={(video) => downloadVideo(video)}
        onLoadMore={videosHasMore && !loadingMoreVideos ? () => void loadMoreVideos() : undefined}
        onShowDetail={(video) => {
          setPlayerIndex(null);
          setDetailVideo(video);
        }}
        onAuthor={(video) => {
          setPlayerIndex(null);
          void handleGoToAuthor(video);
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

function LikedVideosPanel({
  videos,
  loading,
  loadingMore,
  hasMore,
  error,
  onRefresh,
  onLoadMore,
  onSelect,
  onDetail,
  onDownload,
  onAuthor,
  authorLoadingId,
  onDownloadAll,
}: {
  videos: VideoInfo[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelect: (video: VideoInfo) => void;
  onDetail: (video: VideoInfo) => void;
  onDownload: (video: VideoInfo) => void;
  onAuthor: (video: VideoInfo) => void;
  authorLoadingId: string | null;
  onDownloadAll: () => void;
}) {
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);

  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-4">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading || loadingMore}>
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          刷新
        </Button>
        <Button variant="default" size="sm" onClick={onDownloadAll} disabled={videos.length === 0}>
          <Download className="w-3.5 h-3.5" />
          下载当前列表
        </Button>
      </div>

      {loading && videos.length === 0 ? (
        <LoadingGrid />
      ) : error && videos.length === 0 ? (
        <ErrorState message={error} />
      ) : videos.length === 0 ? (
        <EmptyState
          title="暂无点赞视频"
          description={cookieLoggedIn ? "这个账号还没有点赞任何视频" : "需要登录抖音账号后才能读取点赞视频列表"}
          loggedIn={cookieLoggedIn}
        />
      ) : (
        <>
          <VirtualVideoGrid
            videos={videos}
            onSelect={onSelect}
            onDetail={onDetail}
            onDownload={onDownload}
            onAuthor={onAuthor}
            authorLoadingId={authorLoadingId}
            hasMore={hasMore}
            loadingMore={loadingMore}
            onLoadMore={onLoadMore}
          />

          {hasMore ? (
            <div className="flex justify-center mt-6">
              <Button
                variant="outline"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="gap-2"
              >
                {loadingMore ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {loadingMore ? "正在加载更多..." : "继续下滑自动加载"}
              </Button>
            </div>
          ) : (
            <div className="mt-6 text-center text-[0.76rem] text-text-muted">
              已加载全部点赞视频
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LikedAuthorsPanel({
  authors,
  loading,
  error,
  onRefresh,
}: {
  authors: UserInfo[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const addLog = useLogStore((s) => s.addLog);
  const updateTask = useDownloadStore((s) => s.updateTask);
  const openUser = useSearchStore((s) => s.openUser);
  const [busyAuthorId, setBusyAuthorId] = useState<string | null>(null);
  const [downloadAuthorId, setDownloadAuthorId] = useState<string | null>(null);
  const [downloadingAllAuthors, setDownloadingAllAuthors] = useState(false);

  const handleViewVideos = async (author: UserInfo) => {
    if (busyAuthorId || downloadingAllAuthors) return;
    setBusyAuthorId(author.sec_uid);
    try {
      await openUser(author);
    } finally {
      setBusyAuthorId(null);
    }
  };

  const handleDownloadAuthor = async (author: UserInfo) => {
    if (downloadAuthorId || downloadingAllAuthors) return;
    setDownloadAuthorId(author.sec_uid);
    try {
      const result = await downloadUserVideos(
        author.sec_uid,
        author.nickname,
        author.aweme_count || 0
      );
      if (result.success && result.task_id) {
        const totalVideos = result.total_videos ?? author.aweme_count ?? 0;
        updateTask({
          id: result.task_id,
          filename: `${result.nickname || author.nickname || "作者"} 全部作品`,
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
      addLog(result.message || `开始下载 ${author.nickname} 的作品`, result.success ? "success" : "error");
    } catch (error) {
      addLog(error instanceof Error ? error.message : "启动作者下载失败", "error");
    } finally {
      setDownloadAuthorId(null);
    }
  };

  const handleDownloadAllAuthors = async () => {
    if (downloadingAllAuthors || authors.length === 0) return;
    setDownloadingAllAuthors(true);
    let started = 0;
    let failed = 0;

    try {
      for (const author of authors) {
        try {
          const result = await downloadUserVideos(
            author.sec_uid,
            author.nickname,
            author.aweme_count || 0
          );
          if (result.success && result.task_id) {
            const totalVideos = result.total_videos ?? author.aweme_count ?? 0;
            updateTask({
              id: result.task_id,
              filename: `${result.nickname || author.nickname || "作者"} 全部作品`,
              progress: 0,
              status: "downloading",
              isBatch: true,
              mediaCount: totalVideos,
              fileTotal: totalVideos,
              fileIndex: 0,
              startTime: Date.now(),
              speed: 0,
            });
            started += 1;
          } else {
            failed += 1;
            addLog(result.message || `${author.nickname} 下载启动失败`, "error");
          }
        } catch (error) {
          failed += 1;
          addLog(error instanceof Error ? error.message : `${author.nickname} 下载启动失败`, "error");
        }
      }

      addLog(
        `点赞作者作品下载已提交: 成功 ${started} 个作者${failed ? `, 失败 ${failed} 个` : ""}`,
        started > 0 ? "success" : "warning"
      );
    } finally {
      setDownloadingAllAuthors(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-end gap-2 mb-4">
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          刷新
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleDownloadAllAuthors()}
          disabled={authors.length === 0 || downloadingAllAuthors || loading}
        >
          {downloadingAllAuthors ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          下载全部作者作品
        </Button>
      </div>

      {loading && authors.length === 0 ? (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Surface key={index} density="default" className="rounded-[16px]">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-white/[0.05] animate-pulse" />
                <div className="flex-1">
                  <div className="h-4 w-1/2 rounded bg-white/[0.05] animate-pulse mb-2" />
                  <div className="h-3 w-2/3 rounded bg-white/[0.05] animate-pulse" />
                </div>
              </div>
              <div className="h-4 rounded bg-white/[0.05] animate-pulse mb-2" />
              <div className="h-4 w-4/5 rounded bg-white/[0.05] animate-pulse mb-4" />
              <div className="grid grid-cols-4 gap-2 mb-4">
                {Array.from({ length: 4 }).map((__, statIndex) => (
                  <div key={statIndex} className="h-14 rounded-[12px] bg-white/[0.05] animate-pulse" />
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="h-9 rounded-[12px] bg-white/[0.05] animate-pulse" />
                <div className="h-9 rounded-[12px] bg-white/[0.05] animate-pulse" />
              </div>
            </Surface>
          ))}
        </div>
      ) : error && authors.length === 0 ? (
        <ErrorState message={error} />
      ) : authors.length === 0 ? (
        <EmptyState title="暂无点赞作者" description="读取点赞作者同样需要有效的登录态 Cookie" />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {authors.map((author) => {
            const viewing = busyAuthorId === author.sec_uid;
            const downloading = downloadAuthorId === author.sec_uid;
            return (
              <motion.div
                key={author.sec_uid}
                initial={false}
                animate={{ opacity: 1, y: 0 }}
                className={surfaceClassName({
                  density: "default",
                  tone: "solid",
                  className: "rounded-[18px]",
                })}
              >
                <div className="flex items-center gap-3 mb-3">
                  <img
                    src={mediaProxyUrl(author.avatar_larger || author.avatar_medium || author.avatar_thumb, "image")}
                    alt={author.nickname}
                    className="w-12 h-12 rounded-full object-cover border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.24)]"
                  />
                  <div className="min-w-0">
                    <div className="text-[0.88rem] font-semibold text-text truncate">
                      {author.nickname}
                    </div>
                    <div className="text-[0.72rem] text-text-muted truncate">
                      @{author.unique_id || author.sec_uid}
                    </div>
                  </div>
                </div>

                <p className="text-[0.75rem] text-text-secondary line-clamp-2 leading-relaxed min-h-[38px]">
                  {author.signature || "这个作者还没有填写简介"}
                </p>

                <div className="grid grid-cols-4 gap-2 mt-3">
                  {[
                    { label: "作品", value: author.aweme_count || 0 },
                    { label: "粉丝", value: author.follower_count || 0 },
                    { label: "关注", value: author.following_count || 0 },
                    { label: "获赞", value: author.total_favorited || 0 },
                  ].map((stat) => (
                    <div key={stat.label} className="rounded-[12px] bg-white/[0.03] px-2 py-2 text-center">
                      <div className="text-[0.78rem] font-semibold text-text tabular-nums">
                        {formatNumber(stat.value)}
                      </div>
                      <div className="text-[0.63rem] text-text-muted mt-0.5">{stat.label}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2 mt-4">
                  <Button
                    variant="info-outline"
                    size="sm"
                    onClick={() => void handleViewVideos(author)}
                    disabled={viewing || downloading || downloadingAllAuthors}
                  >
                    {viewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    查看作品
                  </Button>
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void handleDownloadAuthor(author)}
                    disabled={viewing || downloading || downloadingAllAuthors}
                  >
                    {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                    下载作品
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LoadingGrid() {
  return (
    <div className={ORIGINAL_VIDEO_GRID_CLASS}>
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className={`${VIDEO_CARD_HEIGHT_CLASS} overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70`}
        >
          <div className={`${VIDEO_CARD_COVER_CLASS} bg-white/[0.05] animate-pulse`} />
          <div className={`${VIDEO_CARD_BODY_CLASS} p-3`}>
            <div className="h-4 rounded bg-white/[0.05] animate-pulse mb-2" />
            <div className="h-3 w-1/2 rounded bg-white/[0.05] animate-pulse mb-3" />
            <div className="mt-auto grid grid-cols-3 gap-1.5">
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
              <div className="h-7 rounded bg-white/[0.05] animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, description, icon: Icon = Heart, loggedIn = false }: { title: string; description: string; icon?: React.ElementType; loggedIn?: boolean }) {
  return <LoginRequiredState title={title} description={description} icon={Icon} loggedIn={loggedIn} />;
}

function ErrorState({ message }: { message: string }) {
  return <SharedErrorState message={message} retry={() => window.location.reload()} />;
}
