import { create } from "zustand";
import type { AppState, ViewType, ThemeMode, DownloadTask, LogEntry } from "@/types";

// ═══════════════════════════════════════════════
// Global App Store
// ═══════════════════════════════════════════════

let themeWatcherInitialized = false;

export const useAppStore = create<AppState>((set) => ({
  currentView: "home",
  setView: (view: ViewType) => set({ currentView: view }),

  theme: "auto",
  setTheme: (theme: ThemeMode) => {
    set({ theme });
    try {
      localStorage.setItem("dy_theme", theme);
    } catch {
      // Ignore storage failures and still apply the selected theme.
    }
    applyTheme(theme);
  },

  fontSize: "medium",
  setFontSize: (fontSize: any) => {
    set({ fontSize });
    try {
      localStorage.setItem("dy_font_size", fontSize);
    } catch {
      // Ignore storage failures
    }
    applyFontSize(fontSize);
  },

  sidebarCollapsed: false,
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  bottomBarExpanded: false,
  toggleBottomBar: () => set((s) => ({ bottomBarExpanded: !s.bottomBarExpanded })),
  setBottomBarExpanded: (expanded: boolean) => set({ bottomBarExpanded: expanded }),

  settingsOpen: false,
  setSettingsOpen: (open: boolean) => set({ settingsOpen: open }),

  commandOpen: false,
  setCommandOpen: (open: boolean) => set({ commandOpen: open }),

  commandMode: "search",
  setCommandMode: (mode) => set({ commandMode: mode }),

  cookieLoggedIn: false,
  cookieNickname: "",
  currentSecUid: "",
  setCookieLoggedIn: (loggedIn: boolean, nickname?: string, secUid?: string) =>
    set((state) => ({
      cookieLoggedIn: loggedIn,
      cookieNickname: nickname || "",
      currentSecUid: loggedIn ? secUid || state.currentSecUid : "",
    })),

  friendUnreadCount: 0,
  setFriendUnreadCount: (count: number) => set({ friendUnreadCount: Math.max(0, count) }),

  noticeUnreadCount: 0,
  setNoticeUnreadCount: (count: number) => set({ noticeUnreadCount: Math.max(0, count) }),
}));

// ── Alert Store ──

export interface AlertConfig {
  title: string;
  description: React.ReactNode;
  variant?: "info" | "success" | "warning" | "error" | "danger";
  actionLabel?: string;
  cancelLabel?: string;
  onAction?: () => void;
  onCancel?: () => void;
}

interface AlertStore {
  isOpen: boolean;
  config: AlertConfig | null;
  showAlert: (config: AlertConfig) => void;
  hideAlert: () => void;
}

export const useAlertStore = create<AlertStore>((set) => ({
  isOpen: false,
  config: null,
  showAlert: (config) => set({ isOpen: true, config }),
  hideAlert: () => set({ isOpen: false }),
}));

// ── Global Loader Store ──

interface LoaderStore {
  isLoading: boolean;
  message: string;
  startedAt: number;
  showLoader: (message?: string) => void;
  hideLoader: () => void;
}

export const useLoaderStore = create<LoaderStore>((set) => ({
  isLoading: false,
  message: "",
  startedAt: 0,
  showLoader: (message = "正在处理...") => set({ isLoading: true, message, startedAt: Date.now() }),
  hideLoader: () => set({ isLoading: false, message: "", startedAt: 0 }),
}));

// ── Verify Recovery Store ──

export interface VerifyRecoveryConfig {
  title?: string;
  message: string;
  actionLabel?: string;
  onResume: () => void;
}

interface VerifyRecoveryStore {
  isOpen: boolean;
  config: VerifyRecoveryConfig | null;
  showRecovery: (config: VerifyRecoveryConfig) => void;
  resume: () => void;
  dismiss: () => void;
}

export const useVerifyRecoveryStore = create<VerifyRecoveryStore>((set, get) => ({
  isOpen: false,
  config: null,
  showRecovery: (config) => set({ isOpen: true, config }),
  resume: () => {
    const action = get().config?.onResume;
    set({ isOpen: false, config: null });
    action?.();
  },
  dismiss: () => set({ isOpen: false, config: null }),
}));

// ── Update Store ──

export type UpdateStatus = "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";

export interface UpdateInfo {
  version?: string;
  current_version?: string;
  notes?: string;
  asset_name?: string;
  asset_size?: number;
  download_url?: string;
  install_mode?: string;
  portable?: boolean;
}

interface UpdateState {
  status: UpdateStatus;
  message: string;
  info: UpdateInfo | null;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speedBps: number;
  canRestart: boolean;
  setStatus: (status: UpdateStatus) => void;
  setMessage: (message: string | ((current: string) => string)) => void;
  setInfo: (info: UpdateInfo | null) => void;
  setCanRestart: (canRestart: boolean) => void;
  resetProgress: () => void;
  setProgress: (payload: {
    progress?: number | null;
    downloaded?: number | null;
    total?: number | null;
    speed_bps?: number | null;
    speedBps?: number | null;
  }) => void;
}

function clampProgress(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, progress));
}

function finiteBytes(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  status: "idle",
  message: "",
  info: null,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: 0,
  speedBps: 0,
  canRestart: false,
  setStatus: (status) => set({ status }),
  setMessage: (message) =>
    set((state) => ({
      message: typeof message === "function" ? message(state.message) : message,
    })),
  setInfo: (info) =>
    set((state) => ({
      info,
      totalBytes: finiteBytes(info?.asset_size) || state.totalBytes,
    })),
  setCanRestart: (canRestart) => set({ canRestart }),
  resetProgress: () =>
    set((state) => ({
      progress: 0,
      downloadedBytes: 0,
      totalBytes: finiteBytes(state.info?.asset_size),
      speedBps: 0,
    })),
  setProgress: (payload) =>
    set((state) => {
      const downloadedBytes = Math.max(finiteBytes(payload.downloaded), state.downloadedBytes);
      const totalBytes = Math.max(
        finiteBytes(payload.total),
        finiteBytes(state.info?.asset_size),
        state.totalBytes,
      );
      const explicitProgress = typeof payload.progress === "number" ? payload.progress : null;
      const derivedProgress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : null;
      const nextProgress = Math.max(
        state.progress,
        explicitProgress === null ? 0 : clampProgress(explicitProgress),
        derivedProgress === null ? 0 : clampProgress(derivedProgress),
      );

      return {
        progress: nextProgress,
        downloadedBytes,
        totalBytes,
        speedBps: finiteBytes(payload.speed_bps ?? payload.speedBps) || state.speedBps,
      };
    }),
}));

// ── Download Store ──

interface DownloadStore {
  tasks: Record<string, DownloadTask>;
  taskIds: string[];
  listVersion: number;
  activeCount: number;
  updateTask: (task: Partial<DownloadTask> & { id: string }) => void;
  replaceTaskId: (fromId: string, toId: string, patch?: Partial<DownloadTask>) => void;
  removeTask: (id: string) => void;
  clearCompleted: () => void;
}

const createEmptyTask = (id: string): DownloadTask => ({
  id,
  filename: "",
  progress: 0,
  speed: 0,
  status: "pending",
});

const countActiveTasks = (tasks: Record<string, DownloadTask>) =>
  Object.values(tasks).filter(
    (t) => t.status === "downloading" || t.status === "pending" || t.status === "paused"
  ).length;

const isActiveDownloadStatus = (status: DownloadTask["status"]) =>
  status === "downloading" || status === "pending" || status === "paused";

const taskAffectsListShape = (existing: DownloadTask | undefined, updated: DownloadTask, taskExisted: boolean) => {
  if (!taskExisted || !existing) return true;
  return (
    existing.status !== updated.status ||
    existing.filename !== updated.filename ||
    existing.awemeId !== updated.awemeId ||
    existing.savePath !== updated.savePath ||
    existing.filePath !== updated.filePath ||
    existing.mediaType !== updated.mediaType ||
    existing.totalBytes !== updated.totalBytes ||
    existing.startTime !== updated.startTime ||
    existing.finishedTime !== updated.finishedTime ||
    existing.isBatch !== updated.isBatch
  );
};

const nextListVersion = (version: number) => version + 1;

const deriveTaskProgress = (task: DownloadTask, patch: Partial<DownloadTask>) => {
  if (!task.isBatch || !task.fileTotal || task.fileTotal <= 0 || task.fileIndex === undefined) {
    return task.progress;
  }
  if (patch.progress !== undefined && !(patch.progress === 0 && task.fileIndex > 0)) {
    return task.progress;
  }
  return Math.max(0, Math.min(100, (task.fileIndex / task.fileTotal) * 100));
};

const preservePausedProgressSnapshot = (
  existing: DownloadTask,
  patch: Partial<DownloadTask>,
  merged: DownloadTask
) => {
  if (patch.status !== "paused") return merged;

  const restored = { ...merged };
  if ((patch.progress === undefined || patch.progress === 0) && existing.progress > 0) {
    restored.progress = existing.progress;
  }
  if ((patch.fileProgress === undefined || patch.fileProgress === 0) && (existing.fileProgress ?? 0) > 0) {
    restored.fileProgress = existing.fileProgress;
  }
  if ((patch.fileIndex === undefined || patch.fileIndex === 0) && (existing.fileIndex ?? 0) > 0) {
    restored.fileIndex = existing.fileIndex;
  }
  if ((patch.completedCount === undefined || patch.completedCount === 0) && (existing.completedCount ?? 0) > 0) {
    restored.completedCount = existing.completedCount;
  }
  if ((patch.downloadedBytes === undefined || patch.downloadedBytes === 0) && (existing.downloadedBytes ?? 0) > 0) {
    restored.downloadedBytes = existing.downloadedBytes;
  }
  if ((patch.totalBytes === undefined || patch.totalBytes === 0) && (existing.totalBytes ?? 0) > 0) {
    restored.totalBytes = existing.totalBytes;
  }
  return restored;
};

export const useDownloadStore = create<DownloadStore>((set) => ({
  tasks: {},
  taskIds: [],
  listVersion: 0,
  activeCount: 0,
  updateTask: (task) =>
    set((s) => {
      const existingTask = s.tasks[task.id];
      const taskExisted = Boolean(existingTask);
      const existing = existingTask || createEmptyTask(task.id);
      const definedPatch = Object.fromEntries(
        Object.entries(task).filter(([, value]) => value !== undefined && value !== "")
      ) as Partial<DownloadTask> & { id: string };
      const merged = preservePausedProgressSnapshot(existing, definedPatch, { ...existing, ...definedPatch });
      const updated = { ...merged, progress: deriveTaskProgress(merged, definedPatch) };
      const previousActive = taskExisted ? isActiveDownloadStatus(existing.status) : false;
      const nextActive = isActiveDownloadStatus(updated.status);
      const tasks = { ...s.tasks, [task.id]: updated };
      const taskIds = taskExisted ? s.taskIds : [...s.taskIds, task.id];
      return {
        tasks,
        taskIds,
        listVersion: taskAffectsListShape(existingTask, updated, taskExisted)
          ? nextListVersion(s.listVersion)
          : s.listVersion,
        activeCount: previousActive === nextActive
          ? s.activeCount
          : s.activeCount + (nextActive ? 1 : -1),
      };
    }),
  replaceTaskId: (fromId, toId, patch = {}) =>
    set((s) => {
      if (fromId === toId) {
        const existing = s.tasks[toId] || createEmptyTask(toId);
        const tasks = { ...s.tasks, [toId]: { ...existing, ...patch, id: toId } };
        const taskIds = s.taskIds.includes(toId) ? s.taskIds : [...s.taskIds, toId];
        return { tasks, taskIds, activeCount: countActiveTasks(tasks), listVersion: nextListVersion(s.listVersion) };
      }

      const source = s.tasks[fromId];
      const target = s.tasks[toId];
      const replacement = {
        ...(source || createEmptyTask(toId)),
        ...target,
        ...patch,
        id: toId,
      };

      const tasks: Record<string, DownloadTask> = {};
      let inserted = false;

      Object.entries(s.tasks).forEach(([id, task]) => {
        if (id === fromId) {
          tasks[toId] = replacement;
          inserted = true;
          return;
        }
        if (id === toId) {
          if (!inserted) {
            tasks[toId] = replacement;
            inserted = true;
          }
          return;
        }
        tasks[id] = task;
      });

      if (!inserted) {
        tasks[toId] = replacement;
      }

      const taskIds = s.taskIds.map((id) => id === fromId ? toId : id).filter((id, index, ids) => ids.indexOf(id) === index);
      if (!taskIds.includes(toId)) taskIds.push(toId);

      return { tasks, taskIds, activeCount: countActiveTasks(tasks), listVersion: nextListVersion(s.listVersion) };
    }),
  removeTask: (id) =>
    set((s) => {
      if (!s.tasks[id]) return s;
      const { [id]: _, ...rest } = s.tasks;
      return {
        tasks: rest,
        taskIds: s.taskIds.filter((taskId) => taskId !== id),
        activeCount: countActiveTasks(rest),
        listVersion: nextListVersion(s.listVersion),
      };
    }),
  clearCompleted: () =>
    set((s) => {
      const tasks = Object.fromEntries(
        Object.entries(s.tasks).filter(
          ([, t]) => t.status !== "completed" && t.status !== "cancelled" && t.status !== "error"
        )
      );
      const taskIds = s.taskIds.filter((id) => Boolean(tasks[id]));
      return { tasks, taskIds, activeCount: countActiveTasks(tasks), listVersion: nextListVersion(s.listVersion) };
    }),
}));

// ── Log Store ──

interface LogStore {
  logs: LogEntry[];
  nextId: number;
  addLog: (message: string, type: LogEntry["type"]) => void;
  clearLogs: () => void;
}

export const useLogStore = create<LogStore>((set) => ({
  logs: [],
  nextId: 1,
  addLog: (message, type) =>
    set((s) => ({
      logs: [...s.logs.slice(-200), { id: s.nextId, message, type, timestamp: Date.now() }],
      nextId: s.nextId + 1,
    })),
  clearLogs: () => set({ logs: [], nextId: 1 }),
}));

// ── Theme Helper ──

function applyTheme(theme: ThemeMode) {
  if (theme === "auto") {
    const isLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    document.documentElement.dataset.theme = isLight ? "light" : "";
  } else if (theme === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function applyFontSize(size: string) {
  let pxSize = "16px";
  if (size === "small") pxSize = "14px";
  else if (size === "large") pxSize = "18px";
  else if (size === "xlarge") pxSize = "20px";
  document.documentElement.style.fontSize = pxSize;
}

export function initTheme() {
  let saved: ThemeMode = "auto";
  try {
    saved = (localStorage.getItem("dy_theme") as ThemeMode) || "auto";
  } catch {
    // Ignore storage failures and fall back to auto theme.
  }

  useAppStore.getState().setTheme(saved);

  let savedFontSize: any = "medium";
  try {
    savedFontSize = localStorage.getItem("dy_font_size") || "medium";
  } catch {
    // Ignore
  }
  useAppStore.getState().setFontSize(savedFontSize);

  if (themeWatcherInitialized) return;
  themeWatcherInitialized = true;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
  const handleThemeChange = () => {
    if (useAppStore.getState().theme === "auto") {
      applyTheme("auto");
    }
  };

  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", handleThemeChange);
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(handleThemeChange);
  }
}
