import { motion } from "framer-motion";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Download, Eye, Heart, Star, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { VideoCover } from "@/components/media/video-cover";
import { cancelVideoPrewarm, prewarmVideoForPlayback } from "@/lib/media-prewarm";
import { cn, formatTime } from "@/lib/utils";
import { mediaProxyUrl, type VideoInfo } from "@/lib/tauri";

interface VideoCardProps {
  video: VideoInfo;
  index?: number;
  onSelect?: (video: VideoInfo) => void;
  onDetail?: (video: VideoInfo) => void;
  onDownload?: (video: VideoInfo) => void;
  onAuthor?: (video: VideoInfo) => void;
  authorLoading?: boolean;
  selected?: boolean;
  animate?: boolean;
}

export const VIDEO_CARD_GRID_CLASS = "grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3";
export const VIDEO_CARD_HEIGHT_CLASS = "h-[412px]";
export const VIDEO_CARD_COVER_CLASS = "h-[280px]";
export const VIDEO_CARD_BODY_CLASS = "h-[132px]";

export function VideoCard({
  video,
  index = 0,
  onSelect,
  onDetail,
  onDownload,
  onAuthor,
  authorLoading,
  selected,
  animate = false,
}: VideoCardProps) {
  const Card = animate ? motion.div : "div";
  const authorLabel = video.author?.nickname ? `@${video.author.nickname}` : "";
  const authorAvatar = video.author?.avatar_thumb || video.author?.avatar_medium;

  const handleCardClick = () => {
    prewarmVideoForPlayback(video, { mode: "playback" });
    onSelect?.(video);
  };

  const stopAndRun = (
    event: ReactMouseEvent,
    action: ((video: VideoInfo) => void) | undefined
  ) => {
    event.stopPropagation();
    action?.(video);
  };

  return (
    <Card
      {...(animate
        ? {
            initial: { opacity: 0, y: 12 },
            animate: { opacity: 1, y: 0 },
            transition: { delay: index * 0.05, type: "spring" as const, stiffness: 350, damping: 28 },
          }
        : {})}
      style={{ breakInside: "avoid" }}
      onClick={handleCardClick}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        prewarmVideoForPlayback(video);
      }}
      onPointerLeave={() => cancelVideoPrewarm(video)}
      onPointerDown={() => prewarmVideoForPlayback(video, { mode: "playback" })}
      onPointerCancel={() => cancelVideoPrewarm(video)}
      onBlur={() => cancelVideoPrewarm(video)}
      onFocus={() => prewarmVideoForPlayback(video)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleCardClick();
        }
      }}
      tabIndex={0}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-[var(--radius-lg)] bg-surface-solid/90 shadow-sm",
        VIDEO_CARD_HEIGHT_CLASS,
        "border border-transparent transition-[box-shadow,border-color,background-color] duration-[var(--duration-base)] ease-[var(--ease-spring)]",
        "hover:border-border-strong hover:shadow-md",
        selected && "border-accent shadow-[var(--shadow-glow)]"
      )}
    >
      <VideoCover video={video} className={VIDEO_CARD_COVER_CLASS} priority={index < 8} showPlayOverlay={false} />

      {(video.is_liked || video.is_collected) && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex gap-1">
          {video.is_liked && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/55 text-accent shadow-sm backdrop-blur-md" title="已点赞">
              <Heart className="h-3.5 w-3.5 fill-current" />
            </span>
          )}
          {video.is_collected && (
            <span className="flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/55 text-warning shadow-sm backdrop-blur-md" title="已收藏">
              <Star className="h-3.5 w-3.5 fill-current" />
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div className={cn("flex flex-col p-3", VIDEO_CARD_BODY_CLASS)}>
        <p className="mb-1.5 min-h-[2.75em] break-words text-[0.82rem] leading-[1.35] text-text line-clamp-2">
          {video.desc}
        </p>

        <div className="mb-auto flex items-center gap-2 min-w-0">
          {authorAvatar && (
            <img
              src={mediaProxyUrl(authorAvatar, "image")}
              alt={authorLabel}
              className="w-5 h-5 rounded-full object-cover shrink-0 ring-1 ring-border/50"
            />
          )}
          <span className="truncate text-[0.7rem] text-text-muted">
            {[authorLabel, formatTime(video.create_time)].filter(Boolean).join(" · ")}
          </span>
        </div>

        <div className="mt-2.5 flex gap-1.5 transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-spring)] sm:translate-y-1 sm:opacity-0 sm:group-hover:translate-y-0 sm:group-hover:opacity-100 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100">
          <Button
            variant="outline"
            size="icon-sm"
            className="h-8 flex-1 rounded-[8px]"
            onClick={(event) => stopAndRun(event, onAuthor)}
            disabled={!onAuthor || !video.author?.sec_uid || authorLoading}
            title={video.author?.sec_uid ? "进入作者主页" : "作者信息不可用"}
            aria-label="进入作者主页"
          >
            {authorLoading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <UserRound className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            variant="info-outline"
            size="icon-sm"
            className="h-8 flex-1 rounded-[8px]"
            onClick={(event) => stopAndRun(event, onDetail)}
            disabled={!onDetail}
            title="详情"
            aria-label="查看详情"
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="success-outline"
            size="icon-sm"
            className="h-8 flex-1 rounded-[8px]"
            onClick={(event) => stopAndRun(event, onDownload)}
            disabled={!onDownload}
            title="下载"
            aria-label="下载作品"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </Card>
  );
}
