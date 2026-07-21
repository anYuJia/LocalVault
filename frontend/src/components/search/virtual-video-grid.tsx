import { memo, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { VideoCard, VIDEO_CARD_GRID_CLASS, VIDEO_CARD_HEIGHT_CLASS } from "@/components/search/video-card";
import type { VideoInfo } from "@/lib/tauri";

const MIN_CARD_WIDTH = 210;
const GRID_GAP = 12;
const CARD_HEIGHT = 412;
const ROW_HEIGHT = CARD_HEIGHT + GRID_GAP;
const OVERSCAN_ROWS = 2;

function findScrollParent(node: HTMLElement | null): HTMLElement | Window {
  let current = node?.parentElement || null;
  while (current) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return current;
    }
    current = current.parentElement;
  }
  return window;
}

function readScrollParentViewport(node: HTMLElement, scrollParent: HTMLElement | Window) {
  const rect = node.getBoundingClientRect();
  if (scrollParent === window) {
    return {
      top: Math.max(0, -rect.top),
      height: window.innerHeight || 900,
      width: rect.width,
    };
  }

  const parent = scrollParent as HTMLElement;
  const parentRect = parent.getBoundingClientRect();
  return {
    top: Math.max(0, parentRect.top - rect.top),
    height: parent.clientHeight || 900,
    width: rect.width,
  };
}

interface VirtualVideoGridProps {
  videos: VideoInfo[];
  onSelect: (video: VideoInfo) => void;
  onDetail: (video: VideoInfo) => void;
  onDownload: (video: VideoInfo) => void;
  onAuthor: (video: VideoInfo) => void;
  authorLoadingId?: string | null;
  selectedIds?: Set<string>;
  animate?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  loadMoreRootMargin?: string;
}

export const VirtualVideoGrid = memo(function VirtualVideoGrid({
  videos,
  onSelect,
  onDetail,
  onDownload,
  onAuthor,
  authorLoadingId,
  selectedIds,
  animate = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  loadMoreRootMargin = "520px 0px",
}: VirtualVideoGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 900, width: 0 });

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const scrollParent = findScrollParent(node);
    let frame: number | null = null;
    const updateViewport = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        const currentNode = containerRef.current;
        if (!currentNode) return;
        const next = readScrollParentViewport(currentNode, scrollParent);
        setViewport((current) =>
          current.top === next.top && current.height === next.height && current.width === next.width
            ? current
            : next
        );
      });
    };

    updateViewport();
    const resizeObserver = new ResizeObserver(updateViewport);
    resizeObserver.observe(node);
    scrollParent.addEventListener("scroll", updateViewport, { passive: true });
    window.addEventListener("resize", updateViewport);

    return () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      scrollParent.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  const columns = Math.max(1, Math.floor((viewport.width + GRID_GAP) / (MIN_CARD_WIDTH + GRID_GAP)));
  const rowCount = Math.ceil(videos.length / columns);
  const startRow = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN_ROWS);
  const endRow = Math.min(rowCount, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN_ROWS);
  const startIndex = startRow * columns;
  const endIndex = Math.min(videos.length, endRow * columns);
  const visibleVideos = useMemo(
    () => videos.slice(startIndex, endIndex),
    [endIndex, startIndex, videos]
  );

  useEffect(() => {
    if (!hasMore || loadingMore || !onLoadMore || videos.length === 0) return;
    const node = loadMoreRef.current;
    if (!node) return;
    const scrollParent = findScrollParent(containerRef.current);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      {
        root: scrollParent instanceof HTMLElement ? scrollParent : null,
        rootMargin: loadMoreRootMargin,
        threshold: 0.01,
      }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMoreRootMargin, loadingMore, onLoadMore, videos.length]);

  return (
    <>
      <motion.div
        ref={containerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.2 }}
        style={{ height: rowCount > 0 ? rowCount * ROW_HEIGHT - GRID_GAP : 0 }}
        className="relative"
      >
        <div
          className={VIDEO_CARD_GRID_CLASS}
          style={{
            position: "absolute",
            insetInline: 0,
            top: startRow * ROW_HEIGHT,
          }}
        >
          {visibleVideos.map((video, offset) => {
            const index = startIndex + offset;
            return (
              <VideoCard
                key={video.aweme_id}
                video={video}
                index={index}
                animate={animate}
                onSelect={onSelect}
                onDetail={onDetail}
                onDownload={onDownload}
                onAuthor={onAuthor}
                authorLoading={authorLoadingId === video.aweme_id}
                selected={selectedIds?.has(video.aweme_id)}
              />
            );
          })}
        </div>
      </motion.div>
      <div ref={loadMoreRef} className="h-px w-full" aria-hidden="true" />
    </>
  );
});

export function VideoGridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className={VIDEO_CARD_GRID_CLASS}>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className={`${VIDEO_CARD_HEIGHT_CLASS} overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70`}
        >
          <div className="h-[280px] bg-white/[0.05] animate-pulse" />
          <div className="h-[132px] p-3">
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
