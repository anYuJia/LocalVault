import { motion } from "framer-motion";
import { ListVideo, Loader2, RefreshCw, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorState as SharedErrorState, InlineStatus, LoginRequiredState } from "@/components/common/page-state";
import {
  VIDEO_CARD_BODY_CLASS,
  VIDEO_CARD_COVER_CLASS,
  VIDEO_CARD_HEIGHT_CLASS,
} from "@/components/search/video-card";
import { mediaProxyUrl, type CollectedMixItem } from "@/lib/tauri";
import { cn, formatNumber, formatTime } from "@/lib/utils";
import { ORIGINAL_VIDEO_GRID_CLASS } from "./collected-utils";

export function MixCard({ mix, onOpen }: { mix: CollectedMixItem; onOpen: () => void }) {
  const cover = mix.cover_url ? mediaProxyUrl(mix.cover_url, "image") : "";
  const episodeCount = mix.statis?.updated_to_episode || 0;
  const playCount = mix.statis?.play_vv || 0;
  const collectCount = mix.statis?.collect_vv || 0;
  const authorAvatar = mix.author?.avatar_thumb;

  return (
    <motion.button
      type="button"
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      onClick={onOpen}
      className="group overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/80 text-left transition-[background-color,border-color,box-shadow,transform] duration-200 hover:border-border-strong hover:bg-surface-raised hover:shadow-md active:scale-[0.99] h-[265px]"
    >
      <div className="relative h-[150px] bg-surface">
        {cover ? (
          <img src={cover} alt={mix.mix_name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ListVideo className="h-10 w-10 text-text-muted" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-9">
          <span className="text-[0.7rem] font-semibold text-white/90">
            {episodeCount > 0 ? `${episodeCount} 个视频` : "收藏合集"}
          </span>
        </div>
      </div>
      <div className="p-3">
        <div className="mb-1 truncate text-[0.86rem] font-semibold text-text">{mix.mix_name || "未命名合集"}</div>
        <p className="min-h-[2.3em] text-[0.72rem] leading-relaxed text-text-muted line-clamp-2">
          {mix.desc || "没有合集简介"}
        </p>
        <div className="mt-3 flex items-center justify-between gap-3 text-[0.68rem] text-text-muted">
          <span className="flex min-w-0 items-center gap-1.5">
            {authorAvatar && (
              <img src={mediaProxyUrl(authorAvatar, "image")} alt={mix.author?.nickname || ""} className="h-5 w-5 shrink-0 rounded-full object-cover" />
            )}
            <span className="truncate">@{mix.author?.nickname || "未知作者"}</span>
          </span>
          <span className="shrink-0 tabular-nums">
            {playCount > 0 ? `${formatNumber(playCount)} 播放` : `${formatNumber(collectCount)} 收藏`}
          </span>
        </div>
        {mix.update_time > 0 && (
          <div className="mt-2 text-[0.64rem] text-text-muted">更新于 {formatTime(mix.update_time)}</div>
        )}
      </div>
    </motion.button>
  );
}

export function LoadMoreFooter({
  hasMore,
  loadingMore,
  label,
  onLoadMore,
}: {
  hasMore: boolean;
  loadingMore: boolean;
  label: string;
  onLoadMore: () => void;
}) {
  if (!hasMore) {
    return <div className="mt-6 text-center text-[0.76rem] text-text-muted">已加载全部{label}</div>;
  }

  return (
    <div className="mt-6 flex justify-center">
      <Button variant="outline" onClick={onLoadMore} disabled={loadingMore} className="gap-2">
        {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {loadingMore ? "正在加载更多..." : "继续下滑自动加载"}
      </Button>
    </div>
  );
}

export function LoadingGrid() {
  return (
    <div className={ORIGINAL_VIDEO_GRID_CLASS}>
      {Array.from({ length: 8 }).map((_, index) => (
        <div key={index} className={cn(`${VIDEO_CARD_HEIGHT_CLASS} overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70`)}>
          <div className={`${VIDEO_CARD_COVER_CLASS} bg-white/[0.05] animate-pulse`} />
          <div className={`${VIDEO_CARD_BODY_CLASS} p-3`}>
            <div className="mb-2 h-4 rounded bg-white/[0.05] animate-pulse" />
            <div className="mb-3 h-3 w-1/2 rounded bg-white/[0.05] animate-pulse" />
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

export function MixSkeletonGrid() {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="h-[265px] overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70">
          <div className="h-[150px] bg-white/[0.05] animate-pulse" />
          <div className="p-3">
            <div className="mb-2 h-4 rounded bg-white/[0.05] animate-pulse" />
            <div className="mb-2 h-3 rounded bg-white/[0.05] animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-white/[0.05] animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, loggedIn = false }: { title: string; description: string; loggedIn?: boolean }) {
  return <LoginRequiredState title={title} description={description} icon={Star} loggedIn={loggedIn} />;
}

export function InlineWarning({ message }: { message: string }) {
  return (
    <InlineStatus tone="warning">
      当前显示的是本地缓存，刷新失败：{message}
    </InlineStatus>
  );
}

export function ErrorState({ message }: { message: string }) {
  return <SharedErrorState message={message} icon={Star} />;
}
