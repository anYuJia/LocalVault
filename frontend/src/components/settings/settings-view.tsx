import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore, useLogStore, useAlertStore, useUpdateStore } from "@/stores/app-store";
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
import { motion, AnimatePresence } from "framer-motion";
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
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
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
  getAccounts,
  switchAccount,
  deleteAccount,
  addAccount,
} from "@/lib/tauri";
import type { AccountInfo } from "@/lib/tauri";
import type { ThemeMode } from "@/types";
import {
  FILENAME_PRESETS,
  TEMPLATE_VARIABLES,
  type LoginStatus,
  type SavingFields,
  type SettingsField,
  type SettingsPatch,
  type SettingStatus,
} from "./settings-utils";
import { SettingGroup } from "./settings-components";

export function SettingsView() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const cookieNickname = useAppStore((s) => s.cookieNickname);
  const setCookieLoggedIn = useAppStore((s) => s.setCookieLoggedIn);
  const addLog = useLogStore((s) => s.addLog);
  const toast = useToast();
  const showAlert = useAlertStore((s) => s.showAlert);

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
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [currentSecUid, setCurrentSecUid] = useState("");

  const loadAccounts = useCallback(async () => {
    try {
      const res = await getAccounts();
      if (res.success) {
        setAccounts(res.accounts || []);
        setCurrentSecUid(res.current_sec_uid || "");
        const active = res.accounts?.find((a) => a.sec_uid === res.current_sec_uid);
        if (active) {
          setCookieLoggedIn(true, active.nickname, active.sec_uid);
        } else {
          // Fallback if no active found but accounts exist
          setCookieLoggedIn(false);
        }
      }
    } catch (e) {
      console.error("加载账号列表失败", e);
    }
  }, [setCookieLoggedIn]);

  // Config state
  const [downloadPath, setDownloadPath] = useState("");
  const [downloadQuality, setDownloadQuality] = useState("auto");
  const [maxConcurrent, setMaxConcurrent] = useState("3");
  const [filenameTemplate, setFilenameTemplate] = useState("{title}_{aweme_id}");
  const [folderNameTemplate, setFolderNameTemplate] = useState("{author}");
  const [autoCreateFolder, setAutoCreateFolder] = useState(true);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [savingFields, setSavingFields] = useState<SavingFields>({});
  const [savedFields, setSavedFields] = useState<SavingFields>({});
  const [failedFields, setFailedFields] = useState<SavingFields>({});
  const statusTimersRef = useRef<Partial<Record<SettingsField, ReturnType<typeof setTimeout>>>>({});
  const savedSettingsRef = useRef({
    downloadPath: "",
    downloadQuality: "auto",
    maxConcurrent: "3",
    filenameTemplate: "{title}_{aweme_id}",
    folderNameTemplate: "{author}",
    autoCreateFolder: true,
    theme,
  });

  // Update state — read from global store so background progress is visible
  const [appVersion, setAppVersion] = useState("");
  const updateStatus = useUpdateStore((s) => s.status);
  const updateMessage = useUpdateStore((s) => s.message);
  const updateInfo = useUpdateStore((s) => s.info);
  const updateProgress = useUpdateStore((s) => s.progress);
  const updateCanRestart = useUpdateStore((s) => s.canRestart);

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
        const nextDownloadQuality = config.download_quality || "auto";
        const nextMaxConcurrent = String(config.max_concurrent || 3);
        const nextFilenameTemplate = config.filename_template || "{title}_{aweme_id}";
        const nextFolderNameTemplate = config.folder_name_template || "{author}";
        const nextAutoCreateFolder = config.auto_create_folder ?? true;
        setDownloadPath(nextDownloadPath);
        setDownloadQuality(nextDownloadQuality);
        setMaxConcurrent(nextMaxConcurrent);
        setFilenameTemplate(nextFilenameTemplate);
        setFolderNameTemplate(nextFolderNameTemplate);
        setAutoCreateFolder(nextAutoCreateFolder);
        savedSettingsRef.current = {
          ...savedSettingsRef.current,
          downloadPath: nextDownloadPath,
          downloadQuality: nextDownloadQuality,
          maxConcurrent: nextMaxConcurrent,
          filenameTemplate: nextFilenameTemplate,
          folderNameTemplate: nextFolderNameTemplate,
          autoCreateFolder: nextAutoCreateFolder,
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
    void loadAccounts();
    getAppVersion().then((version) => {
      if (!disposed) setAppVersion(version);
    }).catch(() => {});
    return () => {
      disposed = true;
      cleanup();
    };
  }, [cleanup, setCookieLoggedIn, loadAccounts]);

  // Note: update event listeners are handled globally in App.tsx via useUpdateStore.
  // No duplicate listeners needed here — the store subscriptions above pick up changes.

  const startLogin = async (cookie?: string) => {
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
                  void loadAccounts();
                })
                .catch((error) => {
                  setCookieLoggedIn(false);
                  setLoginStatus("error");
                  setLoginMessage(error instanceof Error ? error.message : "Cookie 校验失败，请重新登录");
                });
            } else {
              void loadAccounts();
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

      await cookieBrowserLogin(300, browserType, cookie);
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

  const handleSaveCookie = async (value = cookieValue) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setCookieInputStatus("invalid");
      return;
    }

    lastCookieAttemptRef.current = trimmed;
    setSavingCookie(true);
    try {
      const result = await addAccount(trimmed);
      if (!result.success) {
        throw new Error(result.message || "添加账号失败");
      }
      setCookieLoggedIn(true, result.nickname, result.sec_uid);
      setCookieInputStatus("valid");
      setLoginMessage(result.message || "账号添加成功并激活");
      addLog(`成功添加并切换账号: ${result.nickname}`, "success");
      toast.success(`已切换为账号: ${result.nickname}`, "添加成功");
      setCookieValue(""); // Clear input on success
      rejectedCookieRef.current = "";
      await loadAccounts();
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
    const previousQuality = savedSettingsRef.current.downloadQuality;
    setDownloadQuality(value);
    if (value === previousQuality || savingFields.download_quality) return;

    const saved = await saveSetting(
      "download_quality",
      { download_quality: value },
      "下载质量已保存"
    );
    if (saved) {
      savedSettingsRef.current.downloadQuality = value;
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
    const nextTemplate = normalizeTemplate(value, "{title}_{aweme_id}");
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

  const appendFilenameToken = (token: string) => {
    const separator = filenameTemplate.trim() ? "_" : "";
    setFilenameTemplate(`${filenameTemplate}${separator}${token}`);
  };

  const appendFolderToken = (token: string) => {
    const separator = folderNameTemplate.trim() ? "_" : "";
    setFolderNameTemplate(`${folderNameTemplate}${separator}${token}`);
  };

  useEffect(() => {
    const trimmed = cookieValue.trim();
    if (!trimmed) {
      setCookieInputStatus("idle");
      return;
    }
    if (trimmed === rejectedCookieRef.current) {
      setCookieInputStatus("invalid");
      return;
    }

    const status = getCookieInputStatus(trimmed);
    setCookieInputStatus(status);
  }, [cookieValue]);

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
    const nextTemplate = normalizeTemplate(filenameTemplate, "{title}_{aweme_id}");
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

  const handleCheckUpdate = async () => {
    const store = useUpdateStore.getState();
    store.setStatus("checking");
    store.setMessage("正在检查更新...");
    try {
      const result = await checkUpdate();
      if (!result.success) {
        store.setStatus("error");
        store.setMessage(result.message || "检查更新失败");
        return;
      }
      if (result.has_update) {
        store.setStatus("available");
        store.setInfo({
          version: result.version,
          current_version: result.current_version,
          notes: result.notes,
          asset_name: result.asset_name,
          asset_size: result.asset_size,
          install_mode: result.install_mode,
          portable: result.portable,
        });
        store.setCanRestart(false);
        store.setMessage(`发现新版本 ${result.version || ""}`.trim());
      } else {
        store.setStatus("none");
        store.setInfo(null);
        store.setCanRestart(false);
        store.setMessage("当前已是最新版本");
      }
    } catch (error) {
      store.setStatus("error");
      store.setMessage(error instanceof Error ? error.message : "检查更新失败");
    }
  };

  const handleDownloadUpdate = async () => {
    const store = useUpdateStore.getState();
    store.setStatus("downloading");
    store.resetProgress();
    try {
      const result = await downloadUpdate();
      if (!result.success) {
        throw new Error(result.message || "更新下载失败");
      }
      const autoClosing = result.message.includes("自动关闭");
      if (!autoClosing) {
        store.setStatus("ready");
      }
      store.setCanRestart(!autoClosing && Boolean(result.restart_required ?? true));
      store.setMessage(result.message || "更新下载完成");
      store.setProgress({ progress: 100, speed_bps: 0 });
    } catch (error) {
      store.setStatus("error");
      store.setCanRestart(false);
      store.setMessage(error instanceof Error ? error.message : "更新下载失败");
    }
  };

  const handleRestart = async () => {
    try {
      await restartApp();
    } catch (error) {
      addLog(error instanceof Error ? error.message : "重启失败", "error");
    }
  };

  const [activeTab, setActiveTab] = useState<"accounts" | "download" | "preferences" | "about">("accounts");

  const TABS = [
    { id: "accounts", label: "账号管理", icon: Key },
    { id: "download", label: "下载配置", icon: FolderOpen },
    { id: "preferences", label: "外观偏好", icon: Palette },
    { id: "about", label: "关于更新", icon: Info },
  ] as const;

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
      className="mx-auto w-full max-w-[860px] p-4 lg:p-6"
    >
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-[1.25rem] font-bold text-text">设置</h1>
          <p className="text-[0.75rem] text-text-muted mt-0.5">
            修改将自动保存并立即生效
          </p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-6">
        {/* Navigation Sidebar */}
        <div className="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible shrink-0 pb-2 md:pb-0 md:w-[180px] border-b md:border-b-0 md:border-r border-white/[0.06]">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "relative flex items-center gap-2.5 px-3 py-2 rounded-[8px] text-[0.8rem] font-medium transition-all cursor-pointer whitespace-nowrap",
                  isActive ? "text-accent font-semibold" : "text-text-muted hover:text-text hover:bg-white/[0.03]"
                )}
              >
                {isActive && (
                  <motion.div
                    layoutId="active-tab-bg"
                    className="absolute inset-0 bg-accent/10 rounded-[8px]"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
                <Icon className={cn("w-4 h-4 shrink-0", isActive ? "text-accent" : "text-text-muted")} />
                <span className="relative z-10">{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Tab Contents */}
        <div className="flex-1 min-w-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={activeTab}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="space-y-4"
            >
              {activeTab === "accounts" && (
                <div className="space-y-4">
                  {/* Multi Accounts List */}
                  <SettingGroup icon={Key} label="已登录账号">
                    {accounts.length > 0 ? (
                      <div className="grid gap-2">
                        {accounts.map((acc) => {
                          const isActive = acc.sec_uid === currentSecUid;
                          const isExpired = acc.is_valid === false;
                          return (
                            <div
                              key={acc.sec_uid}
                              className={cn(
                                "flex items-center gap-3 p-3 rounded-[10px] transition-all duration-200 border",
                                isActive
                                  ? "bg-accent/[0.04] border-accent/20 shadow-[0_0_12px_rgba(254,44,85,0.02)]"
                                  : "bg-white/[0.02] border-white/[0.04] hover:bg-white/[0.04]"
                              )}
                            >
                              <img
                                src={acc.avatar_thumb || "/default-avatar.svg"}
                                alt={acc.nickname}
                                className="w-8 h-8 rounded-full border border-white/10 object-cover"
                              />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-[0.78rem] font-semibold text-text truncate">{acc.nickname}</span>
                                  {isActive && (
                                    <span className="px-1.5 py-0.5 rounded-[4px] bg-accent/15 text-accent text-[0.58rem] font-bold">
                                      当前激活
                                    </span>
                                  )}
                                  {isExpired && (
                                    <span className="px-1.5 py-0.5 rounded-[4px] bg-danger/15 text-danger text-[0.58rem] font-bold">
                                      已失效
                                    </span>
                                  )}
                                </div>
                                <span className="text-[0.62rem] text-text-muted truncate block font-mono">
                                  ID: {acc.sec_uid.substring(0, 15)}...
                                </span>
                              </div>
                              <div className="flex items-center gap-1">
                                {isExpired ? (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => startLogin(acc.cookie)}
                                    className="h-7 rounded-[6px] text-[0.72rem] font-semibold px-2 hover:bg-danger/10 hover:text-danger text-danger cursor-pointer animate-pulse"
                                  >
                                    重新登录
                                  </Button>
                                ) : (
                                  !isActive && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={async () => {
                                        try {
                                          const res = await switchAccount(acc.sec_uid);
                                          if (res.success) {
                                            toast.success(`已切换为: ${res.nickname}`, "切换成功");
                                            await loadAccounts();
                                            await initClient().catch(() => {});
                                          } else {
                                            toast.error(res.message, "切换失败");
                                          }
                                        } catch (e) {
                                          toast.error(e instanceof Error ? e.message : "切换失败", "错误");
                                        }
                                      }}
                                      className="h-7 rounded-[6px] text-[0.72rem] font-semibold px-2 hover:bg-accent/10 hover:text-accent cursor-pointer"
                                    >
                                      切换
                                    </Button>
                                  )
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => {
                                    showAlert({
                                      title: "注销并删除账号",
                                      variant: "danger",
                                      description: `确定要注销并删除账号「${acc.nickname}」吗？`,
                                      actionLabel: "确定注销",
                                      cancelLabel: "取消",
                                      onAction: async () => {
                                        try {
                                          const res = await deleteAccount(acc.sec_uid);
                                          if (res.success) {
                                            toast.success("账号已删除", "注销成功");
                                            await loadAccounts();
                                            await initClient().catch(() => {});
                                          } else {
                                            toast.error(res.message, "注销失败");
                                          }
                                        } catch (e) {
                                          toast.error(e instanceof Error ? e.message : "删除失败", "错误");
                                        }
                                      }
                                    });
                                  }}
                                  className="w-7 h-7 rounded-[6px] text-text-muted hover:text-danger hover:bg-danger/10 cursor-pointer"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[0.75rem] text-text-muted text-center py-4 bg-white/[0.01] rounded-[10px] border border-dashed border-white/[0.04]">
                        暂无已登录账号，请在下方添加
                      </p>
                    )}
                  </SettingGroup>

                  {/* Add Account Area */}
                  <SettingGroup icon={Globe} label="添加账号">
                    {loginStatus === "idle" ? (
                      <div className="space-y-3">
                        <div className="flex items-center gap-3">
                          <p className="text-[0.72rem] font-semibold uppercase tracking-wider text-text-muted">
                            扫码/网页登录浏览器类型
                          </p>
                          <Select value={browserType} onValueChange={setBrowserType}>
                            <SelectTrigger className="h-8 rounded-[8px] text-[0.74rem] w-[140px] ml-auto">
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
                          onClick={() => startLogin()}
                          className="w-full h-9 rounded-[8px] text-[0.78rem] font-bold gap-1.5 cursor-pointer"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          打开内置窗口登录
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-[10px] bg-white/[0.02] border border-white/[0.04] p-3">
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0",
                              (loginStatus === "starting" || loginStatus === "waiting") && "bg-info/10",
                              loginStatus === "success" && "bg-success/10",
                              loginStatus === "error" && "bg-danger/10",
                              loginStatus === "cancelled" && "bg-white/[0.06]"
                            )}
                          >
                            {(loginStatus === "starting" || loginStatus === "waiting") && (
                              <Loader2 className="w-4 h-4 text-info animate-spin" />
                            )}
                            {loginStatus === "success" && (
                              <CheckCircle2 className="w-4 h-4 text-success" />
                            )}
                            {loginStatus === "error" && (
                              <XCircle className="w-4 h-4 text-danger" />
                            )}
                            {loginStatus === "cancelled" && (
                              <X className="w-4 h-4 text-text-muted" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[0.78rem] font-semibold text-text">
                              {loginStatus === "starting" && "正在启动..."}
                              {loginStatus === "waiting" && "等待登录"}
                              {loginStatus === "success" && "登录成功"}
                              {loginStatus === "error" && "登录失败"}
                              {loginStatus === "cancelled" && "已取消"}
                            </p>
                            <p className="text-[0.7rem] text-text-muted truncate mt-0.5">
                              {loginMessage}
                            </p>
                          </div>
                        </div>

                        {loginStatus === "waiting" && countdown > 0 && (
                          <div className="flex items-center justify-between px-2.5 py-1.5 rounded-[8px] bg-white/[0.04] my-2 text-[0.7rem]">
                            <span className="text-text-muted">剩余时间</span>
                            <span className="font-mono font-semibold text-text tabular-nums">
                              {formatCountdown(countdown)}
                            </span>
                          </div>
                        )}

                        <div className="flex gap-2 mt-3">
                          {(loginStatus === "starting" || loginStatus === "waiting") && (
                            <Button
                              variant="outline"
                              onClick={handleCancel}
                              className="flex-1 h-8 rounded-[8px] text-[0.74rem] text-danger hover:text-danger cursor-pointer"
                            >
                              取消
                            </Button>
                          )}
                          {(loginStatus === "success" || loginStatus === "error" || loginStatus === "cancelled") && (
                            <Button
                              variant="outline"
                              onClick={resetLogin}
                              className="flex-1 h-8 rounded-[8px] text-[0.74rem] cursor-pointer"
                            >
                              {loginStatus === "success" ? "完成" : "重试"}
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                  </SettingGroup>

                  {/* Manual cookie input */}
                  {loginStatus === "idle" && (
                    <SettingGroup icon={Key} label="手动录入 Cookie">
                      <div className="space-y-3">
                        <Textarea
                          value={cookieValue}
                          onChange={(e) => setCookieValue(e.target.value)}
                          onBlur={handleValidateCookie}
                          placeholder="从浏览器开发者工具复制抖音 Cookie并在此粘贴..."
                          rows={2.5}
                          className="text-[0.76rem] font-mono leading-relaxed placeholder:text-[0.74rem]"
                        />
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            {savingCookie ? (
                              <p className="text-[0.68rem] text-info flex items-center gap-1">
                                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在校验并登录...
                              </p>
                            ) : cookieInputStatus === "valid" ? (
                              <p className="text-[0.68rem] text-success flex items-center gap-1 font-semibold">
                                <CheckCircle2 className="w-3.5 h-3.5" /> 格式校验通过
                              </p>
                            ) : cookieInputStatus === "invalid" ? (
                              <p className="text-[0.68rem] text-danger flex items-center gap-1">
                                <XCircle className="w-3.5 h-3.5" /> 需包含必要参数 sessionid
                              </p>
                            ) : null}
                          </div>
                          
                          <Button
                            onClick={() => void handleSaveCookie(cookieValue)}
                            disabled={savingCookie || !cookieValue.trim() || cookieInputStatus === "invalid"}
                            className="h-8.5 rounded-[8px] text-[0.76rem] font-bold px-4 cursor-pointer shrink-0"
                          >
                            确认添加
                          </Button>
                        </div>
                        {loginMessage && (
                          <p className="text-[0.68rem] text-text-muted mt-1 leading-relaxed bg-white/[0.02] p-2 rounded-[6px] border border-white/[0.04]">
                            {loginMessage}
                          </p>
                        )}
                      </div>
                    </SettingGroup>
                  )}
                </div>
              )}

              {activeTab === "download" && (
                <div className="space-y-4">
                  {/* Download Dir */}
                  <SettingGroup icon={FolderOpen} label="下载目录" status={fieldStatus("download_path")}>
                    <div className="flex gap-2">
                      <Input
                        value={downloadPath}
                        onChange={(event) => setDownloadPath(event.target.value)}
                        placeholder="选择或输入下载路径"
                        className="h-9 text-[0.78rem]"
                      />
                      <Button
                        variant="secondary"
                        onClick={handleChooseDirectory}
                        disabled={choosingDirectory}
                        className="h-9 rounded-[8px] text-[0.76rem] px-3 shrink-0 cursor-pointer"
                      >
                        {choosingDirectory ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          "选择"
                        )}
                      </Button>
                    </div>
                  </SettingGroup>

                  {/* Folder Rule */}
                  <SettingGroup icon={FolderTree} label="作者目录规则" status={fieldStatus("folder_name_template") || fieldStatus("auto_create_folder")}>
                    <div className="space-y-2">
                      <button
                        type="button"
                        onClick={() => void handleAutoCreateFolderChange(!autoCreateFolder)}
                        disabled={savingFields.auto_create_folder}
                        className={cn(
                          "flex h-8 w-full items-center justify-between rounded-[8px] border px-2.5 transition-[background-color,border-color,opacity]",
                          autoCreateFolder
                            ? "border-accent/25 bg-accent/5"
                            : "border-border bg-white/[0.01]",
                          savingFields.auto_create_folder && "opacity-70"
                        )}
                      >
                        <span className="text-[0.76rem] font-semibold text-text">按目录归档</span>
                        <span
                          className={cn(
                            "relative h-4.5 w-8.5 rounded-full transition-colors",
                            autoCreateFolder ? "bg-accent" : "bg-white/[0.12]"
                          )}
                        >
                          <span
                            className={cn(
                              "absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform",
                              autoCreateFolder ? "translate-x-4.5" : "translate-x-0.5"
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
                        className="h-9 font-mono text-[0.78rem]"
                      />

                      <div className="flex flex-wrap gap-1">
                        {TEMPLATE_VARIABLES.filter((item) => item.token !== "{title}").map((item) => (
                          <button
                            key={item.token}
                            type="button"
                            onClick={() => appendFolderToken(item.token)}
                            disabled={!autoCreateFolder || savingFields.folder_name_template}
                            className="inline-flex h-6 items-center rounded-[6px] border border-border bg-white/[0.01] px-1.5 font-mono text-[0.65rem] text-text-secondary transition-all hover:border-accent/30 hover:bg-accent/10 hover:text-accent disabled:opacity-50"
                            title={item.label}
                          >
                            {item.token}
                          </button>
                        ))}
                      </div>
                    </div>
                  </SettingGroup>

                  {/* File naming */}
                  <SettingGroup icon={FileText} label="文件命名规则" status={fieldStatus("filename_template")}>
                    <div className="space-y-2">
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
                        placeholder="{title}_{aweme_id}"
                        className="h-9 font-mono text-[0.78rem]"
                      />

                      <div className="flex flex-wrap gap-1">
                        {TEMPLATE_VARIABLES.map((item) => (
                          <button
                            key={item.token}
                            type="button"
                            onClick={() => appendFilenameToken(item.token)}
                            disabled={savingFields.filename_template}
                            className="inline-flex h-6 items-center rounded-[6px] border border-border bg-white/[0.01] px-1.5 font-mono text-[0.65rem] text-text-secondary transition-all hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
                            title={item.label}
                          >
                            {item.token}
                          </button>
                        ))}
                      </div>
                    </div>
                  </SettingGroup>

                  {/* Quality and concurrency */}
                  <div className="grid grid-cols-2 gap-3">
                    <SettingGroup icon={Gauge} label="下载质量" status={fieldStatus("download_quality")}>
                      <Select value={downloadQuality} onValueChange={(value) => void handleQualityChange(value)}>
                        <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]" disabled={savingFields.download_quality}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="auto">自动</SelectItem>
                          <SelectItem value="highest">最高质量</SelectItem>
                          <SelectItem value="h264">兼容优先 (H.264)</SelectItem>
                          <SelectItem value="4k">4K</SelectItem>
                          <SelectItem value="2k">2K</SelectItem>
                          <SelectItem value="1080p">1080P</SelectItem>
                          <SelectItem value="720p">720P</SelectItem>
                          <SelectItem value="480p">480P</SelectItem>
                          <SelectItem value="smallest">最小体积</SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingGroup>

                    <SettingGroup icon={Zap} label="并发数" status={fieldStatus("max_concurrent")}>
                      <Select value={maxConcurrent} onValueChange={(value) => void handleMaxConcurrentChange(value)}>
                        <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]" disabled={savingFields.max_concurrent}>
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
                </div>
              )}

              {activeTab === "preferences" && (
                <div className="space-y-4">
                  {/* Theme */}
                  <SettingGroup icon={Palette} label="外观主题" status={fieldStatus("theme")}>
                    <div className="flex gap-1 p-1 rounded-[10px] bg-white/[0.02] border border-white/[0.04]">
                      {(
                        [
                          { value: "light", icon: Sun, label: "亮色" },
                          { value: "dark", icon: Moon, label: "暗色" },
                          { value: "auto", icon: Monitor, label: "系统" },
                        ] as const
                      ).map(({ value, icon: Icon, label }) => (
                        <button
                          key={value}
                          onClick={() => void handleThemeChange(value as ThemeMode)}
                          disabled={savingFields.theme}
                          className={cn(
                            "relative flex-1 flex items-center justify-center gap-1.5 h-8.5 rounded-[8px] text-[0.78rem] font-semibold transition-all duration-200 cursor-pointer",
                            savingFields.theme && "cursor-wait opacity-75",
                            theme === value
                              ? "text-text"
                              : "text-text-muted hover:text-text-secondary"
                          )}
                        >
                          {theme === value && (
                            <motion.div
                              layoutId="theme-tab-bg"
                              className="absolute inset-0 rounded-[8px] bg-accent/[0.1] shadow-[0_0_12px_rgba(254,44,85,0.04)]"
                              transition={{ type: "spring", stiffness: 400, damping: 30 }}
                            />
                          )}
                          <Icon className="relative w-3.5 h-3.5" />
                          <span className="relative">{label}</span>
                        </button>
                      ))}
                    </div>
                  </SettingGroup>
                </div>
              )}

              {activeTab === "about" && (
                <div className="space-y-4">
                  <SettingGroup icon={Info} label="关于">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between py-2 px-3 rounded-[8px] bg-white/[0.02] border border-white/[0.04]">
                        <span className="text-[0.78rem] text-text-muted">当前版本</span>
                        <span className="text-[0.78rem] text-text font-mono font-semibold">
                          {appVersion ? `v${appVersion}` : "读取中"}
                        </span>
                      </div>
                      
                      {updateMessage && (
                        <div
                          className={cn(
                            "rounded-[8px] border px-3 py-1.5 text-[0.72rem]",
                            updateStatus === "error"
                              ? "border-white/[0.06] bg-danger-soft text-danger"
                              : updateStatus === "available"
                                ? "border-info/20 bg-info/10 text-info"
                                : updateStatus === "ready"
                                  ? "border-success/20 bg-success-soft text-success"
                                  : "border-border bg-white/[0.02] text-text-muted"
                          )}
                        >
                          {updateMessage}
                        </div>
                      )}

                      {updateInfo?.notes && (
                        <div className="max-h-[140px] overflow-y-auto rounded-[8px] border border-border bg-white/[0.01] p-2.5 text-[0.7rem] leading-relaxed text-text-secondary whitespace-pre-wrap font-mono">
                          {updateInfo.notes}
                        </div>
                      )}

                      {updateInfo?.asset_name && updateStatus === "available" && (
                        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-white/[0.02] px-3 py-1.5 text-[0.7rem] text-text-muted">
                          <span className="min-w-0 truncate">{updateInfo.asset_name}</span>
                          {formatBytes(updateInfo.asset_size) && (
                            <span className="shrink-0 font-mono">{formatBytes(updateInfo.asset_size)}</span>
                          )}
                        </div>
                      )}

                      {updateStatus === "downloading" && (
                        <div className="rounded-[8px] bg-white/[0.02] border border-white/[0.04] p-3">
                          <div className="mb-1 flex items-center justify-between text-[0.68rem] text-text-muted">
                            <span>正在下载更新文件</span>
                            <span className="font-mono">{Math.round(updateProgress)}%</span>
                          </div>
                          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.08]">
                            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${updateProgress}%` }} />
                          </div>
                        </div>
                      )}

                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          onClick={handleCheckUpdate}
                          disabled={updateStatus === "checking" || updateStatus === "downloading"}
                          className="flex-1 h-9 rounded-[8px] text-[0.76rem] gap-1 cursor-pointer"
                        >
                          <RefreshCw className={cn("w-3.5 h-3.5", updateStatus === "checking" && "animate-spin")} />
                          {updateStatus === "checking" ? "检查中" : "检查新版本"}
                        </Button>
                        
                        {updateStatus === "available" && (
                          <Button
                            variant="default"
                            onClick={handleDownloadUpdate}
                            className="flex-1 h-9 rounded-[8px] text-[0.76rem] gap-1 cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            下载安装更新
                          </Button>
                        )}

                        {updateStatus === "ready" && updateCanRestart && (
                          <Button
                            variant="default"
                            onClick={handleRestart}
                            className="flex-1 h-9 rounded-[8px] text-[0.76rem] gap-1 cursor-pointer"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                            立即重启升级
                          </Button>
                        )}
                      </div>
                    </div>
                  </SettingGroup>

                  <SettingGroup icon={Users} label="交流与支持">
                    <div className="space-y-4">
                      {/* GitHub Star Card */}
                      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-[12px] bg-white/[0.02] border border-white/[0.04] backdrop-blur-xl">
                        <div className="flex items-start gap-3">
                          <div className="w-10 h-10 rounded-[12px] bg-white/[0.04] flex items-center justify-center shrink-0 border border-white/[0.05]">
                            <svg className="w-5.5 h-5.5 text-text" viewBox="0 0 24 24" fill="currentColor">
                              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482C19.138 20.193 22 16.44 22 12.017 22 6.484 17.522 2 12 2z" />
                            </svg>
                          </div>
                          <div>
                            <div className="text-[0.82rem] font-bold text-text">喜欢这个项目吗？</div>
                            <div className="text-[0.72rem] text-text-secondary mt-0.5 leading-relaxed">
                              这个项目花费了作者大量的时间和精力。如果它帮到了你，欢迎去 GitHub 点个 Star 支持作者继续走下去！
                            </div>
                          </div>
                        </div>
                        <a
                          href="https://github.com/anYuJia/better-douyin"
                          target="_blank"
                          rel="noreferrer"
                          className="w-full sm:w-auto shrink-0 group relative flex h-8.5 items-center justify-center rounded-[8px] bg-accent px-4 text-[0.74rem] font-black text-white shadow-lg shadow-accent/20 active:scale-[0.96] transition-[background-color,color,box-shadow,transform,opacity]"
                        >
                          <span className="relative z-10">去 GitHub 点 Star</span>
                          <div className="absolute inset-0 rounded-[8px] bg-white opacity-0 group-hover:opacity-10 transition-opacity" />
                        </a>
                      </div>

                      {/* QQ Group Card */}
                      <div className="flex flex-col md:flex-row items-center gap-5 p-4 rounded-[12px] bg-white/[0.02] border border-white/[0.04] backdrop-blur-xl">
                        <div className="flex-1 min-w-0">
                          <div className="text-[0.82rem] font-bold text-text">官方交流群</div>
                          <div className="text-[0.72rem] text-text-secondary mt-1.5 leading-relaxed">
                            欢迎加入官方交流群，与其他用户以及作者一起交流、反馈建议或分享使用心得。
                          </div>
                          <div className="mt-3.5 flex flex-col gap-2">
                            <div className="flex items-center justify-between py-2 px-3 rounded-[8px] bg-white/[0.01] border border-white/[0.03]">
                              <span className="text-[0.74rem] text-text-muted">QQ 群号</span>
                              <span className="text-[0.78rem] text-text font-mono font-bold select-all">438407379</span>
                            </div>
                          </div>
                        </div>
                        <div className="w-[180px] rounded-[10px] bg-white p-1 flex items-center justify-center shrink-0 shadow-lg border border-white/10">
                          <img
                            src="/qq-group.jpg"
                            alt="QQ群二维码"
                            className="w-full h-auto object-contain rounded-[6px]"
                          />
                        </div>
                      </div>
                    </div>
                  </SettingGroup>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

