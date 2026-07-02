import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Clock, Film, Heart, MessageCircle, Play, Share2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  clearMediaFailure,
  hasRecentMediaFailure,
  markMediaFailure,
} from "@/lib/media-failure-cache";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import { mediaProxyUrl, type VideoInfo } from "@/lib/tauri";
import {
  collectVideoMedia,
  getMediaProxyType,
  getVideoCover,
  getVideoDurationSeconds,
  getVideoMediaLabel,
  isVideoLikeMedia,
} from "@/lib/video-media";

const COVER_RETRY_DELAY_MS = 2500;
const COVER_MAX_RETRIES = 2;

interface VideoCoverProps {
  video: VideoInfo;
  className?: string;
  imageClassName?: string;
  priority?: boolean;
  showStats?: boolean;
  showDuration?: boolean;
  showPlayOverlay?: boolean;
  allowVideoFallback?: boolean;
}

export function VideoCover({
  video,
  className,
  imageClassName,
  priority = false,
  showStats = true,
  showDuration = true,
  showPlayOverlay = true,
  allowVideoFallback = false,
}: VideoCoverProps) {
  const cover = getVideoCover(video);
  const coverProxyUrl = useMemo(() => (cover ? mediaProxyUrl(cover, "image") : ""), [cover]);
  const [coverRetryKey, setCoverRetryKey] = useState(0);
  const coverUrl = useMemo(() => {
    if (!coverProxyUrl || coverRetryKey <= 0) return coverProxyUrl;
    return `${coverProxyUrl}${coverProxyUrl.includes("?") ? "&" : "?"}cover_retry=${coverRetryKey}`;
  }, [coverProxyUrl, coverRetryKey]);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const mediaItems = useMemo(() => collectVideoMedia(video), [video]);
  const fallbackMedia = mediaItems[0] || null;
  const durationSeconds = getVideoDurationSeconds(video);
  const durationLabel = durationSeconds > 0 ? formatDuration(durationSeconds) : "";
  const mediaTypeLabel = getVideoMediaLabel(video);
  const stats = video.statistics;

  useEffect(() => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    setCoverRetryKey(0);
    setCoverLoaded(false);
    setCoverFailed(hasRecentMediaFailure(coverProxyUrl));
  }, [coverProxyUrl]);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  const scheduleCoverRetry = useCallback(() => {
    if (!coverProxyUrl || retryTimerRef.current !== null) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      setCoverRetryKey((value) => {
        if (value >= COVER_MAX_RETRIES) {
          markMediaFailure(coverProxyUrl);
          setCoverFailed(true);
          return value;
        }
        return value + 1;
      });
    }, COVER_RETRY_DELAY_MS);
  }, [coverProxyUrl]);

  const handleImageNode = useCallback((node: HTMLImageElement | null) => {
    imageRef.current = node;
    if (!node || !coverUrl) return;
    if (node.complete) {
      if (node.naturalWidth > 0) {
        clearMediaFailure(coverProxyUrl);
        setCoverLoaded(true);
        setCoverFailed(false);
      } else {
        markMediaFailure(coverProxyUrl);
        setCoverFailed(true);
      }
    }
  }, [coverUrl]);

  useEffect(() => {
    const image = imageRef.current;
    if (!coverUrl || !image) return;
    if (image.complete) {
      if (image.naturalWidth > 0) {
        clearMediaFailure(coverProxyUrl);
        setCoverLoaded(true);
        setCoverFailed(false);
      } else {
        markMediaFailure(coverProxyUrl);
        setCoverFailed(true);
      }
    }
  }, [coverUrl]);

  useEffect(() => {
    if (!coverUrl || coverLoaded || coverFailed || coverRetryKey >= COVER_MAX_RETRIES) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      const image = imageRef.current;
      if (image?.complete && image.naturalWidth > 0) {
        clearMediaFailure(coverProxyUrl);
        setCoverLoaded(true);
        return;
      }
      setCoverRetryKey((value) => Math.min(COVER_MAX_RETRIES, value + 1));
    }, COVER_RETRY_DELAY_MS);
    return () => {
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [coverFailed, coverLoaded, coverProxyUrl, coverRetryKey, coverUrl]);

  const skipCoverRequest = coverFailed || hasRecentMediaFailure(coverProxyUrl);

  return (
    <div className={cn("relative isolate overflow-hidden bg-surface", className)}>
      {coverUrl && !skipCoverRequest ? (
        <>
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-0 bg-[radial-gradient(circle_at_50%_30%,rgba(254,44,85,0.12),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.07),rgba(255,255,255,0.02))] transition-opacity duration-200",
              coverLoaded ? "opacity-0" : "opacity-100"
            )}
          />
          <img
            ref={handleImageNode}
            key={coverUrl}
            src={coverUrl}
            alt={video.desc}
            className={cn(
              "relative h-full w-full object-cover transition-[opacity,transform] duration-[var(--duration-base)] group-hover:scale-[1.025]",
              coverLoaded ? "opacity-100" : "opacity-95",
              imageClassName
            )}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : "auto"}
            decoding="async"
            onLoad={() => {
              clearMediaFailure(coverProxyUrl);
              setCoverLoaded(true);
              setCoverFailed(false);
            }}
            onError={() => {
              if (coverRetryKey < COVER_MAX_RETRIES) {
                scheduleCoverRetry();
                return;
              }
              markMediaFailure(coverProxyUrl);
              setCoverFailed(true);
            }}
          />
        </>
      ) : allowVideoFallback && fallbackMedia && isVideoLikeMedia(fallbackMedia) ? (
        <video
          src={mediaProxyUrl(fallbackMedia.url, getMediaProxyType(fallbackMedia))}
          muted
          playsInline
          preload="metadata"
          className={cn("h-full w-full object-cover", imageClassName)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_30%,rgba(254,44,85,0.16),transparent_35%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))]">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-black/20 text-white/60 backdrop-blur-sm">
            <Film className="h-7 w-7" />
          </div>
        </div>
      )}

      {showPlayOverlay && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/45 text-white shadow-[0_14px_42px_rgba(0,0,0,0.35)] backdrop-blur-md">
            <Play className="ml-1 h-7 w-7 fill-white" />
          </div>
        </div>
      )}

      <Badge
        variant="default"
        size="sm"
        className="pointer-events-none absolute right-2 top-2 border-white/20 bg-black/45 text-white backdrop-blur-sm"
      >
        {mediaTypeLabel}
      </Badge>

      {showDuration && durationLabel && (
        <Badge
          variant="secondary"
          size="sm"
          className="pointer-events-none absolute bottom-2 left-2 gap-1 border-white/15 bg-black/55 text-white backdrop-blur-sm"
        >
          <Clock className="h-3 w-3" />
          {durationLabel}
        </Badge>
      )}

      {showStats && stats && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-3 pt-8 opacity-0 transition-opacity duration-[var(--duration-fast)] group-hover:opacity-100">
          <div className="flex items-center justify-around text-[0.7rem] font-semibold text-white">
            <span className="flex flex-col items-center gap-0.5">
              <Heart className="h-4 w-4 text-accent" />
              {formatNumber(stats.digg_count)}
            </span>
            <span className="flex flex-col items-center gap-0.5">
              <MessageCircle className="h-4 w-4 text-cyan-400" />
              {formatNumber(stats.comment_count)}
            </span>
            <span className="flex flex-col items-center gap-0.5">
              <Share2 className="h-4 w-4 text-green-400" />
              {formatNumber(stats.share_count)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
