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
  FileVideo,
  Folder,
  FolderOpen,
  Search,
  RefreshCw,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { useDownloads } from "@/hooks/use-downloads";
import { useHistory } from "@/hooks/use-history";
import {
  deleteFile,
  listDownloadFilesPage,
  openFileLocation,
  type HistoryItem,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  FILE_PAGE_SIZE_OPTIONS,
  buildDownloadPlayerVideo,
  buildDownloadWorkGroups,
  dedupeDownloadItems,
  findDownloadWorkGroupForItem,
  getDownloadDeleteKey,
  getLocalDownloadItems,
  getPlayableDownloadItems,
  isSameDownloadItem,
  mergeDownloadFileItems,
  type DownloadDisplayMode,
  type DownloadPlayerState,
  type DownloadWorkGroup,
} from "./downloads-utils";
import {
  DownloadWorkCard,
  FilePagination,
  HistoryFileCard,
} from "./downloads-components";


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

  const clearTransientTasks = useCallback(() => {
    const store = useDownloadStore.getState();
    transientTasks.forEach((task) => {
      store.removeTask(task.id);
    });
    addLog(`已清理 ${transientTasks.length} 条无路径旧任务`, "info");
  }, [transientTasks, addLog]);

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
        <div className="mt-4 rounded-[14px] border border-warning/20 bg-warning-soft/15 px-4 py-3 flex items-center justify-between gap-3">
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
          <button
            onClick={clearTransientTasks}
            className="shrink-0 px-3 py-1.5 rounded-[8px] bg-warning/10 hover:bg-warning/20 text-warning text-xs font-semibold transition-colors cursor-pointer"
          >
            清理记录
          </button>
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
