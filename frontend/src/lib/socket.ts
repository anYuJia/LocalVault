import { useEffect, useRef } from "react";
import { useDownloadStore, useLogStore } from "@/stores/app-store";
import { useToastStore } from "@/components/ui/toast";
import type { DownloadTask } from "@/types";
import { listenEvent } from "./tauri";

// ═══════════════════════════════════════════════
// Tauri Event Listener Manager
// Replaces the old WebSocket approach — all events
// come through Tauri's built-in event system.
// ═══════════════════════════════════════════════

interface DownloadStartedPayload {
  task_id: string;
  desc: string;
  display_name: string;
  type: string;
  aweme_id: string;
  media_type: string;
  media_count: number;
  save_path?: string;
}

interface BatchDownloadStartedPayload {
  task_id: string;
  nickname?: string;
  total_videos?: number;
  message?: string;
}

interface DownloadProgressPayload {
  task_id: string;
  progress?: number;
  completed?: number;
  total?: number;
  status?: string;
  desc?: string;
  display_name?: string;
  file_index?: number;
  file_total?: number;
  file_progress?: number;
  bytes_downloaded?: number;
  bytes_total?: number;
  speed_bps?: number;
  speed_mbps?: number;
  eta_seconds?: number | null;
  save_path?: string;
  file_path?: string;
  media_type?: string;
  overall_progress?: number;
  current_downloaded?: number;
  total_videos?: number;
  skipped?: number;
  failed?: number;
  processed?: number;
  elapsed_seconds?: number;
  message?: string;
}

interface DownloadLogPayload {
  task_id: string;
  display_name: string;
  message: string;
  timestamp: string;
}

interface DownloadFailedPayload {
  task_id: string;
  error: string;
}

interface DownloadErrorPayload {
  task_id: string;
  message: string;
}

interface DownloadCompletedPayload {
  task_id: string;
  display_name?: string;
  message?: string;
  files?: string[];
  file_path?: string;
  save_path?: string;
  total_size?: number;
}

interface DownloadCancelledPayload {
  task_id: string;
  message?: string;
}

interface BatchDownloadCompletedPayload {
  task_id: string;
  total_videos?: number;
  completed?: number;
  succeeded?: number;
  skipped?: number;
  failed?: number;
  processed?: number;
  message?: string;
}

interface CurrentVideoProgressPayload {
  task_id: string;
  aweme_id?: string;
  name?: string;
  progress?: number;
  speed_bps?: number;
  speed_mbps?: number;
}

function normalizeDownloadStatus(status: string) {
  const value = String(status || "").toLowerCase();
  if (value === "completed") return "completed" as const;
  if (value === "paused") return "paused" as const;
  if (value === "cancelled" || value === "canceled") return "cancelled" as const;
  if (value === "failed" || value === "error") return "error" as const;
  return "downloading" as const;
}

function isCancelledMessage(message?: string) {
  return /cancelled|canceled|已取消|取消/.test(message || "");
}

function isTerminalStatus(status?: string) {
  return status === "completed" || status === "error" || status === "cancelled";
}

function toFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toPercent(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function computeBatchProgress(d: DownloadProgressPayload, existing?: DownloadTask) {
  const hasBatchCounters =
    d.overall_progress !== undefined ||
    d.current_downloaded !== undefined ||
    d.total_videos !== undefined ||
    d.processed !== undefined;
  const explicitOverall = d.overall_progress;
  const explicitNumber = toFiniteNumber(explicitOverall);
  if (explicitNumber !== undefined) {
    return toPercent(explicitNumber);
  }

  const total = toFiniteNumber(d.total_videos ?? d.total ?? existing?.fileTotal ?? existing?.mediaCount);
  const processed = toFiniteNumber(
    d.processed ?? d.current_downloaded ?? d.completed ?? existing?.fileIndex ?? existing?.completedCount
  );
  if (total !== undefined && total > 0 && processed !== undefined) {
    const fileProgress = toFiniteNumber(d.file_progress);
    const currentWeight =
      d.status !== "completed" && d.status !== "failed" && fileProgress !== undefined
        ? toPercent(fileProgress) / 100
        : 0;
    return toPercent(((processed + currentWeight) / total) * 100);
  }

  if (hasBatchCounters && d.progress !== undefined) {
    return toPercent(d.progress);
  }

  return existing?.progress;
}

function normalizeSpeedBps(payload: { speed_bps?: number; speed_mbps?: number }) {
  const speedBps = toFiniteNumber(payload.speed_bps);
  if (speedBps !== undefined) return speedBps;
  const speedMbps = toFiniteNumber(payload.speed_mbps);
  if (speedMbps === undefined) return undefined;
  return speedMbps * 1024 * 1024;
}

export function useSocket() {
  const updateTask = useDownloadStore((s) => s.updateTask);
  const addLog = useLogStore((s) => s.addLog);
  const toast = useToastStore((s) => s.toast);
  const unlistenRefs = useRef<(() => void)[]>([]);

  useEffect(() => {
    let disposed = false;
    const register = async <T,>(event: string, handler: (payload: T) => void) => {
      const unlisten = await listenEvent<T>(event, handler);
      if (disposed) {
        unlisten();
        return;
      }
      unlistenRefs.current.push(unlisten);
    };

    const setup = async () => {
      // download-started
      await register<DownloadStartedPayload>("download-started", (d) => {
          updateTask({
            id: d.task_id,
            filename: d.display_name || d.desc,
            awemeId: d.aweme_id,
            progress: 0,
            status: "downloading",
            startTime: Date.now(),
            savePath: d.save_path,
            mediaType: d.media_type,
            mediaCount: d.media_count,
            fileTotal: d.media_count,
          });
          const msg = `开始下载: ${d.display_name || d.desc}`;
          addLog(msg, "info");
          toast(msg, "info");
        });

      // batch-download-started
      await register<BatchDownloadStartedPayload>("batch-download-started", (d) => {
          updateTask({
            id: d.task_id,
            filename: d.nickname ? `${d.nickname} 全部作品` : "批量下载",
            progress: 0,
            status: "downloading",
            startTime: Date.now(),
            isBatch: true,
            mediaCount: d.total_videos,
            fileTotal: d.total_videos,
            fileIndex: 0,
            completedCount: 0,
            skippedCount: 0,
            failedCount: 0,
            speed: 0,
            etaSeconds: undefined,
          });
          const msg = d.message || `开始批量下载 ${d.total_videos || 0} 个作品`;
          addLog(msg, "info");
          toast(msg, "info", "批量下载");
        });

      // download-progress
      await register<DownloadProgressPayload>("download-progress", (d) => {
          const existing = useDownloadStore.getState().tasks[d.task_id];
          const hasBatchProgress =
            d.overall_progress !== undefined ||
            d.current_downloaded !== undefined ||
            d.total_videos !== undefined ||
            d.processed !== undefined;
          const isBatchTask = hasBatchProgress || existing?.isBatch || false;
          const nextStatus = normalizeDownloadStatus(d.status || "downloading");

          if (existing && isTerminalStatus(existing.status) && nextStatus === "downloading") {
            return;
          }

          const patch: Partial<DownloadTask> & { id: string } = {
            id: d.task_id,
            ...(d.display_name || d.desc ? { filename: d.display_name || d.desc || "" } : {}),
            status: nextStatus,
            downloadedBytes: d.bytes_downloaded,
            totalBytes: d.bytes_total,
            etaSeconds: d.eta_seconds ?? undefined,
            savePath: d.save_path,
            filePath: d.file_path,
            mediaType: d.media_type,
          };
          const speed = normalizeSpeedBps(d);
          if (speed !== undefined) {
            patch.speed = speed;
          }

          if (isBatchTask) {
            patch.isBatch = true;
            patch.filename =
              d.display_name || d.desc || existing?.filename || "批量下载";
            if (existing?.status === "paused" && nextStatus === "downloading") {
              patch.status = "paused";
            }
            const batchProgress = computeBatchProgress(d, existing);
            if (batchProgress !== undefined) {
              patch.progress = batchProgress;
            }
            const totalVideos = toFiniteNumber(d.total_videos ?? d.total ?? existing?.fileTotal);
            if (totalVideos !== undefined) {
              patch.fileTotal = totalVideos;
              patch.mediaCount = totalVideos;
            }
            const currentDownloaded = toFiniteNumber(
              d.processed ?? d.current_downloaded ?? d.completed ?? existing?.fileIndex ?? 0
            );
            if (currentDownloaded !== undefined) {
              patch.fileIndex = currentDownloaded;
              patch.completedCount = currentDownloaded;
            }
            if (d.message) {
              patch.currentName = d.message;
            }
            if (d.skipped !== undefined) {
              patch.skippedCount = d.skipped;
            }
            if (d.failed !== undefined) {
              patch.failedCount = d.failed;
            }
            if (d.file_progress !== undefined) {
              patch.fileProgress = toPercent(d.file_progress);
            }
            if (d.status) {
              patch.status = nextStatus;
            }
            if (existing?.status === "paused" && nextStatus === "downloading") {
              patch.status = "paused";
            }
            if (d.bytes_downloaded !== undefined) {
              patch.downloadedBytes = d.bytes_downloaded;
            }
            if (d.bytes_total !== undefined) {
              patch.totalBytes = d.bytes_total;
            }
            if (d.eta_seconds !== undefined) {
              patch.etaSeconds = d.eta_seconds ?? undefined;
            }
          } else if (d.progress !== undefined) {
            patch.progress = d.progress;
            if (d.file_index !== undefined) patch.fileIndex = d.file_index;
            if (d.file_total !== undefined || d.total !== undefined) {
              patch.fileTotal = d.file_total || d.total;
            }
            if (d.file_progress !== undefined) patch.fileProgress = d.file_progress;
          }

          updateTask(patch);
        });

      // download-log
      await register<DownloadLogPayload>("download-log", (d) => {
          addLog(d.message, "info");
        });

      // download-failed
      await register<DownloadFailedPayload>("download-failed", (d) => {
          const cancelled = isCancelledMessage(d.error);
          updateTask({ id: d.task_id, status: cancelled ? "cancelled" : "error", speed: 0, errorMessage: d.error });
          addLog(d.error, cancelled ? "warning" : "error");
          if (!cancelled) {
            toast(d.error, "error", "下载失败");
          }
        });

      // download-error
      await register<DownloadErrorPayload>("download-error", (d) => {
          const cancelled = isCancelledMessage(d.message);
          updateTask({ id: d.task_id, status: cancelled ? "cancelled" : "error", speed: 0, errorMessage: d.message });
          addLog(d.message, cancelled ? "warning" : "error");
          if (!cancelled) {
            toast(d.message, "error", "下载异常");
          }
        });

      await register<DownloadCancelledPayload>("download-cancelled", (d) => {
          updateTask({ id: d.task_id, status: "cancelled", speed: 0, etaSeconds: 0 });
          const msg = d.message || "下载已取消";
          addLog(msg, "warning");
          toast(msg, "warning");
        });

      // download-completed
      await register<DownloadCompletedPayload>(
        "download-completed",
        (d) => {
            updateTask({
              id: d.task_id,
              ...(d.display_name ? { filename: d.display_name } : {}),
              status: "completed",
              progress: 100,
              speed: 0,
              etaSeconds: 0,
              totalBytes: d.total_size,
              filePath: d.file_path || d.files?.[0],
              savePath: d.save_path,
              finishedTime: Date.now(),
            });
            const msg = d.message || `下载完成: ${d.display_name || d.task_id}`;
            addLog(msg, "success");
            toast(msg, "success", "下载完成");
          }
      );

      // batch-download-completed
      await register<BatchDownloadCompletedPayload>("batch-download-completed", (d) => {
          const existing = useDownloadStore.getState().tasks[d.task_id];
          const totalVideos = toFiniteNumber(d.total_videos ?? existing?.fileTotal ?? 0);
          const completed = toFiniteNumber(d.completed ?? existing?.fileIndex ?? totalVideos ?? 0);
          const succeeded = toFiniteNumber(d.succeeded);
          const skipped = toFiniteNumber(d.skipped ?? existing?.skippedCount ?? 0) || 0;
          const failed = toFiniteNumber(d.failed ?? existing?.failedCount ?? 0) || 0;
          const processed = toFiniteNumber(d.processed) ?? completed ?? Math.min(totalVideos || 0, skipped + failed);
          const successful = succeeded ?? Math.max(0, (processed || 0) - skipped - failed);
          const progress =
            totalVideos && totalVideos > 0
              ? Math.max(0, Math.min(100, (processed / totalVideos) * 100))
              : 100;
          const status = successful > 0 || skipped > 0 ? "completed" : failed > 0 ? "error" : "completed";

          updateTask({
            id: d.task_id,
            filename: existing?.filename || "批量下载",
            isBatch: true,
            status,
            progress,
            speed: 0,
            etaSeconds: 0,
            finishedTime: Date.now(),
            fileIndex: processed || completed || undefined,
            fileTotal: totalVideos ?? undefined,
            mediaCount: totalVideos ?? undefined,
            skippedCount: skipped,
            failedCount: failed,
            errorMessage: status === "error" ? d.message || "批量下载失败" : undefined,
          });
          const msg = d.message || "批量下载已完成";
          addLog(msg, failed > 0 ? "warning" : "success");
          toast(msg, failed > 0 ? "warning" : "success", "批量下载已完成");
        });

      // batch-download-cancelled
      await register<DownloadCancelledPayload>("batch-download-cancelled", (d) => {
          updateTask({
            id: d.task_id,
            status: "cancelled",
            speed: 0,
            etaSeconds: 0,
            errorMessage: d.message || "下载已取消",
          });
          addLog(d.message || "下载已取消", "warning");
        });

      // current-video-progress
      await register<CurrentVideoProgressPayload>("current-video-progress", (d) => {
          const existing = useDownloadStore.getState().tasks[d.task_id];
          if (existing && isTerminalStatus(existing.status)) return;

          updateTask({
            id: d.task_id,
            isBatch: true,
            filename: existing?.filename || "批量下载",
            currentAwemeId: d.aweme_id,
            currentName: d.name,
            fileProgress: d.progress,
            speed: normalizeSpeedBps(d) ?? existing?.speed ?? 0,
            status: existing?.status === "paused" ? "paused" : "downloading",
          });
        });
    };

    setup();

    return () => {
      disposed = true;
      unlistenRefs.current.forEach((unlisten) => unlisten());
      unlistenRefs.current = [];
    };
  }, [updateTask, addLog, toast]);
}
