// ═══════════════════════════════════════════════
// TypeScript Type Exports
// ═══════════════════════════════════════════════

import type { NoticeItem } from "@/lib/contracts";

export type ViewType = "home" | "search" | "user" | "link" | "recommended" | "downloads" | "liked" | "collected" | "liked-authors" | "notices" | "friends-status" | "automation" | "settings";

export type ThemeMode = "light" | "dark" | "auto";

export type FontSizeMode = "small" | "medium" | "large" | "xlarge";

export type DownloadStatus = "pending" | "downloading" | "completed" | "error" | "paused" | "cancelled";

export interface CurrentDownloadItem {
  awemeId: string;
  name: string;
  progress: number;
  slot: number;
  status?: string;
  speed?: number;
  bytesDownloaded?: number;
  bytesTotal?: number;
  fileIndex?: number;
  fileTotal?: number;
  updatedAt: number;
}

export interface AppState {
  currentView: ViewType;
  setView: (view: ViewType) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  fontSize: FontSizeMode;
  setFontSize: (size: FontSizeMode) => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  bottomBarExpanded: boolean;
  toggleBottomBar: () => void;
  setBottomBarExpanded: (expanded: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  commandMode: "search" | "link";
  setCommandMode: (mode: "search" | "link") => void;
  cookieLoggedIn: boolean;
  cookieNickname: string;
  currentSecUid: string;
  setCookieLoggedIn: (loggedIn: boolean, nickname?: string, secUid?: string) => void;
  friendUnreadCount: number;
  setFriendUnreadCount: (count: number) => void;
  noticeUnreadCount: number;
  setNoticeUnreadCount: (count: number) => void;
  noticeItems: NoticeItem[];
  setNoticeItems: (items: NoticeItem[]) => void;
  noticeRefreshIntervalSeconds: number;
  setNoticeRefreshIntervalSeconds: (seconds: number) => void;
  noticeAutoRefreshing: boolean;
  setNoticeAutoRefreshing: (refreshing: boolean) => void;
  noticeLastUpdatedAt: number;
  setNoticeLastUpdatedAt: (time: number) => void;
  feedAutomationRunning: boolean;
  setFeedAutomationRunning: (running: boolean) => void;
}

export interface DownloadTask {
  id: string;
  filename: string;
  progress: number;
  speed: number;
  status: DownloadStatus;
  isBatch?: boolean;
  awemeId?: string;
  currentAwemeId?: string;
  currentName?: string;
  currentDownloads?: Record<string, CurrentDownloadItem>;
  savePath?: string;
  filePath?: string;
  mediaType?: string;
  mediaCount?: number;
  fileIndex?: number;
  fileTotal?: number;
  fileProgress?: number;
  completedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  succeededCount?: number;
  etaSeconds?: number;
  totalBytes?: number;
  downloadedBytes?: number;
  capacityTotalBytes?: number;
  capacityDownloadedBytes?: number;
  startTime?: number;
  finishedTime?: number;
  errorMessage?: string;
}

export interface LogEntry {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
  timestamp: number;
}
