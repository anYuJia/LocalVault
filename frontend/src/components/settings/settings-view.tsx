import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/toast";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { motion } from "framer-motion";
import {
  Palette,
  Key,
  FolderOpen,
  Zap,
  Gauge,
  Info,
  RefreshCw,
  Sun,
  Moon,
  Monitor,
  Globe,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  ShieldCheck,
  X,
  LogOut,
  FileText,
  FolderTree,
  Download as DownloadIcon,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeUpdateNotes } from "@/lib/update-notes";
import {
  cancelCookieBrowserLogin,
  checkUpdate,
  cookieBrowserLogin,
  downloadUpdate,
  getAppVersion,
  getConfig,
  initClient,
  listenEvent,
  restartApp,
  saveConfig,
  selectDirectory,
  verifyCookie,
} from "@/lib/tauri";
import type { ThemeMode } from "@/types";

type LoginStatus = "idle" | "starting" | "waiting" | "success" | "error" | "cancelled";
type UpdateStatus = "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";
type UpdateInfo = {
  version?: string;
  current_version?: string;
  notes?: string;
  asset_name?: string;
  asset_size?: number;
  download_url?: string;
  install_mode?: string;
  portable?: boolean;
};
type SettingsField =
  | "theme"
  | "download_path"
  | "download_quality"
  | "max_concurrent"
  | "filename_template"
  | "folder_name_template"
  | "auto_create_folder"
  | "im_friend_include_all_users"
  | "im_friend_refresh_interval_seconds";
type SavingFields = Partial<Record<SettingsField, boolean>>;
type SettingsPatch = Parameters<typeof saveConfig>[0];

const DOWNLOAD_QUALITY_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "highest", label: "最高质量" },
  { value: "4k", label: "4K" },
  { value: "2k", label: "2K" },
  { value: "1080p", label: "1080p" },
  { value: "720p", label: "720p" },
  { value: "480p", label: "480p" },
  { value: "h264", label: "兼容优先 (H.264)" },
  { value: "smallest", label: "最小体积" },
] as const;
const DOWNLOAD_QUALITY_VALUES = new Set<string>(DOWNLOAD_QUALITY_OPTIONS.map((option) => option.value));
type SettingStatus = "saving" | "saved" | "error";

function normalizeDownloadQuality(value: unknown) {
  const normalized = String(value || "auto").trim().toLowerCase();
  const canonical = ({
    p480: "480p",
    p720: "720p",
    p1080: "1080p",
    p1440: "2k",
    "1440p": "2k",
    p2160: "4k",
    "2160p": "4k",
  } as Record<string, string>)[normalized] ?? normalized;
  return DOWNLOAD_QUALITY_VALUES.has(canonical) ? canonical : "auto";
}

const TEMPLATE_VARIABLES = [
  { token: "{title}", label: "标题" },
  { token: "{aweme_id}", label: "作品ID" },
  { token: "{author}", label: "作者" },
  { token: "{date}", label: "发布日期" },
  { token: "{time}", label: "发布时间" },
  { token: "{media_type}", label: "类型" },
];

const FILENAME_PRESETS = [
  { value: "{title}", label: "只写标题" },
  { value: "{title}_{aweme_id}", label: "标题 + 作品ID" },
  { value: "{author}_{title}_{aweme_id}", label: "作者 + 标题 + 作品ID" },
  { value: "{date}_{title}_{aweme_id}", label: "发布日期 + 标题 + 作品ID" },
];

export function SettingsView() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const cookieNickname = useAppStore((s) => s.cookieNickname);
  const setCookieLoggedIn = useAppStore((s) => s.setCookieLoggedIn);
  const addLog = useLogStore((s) => s.addLog);
  const toast = useToast();

  // Browser login flow state
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle");
  const [loginMessage, setLoginMessage] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [browserType, setBrowserType] = useState("chrome");
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // Manual cookie state
  const [cookieValue, setCookieValue] = useState("");
  const [cookieInputStatus, setCookieInputStatus] = useState<"idle" | "valid" | "invalid">("idle");
  const [savingCookie, setSavingCookie] = useState(false);
  const lastCookieAttemptRef = useRef("");
  const rejectedCookieRef = useRef("");

  // Config state
  const [downloadPath, setDownloadPath] = useState("");
  const [downloadQuality, setDownloadQuality] = useState("auto");
  const [maxConcurrent, setMaxConcurrent] = useState("3");
  const [filenameTemplate, setFilenameTemplate] = useState("{title}");
  const [folderNameTemplate, setFolderNameTemplate] = useState("{author}");
  const [autoCreateFolder, setAutoCreateFolder] = useState(true);
  const [imFriendIncludeAllUsers, setImFriendIncludeAllUsers] = useState(false);
  const [imFriendRefreshIntervalSeconds, setImFriendRefreshIntervalSeconds] = useState("30");
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [savingFields, setSavingFields] = useState<SavingFields>({});
  const [savedFields, setSavedFields] = useState<SavingFields>({});
  const [failedFields, setFailedFields] = useState<SavingFields>({});
  const statusTimersRef = useRef<Partial<Record<SettingsField, ReturnType<typeof setTimeout>>>>({});
  const savedSettingsRef = useRef({
    downloadPath: "",
    downloadQuality: "auto",
    maxConcurrent: "3",
    filenameTemplate: "{title}",
    folderNameTemplate: "{author}",
    autoCreateFolder: true,
    imFriendIncludeAllUsers: false,
    imFriendRefreshIntervalSeconds: "30",
    theme,
  });

  // Update state
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateCanRestart, setUpdateCanRestart] = useState(false);

  const cleanup = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      Object.values(statusTimersRef.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
      statusTimersRef.current = {};
    };
  }, []);

  // On mount: check if cookie is already saved
  useEffect(() => {
    let disposed = false;
    getConfig()
      .then((config) => {
        if (disposed) return;
        const nextDownloadPath = config.download_path || config.download_dir || "";
        const nextDownloadQuality = normalizeDownloadQuality(config.download_quality);
        const nextMaxConcurrent = String(config.max_concurrent || 3);
        const nextFilenameTemplate = config.filename_template || "{title}";
        const nextFolderNameTemplate = config.folder_name_template || "{author}";
        const nextAutoCreateFolder = config.auto_create_folder ?? true;
        const nextImFriendIncludeAllUsers = config.im_friend_include_all_users ?? false;
        const nextImFriendRefreshIntervalSeconds = String(config.im_friend_refresh_interval_seconds || 30);
        setDownloadPath(nextDownloadPath);
        setDownloadQuality(nextDownloadQuality);
        setMaxConcurrent(nextMaxConcurrent);
        setFilenameTemplate(nextFilenameTemplate);
        setFolderNameTemplate(nextFolderNameTemplate);
        setAutoCreateFolder(nextAutoCreateFolder);
        setImFriendIncludeAllUsers(nextImFriendIncludeAllUsers);
        setImFriendRefreshIntervalSeconds(nextImFriendRefreshIntervalSeconds);
        savedSettingsRef.current = {
          ...savedSettingsRef.current,
          downloadPath: nextDownloadPath,
          downloadQuality: nextDownloadQuality,
          maxConcurrent: nextMaxConcurrent,
          filenameTemplate: nextFilenameTemplate,
          folderNameTemplate: nextFolderNameTemplate,
          autoCreateFolder: nextAutoCreateFolder,
          imFriendIncludeAllUsers: nextImFriendIncludeAllUsers,
          imFriendRefreshIntervalSeconds: nextImFriendRefreshIntervalSeconds,
        };
        if (config.cookie_set) {
          verifyCookie()
            .then((status) => {
              if (disposed) return;
              setCookieLoggedIn(status.valid, status.user_name || undefined);
              if (!status.valid) {
                setLoginMessage(status.message || "Cookie 已失效，请重新登录");
              }
            })
            .catch((error) => {
              if (disposed) return;
              setCookieLoggedIn(false);
              setLoginMessage(error instanceof Error ? error.message : "Cookie 校验失败");
            });
        } else {
          setCookieLoggedIn(false);
        }
      })
      .catch(() => {});
    getAppVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    }).catch(() => {});
    return () => {
      disposed = true;
      cleanup();
    };
  }, [cleanup, setCookieLoggedIn]);

  useEffect(() => {
    let disposed = false;
    let removeProgress: (() => void) | null = null;
    let removeFinished: (() => void) | null = null;
    let removeError: (() => void) | null = null;

    const setup = async () => {
      removeProgress = await listenEvent<{ progress?: number; downloaded?: number; total?: number }>(
        "update-download-progress",
        (payload) => {
          if (disposed) return;
          if (typeof payload.progress === "number") {
            setUpdateProgress(Math.max(0, Math.min(100, payload.progress)));
          }
        }
      );
      removeFinished = await listenEvent("update-download-finished", () => {
        if (disposed) return;
        setUpdateStatus("ready");
        setUpdateProgress(100);
        setUpdateMessage((current) => current || "更新已下载");
      });
      removeError = await listenEvent<{ message?: string }>("update-download-error", (payload) => {
        if (disposed) return;
        setUpdateStatus("error");
        setUpdateMessage(payload.message || "更新下载失败");
      });
    };

    void setup();

    return () => {
      disposed = true;
      removeProgress?.();
      removeFinished?.();
      removeError?.();
    };
  }, []);

  const startLogin = async () => {
    setLoginStatus("starting");
    setLoginMessage("正在启动浏览器...");

    try {
      unlistenRef.current = await listenEvent<{
        event: string;
        message?: string;
        cookie_set?: boolean;
      }>("cookie-login-status", ({ event, message, cookie_set }) => {
        switch (event) {
          case "pending":
            setLoginStatus("waiting");
            setLoginMessage(message || "请在弹出的浏览器中登录抖音账号");
            if (!countdownRef.current) {
              let remaining = 300;
              setCountdown(remaining);
              countdownRef.current = setInterval(() => {
                remaining--;
                setCountdown(remaining);
                if (remaining <= 0) {
                  cleanup();
                  setLoginStatus("error");
                  setLoginMessage("登录超时，请重试");
                }
              }, 1000);
            }
            break;
          case "success":
            cleanup();
            setLoginStatus("success");
            setLoginMessage(message || "Cookie 已自动保存");
            if (cookie_set) {
              void verifyCookie()
                .then((status) => {
                  setCookieLoggedIn(status.valid, status.user_name || undefined);
                  if (!status.valid) {
                    setLoginStatus("error");
                    setLoginMessage(status.message || "Cookie 校验失败，请重新登录");
                  }
                })
                .catch((error) => {
                  setCookieLoggedIn(false);
                  setLoginStatus("error");
                  setLoginMessage(error instanceof Error ? error.message : "Cookie 校验失败，请重新登录");
                });
            }
            break;
          case "error":
          case "timeout":
            cleanup();
            setLoginStatus("error");
            setLoginMessage(message || "登录失败");
            break;
          case "cancelled":
            cleanup();
            setLoginStatus("cancelled");
            setLoginMessage("已取消");
            break;
        }
      });

      await cookieBrowserLogin(300, browserType);
    } catch (e) {
      cleanup();
      setLoginStatus("error");
      setLoginMessage(e instanceof Error ? e.message : "启动浏览器失败");
    }
  };

  const handleCancel = async () => {
    try {
      await cancelCookieBrowserLogin();
    } catch {
      // Ignore
    }
    cleanup();
    setLoginStatus("cancelled");
    setLoginMessage("已取消");
  };

  const resetLogin = () => {
    cleanup();
    setLoginStatus("idle");
    setLoginMessage("");
    setCountdown(0);
  };

  const getCookieInputStatus = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "idle" as const;
    }
    const pairs = Object.fromEntries(
      trimmed.split(";").map((p) => {
        const [k, ...v] = p.trim().split("=");
        return [k.trim(), v.join("=")];
      })
    );
    return pairs["sessionid"]?.trim() ? "valid" : "invalid";
  };

  const handleValidateCookie = () => {
    setCookieInputStatus(getCookieInputStatus(cookieValue));
  };

  const formatCountdown = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const updateAssetName = (info: UpdateInfo | null) => {
    const explicit = info?.asset_name?.trim();
    if (explicit) return explicit;
    const downloadUrl = info?.download_url?.trim();
    if (!downloadUrl) return "";
    try {
      const pathname = new URL(downloadUrl).pathname;
      return decodeURIComponent(pathname.split("/").filter(Boolean).pop() || "");
    } catch {
      return downloadUrl.split("/").filter(Boolean).pop() || "";
    }
  };

  const handleSaveCookie = async (value = cookieValue) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setCookieInputStatus("invalid");
      return;
    }

    lastCookieAttemptRef.current = trimmed;
    setSavingCookie(true);
    try {
      const result = await saveConfig({ cookie: trimmed });
      if (!result.success) {
        throw new Error(result.message || "保存 Cookie 失败");
      }
      const status = await verifyCookie().catch((error) => ({
        valid: false,
        user_name: null,
        message: error instanceof Error ? error.message : "Cookie 校验失败",
      }));
      setCookieLoggedIn(status.valid, status.user_name || undefined);
      rejectedCookieRef.current = status.valid ? "" : trimmed;
      setCookieInputStatus(status.valid ? "valid" : "invalid");
      setLoginMessage(status.message || "Cookie 已保存");
      addLog(status.valid ? "Cookie 已保存并通过校验" : "Cookie 已保存但校验失败", status.valid ? "success" : "warning");
      if (status.valid) {
        toast.success("Cookie 已自动保存并校验", "已登录");
      } else {
        toast.warning(status.message || "Cookie 已保存但校验失败", "需要重新登录");
      }
      await initClient().catch(() => {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存 Cookie 失败";
      rejectedCookieRef.current = trimmed;
      addLog(message, "error");
      toast.error(message, "保存失败");
      setCookieInputStatus("invalid");
    } finally {
      setSavingCookie(false);
    }
  };

  const markFieldStatus = (field: SettingsField, status: "saved" | "error") => {
    if (statusTimersRef.current[field]) {
      clearTimeout(statusTimersRef.current[field]);
    }

    setSavedFields((current) => ({ ...current, [field]: status === "saved" }));
    setFailedFields((current) => ({ ...current, [field]: status === "error" }));

    statusTimersRef.current[field] = setTimeout(() => {
      setSavedFields((current) => ({ ...current, [field]: false }));
      setFailedFields((current) => ({ ...current, [field]: false }));
      statusTimersRef.current[field] = undefined;
    }, status === "saved" ? 1800 : 3200);
  };

  const fieldStatus = (field: SettingsField): SettingStatus | undefined => {
    if (savingFields[field]) return "saving";
    if (failedFields[field]) return "error";
    if (savedFields[field]) return "saved";
    return undefined;
  };

  const reportSettingSaved = (
    field: SettingsField,
    successMessage: string,
    logMessage = successMessage
  ) => {
    markFieldStatus(field, "saved");
    toast.success(successMessage, "已保存");
    addLog(logMessage, "success");
  };

  const saveSetting = async (
    field: SettingsField,
    patch: SettingsPatch,
    successMessage: string,
    logMessage = successMessage,
    refreshClient = true
  ) => {
    setSavingFields((current) => ({ ...current, [field]: true }));
    try {
      const result = await saveConfig(patch);
      if (!result.success) {
        throw new Error(result.message || "保存设置失败");
      }
      if (refreshClient) {
        await initClient().catch(() => {});
      }
      reportSettingSaved(field, successMessage, logMessage);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存设置失败";
      markFieldStatus(field, "error");
      toast.error(message, "保存失败");
      addLog(message, "error");
      return false;
    } finally {
      setSavingFields((current) => ({ ...current, [field]: false }));
    }
  };

  const saveDownloadPath = async (path: string) => {
    const nextPath = path.trim();
    const previousPath = savedSettingsRef.current.downloadPath;
    if (!nextPath || nextPath === previousPath || savingFields.download_path) {
      return;
    }
    const saved = await saveSetting(
      "download_path",
      { download_path: nextPath },
      "下载目录已保存",
      `下载目录已保存: ${nextPath}`
    );
    if (saved) {
      savedSettingsRef.current.downloadPath = nextPath;
    }
  };

  const handleChooseDirectory = async () => {
    if (choosingDirectory || savingFields.download_path) {
      return;
    }
    setChoosingDirectory(true);
    try {
      const path = await selectDirectory();
      setChoosingDirectory(false);
      if (path) {
        setDownloadPath(path);
        await saveDownloadPath(path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "选择目录失败";
      addLog(message, "error");
      toast.error(message, "选择失败");
      markFieldStatus("download_path", "error");
    } finally {
      setChoosingDirectory(false);
    }
  };

  const handleThemeChange = async (value: ThemeMode) => {
    const previousTheme = savedSettingsRef.current.theme;
    setTheme(value);
    if (value === previousTheme || savingFields.theme) return;

    savedSettingsRef.current.theme = value;
    reportSettingSaved("theme", "外观主题已保存");
  };

  const handleQualityChange = async (value: string) => {
    const nextQuality = normalizeDownloadQuality(value);
    const previousQuality = savedSettingsRef.current.downloadQuality;
    setDownloadQuality(nextQuality);
    if (nextQuality === previousQuality || savingFields.download_quality) return;

    const saved = await saveSetting(
      "download_quality",
      { download_quality: nextQuality },
      "下载质量已保存"
    );
    if (saved) {
      savedSettingsRef.current.downloadQuality = nextQuality;
    } else {
      setDownloadQuality(previousQuality);
    }
  };

  const handleMaxConcurrentChange = async (value: string) => {
    const previousMaxConcurrent = savedSettingsRef.current.maxConcurrent;
    setMaxConcurrent(value);
    if (value === previousMaxConcurrent || savingFields.max_concurrent) return;

    const nextValue = Number(value) || 3;
    const saved = await saveSetting(
      "max_concurrent",
      { max_concurrent: nextValue },
      "并发下载数已保存"
    );
    if (saved) {
      savedSettingsRef.current.maxConcurrent = String(nextValue);
    } else {
      setMaxConcurrent(previousMaxConcurrent);
    }
  };

  const normalizeTemplate = (value: string, fallback: string) => {
    const nextValue = value.trim();
    return nextValue || fallback;
  };

  const saveFilenameTemplate = async (value: string) => {
    const nextTemplate = normalizeTemplate(value, "{title}");
    const previousTemplate = savedSettingsRef.current.filenameTemplate;
    if (nextTemplate === previousTemplate || savingFields.filename_template) {
      return;
    }

    const saved = await saveSetting(
      "filename_template",
      { filename_template: nextTemplate },
      "文件命名规则已保存",
      `文件命名规则已保存: ${nextTemplate}`
    );
    if (saved) {
      savedSettingsRef.current.filenameTemplate = nextTemplate;
      setFilenameTemplate(nextTemplate);
    } else {
      setFilenameTemplate(previousTemplate);
    }
  };

  const saveFolderNameTemplate = async (value: string) => {
    const nextTemplate = normalizeTemplate(value, "{author}");
    const previousTemplate = savedSettingsRef.current.folderNameTemplate;
    if (nextTemplate === previousTemplate || savingFields.folder_name_template) {
      return;
    }

    const saved = await saveSetting(
      "folder_name_template",
      { folder_name_template: nextTemplate },
      "目录命名规则已保存",
      `目录命名规则已保存: ${nextTemplate}`
    );
    if (saved) {
      savedSettingsRef.current.folderNameTemplate = nextTemplate;
      setFolderNameTemplate(nextTemplate);
    } else {
      setFolderNameTemplate(previousTemplate);
    }
  };

  const handleAutoCreateFolderChange = async (value: boolean) => {
    const previousValue = savedSettingsRef.current.autoCreateFolder;
    setAutoCreateFolder(value);
    if (value === previousValue || savingFields.auto_create_folder) return;

    const saved = await saveSetting(
      "auto_create_folder",
      { auto_create_folder: value },
      value ? "作者目录已启用" : "作者目录已关闭"
    );
    if (saved) {
      savedSettingsRef.current.autoCreateFolder = value;
    } else {
      setAutoCreateFolder(previousValue);
    }
  };

  const handleImFriendIncludeAllUsersChange = async (value: boolean) => {
    const previousValue = savedSettingsRef.current.imFriendIncludeAllUsers;
    setImFriendIncludeAllUsers(value);
    if (value === previousValue || savingFields.im_friend_include_all_users) return;

    const saved = await saveSetting(
      "im_friend_include_all_users",
      { im_friend_include_all_users: value },
      value ? "好友状态已显示全部用户" : "好友状态已切回仅互关",
      value ? "好友状态已显示全部用户" : "好友状态已切回仅互关",
      false
    );
    if (saved) {
      savedSettingsRef.current.imFriendIncludeAllUsers = value;
    } else {
      setImFriendIncludeAllUsers(previousValue);
    }
  };

  const saveImFriendRefreshInterval = async (value: string) => {
    const previousValue = savedSettingsRef.current.imFriendRefreshIntervalSeconds;
    const parsed = Math.floor(Number(value));
    const nextSeconds = Number.isFinite(parsed) ? Math.max(1, Math.min(3600, parsed)) : 30;
    const nextValue = String(nextSeconds);
    setImFriendRefreshIntervalSeconds(nextValue);
    if (nextValue === previousValue || savingFields.im_friend_refresh_interval_seconds) return;

    const saved = await saveSetting(
      "im_friend_refresh_interval_seconds",
      { im_friend_refresh_interval_seconds: nextSeconds },
      "好友状态刷新间隔已保存",
      `好友状态刷新间隔已保存: ${nextSeconds} 秒`,
      false
    );
    if (saved) {
      savedSettingsRef.current.imFriendRefreshIntervalSeconds = nextValue;
    } else {
      setImFriendRefreshIntervalSeconds(previousValue);
    }
  };

  const appendFilenameToken = (token: string) => {
    const separator = filenameTemplate.trim() ? "_" : "";
    setFilenameTemplate(`${filenameTemplate}${separator}${token}`);
  };

  const appendFolderToken = (token: string) => {
    const separator = folderNameTemplate.trim() ? "_" : "";
    setFolderNameTemplate(`${folderNameTemplate}${separator}${token}`);
  };

  useEffect(() => {
    if (cookieLoggedIn || loginStatus !== "idle") return;

    const trimmed = cookieValue.trim();
    if (!trimmed) {
      lastCookieAttemptRef.current = "";
      rejectedCookieRef.current = "";
      setCookieInputStatus("idle");
      return;
    }
    if (trimmed === rejectedCookieRef.current) {
      setCookieInputStatus("invalid");
      return;
    }

    const status = getCookieInputStatus(trimmed);
    setCookieInputStatus(status);

    if (status !== "valid" || savingCookie || trimmed === lastCookieAttemptRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      void handleSaveCookie(trimmed);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [cookieValue, cookieLoggedIn, loginStatus, savingCookie]);

  useEffect(() => {
    const nextPath = downloadPath.trim();
    if (!nextPath || nextPath === savedSettingsRef.current.downloadPath || savingFields.download_path) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveDownloadPath(nextPath);
    }, 800);

    return () => window.clearTimeout(timer);
  }, [downloadPath, savingFields.download_path]);

  useEffect(() => {
    const nextTemplate = normalizeTemplate(filenameTemplate, "{title}");
    if (nextTemplate === savedSettingsRef.current.filenameTemplate || savingFields.filename_template) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveFilenameTemplate(nextTemplate);
    }, 800);

    return () => window.clearTimeout(timer);
  }, [filenameTemplate, savingFields.filename_template]);

  useEffect(() => {
    if (!autoCreateFolder) return;
    const nextTemplate = normalizeTemplate(folderNameTemplate, "{author}");
    if (nextTemplate === savedSettingsRef.current.folderNameTemplate || savingFields.folder_name_template) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveFolderNameTemplate(nextTemplate);
    }, 800);

    return () => window.clearTimeout(timer);
  }, [folderNameTemplate, autoCreateFolder, savingFields.folder_name_template]);

  useEffect(() => {
    const parsed = Math.floor(Number(imFriendRefreshIntervalSeconds));
    if (!Number.isFinite(parsed) || parsed < 1) return;
    const nextValue = String(Math.max(1, Math.min(3600, parsed)));
    if (
      nextValue === savedSettingsRef.current.imFriendRefreshIntervalSeconds ||
      savingFields.im_friend_refresh_interval_seconds
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      void saveImFriendRefreshInterval(nextValue);
    }, 800);

    return () => window.clearTimeout(timer);
  }, [imFriendRefreshIntervalSeconds, savingFields.im_friend_refresh_interval_seconds]);

  const handleCheckUpdate = async () => {
    setUpdateStatus("checking");
    setUpdateMessage("正在检查更新...");
    try {
      const result = await checkUpdate();
      if (!result.success) {
        setUpdateStatus("error");
        setUpdateMessage(result.message || "检查更新失败");
        return;
      }
      if (result.has_update) {
        setUpdateStatus("available");
        setUpdateInfo({
          version: result.version,
          current_version: result.current_version,
          notes: normalizeUpdateNotes(result.notes),
          asset_name: result.asset_name,
          asset_size: result.asset_size,
          download_url: result.download_url,
          install_mode: result.install_mode,
          portable: result.portable,
        });
        setUpdateCanRestart(false);
        setUpdateMessage(`发现新版本 ${result.version || ""}`.trim());
      } else {
        setUpdateStatus("none");
        setUpdateInfo(null);
        setUpdateCanRestart(false);
        setUpdateMessage("当前已是最新版本");
      }
    } catch (error) {
      setUpdateStatus("error");
      setUpdateMessage(error instanceof Error ? error.message : "检查更新失败");
    }
  };

  const handleDownloadUpdate = async () => {
    setUpdateStatus("downloading");
    setUpdateProgress(0);
    try {
      const result = await downloadUpdate();
      if (!result.success) {
        throw new Error(result.message || "更新下载失败");
      }
      const autoClosing = result.message.includes("自动关闭") || result.message.includes("即将关闭");
      if (!autoClosing) {
        setUpdateStatus("ready");
      }
      setUpdateCanRestart(!autoClosing && Boolean(result.restart_required ?? true));
      setUpdateMessage(result.message || "安装包已准备完成，重启后使用新版本");
      setUpdateProgress(100);
    } catch (error) {
      setUpdateStatus("error");
      setUpdateCanRestart(false);
      setUpdateMessage(error instanceof Error ? error.message : "更新下载失败");
    }
  };

  const handleRestart = async () => {
    try {
      await restartApp();
    } catch (error) {
      addLog(error instanceof Error ? error.message : "重启失败", "error");
    }
  };

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
      className="mx-auto w-full max-w-[1040px] p-4 lg:p-6"
    >
      <h1 className="mb-1 text-lg font-bold text-text">设置</h1>
      <p className="mb-4 text-xs text-text-muted">
        更改后自动保存，无需手动提交
      </p>

      <div className="flex flex-col gap-3">
        {/* Cookie Section */}
        <SettingGroup icon={Key} label="Cookie 登录">
          {/* Already logged in */}
          {cookieLoggedIn && loginStatus === "idle" ? (
            <div className="rounded-[var(--radius-sm)] border border-success/15 bg-success/[0.04] p-3">
              <div className="mb-2.5 flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-success/10">
                  <ShieldCheck className="w-5 h-5 text-success" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-success">
                    已登录
                  </p>
                  {cookieNickname && (
                    <p className="text-xs text-text-muted mt-0.5">
                      {cookieNickname}
                    </p>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCookieLoggedIn(false);
                  resetLogin();
                }}
                className="h-9 rounded-lg text-text-muted hover:text-text gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                重新登录
              </Button>
            </div>
          ) : loginStatus === "idle" ? (
            /* Not logged in — show login card */
            <div className="rounded-[var(--radius-sm)] border border-border bg-surface p-3">
              <div className="mb-3 flex items-start gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-solid">
                  <Globe className="h-[18px] w-[18px] text-accent" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-text mb-1">
                    浏览器自动登录
                  </p>
                  <p className="text-xs text-text-muted leading-relaxed">
                    打开浏览器窗口登录抖音，Cookie 将自动提取并保存
                  </p>
                </div>
              </div>

              <div className="mb-3 grid gap-1.5 sm:grid-cols-3">
                {["系统打开浏览器窗口", "在浏览器中登录抖音账号", "登录成功后 Cookie 自动保存"].map(
                  (step, i) => (
                    <div key={i} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-solid/50 px-2 py-1.5">
                      <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-surface text-[0.6rem] font-bold text-text-muted">
                        {i + 1}
                      </span>
                      <span className="truncate text-xs text-text-secondary">
                        {step}
                      </span>
                    </div>
                  )
                )}
              </div>

              <div className="mb-3">
                <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  浏览器类型
                </p>
                <Select value={browserType} onValueChange={setBrowserType}>
                  <SelectTrigger className="h-10 rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chrome">Chrome</SelectItem>
                    <SelectItem value="edge">Edge</SelectItem>
                    <SelectItem value="chromium">Chromium</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button
                onClick={startLogin}
                className="h-10 w-full gap-2 rounded-[var(--radius-sm)] text-sm font-semibold"
              >
                <ExternalLink className="w-4 h-4" />
                打开浏览器登录
              </Button>
            </div>
          ) : (
            /* Login in progress / result */
            <div className="rounded-[var(--radius-sm)] border border-border bg-surface p-3">
              <div className="mb-3 flex items-center gap-3">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                    (loginStatus === "starting" || loginStatus === "waiting") && "bg-info/10",
                    loginStatus === "success" && "bg-success/10",
                    loginStatus === "error" && "bg-danger/10",
                    loginStatus === "cancelled" && "bg-[var(--color-subtle-bg)]"
                  )}
                >
                  {(loginStatus === "starting" || loginStatus === "waiting") && (
                    <Loader2 className="w-5 h-5 text-info animate-spin" />
                  )}
                  {loginStatus === "success" && (
                    <CheckCircle2 className="w-5 h-5 text-success" />
                  )}
                  {loginStatus === "error" && (
                    <XCircle className="w-5 h-5 text-danger" />
                  )}
                  {loginStatus === "cancelled" && (
                    <X className="w-5 h-5 text-text-muted" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-text">
                    {loginStatus === "starting" && "正在启动..."}
                    {loginStatus === "waiting" && "等待登录"}
                    {loginStatus === "success" && "登录成功"}
                    {loginStatus === "error" && "登录失败"}
                    {loginStatus === "cancelled" && "已取消"}
                  </p>
                  <p className="text-xs text-text-muted mt-0.5">
                    {loginMessage}
                  </p>
                </div>
              </div>

              {loginStatus === "waiting" && countdown > 0 && (
                <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-surface-solid/50 px-3 py-2">
                  <span className="text-xs text-text-muted">剩余时间</span>
                  <span className="text-sm font-mono font-semibold text-text tabular-nums">
                    {formatCountdown(countdown)}
                  </span>
                </div>
              )}

              <div className="flex gap-2">
                {(loginStatus === "starting" || loginStatus === "waiting") && (
                  <Button
                    variant="outline"
                    onClick={handleCancel}
                    className="flex-1 h-10 rounded-[var(--radius-sm)] text-danger hover:text-danger"
                  >
                    取消
                  </Button>
                )}
                {(loginStatus === "success" || loginStatus === "error" || loginStatus === "cancelled") && (
                  <Button
                    variant="outline"
                    onClick={resetLogin}
                    className="flex-1 h-10 rounded-[var(--radius-sm)]"
                  >
                    {loginStatus === "success" ? "完成" : "重试"}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Manual cookie input */}
          {!cookieLoggedIn && loginStatus === "idle" && (
            <div className="mt-3">
              <p className="text-xs text-text-muted mb-2">
                或粘贴 Cookie，检测通过后自动保存
              </p>
              <Textarea
                value={cookieValue}
                onChange={(e) => {
                  setCookieValue(e.target.value);
                }}
                onBlur={handleValidateCookie}
                placeholder="从浏览器开发者工具复制抖音 Cookie..."
                rows={3}
              />
              {savingCookie ? (
                <p className="text-xs text-info mt-1.5 flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> 正在自动保存并校验
                </p>
              ) : cookieInputStatus === "valid" ? (
                <p className="text-xs text-success mt-1.5 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> 已检测到登录字段，将自动保存
                </p>
              ) : cookieInputStatus === "invalid" ? (
                <p className="text-xs text-danger mt-1.5 flex items-center gap-1">
                  <XCircle className="w-3 h-3" />
                  {cookieValue.trim() === rejectedCookieRef.current
                    ? "Cookie 校验未通过，请重新获取"
                    : "缺少必要参数，请确认包含 sessionid"}
                </p>
              ) : null}
              {loginMessage && (
                <p className="mt-2 text-xs text-text-muted">{loginMessage}</p>
              )}
            </div>
          )}
        </SettingGroup>

        <div className="grid gap-3 lg:grid-cols-2">
        {/* Theme */}
        <SettingGroup icon={Palette} label="外观主题" status={fieldStatus("theme")}>
          <div className="flex gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface p-1">
            {(
              [
                { value: "light", icon: Sun, label: "亮色" },
                { value: "dark", icon: Moon, label: "暗色" },
                { value: "auto", icon: Monitor, label: "系统" },
              ] as const
            ).map(({ value, icon: Icon, label }) => (
              <button
                type="button"
                key={value}
                onClick={() => void handleThemeChange(value as ThemeMode)}
                disabled={savingFields.theme}
                className={cn(
                  "relative flex-1 flex items-center justify-center gap-2 h-10 rounded-lg text-sm font-semibold transition-[background-color,color,box-shadow,transform,opacity] duration-200 cursor-pointer",
                  savingFields.theme && "cursor-wait opacity-75",
                  theme === value
                    ? "text-text"
                    : "text-text-muted hover:text-text-secondary"
                )}
              >
                {theme === value && (
                  <motion.div
                    layoutId="theme-tab-bg"
                    className="absolute inset-0 rounded-lg bg-surface-solid shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon className="relative w-4 h-4" />
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>
        </SettingGroup>

        <SettingGroup
          icon={Users}
          label="好友在线状态"
          status={fieldStatus("im_friend_include_all_users") || fieldStatus("im_friend_refresh_interval_seconds")}
        >
          <div className="space-y-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={imFriendIncludeAllUsers}
              aria-label="显示全部用户"
              onClick={() => void handleImFriendIncludeAllUsersChange(!imFriendIncludeAllUsers)}
              disabled={savingFields.im_friend_include_all_users}
              className={cn(
                "flex h-10 w-full items-center justify-between rounded-[var(--radius-sm)] border px-3 transition-[background-color,border-color,opacity,box-shadow] duration-200",
                imFriendIncludeAllUsers
                  ? "border-accent/25 bg-accent-soft"
                  : "border-border bg-surface",
                savingFields.im_friend_include_all_users && "opacity-70"
              )}
            >
              <span className="text-sm font-semibold text-text">
                {imFriendIncludeAllUsers ? "显示全部用户" : "仅显示互关用户"}
              </span>
              <span
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors duration-200",
                  imFriendIncludeAllUsers ? "bg-accent" : "bg-[var(--color-toggle-track)]"
                )}
              >
                <span
                  className={cn(
                    "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                    imFriendIncludeAllUsers ? "translate-x-[18px]" : "translate-x-0"
                  )}
                />
              </span>
            </button>

            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-wider text-text-muted">
                自动刷新间隔（秒）
              </label>
              <Input
                type="number"
                min={1}
                max={3600}
                step={1}
                value={imFriendRefreshIntervalSeconds}
                onChange={(event) => setImFriendRefreshIntervalSeconds(event.target.value)}
                onBlur={() => void saveImFriendRefreshInterval(imFriendRefreshIntervalSeconds)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
                disabled={savingFields.im_friend_refresh_interval_seconds}
                className="h-10"
              />
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              好友页后台刷新，默认 30 秒。
            </p>
          </div>
        </SettingGroup>

        {/* Download Dir */}
        <SettingGroup icon={FolderOpen} label="下载目录" status={fieldStatus("download_path")}>
          <div className="flex gap-2">
            <Input
              value={downloadPath}
              onChange={(event) => setDownloadPath(event.target.value)}
              onBlur={() => void saveDownloadPath(downloadPath)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              placeholder="data/"
              className="flex-1 h-10"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleChooseDirectory}
              disabled={choosingDirectory || savingFields.download_path}
              className="h-10 shrink-0 px-4"
            >
              {choosingDirectory || savingFields.download_path ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4" />
              )}
              {choosingDirectory ? "选择中" : savingFields.download_path ? "保存中" : "选择"}
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-1.5">
            输入或选择后自动保存。
          </p>
        </SettingGroup>

        {/* Naming */}
        <SettingGroup icon={FileText} label="文件命名规则" status={fieldStatus("filename_template")}>
          <div className="space-y-2.5">
            <Select
              value={FILENAME_PRESETS.some((preset) => preset.value === filenameTemplate) ? filenameTemplate : "custom"}
              onValueChange={(value) => {
                if (value !== "custom") {
                  setFilenameTemplate(value);
                  void saveFilenameTemplate(value);
                }
              }}
            >
              <SelectTrigger className="h-10" disabled={savingFields.filename_template}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILENAME_PRESETS.map((preset) => (
                  <SelectItem key={preset.value} value={preset.value}>
                    {preset.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">自定义</SelectItem>
              </SelectContent>
            </Select>

            <Input
              value={filenameTemplate}
              onChange={(event) => setFilenameTemplate(event.target.value)}
              onBlur={() => void saveFilenameTemplate(filenameTemplate)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              disabled={savingFields.filename_template}
              placeholder="{title}"
              className="h-10 font-mono text-sm"
            />

            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.map((item) => (
                <button
                  key={item.token}
                  type="button"
                  onClick={() => appendFilenameToken(item.token)}
                  disabled={savingFields.filename_template}
                  className="inline-flex h-7 items-center rounded-lg border border-border bg-surface px-2 font-mono text-xs text-text-secondary transition-[background-color,color,border-color,opacity] hover:border-accent/30 hover:bg-accent/10 hover:text-accent disabled:opacity-50"
                  title={item.label}
                >
                  {item.token}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted leading-relaxed">
              保存时会自动补作品ID，避免同名覆盖。
            </p>
          </div>
        </SettingGroup>

        <SettingGroup icon={FolderTree} label="作者目录规则" status={fieldStatus("folder_name_template") || fieldStatus("auto_create_folder")}>
          <div className="space-y-2.5">
            <button
              type="button"
              role="switch"
              aria-checked={autoCreateFolder}
              aria-label="按目录归档"
              onClick={() => void handleAutoCreateFolderChange(!autoCreateFolder)}
              disabled={savingFields.auto_create_folder}
              className={cn(
                "flex h-10 w-full items-center justify-between rounded-[var(--radius-sm)] border px-3 transition-[background-color,border-color,opacity,box-shadow] duration-200",
                autoCreateFolder
                  ? "border-accent/25 bg-accent-soft"
                  : "border-border bg-surface",
                savingFields.auto_create_folder && "opacity-70"
              )}
            >
              <span className="text-sm font-semibold text-text">按目录归档</span>
              <span
                className={cn(
                  "relative h-5 w-9 rounded-full transition-colors duration-200",
                  autoCreateFolder ? "bg-accent" : "bg-[var(--color-toggle-track)]"
                )}
              >
                <span
                  className={cn(
                    "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
                    autoCreateFolder ? "translate-x-[18px]" : "translate-x-0"
                  )}
                />
              </span>
            </button>

            <Input
              value={folderNameTemplate}
              onChange={(event) => setFolderNameTemplate(event.target.value)}
              onBlur={() => void saveFolderNameTemplate(folderNameTemplate)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
              disabled={!autoCreateFolder || savingFields.folder_name_template}
              placeholder="{author}"
              className="h-10 font-mono text-sm"
            />

            <div className="flex flex-wrap gap-1.5">
              {TEMPLATE_VARIABLES.filter((item) => item.token !== "{title}").map((item) => (
                <button
                  key={item.token}
                  type="button"
                  onClick={() => appendFolderToken(item.token)}
                  disabled={!autoCreateFolder || savingFields.folder_name_template}
                  className="inline-flex h-7 items-center rounded-lg border border-border bg-surface px-2 font-mono text-xs text-text-secondary transition-[background-color,color,border-color,opacity] hover:border-accent/30 hover:bg-accent/10 hover:text-accent disabled:opacity-50"
                  title={item.label}
                >
                  {item.token}
                </button>
              ))}
            </div>
          </div>
        </SettingGroup>

        {/* Quality */}
        <SettingGroup icon={Gauge} label="视频下载质量" status={fieldStatus("download_quality")}>
          <Select value={downloadQuality} onValueChange={(value) => void handleQualityChange(value)}>
            <SelectTrigger className="h-10" disabled={savingFields.download_quality}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DOWNLOAD_QUALITY_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-muted mt-1.5 leading-relaxed">
            目标清晰度会优先选择不超过目标且最接近的版本；图片、图集和 Live Photo 按原始媒体下载。
          </p>
        </SettingGroup>

        {/* Concurrency */}
        <SettingGroup icon={Zap} label="并发下载数" status={fieldStatus("max_concurrent")}>
          <Select value={maxConcurrent} onValueChange={(value) => void handleMaxConcurrentChange(value)}>
            <SelectTrigger className="h-10" disabled={savingFields.max_concurrent}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} 个{n === 3 ? " (推荐)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingGroup>
        </div>

        {/* Divider */}
        <div className="h-px bg-[var(--color-subtle-bg)]" />

        {/* About */}
        <SettingGroup icon={Info} label="关于">
          <div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2.5">
            <span className="text-sm text-text-muted">当前版本</span>
            <span className="text-sm text-text font-mono font-semibold">
              {appVersion ? `v${appVersion}` : "读取中"}
            </span>
          </div>
          {updateMessage && (
            <div
              className={cn(
                "mt-3 rounded-[var(--radius-sm)] border px-3 py-2.5 text-xs leading-relaxed",
                updateStatus === "error"
                  ? "border-danger/20 bg-danger-soft text-danger"
                  : updateStatus === "available"
                    ? "border-info/20 bg-info/10 text-info"
                    : updateStatus === "ready"
                      ? "border-success/20 bg-success-soft text-success"
                      : "border-border bg-surface text-text-muted"
              )}
            >
              {updateMessage}
            </div>
          )}
          {updateInfo?.notes && (
            <div className="mt-3 rounded-[var(--radius-sm)] border border-border bg-surface p-3 text-text-secondary">
              <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-text-muted">新版本内容</div>
              <div className="max-h-[180px] overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed">
                {updateInfo.notes}
              </div>
            </div>
          )}
          {updateAssetName(updateInfo) && updateStatus === "available" && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-border bg-surface px-3 py-2 text-xs text-text-muted">
              <span className="min-w-0 truncate">{updateAssetName(updateInfo)}</span>
              {formatBytes(updateInfo?.asset_size) && (
                <span className="shrink-0 font-mono tabular-nums">{formatBytes(updateInfo?.asset_size)}</span>
              )}
            </div>
          )}
          {updateStatus === "downloading" && (
            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between text-xs text-text-muted">
                <span>下载进度</span>
                <span className="font-mono tabular-nums">{Math.round(updateProgress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--color-subtle-bg)]">
                <div className="h-full rounded-full bg-gradient-to-r from-accent to-info transition-[width] duration-300" style={{ width: `${updateProgress}%` }} />
              </div>
            </div>
          )}
          <Button
            variant="outline"
            onClick={handleCheckUpdate}
            disabled={updateStatus === "checking" || updateStatus === "downloading"}
            className="w-full h-10 rounded-[var(--radius-sm)] mt-3"
          >
            <RefreshCw className={cn("w-4 h-4", updateStatus === "checking" && "animate-spin")} />
            {updateStatus === "checking" ? "检查中..." : "检查更新"}
          </Button>
          {updateStatus === "available" && (
            <Button
              variant="default"
              onClick={handleDownloadUpdate}
              className="mt-2 w-full h-10 rounded-[var(--radius-sm)]"
            >
              <DownloadIcon className="w-4 h-4" />
              立即更新
            </Button>
          )}
          {updateStatus === "ready" && updateCanRestart && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={() => setUpdateCanRestart(false)}
                className="h-10 rounded-[var(--radius-sm)]"
              >
                稍后重启
              </Button>
              <Button
                variant="default"
                onClick={handleRestart}
                className="h-10 rounded-[var(--radius-sm)]"
              >
                <RefreshCw className="w-4 h-4" />
                立即重启
              </Button>
            </div>
          )}
        </SettingGroup>
      </div>
    </motion.div>
  );
}

function SettingGroup({
  icon: Icon,
  label,
  status,
  className,
  children,
}: {
  icon: React.ElementType;
  label: string;
  status?: SettingStatus;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-[var(--radius-lg)] border border-border bg-surface-solid/45 p-3.5 transition-colors", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-sm font-semibold text-text">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-surface">
            <Icon className="w-4 h-4 text-accent" />
          </div>
          {label}
        </label>
        {status && <SettingStatusPill status={status} />}
      </div>
      {children}
    </div>
  );
}

function SettingStatusPill({ status }: { status: SettingStatus }) {
  const config = {
    saving: {
      label: "保存中",
      className: "border-info/20 bg-info-soft text-info",
      icon: <Loader2 className="w-3 h-3 animate-spin" />,
    },
    saved: {
      label: "已保存",
      className: "border-success/20 bg-success-soft text-success",
      icon: <CheckCircle2 className="w-3 h-3" />,
    },
    error: {
      label: "保存失败",
      className: "border-danger/20 bg-danger-soft text-danger",
      icon: <XCircle className="w-3 h-3" />,
    },
  }[status];

  return (
    <motion.span
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-semibold tabular-nums",
        config.className
      )}
    >
      {config.icon}
      {config.label}
    </motion.span>
  );
}
