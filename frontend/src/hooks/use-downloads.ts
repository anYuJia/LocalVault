import { useCallback } from "react";
import { useDownloadStore, useLogStore } from "@/stores/app-store";
import { useToastStore } from "@/components/ui/toast";
import type { VideoInfo } from "@/lib/tauri";
import {
  addDownloadTask,
  cancelDownloadTask,
  downloadVideo,
  downloadVideos,
  getDownloadTasks,
  openDownloadDirectory,
  openFileLocation,
  pauseDownload,
  removeDownloadTask,
  resumeDownload,
  startDownload,
} from "@/lib/tauri";
import type { DownloadStatus, DownloadTask } from "@/types";

// ═══════════════════════════════════════════════
// Download Hook
// ═══════════════════════════════════════════════

export function useDownloads() {
  const updateTask = useDownloadStore((s) => s.updateTask);
  const replaceTaskId = useDownloadStore((s) => s.replaceTaskId);
  const removeTask = useDownloadStore((s) => s.removeTask);
  const clearCompleted = useDownloadStore((s) => s.clearCompleted);
  const addLog = useLogStore((s) => s.addLog);
  const toast = useToastStore((s) => s.toast);

  const getTaskLabel = useCallback((taskId: string) => {
    return useDownloadStore.getState().tasks[taskId]?.filename || taskId;
  }, []);

  const startSingleDownload = useCallback(
    async (video: VideoInfo) => {
      const taskId = video.aweme_id;
      const displayName = `${video.author.nickname}_${video.aweme_id}`;
      const logMsg = `开始下载: ${video.desc?.slice(0, 30) || video.aweme_id}`;
      addLog(logMsg, "info");
      toast(logMsg, "info");

      updateTask({
        id: taskId,
        awemeId: video.aweme_id,
        filename: displayName,
        progress: 0,
        status: "downloading",
        startTime: Date.now(),
      });

      try {
        const result = await downloadVideo(video);
        if (!result.success) {
          throw new Error(result.message || "下载失败");
        }
        if (result.task_id && result.task_id !== taskId) {
          replaceTaskId(taskId, result.task_id, {
            filename: displayName,
            status: "downloading",
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "下载失败";
        updateTask({ id: taskId, status: "error" });
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, replaceTaskId, addLog, toast]
  );

  const downloadBatch = useCallback(
    async (videos: VideoInfo[], name: string = "批量下载") => {
      const logMsg = `批量下载 ${videos.length} 个作品`;
      addLog(logMsg, "info");
      toast(logMsg, "info");

      try {
        const result = await downloadVideos(videos, name);
        if (result.success && result.task_id) {
          const totalVideos = result.total_videos ?? videos.length;
          updateTask({
            id: result.task_id,
            filename: name ? `${name} 全部作品` : "批量下载",
            progress: 0,
            status: "downloading",
            isBatch: true,
            mediaCount: totalVideos,
            fileTotal: totalVideos,
            fileIndex: 0,
            startTime: Date.now(),
            speed: 0,
          });
        } else {
          throw new Error(result.message || "批量下载启动失败");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "批量下载启动失败";
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, addLog, toast]
  );

  const cancelDownload = useCallback(
    async (taskId: string) => {
      const existing = useDownloadStore.getState().tasks[taskId];
      if (existing?.status === "cancelled") return;
      updateTask({ id: taskId, status: "cancelled", speed: 0, etaSeconds: 0 });
      try {
        const result = await cancelDownloadTask(taskId);
        if (!result.success) {
          throw new Error(result.message || "取消下载失败");
        }
        const label = getTaskLabel(taskId);
        addLog(`已取消下载: ${label}`, "warning");
        toast(`已取消下载: ${label}`, "warning");
      } catch (error) {
        const msg = error instanceof Error ? error.message : "取消下载失败";
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, addLog, getTaskLabel, toast]
  );

  const pauseTask = useCallback(
    async (taskId: string) => {
      const previousStatus = useDownloadStore.getState().tasks[taskId]?.status || "downloading";
      if (previousStatus === "paused") return;
      updateTask({ id: taskId, status: "paused", speed: 0 });
      try {
        const result = await pauseDownload(taskId);
        if (!result.success) {
          throw new Error(result.message || "暂停下载失败");
        }
        const label = getTaskLabel(taskId);
        addLog(`已暂停下载: ${label}`, "info");
        toast(`已暂停下载: ${label}`, "info");
      } catch (error) {
        updateTask({ id: taskId, status: previousStatus });
        const msg = error instanceof Error ? error.message : "暂停下载失败";
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, addLog, getTaskLabel, toast]
  );

  const resumeTask = useCallback(
    async (taskId: string) => {
      const previousStatus = useDownloadStore.getState().tasks[taskId]?.status || "paused";
      if (previousStatus === "downloading") return;
      updateTask({ id: taskId, status: "downloading" });
      try {
        const result = await resumeDownload(taskId);
        if (!result.success) {
          throw new Error(result.message || "继续下载失败");
        }
        const label = getTaskLabel(taskId);
        addLog(`继续下载: ${label}`, "info");
        toast(`继续下载: ${label}`, "info");
      } catch (error) {
        updateTask({ id: taskId, status: previousStatus });
        const msg = error instanceof Error ? error.message : "继续下载失败";
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, addLog, getTaskLabel, toast]
  );

  const retryDownload = useCallback(
    async (taskId: string) => {
      const task = useDownloadStore.getState().tasks[taskId];
      const awemeId = (task?.awemeId || task?.currentAwemeId || (!looksLikeUuid(taskId) ? taskId : "")).trim();

      if (!task || !awemeId) {
        const msg = "无法重试：缺少作品ID";
        addLog(msg, "error");
        toast(msg, "error");
        return;
      }

      const label = task.currentName || task.filename || awemeId;
      addLog(`重新下载: ${label}`, "info");
      toast(`重新下载: ${label}`, "info");

      try {
        try {
          await removeDownloadTask(taskId);
        } catch {
          // The old backend task may already be gone; retry should still create a fresh task.
        }
        removeTask(taskId);

        const retryVideo = {
          aweme_id: awemeId,
          desc: task.currentName || task.filename || "",
          author: { nickname: "" },
          media_type: task.mediaType || "video",
          raw_media_type: task.mediaType || "video",
          media_urls: [],
        } as unknown as VideoInfo;

        const nextTaskId = await addDownloadTask(retryVideo);
        const id = nextTaskId || awemeId;
        updateTask({
          id,
          awemeId,
          filename: label,
          progress: 0,
          status: "pending",
          startTime: Date.now(),
          errorMessage: undefined,
        });
        if (nextTaskId) {
          await startDownload(nextTaskId);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "重试下载失败";
        updateTask({
          id: taskId,
          awemeId,
          filename: label,
          progress: 0,
          status: "error",
          errorMessage: msg,
        });
        addLog(msg, "error");
        toast(msg, "error");
      }
    },
    [updateTask, removeTask, addLog, toast]
  );

  const removeDownload = useCallback(
    async (taskId: string) => {
      try {
        await removeDownloadTask(taskId);
      } catch {
        // The backend may already have removed/cancelled the task; keep the UI responsive.
      }
      removeTask(taskId);
    },
    [removeTask]
  );

  const openDownloadsDirectory = useCallback(async () => {
    try {
      await openDownloadDirectory();
    } catch (error) {
      addLog(error instanceof Error ? error.message : "打开下载目录失败", "error");
    }
  }, [addLog]);

  const openTaskLocation = useCallback(
    async (task: DownloadTask) => {
      try {
        const target = task.filePath || task.savePath;
        if (target) {
          await openFileLocation(target);
        } else {
          await openDownloadDirectory();
        }
      } catch (error) {
        addLog(error instanceof Error ? error.message : "打开文件位置失败", "error");
      }
    },
    [addLog]
  );

  const syncTasks = useCallback(async () => {
    try {
      const tasks = await getDownloadTasks();
      tasks.map(normalizeBackendTask).filter(Boolean).forEach((task) => {
        updateTask(task as DownloadTask);
      });
    } catch {
      // Downloader is not initialized during early boot; event updates still keep active tasks fresh.
    }
  }, [updateTask]);

  return {
    downloadVideo: startSingleDownload,
    downloadBatch,
    cancelDownload,
    pauseTask,
    resumeTask,
    retryDownload,
    removeTask: removeDownload,
    clearCompleted,
    openDownloadsDirectory,
    openTaskLocation,
    syncTasks,
  };
}

function normalizeStatus(status: unknown): DownloadStatus {
  const value = String(status || "").trim().toLowerCase();
  if (value === "downloading") return "downloading";
  if (value === "completed") return "completed";
  if (value === "failed" || value === "error") return "error";
  if (value === "paused") return "paused";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "pending";
}

function normalizeBackendTask(value: unknown): (Partial<DownloadTask> & { id: string }) | null {
  if (!value || typeof value !== "object") return null;
  const task = value as Record<string, unknown>;
  const id = String(task.id || "").trim();
  if (!id) return null;

  const title = String(task.title || task.filename || task.display_name || "").trim();
  const downloadedBytes = Number(task.downloaded_size ?? task.downloadedBytes ?? 0) || 0;
  const totalBytes = Number(task.total_size ?? task.totalBytes ?? 0) || 0;
  const startTime = normalizeTimestamp(task.start_time ?? task.create_time ?? task.startTime);
  const finishedTime = normalizeTimestamp(task.end_time ?? task.complete_time ?? task.finishedTime);
  const totalFiles = toFiniteNumber(task.total_videos ?? task.total_files ?? task.mediaCount);
  const processed = toFiniteNumber(task.processed ?? task.current_downloaded ?? task.completed_files);
  const progress = normalizeProgress(task.overall_progress ?? task.progress, processed, totalFiles);

  return {
    id,
    awemeId: String(task.aweme_id || task.awemeId || "").trim(),
    ...(title ? { filename: title } : {}),
    progress,
    speed: 0,
    status: normalizeStatus(task.status),
    savePath: String(task.save_path || task.savePath || "").trim(),
    mediaType: String(task.media_type || task.mediaType || "").trim(),
    mediaCount: totalFiles,
    fileTotal: totalFiles,
    fileIndex: processed,
    completedCount: processed,
    skippedCount: Number(task.skipped ?? task.skipped_count ?? 0) || undefined,
    failedCount: Number(task.failed ?? task.failed_count ?? 0) || undefined,
    downloadedBytes: downloadedBytes || undefined,
    totalBytes: totalBytes || undefined,
    startTime,
    finishedTime,
    errorMessage: String(task.error_msg || "").trim() || undefined,
  };
}

function toFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeProgress(value: unknown, processed?: number, total?: number) {
  const explicit = toFiniteNumber(value);
  if (explicit !== undefined) return Math.max(0, Math.min(100, explicit));
  if (total !== undefined && total > 0 && processed !== undefined) {
    return Math.max(0, Math.min(100, (processed / total) * 100));
  }
  return 0;
}

function normalizeTimestamp(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 10_000_000_000 ? n : n * 1000;
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
