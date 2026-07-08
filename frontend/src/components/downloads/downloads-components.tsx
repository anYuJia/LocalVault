import { useEffect, useMemo, useState } from "react";
import {
  CalendarClock,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileImage,
  FileVideo,
  FolderOpen,
  Music2,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  localFileAssetUrl,
  mediaProxyUrl,
  type HistoryItem,
} from "@/lib/tauri";
import { cn, formatBytes } from "@/lib/utils";
import {
  buildPageRange,
  formatMediaKindLabel,
  formatVideoResolutionLabel,
  formatVideoResolutionTitle,
  formatWorkMediaSummary,
  getHistoryMediaKind,
  readVideoResolution,
  type DownloadWorkGroup,
  type LocalMediaKind,
  type VideoResolution,
} from "./downloads-utils";

export function HistoryFileCard({
  item,
  selected,
  selectionMode,
  onToggle,
  onOpen,
  onReveal,
  onDeleteFile,
  allowVideoPreview,
  deleting,
}: {
  item: HistoryItem;
  selected: boolean;
  selectionMode: boolean;
  allowVideoPreview: boolean;
  deleting: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onDeleteFile: () => void;
}) {
  const filename = item.filename || item.title || item.id;
  const mediaKind = getHistoryMediaKind(item);
  const mediaType = formatMediaKindLabel(mediaKind);
  const createdAt = item.timestamp
    ? new Date(item.timestamp * 1000).toLocaleString()
    : "";

  return (
    <div
      className={cn(
        "group relative rounded-[18px] border bg-surface-solid/75 p-4 transition-[background-color,border-color,box-shadow]",
        selected
          ? "border-accent/45 bg-accent-soft/20 shadow-[0_0_0_1px_var(--color-accent-ring)]"
          : "border-border hover:border-border-strong hover:bg-surface-raised"
      )}
    >
      {selectionMode && (
        <button
          onClick={onToggle}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface/95 text-text-muted shadow-[0_8px_22px_rgba(0,0,0,0.16)] transition-[background-color,color,border-color,box-shadow] hover:text-text"
          title={selected ? "取消选择" : "选择"}
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-accent" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
      )}

      <div className={cn("flex items-start gap-3", selectionMode && "pr-8")}>
        <HistoryFileThumbnail
          item={item}
          mediaKind={mediaKind}
          filename={filename}
          allowVideoPreview={allowVideoPreview}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <MediaKindIcon kind={mediaKind} className="h-4 w-4 shrink-0 text-info" />
            <button
              onClick={onOpen}
              className="truncate text-left text-[0.86rem] font-semibold text-text hover:text-accent transition-colors"
              title={filename}
            >
              {filename}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-text-muted tabular-nums">
            <Badge variant="secondary" size="sm">{mediaType || "未知类型"}</Badge>
            <span>{formatBytes(item.size || 0)}</span>
            {createdAt && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3 w-3" />
                {createdAt}
              </span>
            )}
            {item.author && <span>@{item.author}</span>}
          </div>

          <div className="mt-2 truncate text-[0.66rem] text-text-muted" title={item.path}>
            {item.path || "历史记录没有文件路径"}
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[0.86fr_0.86fr_1.15fr] gap-2">
        <Button variant="default" size="sm" onClick={onOpen} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <Play className="h-3.5 w-3.5" />
          播放
        </Button>
        <Button variant="outline" size="sm" onClick={onReveal} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <FolderOpen className="h-3.5 w-3.5" />
          定位
        </Button>
        <Button variant="danger-outline" size="sm" onClick={onDeleteFile} disabled={deleting} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <Trash2 className="h-3.5 w-3.5" />
          {deleting ? "删除中" : "删除文件"}
        </Button>
      </div>
    </div>
  );
}

export function DownloadWorkCard({
  group,
  selected,
  selectionMode,
  onToggle,
  onPlay,
  onReveal,
  onDeleteFile,
  allowVideoPreview,
  deleting,
}: {
  group: DownloadWorkGroup;
  selected: boolean;
  selectionMode: boolean;
  allowVideoPreview: boolean;
  deleting: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onReveal: () => void;
  onDeleteFile: () => void;
}) {
  const coverKind = getHistoryMediaKind(group.coverItem);
  const createdAt = group.timestamp
    ? new Date(group.timestamp * 1000).toLocaleString()
    : "";
  const firstPath = group.items.find((item) => item.path)?.path || "";

  return (
    <div
      className={cn(
        "group relative rounded-[18px] border bg-surface-solid/75 p-4 transition-[background-color,border-color,box-shadow]",
        selected
          ? "border-accent/45 bg-accent-soft/20 shadow-[0_0_0_1px_var(--color-accent-ring)]"
          : "border-border hover:border-border-strong hover:bg-surface-raised"
      )}
    >
      {selectionMode && (
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface/95 text-text-muted shadow-[0_8px_22px_rgba(0,0,0,0.16)] transition-[background-color,color,border-color,box-shadow] hover:text-text"
          title={selected ? "取消选择" : "选择"}
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-accent" />
          ) : (
            <Square className="h-4 w-4" />
          )}
        </button>
      )}
      <button
        type="button"
        onClick={onPlay}
        className={cn("flex w-full items-start gap-3 text-left", selectionMode && "pr-8")}
      >
        <HistoryFileThumbnail
          item={group.coverItem}
          mediaKind={coverKind}
          filename={group.title}
          allowVideoPreview={allowVideoPreview}
          className="h-28 w-20"
          label={`${group.items.length} 个`}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <FileVideo className="h-4 w-4 shrink-0 text-info" />
            <span className="truncate text-[0.88rem] font-semibold text-text group-hover:text-accent transition-colors">
              {group.title}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-text-muted tabular-nums">
            <Badge variant="secondary" size="sm">{formatWorkMediaSummary(group)}</Badge>
            <span>{formatBytes(group.size)}</span>
            {createdAt && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock className="h-3 w-3" />
                {createdAt}
              </span>
            )}
            {group.author && <span>@{group.author}</span>}
          </div>

          <div className="mt-2 truncate text-[0.66rem] text-text-muted" title={firstPath}>
            {firstPath || "作品没有可定位的文件路径"}
          </div>
        </div>
      </button>

      <div className="mt-3 grid grid-cols-[0.86fr_0.86fr_1.15fr] gap-2">
        <Button variant="default" size="sm" onClick={onPlay} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <Play className="h-3.5 w-3.5" />
          播放
        </Button>
        <Button variant="outline" size="sm" onClick={onReveal} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <FolderOpen className="h-3.5 w-3.5" />
          定位
        </Button>
        <Button variant="danger-outline" size="sm" onClick={onDeleteFile} disabled={deleting} className="min-w-0 gap-1 px-1.5 text-[0.72rem] sm:gap-1.5 sm:px-2 sm:text-[0.75rem]">
          <Trash2 className="h-3.5 w-3.5" />
          {deleting ? "删除中" : "删除文件"}
        </Button>
      </div>
    </div>
  );
}

export function HistoryFileThumbnail({
  item,
  mediaKind,
  filename,
  allowVideoPreview,
  className,
  label,
}: {
  item: HistoryItem;
  mediaKind: LocalMediaKind;
  filename: string;
  allowVideoPreview: boolean;
  className?: string;
  label?: string;
}) {
  const coverUrl = useMemo(() => (item.cover ? mediaProxyUrl(item.cover, "image") : ""), [item.cover]);
  const localUrl = useMemo(() => localFileAssetUrl(item.path), [item.path]);
  const videoUrl = useMemo(() => (localUrl ? `${localUrl}#t=0.1` : ""), [localUrl]);
  const [coverFailed, setCoverFailed] = useState(false);
  const [localFailed, setLocalFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [videoResolution, setVideoResolution] = useState<VideoResolution>(null);

  useEffect(() => {
    setCoverFailed(false);
    setLocalFailed(false);
    setLoaded(false);
    setVideoResolution(null);
  }, [coverUrl, localUrl]);

  const showLocalImage = Boolean(mediaKind === "image" && localUrl && !localFailed);
  const showLocalVideo = Boolean(allowVideoPreview && mediaKind === "video" && videoUrl && !localFailed);
  const loadVideoMetadataOnly = Boolean(mediaKind === "video" && videoUrl && !showLocalVideo && !localFailed);
  const showCover = Boolean(!showLocalImage && !showLocalVideo && coverUrl && !coverFailed);
  const hasPreview = showCover || showLocalImage || showLocalVideo;
  const resolutionLabel = mediaKind === "video" ? formatVideoResolutionLabel(videoResolution) : "";
  const resolutionTitle = formatVideoResolutionTitle(videoResolution);

  return (
    <div className={cn(
      "relative h-24 w-[72px] shrink-0 overflow-hidden rounded-[14px] bg-background-soft shadow-[inset_0_0_0_1px_var(--image-outline)]",
      className
    )}>
      {hasPreview && !loaded && (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,rgba(254,44,85,0.18),transparent_36%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))]" />
      )}

      {showCover && (
        <img
          src={coverUrl}
          alt={`${filename} 封面`}
          className={cn(
            "h-full w-full object-cover transition-[opacity,transform] duration-[var(--duration-base)]",
            loaded ? "opacity-100" : "opacity-0"
          )}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setCoverFailed(true);
            setLoaded(false);
          }}
        />
      )}

      {showLocalImage && (
        <img
          src={localUrl}
          alt={`${filename} 预览`}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-[var(--duration-base)]",
            loaded ? "opacity-100" : "opacity-0"
          )}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLocalFailed(true);
            setLoaded(false);
          }}
        />
      )}

      {showLocalVideo && (
        <video
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          aria-label={`${filename} 预览`}
          className={cn(
            "h-full w-full object-cover transition-opacity duration-[var(--duration-base)]",
            loaded ? "opacity-100" : "opacity-0"
          )}
          onLoadedMetadata={(event) => {
            setLoaded(true);
            setVideoResolution(readVideoResolution(event.currentTarget));
          }}
          onLoadedData={() => setLoaded(true)}
          onError={() => {
            setLocalFailed(true);
            setLoaded(false);
          }}
        />
      )}

      {loadVideoMetadataOnly && (
        <video
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          className="pointer-events-none absolute h-px w-px opacity-0"
          onLoadedMetadata={(event) => setVideoResolution(readVideoResolution(event.currentTarget))}
          onError={() => setLocalFailed(true)}
        />
      )}

      {!hasPreview && (
        <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_25%,rgba(124,92,252,0.18),transparent_38%),linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))]">
          <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-black/20 text-white/65 backdrop-blur-sm">
            <MediaKindIcon kind={mediaKind} className="h-5 w-5" />
          </div>
        </div>
      )}

      {resolutionLabel && (
        <div
          className="absolute right-1.5 top-1.5 max-w-[calc(100%-12px)] rounded-[6px] bg-black/68 px-1.5 py-0.5 text-[0.58rem] font-bold leading-none text-white shadow-[0_4px_12px_rgba(0,0,0,0.28)] backdrop-blur-sm"
          title={resolutionTitle}
        >
          {resolutionLabel}
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-7">
        <span className="text-[0.62rem] font-semibold text-white/90">
          {label || formatMediaKindLabel(mediaKind)}
        </span>
      </div>
    </div>
  );
}

export function MediaKindIcon({ kind, className }: { kind: LocalMediaKind; className?: string }) {
  if (kind === "image") return <FileImage className={className} />;
  if (kind === "audio") return <Music2 className={className} />;
  return <FileVideo className={className} />;
}

export function FilePagination({
  page,
  totalPages,
  totalItems,
  pageStart,
  pageEnd,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageStart: number;
  pageEnd: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  const pages = buildPageRange(page, totalPages);

  return (
    <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="text-[0.72rem] text-text-muted tabular-nums">
        显示 {pageStart + 1}-{pageEnd} / {totalItems}
      </div>

      <div className="flex items-center gap-1">
        <button
          onClick={() => onPageChange(1)}
          disabled={page === 1}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface text-text-muted disabled:opacity-40 hover:bg-surface-raised transition-[background-color,color,box-shadow]"
          title="第一页"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={page === 1}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface text-text-muted disabled:opacity-40 hover:bg-surface-raised transition-[background-color,color,box-shadow]"
          title="上一页"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>

        {pages.map((entry, index) =>
          entry === "ellipsis" ? (
            <span key={`ellipsis-${index}`} className="px-2 text-text-muted text-[0.78rem]">
              ···
            </span>
          ) : (
            <button
              key={entry}
              onClick={() => onPageChange(entry)}
              className={cn(
                "min-w-8 h-8 px-2 rounded-[10px] border text-[0.78rem] font-semibold transition-[background-color,color,border-color,box-shadow]",
                page === entry
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-border bg-surface text-text-muted hover:text-text hover:bg-surface-raised"
              )}
            >
              {entry}
            </button>
          )
        )}

        <button
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface text-text-muted disabled:opacity-40 hover:bg-surface-raised transition-[background-color,color,box-shadow]"
          title="下一页"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={page === totalPages}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-border bg-surface text-text-muted disabled:opacity-40 hover:bg-surface-raised transition-[background-color,color,box-shadow]"
          title="最后一页"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
