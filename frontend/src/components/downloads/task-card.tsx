import { memo } from "react";
import { motion } from "framer-motion";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn, easeConfig, formatBytes } from "@/lib/utils";
import { Ban, Clock3, FolderOpen, Pause, Play, RotateCw, X, CheckCircle2, AlertCircle, Loader2, Gauge, HardDrive } from "lucide-react";
import { useDownloadStore } from "@/stores/app-store";
import type { DownloadTask, DownloadStatus } from "@/types";

interface TaskCardProps {
  task: DownloadTask;
  animateOnMount?: boolean;
  onCancel?: (id: string) => void;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onRetry?: (id: string) => void;
  onOpen?: (task: DownloadTask) => void;
  onRemove?: (id: string) => void;
}

const statusConfig: Record<DownloadStatus, { icon: React.ElementType; label: string; color: string }> = {
  pending: { icon: Loader2, label: "等待中", color: "text-text-muted" },
  downloading: { icon: Loader2, label: "下载中", color: "text-accent" },
  completed: { icon: CheckCircle2, label: "已完成", color: "text-success" },
  error: { icon: AlertCircle, label: "失败", color: "text-danger" },
  paused: { icon: Play, label: "已暂停", color: "text-warning" },
  cancelled: { icon: Ban, label: "已取消", color: "text-text-muted" },
};

export const TaskCard = memo(function TaskCard({
  task,
  animateOnMount = false,
  onCancel,
  onPause,
  onResume,
  onRetry,
  onOpen,
  onRemove,
}: TaskCardProps) {
  const cfg = statusConfig[task.status];
  const Icon = cfg.icon;
  const startedAt = task.startTime ? new Date(task.startTime).toLocaleTimeString() : "";
  const elapsedSeconds = task.startTime
    ? Math.max(0, Math.floor(((task.finishedTime || Date.now()) - task.startTime) / 1000))
    : 0;
  const progress = clampPercent(task.progress);
  const currentProgress = task.fileProgress === undefined ? undefined : clampPercent(task.fileProgress);
  const displayTitle = task.filename || (looksLikeUuid(task.id) ? (task.isBatch ? "批量下载" : "下载任务") : task.id);
  const itemLabel = task.isBatch ? "作品" : "文件";
  const fileLabel = task.fileTotal && task.fileTotal > 1
    ? `${task.fileIndex ?? 0}/${task.fileTotal}`
    : "";
  const active = task.status === "downloading" || task.status === "pending" || task.status === "paused";
  const percentLabel = progress >= 10 ? progress.toFixed(1) : progress.toFixed(0);
  const currentLabel = currentProgress !== undefined ? `${currentProgress.toFixed(0)}%` : "";

  return (
    <motion.div
      layout="position"
      initial={animateOnMount ? { opacity: 0, y: 8 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -12 }}
      transition={{ duration: 0.16, ease: easeConfig }}
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-3 py-3 transition-[background-color,border-color,box-shadow] duration-150 ease-out",
        task.status === "completed"
          ? "border-success/20 bg-success-soft/25"
          : task.status === "error"
            ? "border-danger/20 bg-danger-soft/25"
            : task.status === "cancelled"
              ? "border-border bg-surface/35 opacity-80"
              : task.status === "paused"
                ? "border-warning/30 bg-warning-soft/16"
                : "border-border bg-surface/45 hover:bg-surface/65"
      )}
    >
      {/* Icon */}
      <div className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-raised/70", cfg.color)}>
        <Icon
          className={cn(
            "h-4 w-4",
            task.status === "downloading" && "animate-spin",
            task.status === "pending" && "animate-pulse"
          )}
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[0.84rem] font-semibold leading-5 text-text">
            {displayTitle}
          </span>
          <Badge
            variant={
              task.status === "completed"
                ? "success"
                : task.status === "error"
                  ? "danger"
                  : task.status === "cancelled"
                    ? "secondary"
                  : task.status === "downloading"
                    ? "default"
                    : "secondary"
            }
            size="sm"
          >
            {cfg.label}
          </Badge>
        </div>

        {active && (
          <div className="mb-2 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
            <span className="min-w-[2.8rem] text-right text-[0.72rem] font-semibold tabular-nums text-text-secondary">
              {percentLabel}%
            </span>
            <Progress value={progress} className="h-2 bg-surface-raised/80" />
            {fileLabel ? (
              <span className="min-w-[4.6rem] text-right text-[0.68rem] font-medium tabular-nums text-text-muted">
                {itemLabel} {fileLabel}
              </span>
            ) : (
              <span className="min-w-[2rem]" />
            )}
          </div>
        )}

        {active ? (
          <div className="space-y-2 text-[0.69rem] text-text-muted">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
              {task.skippedCount !== undefined && task.skippedCount > 0 && (
                <span className="shrink-0 rounded-full bg-surface-raised/60 px-1.5 py-0.5">跳过 {task.skippedCount}</span>
              )}
              {task.failedCount !== undefined && task.failedCount > 0 && (
                <span className="shrink-0 rounded-full bg-warning-soft px-1.5 py-0.5 text-warning">失败 {task.failedCount}</span>
              )}
              {task.currentName && (
                <span className="min-w-[12rem] flex-1 truncate">
                  当前 {task.currentName}
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 tabular-nums sm:grid-cols-[auto_auto_auto_auto]">
              {currentProgress !== undefined && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Gauge className="h-3 w-3" />
                  当前 {currentLabel}
                </span>
              )}
              {task.speed > 0 && (
                <span className="whitespace-nowrap">{formatBytes(task.speed)}/s</span>
              )}
              {task.downloadedBytes !== undefined && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <HardDrive className="h-3 w-3" />
                  {formatBytes(task.downloadedBytes)}{task.totalBytes ? ` / ${formatBytes(task.totalBytes)}` : ""}
                </span>
              )}
              {task.etaSeconds !== undefined && task.etaSeconds > 0 && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Clock3 className="h-3 w-3" />
                  约 {formatDurationLabel(task.etaSeconds)}
                </span>
              )}
              {elapsedSeconds > 0 && (
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                  <Clock3 className="h-3 w-3" />
                  已用 {formatDurationLabel(elapsedSeconds)}
                </span>
              )}
              {startedAt && <span className="whitespace-nowrap">开始 {startedAt}</span>}
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.68rem] text-text-muted tabular-nums">
            {fileLabel && <span>{itemLabel} {fileLabel}</span>}
            {task.skippedCount !== undefined && task.skippedCount > 0 && (
              <span>跳过 {task.skippedCount}</span>
            )}
            {task.failedCount !== undefined && task.failedCount > 0 && (
              <span className="text-warning">失败 {task.failedCount}</span>
            )}
            {task.status === "completed" && task.totalBytes && (
              <span>{formatBytes(task.totalBytes)}</span>
            )}
            {task.status === "completed" && task.finishedTime && (
              <span>完成 {new Date(task.finishedTime).toLocaleTimeString()}</span>
            )}
            {(task.status === "error" || task.status === "cancelled") && task.errorMessage && (
              <span className="truncate">{task.errorMessage}</span>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        {task.status === "completed" && (
          <Button variant="ghost" size="icon-sm" onClick={() => onOpen?.(task)} title="打开位置">
            <FolderOpen className="w-3.5 h-3.5" />
          </Button>
        )}
        {task.status === "downloading" && (
          <Button variant="ghost" size="icon-sm" onClick={() => onPause?.(task.id)} title="暂停">
            <Pause className="w-3.5 h-3.5" />
          </Button>
        )}
        {task.status === "paused" && (
          <Button variant="ghost" size="icon-sm" onClick={() => onResume?.(task.id)} title="继续">
            <Play className="w-3.5 h-3.5" />
          </Button>
        )}
        {task.status === "error" && (
          <Button variant="ghost" size="icon-sm" onClick={() => onRetry?.(task.id)} title="重试">
            <RotateCw className="w-3.5 h-3.5" />
          </Button>
        )}
        {(task.status === "downloading" || task.status === "pending" || task.status === "paused") && (
          <Button variant="ghost" size="icon-sm" onClick={() => onCancel?.(task.id)} title="取消">
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
        {(task.status === "completed" || task.status === "error" || task.status === "cancelled") && (
          <Button variant="ghost" size="icon-sm" onClick={() => onRemove?.(task.id)} title="移除">
            <X className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>
    </motion.div>
  );
});

export const DownloadTaskCardById = memo(function DownloadTaskCardById({
  taskId,
  animateOnMount = false,
  onCancel,
  onPause,
  onResume,
  onRetry,
  onOpen,
  onRemove,
}: Omit<TaskCardProps, "task"> & { taskId: string }) {
  const task = useDownloadStore((state) => state.tasks[taskId]);
  if (!task) return null;
  return (
    <TaskCard
      task={task}
      animateOnMount={animateOnMount}
      onCancel={onCancel}
      onPause={onPause}
      onResume={onResume}
      onRetry={onRetry}
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
});

function formatDurationLabel(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const restSeconds = safeSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return `${hours}小时${restMinutes.toString().padStart(2, "0")}分`;
  }
  if (minutes > 0) {
    return `${minutes}分${restSeconds.toString().padStart(2, "0")}秒`;
  }
  return `${restSeconds}秒`;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
