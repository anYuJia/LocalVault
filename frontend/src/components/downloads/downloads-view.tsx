import { useDeferredValue, useEffect, useMemo, useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAlertStore, useDownloadStore, useLogStore } from "@/stores/app-store";
import { TaskCard } from "./task-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  AlertCircle,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileImage,
  FileVideo,
  FolderOpen,
  Search,
  RefreshCw,
  Trash2,
  CheckSquare,
  Square,
  Play,
  Folder,
  Music2,
} from "lucide-react";
import { useDownloads } from "@/hooks/use-downloads";
import { useHistory } from "@/hooks/use-history";
import {
  deleteFile,
  listDownloadFilesPage,
  localFileAssetUrl,
  mediaProxyUrl,
  openFileLocation,
  type HistoryItem,
  type VideoInfo,
} from "@/lib/tauri";
import { cn, formatBytes } from "@/lib/utils";

const FILE_PAGE_SIZE_OPTIONS = [12, 24, 48, 96] as const;
type LocalMediaKind = "video" | "image" | "audio" | "media";
type DownloadDisplayMode = "file" | "work";
type VideoResolution = { width: number; height: number } | null;
type DownloadPlayerState = {
  videos: VideoInfo[];
  initialIndex: number;
  initialMediaIndex: number;
} | null;

interface DownloadWorkGroup {
  id: string;
  title: string;
  author: string;
  timestamp: number;
  size: number;
  items: HistoryItem[];
  coverItem: HistoryItem;
  mediaCounts: Record<LocalMediaKind, number>;
}

function readVideoResolution(video: HTMLVideoElement): VideoResolution {
  const width = Math.round(Number(video.videoWidth || 0));
  const height = Math.round(Number(video.videoHeight || 0));
  return width > 0 && height > 0 ? { width, height } : null;
}

function standardQualityHeightFromDimension(value: number): number {
  if (value <= 0) return 0;
  const standardHeights = [4320, 2160, 1440, 1080, 720, 540, 480, 360, 240];
  const nearest = standardHeights.reduce((best, height) =>
    Math.abs(height - value) < Math.abs(best - value) ? height : best
  );
  const tolerance = Math.max(16, nearest * 0.04);
  return Math.abs(nearest - value) <= tolerance ? nearest : 0;
}

function longSideQualityHeight(value: number): number {
  if (value <= 0) return 0;
  const mappings = [
    [3840, 2160],
    [2560, 1440],
    [1920, 1080],
    [1280, 720],
    [960, 540],
    [854, 480],
    [852, 480],
  ] as const;
  for (const [longSide, qualityHeight] of mappings) {
    const tolerance = Math.max(24, longSide * 0.04);
    if (Math.abs(value - longSide) <= tolerance) return qualityHeight;
  }
  return 0;
}

function inferResolutionQualityHeight(resolution: VideoResolution): number {
  if (!resolution) return 0;
  return Math.max(
    standardQualityHeightFromDimension(resolution.width),
    standardQualityHeightFromDimension(resolution.height),
    longSideQualityHeight(resolution.width),
    longSideQualityHeight(resolution.height)
  );
}

function formatVideoResolutionLabel(resolution: VideoResolution): string {
  if (!resolution) return "";
  const qualityHeight = inferResolutionQualityHeight(resolution);
  if (qualityHeight >= 2160) return "4K";
  if (qualityHeight >= 1440) return "2K";
  if (qualityHeight > 0) return `${qualityHeight}p`;
  return `${resolution.width}x${resolution.height}`;
}

function formatVideoResolutionTitle(resolution: VideoResolution): string {
  if (!resolution) return "";
  return `${resolution.width} x ${resolution.height}`;
}

export function DownloadsView() {
  const tasks = useDownloadStore((s) => s.tasks);
  const clearCompleted = useDownloadStore((s) => s.clearCompleted);
  const addLog = useLogStore((s) => s.addLog);
  const showAlert = useAlertStore((s) => s.showAlert);
  const {
    cancelDownload,
    pauseTask,
    resumeTask,
    retryDownload,
    removeTask,
    openDownloadsDirectory,
    openTaskLocation,
    syncTasks,
  } = useDownloads();
  const {
    items: historyItems,
    loading: historyLoading,
    loadHistory,
    deleteItem: deleteHistoryItem,
  } = useHistory();

  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("date_desc");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedWorks, setSelectedWorks] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [diskFiles, setDiskFiles] = useState<HistoryItem[]>([]);
  const [diskTotal, setDiskTotal] = useState(0);
  const [diskLoading, setDiskLoading] = useState(false);
  const [displayMode, setDisplayMode] = useState<DownloadDisplayMode>("file");
  const [workDiskFiles, setWorkDiskFiles] = useState<HistoryItem[]>([]);
  const [workDiskLoading, setWorkDiskLoading] = useState(false);
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [playerState, setPlayerState] = useState<DownloadPlayerState>(null);
  const [filePage, setFilePage] = useState(1);
  const [filePageSize, setFilePageSize] = useState<number>(24);
  const diskRequestIdRef = useRef(0);
  const workRequestIdRef = useRef(0);

  useEffect(() => {
    void syncTasks();
  }, [syncTasks]);

  const loadDiskFiles = useCallback(async (forceRefresh = false) => {
    const requestId = ++diskRequestIdRef.current;
    setDiskLoading(true);
    try {
      const page = await listDownloadFilesPage({
        offset: (filePage - 1) * filePageSize,
        limit: filePageSize,
        forceRefresh,
        query: deferredSearchQuery.trim() || undefined,
        mediaType: typeFilter,
        sortBy,
      });
      if (requestId !== diskRequestIdRef.current) return;
      setDiskFiles(page.items);
      setDiskTotal(page.total);
    } catch (error) {
      if (requestId === diskRequestIdRef.current) {
        addLog(error instanceof Error ? error.message : "扫描下载目录失败", "error");
      }
    } finally {
      if (requestId === diskRequestIdRef.current) {
        setDiskLoading(false);
      }
    }
  }, [addLog, deferredSearchQuery, filePage, filePageSize, sortBy, typeFilter]);

  useEffect(() => {
    void loadDiskFiles();
  }, [loadDiskFiles]);

  const loadWorkDiskFiles = useCallback(async (forceRefresh = false) => {
    const requestId = ++workRequestIdRef.current;
    setWorkDiskLoading(true);
    try {
      const page = await listDownloadFilesPage({
        offset: 0,
        forceRefresh,
        query: deferredSearchQuery.trim() || undefined,
        mediaType: typeFilter,
        sortBy,
      });
      if (requestId !== workRequestIdRef.current) return;
      setWorkDiskFiles(page.items);
    } catch (error) {
      if (requestId === workRequestIdRef.current) {
        addLog(error instanceof Error ? error.message : "整理下载作品失败", "error");
      }
    } finally {
      if (requestId === workRequestIdRef.current) {
        setWorkDiskLoading(false);
      }
    }
  }, [addLog, deferredSearchQuery, sortBy, typeFilter]);

  useEffect(() => {
    if (displayMode !== "work") return;
    void loadWorkDiskFiles();
  }, [displayMode, loadWorkDiskFiles]);

  const handleRefresh = useCallback(() => {
    void syncTasks();
    void loadHistory();
    void loadDiskFiles(true);
    if (displayMode === "work") {
      void loadWorkDiskFiles(true);
    }
  }, [displayMode, syncTasks, loadHistory, loadDiskFiles, loadWorkDiskFiles]);

  const handleOpenDir = useCallback(() => {
    void openDownloadsDirectory();
  }, [openDownloadsDirectory]);

  const taskMatchesFilters = useCallback((task: {
    filename?: string;
    awemeId?: string;
    savePath?: string;
    filePath?: string;
    mediaType?: string;
    totalBytes?: number;
    startTime?: number;
    finishedTime?: number;
  }) => {
    const query = deferredSearchQuery.trim().toLowerCase();
    if (query) {
      const matched = [task.filename, task.awemeId, task.savePath, task.filePath]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
      if (!matched) return false;
    }
    if (typeFilter !== "all" && !(task.mediaType || "").toLowerCase().includes(typeFilter)) {
      return false;
    }
    return true;
  }, [deferredSearchQuery, typeFilter]);

  const tasksList = useMemo(() => {
    const sorted = Object.values(tasks)
      .filter(taskMatchesFilters)
      .sort((a, b) => {
        if (sortBy === "date_asc") {
          return (a.startTime || a.finishedTime || 0) - (b.startTime || b.finishedTime || 0);
        }
        if (sortBy === "size_desc") {
          return (b.totalBytes || 0) - (a.totalBytes || 0);
        }
        if (sortBy === "size_asc") {
          return (a.totalBytes || 0) - (b.totalBytes || 0);
        }
        return (b.startTime || b.finishedTime || 0) - (a.startTime || a.finishedTime || 0);
      });
    return sorted;
  }, [tasks, taskMatchesFilters, sortBy]);

  const mergedFiles = useMemo(() => {
    return mergeDownloadFileItems(diskFiles, historyItems);
  }, [diskFiles, historyItems]);

  const mergedWorkFiles = useMemo(() => {
    return mergeDownloadFileItems(workDiskFiles, historyItems);
  }, [historyItems, workDiskFiles]);

  const historyList = useMemo(() => {
    return mergedFiles;
  }, [mergedFiles]);

  const workGroups = useMemo(() => {
    return buildDownloadWorkGroups(mergedWorkFiles, sortBy);
  }, [mergedWorkFiles, sortBy]);

  const totalFileItems = displayMode === "work" ? workGroups.length : diskTotal;
  const totalFilePages = Math.max(1, Math.ceil(totalFileItems / filePageSize));
  const safeFilePage = Math.min(filePage, totalFilePages);
  const filePageStart = (safeFilePage - 1) * filePageSize;
  const paginatedHistoryList = historyList;
  const paginatedWorkGroups = useMemo(() => {
    return workGroups.slice(filePageStart, filePageStart + filePageSize);
  }, [filePageSize, filePageStart, workGroups]);
  const displayedItemCount = displayMode === "work" ? paginatedWorkGroups.length : historyList.length;
  const filePageEnd = Math.min(filePageStart + displayedItemCount, totalFileItems);
  const pageSelectedCount = displayMode === "work"
    ? paginatedWorkGroups.filter((group) => selectedWorks.has(group.id)).length
    : paginatedHistoryList.filter((item) => selectedFiles.has(item.id)).length;
  const allPageSelected =
    displayMode === "work"
      ? paginatedWorkGroups.length > 0 && pageSelectedCount === paginatedWorkGroups.length
      : paginatedHistoryList.length > 0 && pageSelectedCount === paginatedHistoryList.length;
  const selectedCount = displayMode === "work" ? selectedWorks.size : selectedFiles.size;
  const localListLoading = historyLoading || diskLoading || (displayMode === "work" && workDiskLoading);
  const deletingFiles = deletingIds.size > 0;

  useEffect(() => {
    setFilePage(1);
    setSelectionMode(false);
    setSelectedFiles(new Set());
    setSelectedWorks(new Set());
  }, [deferredSearchQuery, displayMode, sortBy, typeFilter, filePageSize]);

  useEffect(() => {
    if (filePage > totalFilePages) {
      setFilePage(totalFilePages);
    }
  }, [filePage, totalFilePages]);

  useEffect(() => {
    const validIds = new Set(paginatedHistoryList.map((item) => item.id));
    setSelectedFiles((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [paginatedHistoryList]);

  useEffect(() => {
    const validIds = new Set(paginatedWorkGroups.map((group) => group.id));
    setSelectedWorks((current) => {
      const next = new Set([...current].filter((id) => validIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [paginatedWorkGroups]);

  const toggleSelectAll = useCallback(() => {
    if (displayMode === "work") {
      setSelectedWorks((current) => {
        const next = new Set(current);
        if (allPageSelected) {
          paginatedWorkGroups.forEach((group) => next.delete(group.id));
        } else {
          paginatedWorkGroups.forEach((group) => next.add(group.id));
        }
        return next;
      });
      return;
    }

    setSelectedFiles((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        paginatedHistoryList.forEach((item) => next.delete(item.id));
      } else {
        paginatedHistoryList.forEach((item) => next.add(item.id));
      }
      return next;
    });
  }, [allPageSelected, displayMode, paginatedHistoryList, paginatedWorkGroups]);

  const toggleSelectionMode = useCallback(() => {
    setSelectionMode((enabled) => {
      const nextEnabled = !enabled;
      if (!nextEnabled) {
        setSelectedFiles(new Set());
        setSelectedWorks(new Set());
      }
      return nextEnabled;
    });
  }, []);

  const activeTasks = tasksList.filter(
    (t) => t.status === "downloading" || t.status === "pending" || t.status === "paused"
  );
  const completedTasks = tasksList.filter((t) => t.status === "completed" && (t.filePath || t.savePath));
  const stoppedTasks = tasksList.filter((t) => t.status === "error" || t.status === "cancelled");
  const transientTasks = tasksList.filter(
    (t) => t.status === "completed" && !t.filePath && !t.savePath
  );

  const openDownloadPlayer = useCallback((items: HistoryItem[], initialItem?: HistoryItem) => {
    const playableItems = getPlayableDownloadItems(items);
    const video = buildDownloadPlayerVideo(playableItems);
    if (!video) {
      addLog("没有可播放的本地媒体文件", "error");
      return;
    }

    const mediaIndex = Math.max(
      0,
      playableItems.findIndex((item) => initialItem && isSameDownloadItem(item, initialItem))
    );
    setPlayerState({
      videos: [video],
      initialIndex: 0,
      initialMediaIndex: mediaIndex,
    });
  }, [addLog]);

  const handlePlayHistory = useCallback(async (item: HistoryItem) => {
    const knownItems = dedupeDownloadItems([
      ...historyItems,
      ...diskFiles,
      ...workDiskFiles,
      item,
    ]);
    let group = findDownloadWorkGroupForItem(item, knownItems, sortBy);

    if (!group || group.items.length <= 1) {
      try {
        const page = await listDownloadFilesPage({
          offset: 0,
          query: deferredSearchQuery.trim() || undefined,
          mediaType: typeFilter,
          sortBy,
        });
        const allFilteredItems = mergeDownloadFileItems(page.items, historyItems);
        group = findDownloadWorkGroupForItem(item, allFilteredItems, sortBy) || group;
      } catch {
        // Fall back to the selected file if the full scan cannot be read.
      }
    }

    openDownloadPlayer(group?.items?.length ? group.items : [item], item);
  }, [deferredSearchQuery, diskFiles, historyItems, openDownloadPlayer, sortBy, typeFilter, workDiskFiles]);

  const handlePlayWorkGroup = useCallback((group: DownloadWorkGroup) => {
    openDownloadPlayer(group.items, group.items[0]);
  }, [openDownloadPlayer]);

  const handleRevealHistory = useCallback(async (item: HistoryItem) => {
    if (!item.path) return;
    try {
      await openFileLocation(item.path);
    } catch (error) {
      addLog(error instanceof Error ? error.message : "打开文件位置失败，文件可能已经不存在", "error");
    }
  }, [addLog]);

  const handleRevealWorkGroup = useCallback((group: DownloadWorkGroup) => {
    const firstItem = group.items.find((item) => item.path);
    if (firstItem) {
      void handleRevealHistory(firstItem);
    }
  }, [handleRevealHistory]);

  const handleDeleteItems = useCallback((items: HistoryItem[]) => {
    const targets = getLocalDownloadItems(items).filter((item) => item.path);
    if (targets.length === 0) {
      addLog("没有可删除的本地文件", "warning");
      return;
    }
    const targetIds = new Set(targets.map(getDownloadDeleteKey));

    showAlert({
      title: targets.length > 1 ? `删除 ${targets.length} 个文件？` : "删除这个文件？",
      variant: "danger",
      description: "文件会从本地下载目录中删除，操作完成后会同步刷新下载列表。",
      actionLabel: "删除文件",
      cancelLabel: "取消",
      onAction: () => {
        void (async () => {
          setDeletingIds((current) => new Set([...current, ...targetIds]));
          try {
            for (const item of targets) {
              await deleteFile(item.path);
              try {
                await deleteHistoryItem(item.aweme_id || item.id);
              } catch {
                // The disk scan is the source of truth; stale history cleanup is best-effort.
              }
            }
            const deletedIds = new Set(targets.map((item) => item.id));
            const deletedPaths = new Set(targets.map((item) => item.path).filter(Boolean));
            const isDeletedItem = (item: HistoryItem) => deletedIds.has(item.id) || deletedPaths.has(item.path);
            setDiskFiles((current) => current.filter((item) => !isDeletedItem(item)));
            setWorkDiskFiles((current) => current.filter((item) => !isDeletedItem(item)));
            setDiskTotal((current) => Math.max(0, current - targets.length));
            setSelectedFiles((current) => {
              const next = new Set([...current].filter((id) => !deletedIds.has(id)));
              return next;
            });
            setSelectedWorks(new Set());
            setSelectionMode(false);
            void loadHistory();
            void loadDiskFiles();
            if (displayMode === "work") {
              void loadWorkDiskFiles();
            }
            addLog(targets.length > 1 ? `已删除 ${targets.length} 个文件` : "已删除文件", "info");
          } catch (error) {
            addLog(error instanceof Error ? error.message : "删除失败", "error");
          } finally {
            setDeletingIds((current) => {
              const next = new Set(current);
              targetIds.forEach((id) => next.delete(id));
              return next;
            });
          }
        })();
      },
    });
  }, [addLog, deleteHistoryItem, displayMode, loadDiskFiles, loadHistory, loadWorkDiskFiles, showAlert]);

  const handleDeleteSelected = useCallback(() => {
    if (deletingFiles) return;
    const targets = displayMode === "work"
      ? paginatedWorkGroups
          .filter((group) => selectedWorks.has(group.id))
          .flatMap((group) => group.items)
      : paginatedHistoryList.filter((item) => selectedFiles.has(item.id));
    handleDeleteItems(targets);
  }, [deletingFiles, displayMode, handleDeleteItems, paginatedHistoryList, paginatedWorkGroups, selectedFiles, selectedWorks]);

  const requestDeleteItems = useCallback((items: HistoryItem[]) => {
    if (deletingFiles) return;
    handleDeleteItems(items);
  }, [deletingFiles, handleDeleteItems]);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-accent" />
          <h3 className="text-[0.9rem] font-semibold text-text">我的下载</h3>
          <Badge variant="secondary">{activeTasks.length} 个进行中</Badge>
          <Badge variant="outline">
            {displayMode === "work" ? `${totalFileItems} 个作品` : `${totalFileItems} 个本地文件`}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleOpenDir}>
            <Folder className="w-3.5 h-3.5" />
            打开目录
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="w-3.5 h-3.5" />
            同步
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <Input
            placeholder="搜索文件名、作者..."
            value={searchQuery}
            onChange={(e) => {
              setFilePage(1);
              setSearchQuery(e.target.value);
            }}
            className="pl-8 h-8 text-[0.8rem]"
          />
        </div>
        <Select
          value={typeFilter}
          onValueChange={(value) => {
            setFilePage(1);
            setTypeFilter(value);
          }}
        >
          <SelectTrigger className="w-[120px] h-8 text-[0.8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            <SelectItem value="video">视频</SelectItem>
            <SelectItem value="image">图片</SelectItem>
            <SelectItem value="audio">音频</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={sortBy}
          onValueChange={(value) => {
            setFilePage(1);
            setSortBy(value);
          }}
        >
          <SelectTrigger className="w-[120px] h-8 text-[0.8rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="date_desc">最新优先</SelectItem>
            <SelectItem value="date_asc">最早优先</SelectItem>
            <SelectItem value="size_desc">最大优先</SelectItem>
            <SelectItem value="size_asc">最小优先</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex h-8 shrink-0 items-center rounded-[var(--radius-sm)] border border-border bg-surface p-0.5">
          <button
            type="button"
            onClick={() => setDisplayMode("file")}
            className={cn(
              "h-7 rounded-[10px] px-3 text-[0.75rem] font-semibold transition-[background-color,color,box-shadow]",
              displayMode === "file"
                ? "bg-accent text-white shadow-[0_6px_18px_rgba(254,44,85,0.24)]"
                : "text-text-muted hover:text-text"
            )}
          >
            文件形式
          </button>
          <button
            type="button"
            onClick={() => setDisplayMode("work")}
            className={cn(
              "h-7 rounded-[10px] px-3 text-[0.75rem] font-semibold transition-[background-color,color,box-shadow]",
              displayMode === "work"
                ? "bg-accent text-white shadow-[0_6px_18px_rgba(254,44,85,0.24)]"
                : "text-text-muted hover:text-text"
            )}
          >
            作品形式
          </button>
        </div>
      </div>

      {/* Active Tasks */}
      {activeTasks.length > 0 && (
        <div className="mb-4">
          <div className="text-[0.7rem] font-bold text-text-muted uppercase tracking-wider mb-2">
            进行中 ({activeTasks.length})
          </div>
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {activeTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onCancel={cancelDownload}
                  onPause={pauseTask}
                  onResume={resumeTask}
                  onOpen={openTaskLocation}
                  onRemove={removeTask}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {/* Completed Tasks */}
      {completedTasks.length > 0 && (
        <div className="mt-4">
          <div className="text-[0.7rem] font-bold text-text-muted uppercase tracking-wider mb-2">
            本次完成 ({completedTasks.length})
          </div>
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {completedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onOpen={openTaskLocation}
                  onRemove={removeTask}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      {transientTasks.length > 0 && (
        <div className="mt-4 rounded-[14px] border border-warning/20 bg-warning-soft/15 px-4 py-3">
          <div className="flex items-start gap-2 text-[0.78rem] text-text-secondary">
            <AlertCircle className="w-4 h-4 shrink-0 text-warning mt-0.5" />
            <div>
              <div className="font-semibold text-warning mb-0.5">
                有 {transientTasks.length} 条旧任务没有文件路径
              </div>
              <div className="text-text-muted">
                这些是前端内存任务，不代表真实文件。已下载文件请以下方“本地文件”为准。
              </div>
            </div>
          </div>
        </div>
      )}

      {stoppedTasks.length > 0 && (
        <div className="mt-4">
          <div className="text-[0.7rem] font-bold text-text-muted uppercase tracking-wider mb-2">
            已停止 ({stoppedTasks.length})
          </div>
          <div className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {stoppedTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onRetry={retryDownload}
                  onOpen={openTaskLocation}
                  onRemove={removeTask}
                />
              ))}
            </AnimatePresence>
          </div>
        </div>
      )}

      <div className="mt-5">
        <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
          <div className="flex items-center gap-2">
            <FileVideo className="w-4 h-4 text-info" />
            <div className="text-[0.7rem] font-bold text-text-muted uppercase tracking-wider">
              {displayMode === "work" ? "下载作品" : "本地文件"} ({totalFileItems})
            </div>
          </div>
          <div className="flex items-center gap-2">
            {localListLoading && (
              <span className="text-[0.72rem] text-text-muted">
                {displayMode === "work" && workDiskLoading
                  ? "整理作品中..."
                  : diskLoading
                    ? "扫描下载目录中..."
                    : "同步历史中..."}
              </span>
            )}
            {totalFileItems > 0 && (
              <span className="text-[0.72rem] text-text-muted tabular-nums">
                {filePageStart + 1}-{filePageEnd} / {totalFileItems}
              </span>
            )}
            {totalFileItems > 0 && (
              <Button variant={selectionMode ? "default" : "outline"} size="sm" onClick={toggleSelectionMode} disabled={deletingFiles}>
                {selectionMode ? (
                  <Square className="h-3.5 w-3.5" />
                ) : (
                  <CheckSquare className="h-3.5 w-3.5" />
                )}
                {selectionMode ? "取消" : "选择"}
              </Button>
            )}
            <Select
              value={String(filePageSize)}
              onValueChange={(value) => {
                setFilePage(1);
                setFilePageSize(Number(value));
              }}
            >
              <SelectTrigger className="w-[92px] h-8 text-[0.75rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILE_PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / 页
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {selectionMode && totalFileItems > 0 && (
          <div className="mb-3 flex items-center gap-2">
            <button
              onClick={toggleSelectAll}
              className="flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 text-[0.78rem] text-text-secondary transition-[background-color,border-color,color,box-shadow,opacity] hover:text-text"
            >
              {allPageSelected ? (
                <CheckSquare className="h-3.5 w-3.5 text-accent" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              全选本页
            </button>
            {selectedCount > 0 && (
              <>
                <Badge variant="default">{selectedCount} 已选</Badge>
                <Button variant="danger-outline" size="sm" onClick={handleDeleteSelected} disabled={deletingFiles}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {deletingFiles ? "删除中" : "删除文件"}
                </Button>
              </>
            )}
            {(completedTasks.length > 0 || stoppedTasks.length > 0) && (
              <Button variant="ghost" size="sm" onClick={clearCompleted} className="ml-auto">
                清除已完成
              </Button>
            )}
          </div>
        )}

        {totalFileItems > 0 ? (
          <>
            {displayMode === "work" ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {paginatedWorkGroups.map((group) => (
                  <DownloadWorkCard
                    key={group.id}
                    group={group}
                    selected={selectedWorks.has(group.id)}
                    selectionMode={selectionMode}
                    allowVideoPreview={filePageSize <= 24}
                    onToggle={() => {
                      setSelectedWorks((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) {
                          next.delete(group.id);
                        } else {
                          next.add(group.id);
                        }
                        return next;
                      });
                    }}
                    onPlay={() => handlePlayWorkGroup(group)}
                    onReveal={() => handleRevealWorkGroup(group)}
                    deleting={group.items.some((item) => deletingIds.has(getDownloadDeleteKey(item)))}
                    onDeleteFile={() => requestDeleteItems(group.items)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {paginatedHistoryList.map((item) => (
                  <HistoryFileCard
                    key={item.id}
                    item={item}
                    selected={selectedFiles.has(item.id)}
                    selectionMode={selectionMode}
                    allowVideoPreview={filePageSize <= 24}
                    onToggle={() => {
                      setSelectedFiles((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) {
                          next.delete(item.id);
                        } else {
                          next.add(item.id);
                        }
                        return next;
                      });
                    }}
                    onOpen={() => void handlePlayHistory(item)}
                    onReveal={() => void handleRevealHistory(item)}
                    deleting={deletingIds.has(getDownloadDeleteKey(item))}
                    onDeleteFile={() => requestDeleteItems([item])}
                  />
                ))}
              </div>
            )}
            <FilePagination
              page={safeFilePage}
              totalPages={totalFilePages}
              totalItems={totalFileItems}
              pageStart={filePageStart}
              pageEnd={filePageEnd}
              onPageChange={setFilePage}
            />
          </>
        ) : localListLoading ? (
          <div className="rounded-[16px] border border-border bg-surface-solid/60 p-6 text-center">
            <p className="text-[0.85rem] text-text-secondary mb-1">
              {displayMode === "work" ? "正在整理下载作品..." : "正在扫描下载目录..."}
            </p>
            <p className="text-[0.76rem] text-text-muted">
              文件越多，首次整理需要的时间越长。
            </p>
          </div>
        ) : (
          <div className="rounded-[16px] border border-border bg-surface-solid/60 p-6 text-center">
            <p className="text-[0.85rem] text-text-secondary mb-1">
              {displayMode === "work" ? "没有找到下载作品" : "没有找到本地文件"}
            </p>
            <p className="text-[0.76rem] text-text-muted">
              这里直接扫描下载目录，已过滤 .DS_Store、.downloaded 和非媒体文件。
            </p>
          </div>
        )}
      </div>

      <FullscreenPlayer
        key={playerState ? `${playerState.initialIndex}:${playerState.initialMediaIndex}` : "closed"}
        videos={playerState?.videos || []}
        initialIndex={playerState?.initialIndex || 0}
        initialMediaIndex={playerState?.initialMediaIndex || 0}
        open={Boolean(playerState)}
        onClose={() => setPlayerState(null)}
        onDownload={() => addLog("本地文件已经在下载目录中", "info")}
      />

      {/* Empty State */}
      {tasksList.length === 0 && totalFileItems === 0 && !localListLoading && (
        <motion.div
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center justify-center py-16 text-center"
        >
          <div className="w-14 h-14 rounded-[18px] bg-surface border border-border flex items-center justify-center mb-4">
            <FolderOpen className="w-6 h-6 text-text-muted" />
          </div>
          <p className="text-[0.85rem] text-text-secondary mb-1">暂无下载任务</p>
          <p className="text-[0.8rem] text-text-muted">搜索用户或粘贴链接开始下载</p>
        </motion.div>
      )}
    </div>
  );
}

function HistoryFileCard({
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

function DownloadWorkCard({
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

function HistoryFileThumbnail({
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

function MediaKindIcon({ kind, className }: { kind: LocalMediaKind; className?: string }) {
  if (kind === "image") return <FileImage className={className} />;
  if (kind === "audio") return <Music2 className={className} />;
  return <FileVideo className={className} />;
}

function mergeDownloadFileItems(files: HistoryItem[], historyItems: HistoryItem[]): HistoryItem[] {
  const historyByPath = new Map(
    historyItems
      .filter((item) => item.path)
      .map((item) => [item.path, item] as const)
  );

  return files.map((file) => {
    const history = historyByPath.get(file.path);
    return {
      ...file,
      ...history,
      id: file.id || file.path,
      path: file.path,
      file_path: file.path,
      size: file.size || history?.size || 0,
      timestamp: history?.timestamp || file.timestamp,
    };
  });
}

function getDownloadDeleteKey(item: HistoryItem): string {
  return item.path || item.id || item.aweme_id || item.filename || "";
}

function buildDownloadWorkGroups(items: HistoryItem[], sortBy: string): DownloadWorkGroup[] {
  const grouped = new Map<string, HistoryItem[]>();

  for (const item of dedupeDownloadItems(items)) {
    if (!item.path) continue;
    const key = getDownloadWorkKey(item);
    const groupItems = grouped.get(key) || [];
    groupItems.push(item);
    grouped.set(key, groupItems);
  }

  const groups = Array.from(grouped.entries()).map(([id, groupItems]) => {
    const sortedItems = sortDownloadWorkItems(groupItems);
    const coverItem = chooseDownloadWorkCover(sortedItems);
    const mediaCounts = createEmptyMediaCounts();

    for (const item of sortedItems) {
      mediaCounts[getHistoryMediaKind(item)] += 1;
    }

    return {
      id,
      title: resolveDownloadWorkTitle(sortedItems),
      author: sortedItems.find((item) => item.author)?.author || "",
      timestamp: Math.max(...sortedItems.map((item) => Number(item.timestamp || item.create_time || 0))),
      size: sortedItems.reduce((sum, item) => sum + (Number(item.size || item.file_size || 0) || 0), 0),
      items: sortedItems,
      coverItem,
      mediaCounts,
    };
  });

  return sortDownloadWorkGroups(groups, sortBy);
}

function findDownloadWorkGroupForItem(
  item: HistoryItem,
  items: HistoryItem[],
  sortBy: string
): DownloadWorkGroup | null {
  const targetKey = getDownloadWorkKey(item);
  return buildDownloadWorkGroups(items, sortBy).find((group) => group.id === targetKey) || null;
}

function dedupeDownloadItems(items: HistoryItem[]): HistoryItem[] {
  const seen = new Set<string>();
  const result: HistoryItem[] = [];

  for (const item of items) {
    const key = getDownloadItemKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function getLocalDownloadItems(items: HistoryItem[]): HistoryItem[] {
  return dedupeDownloadItems(items).filter((item) => Boolean(item.path));
}

function isDownloadPlayerMedia(item: HistoryItem): boolean {
  const kind = getHistoryMediaKind(item);
  return kind === "video" || kind === "image";
}

function getPlayableDownloadItems(items: HistoryItem[]): HistoryItem[] {
  return getLocalDownloadItems(items).filter(isDownloadPlayerMedia);
}

function buildDownloadPlayerVideo(items: HistoryItem[]): VideoInfo | null {
  const playableItems = getPlayableDownloadItems(items);
  if (playableItems.length === 0) return null;

  const title = resolveDownloadWorkTitle(playableItems);
  const authorName = playableItems.find((item) => item.author)?.author || "本地下载";
  const coverItem = chooseDownloadWorkCover(playableItems);
  const coverUrl = getDownloadCoverUrl(coverItem);
  const mediaUrls = playableItems.flatMap((item) => {
    const kind = getHistoryMediaKind(item);
    const url = localFileAssetUrl(item.path);
    if (kind === "image") return [{ type: "image", url }];
    if (kind === "video") return [{ type: "video", url }];
    return [];
  });
  if (mediaUrls.length === 0) return null;

  const imageUrls = mediaUrls
    .filter((item) => item.type === "image")
    .map((item) => item.url);
  const firstVideoUrl = mediaUrls.find((item) => item.type === "video")?.url || "";
  const timestamp = Math.max(...playableItems.map((item) => Number(item.timestamp || item.create_time || 0)));
  const allImages = mediaUrls.length > 0 && mediaUrls.every((item) => item.type === "image");
  const allVideos = mediaUrls.length > 0 && mediaUrls.every((item) => item.type === "video");
  const mediaType = allImages ? "image" : allVideos ? "video" : "mixed";

  return {
    aweme_id: "",
    desc: title,
    create_time: timestamp,
    author: {
      uid: "",
      sec_uid: "",
      nickname: authorName,
      avatar_thumb: "",
      avatar_medium: "",
      signature: "",
      follower_count: 0,
      following_count: 0,
      aweme_count: 0,
      favoriting_count: 0,
      is_follow: false,
      verify_status: 0,
      unique_id: "",
    },
    video: {
      preview_addr: null,
      play_addr: firstVideoUrl,
      play_addr_h264: null,
      play_addr_lowbr: null,
      download_addr: firstVideoUrl || mediaUrls[0]?.url || null,
      cover: coverUrl,
      dynamic_cover: "",
      origin_cover: coverUrl,
      width: 0,
      height: 0,
      duration: 0,
      ratio: "",
      bit_rate: null,
    },
    statistics: {
      play_count: 0,
      digg_count: 0,
      comment_count: 0,
      share_count: 0,
      collect_count: 0,
      forward_count: 0,
    },
    media_urls: mediaUrls,
    image_urls: imageUrls,
    images: imageUrls,
    live_photo_urls: null,
    live_photos: null,
    has_live_photo: false,
    is_image: allImages,
    media_type: mediaType,
    raw_media_type: mediaType,
    bgm_url: null,
    cover_url: coverUrl,
    music: null,
  };
}

function getDownloadWorkKey(item: HistoryItem): string {
  const awemeId = String(item.aweme_id || "").trim();
  if (isUsableAwemeId(awemeId, item)) return `aweme:${awemeId}`;

  const title = normalizeDownloadWorkTitle(resolveDownloadItemTitle(item));
  const scope = (item.author || getParentDirectoryName(item.path) || "unknown").trim().toLowerCase();
  return `work:${scope}:${title.toLowerCase()}`;
}

function isUsableAwemeId(awemeId: string, item: HistoryItem): boolean {
  if (!awemeId) return false;
  if (item.path && awemeId === item.path) return false;
  if (/[\\/]/.test(awemeId) || awemeId.includes(":")) return false;
  return awemeId.length <= 80;
}

function resolveDownloadWorkTitle(items: HistoryItem[]): string {
  const title = items
    .map(resolveDownloadItemTitle)
    .map(normalizeDownloadWorkTitle)
    .find(Boolean);
  return title || "未命名作品";
}

function resolveDownloadItemTitle(item: HistoryItem): string {
  const direct = String(item.title || item.desc || item.filename || "").trim();
  if (direct) return stripKnownMediaExtension(direct);
  return getFileStem(item.path || item.file_path || "") || item.id || "未命名作品";
}

function normalizeDownloadWorkTitle(value: string): string {
  let result = stripKnownMediaExtension(value).trim();

  for (let index = 0; index < 3; index += 1) {
    const next = result
      .replace(/\s*[（(]\d{1,4}[）)]$/u, "")
      .replace(/\s*[\[【]\d{1,4}[\]】]$/u, "")
      .replace(/(?:[_-](?:\d{1,4}|img\d{0,4}|image\d{0,4}|photo\d{0,4}|cover|poster|live[_-]?photo\d{0,4}|实况|封面|图片\d{0,4}))$/iu, "")
      .replace(/第\d{1,4}[张集]$/u, "")
      .trim();
    if (next === result) break;
    result = next;
  }

  return result || stripKnownMediaExtension(value).trim();
}

function sortDownloadWorkItems(items: HistoryItem[]): HistoryItem[] {
  return [...items].sort((a, b) => {
    const titleCompare = resolveDownloadItemTitle(a).localeCompare(
      resolveDownloadItemTitle(b),
      undefined,
      { numeric: true, sensitivity: "base" }
    );
    if (titleCompare !== 0) return titleCompare;
    return (a.path || "").localeCompare(b.path || "", undefined, { numeric: true, sensitivity: "base" });
  });
}

function sortDownloadWorkGroups(groups: DownloadWorkGroup[], sortBy: string): DownloadWorkGroup[] {
  return [...groups].sort((a, b) => {
    if (sortBy === "date_asc") return a.timestamp - b.timestamp;
    if (sortBy === "size_desc") return b.size - a.size;
    if (sortBy === "size_asc") return a.size - b.size;
    return b.timestamp - a.timestamp;
  });
}

function chooseDownloadWorkCover(items: HistoryItem[]): HistoryItem {
  return (
    items.find((item) => item.cover) ||
    items.find((item) => getHistoryMediaKind(item) === "image") ||
    items.find((item) => getHistoryMediaKind(item) === "video") ||
    items[0]!
  );
}

function getDownloadCoverUrl(item: HistoryItem): string {
  if (item.cover) return item.cover;
  if (getHistoryMediaKind(item) === "image" && item.path) {
    return localFileAssetUrl(item.path);
  }
  return "";
}

function createEmptyMediaCounts(): Record<LocalMediaKind, number> {
  return {
    video: 0,
    image: 0,
    audio: 0,
    media: 0,
  };
}

function formatWorkMediaSummary(group: DownloadWorkGroup): string {
  const parts = [
    group.mediaCounts.video ? `视频 ${group.mediaCounts.video}` : "",
    group.mediaCounts.image ? `图片 ${group.mediaCounts.image}` : "",
    group.mediaCounts.audio ? `音频 ${group.mediaCounts.audio}` : "",
    group.mediaCounts.media ? `媒体 ${group.mediaCounts.media}` : "",
  ].filter(Boolean);

  return parts.join(" · ") || `${group.items.length} 个文件`;
}

function isSameDownloadItem(a: HistoryItem, b: HistoryItem): boolean {
  const aPath = a.path || a.file_path || "";
  const bPath = b.path || b.file_path || "";
  if (aPath && bPath) return aPath === bPath;
  return getDownloadItemKey(a) === getDownloadItemKey(b);
}

function getDownloadItemKey(item: HistoryItem): string {
  return item.path || item.file_path || item.id || item.aweme_id || item.filename || "";
}

function getParentDirectoryName(path: string): string {
  const normalized = (path || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function getFileStem(path: string): string {
  const filename = (path || "").split(/[\\/]/).pop() || "";
  return stripKnownMediaExtension(filename);
}

function stripKnownMediaExtension(value: string): string {
  const extension = getPathExtension(value);
  if (!extension || !mediaKindFromExtension(extension)) return value;
  return value.slice(0, Math.max(0, value.length - extension.length - 1));
}

function getHistoryMediaKind(item: HistoryItem): LocalMediaKind {
  const extensionKind = mediaKindFromExtension(getPathExtension(item.path || item.file_path || ""));
  if (extensionKind) return extensionKind;

  const raw = String(item.media_type || item.file_type || "").toLowerCase();
  if (raw.includes("image")) return "image";
  if (raw.includes("audio")) return "audio";
  if (raw.includes("video") || raw.includes("live_photo") || raw.includes("mixed")) return "video";
  return "media";
}

function mediaKindFromExtension(extension: string): LocalMediaKind | null {
  switch (extension.toLowerCase()) {
    case "mp4":
    case "mov":
    case "m4v":
    case "webm":
    case "mkv":
    case "avi":
    case "flv":
      return "video";
    case "jpg":
    case "jpeg":
    case "png":
    case "webp":
    case "gif":
    case "avif":
    case "heic":
    case "heif":
      return "image";
    case "mp3":
    case "m4a":
    case "aac":
    case "wav":
    case "flac":
    case "ogg":
      return "audio";
    default:
      return null;
  }
}

function getPathExtension(path: string): string {
  const filename = path.split(/[\\/]/).pop() || "";
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return "";
  return filename.slice(dotIndex + 1);
}

function formatMediaKindLabel(kind: LocalMediaKind): string {
  if (kind === "video") return "视频";
  if (kind === "image") return "图片";
  if (kind === "audio") return "音频";
  return "媒体";
}

function FilePagination({
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

function buildPageRange(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, total, current]);
  for (let offset = -1; offset <= 1; offset += 1) {
    const page = current + offset;
    if (page > 1 && page < total) {
      pages.add(page);
    }
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const output: Array<number | "ellipsis"> = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    const previous = sorted[index - 1];
    if (index > 0 && page - previous > 1) {
      output.push("ellipsis");
    }
    output.push(page);
  }

  return output;
}
