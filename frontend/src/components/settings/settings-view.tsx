import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore, useLogStore, useAlertStore, useUpdateStore } from "@/stores/app-store";
import { useToast } from "@/components/ui/toast";
import { motion, AnimatePresence } from "framer-motion";
import { Palette, Key, FolderOpen, Info, Sparkles } from "lucide-react";
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
  suggestAiInteraction,
  verifyCookie,
  getAccounts,
  switchAccount,
  deleteAccount,
  addAccount,
} from "@/lib/tauri";
import type { AccountInfo } from "@/lib/tauri";
import type { AiProviderPreset } from "@/lib/contracts";
import type { ThemeMode, FontSizeMode } from "@/types";
import type {
  LoginStatus,
  SavingFields,
  SettingsField,
  SettingsPatch,
  SettingStatus,
} from "./settings-utils";
import { AccountListSection, LoginSection, CookieInputSection } from "./settings-account";
import { SettingsDownloadTab } from "./settings-download";
import { SettingsAppearanceTab } from "./settings-appearance";
import { SettingsAboutTab } from "./settings-about";
import { SettingGroup } from "./settings-components";
import { SettingsAiTab } from "./settings-ai";

export function SettingsView() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const fontSize = useAppStore((s) => s.fontSize);
  const setFontSize = useAppStore((s) => s.setFontSize);
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
  const [downloadLivePhotoVideo, setDownloadLivePhotoVideo] = useState(true);
  const [downloadLivePhotoImage, setDownloadLivePhotoImage] = useState(true);
  const [maxConcurrent, setMaxConcurrent] = useState("3");
  const [filenameTemplate, setFilenameTemplate] = useState("{title}_{aweme_id}");
  const [folderNameTemplate, setFolderNameTemplate] = useState("{author}");
  const [autoCreateFolder, setAutoCreateFolder] = useState(true);
  const [sslVerify, setSslVerify] = useState(true);
  const [updateProxy, setUpdateProxy] = useState("");
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiProvider, setAiProvider] = useState("openai");
  const [aiProviderPresets, setAiProviderPresets] = useState<AiProviderPreset[]>([]);
  const [aiApiBase, setAiApiBase] = useState("https://api.openai.com/v1");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiApiKeySet, setAiApiKeySet] = useState(false);
  const [aiModel, setAiModel] = useState("gpt-4o-mini");
  const [aiSystemPrompt, setAiSystemPrompt] = useState("");
  const [aiAutoSendComments, setAiAutoSendComments] = useState(false);
  const [aiAutoSendPrivateMessages, setAiAutoSendPrivateMessages] = useState(false);
  const [aiAutoLike, setAiAutoLike] = useState(false);
  const [aiAutoCollect, setAiAutoCollect] = useState(false);
  const [aiAutoSendDelayMs, setAiAutoSendDelayMs] = useState("0");
  const [aiAutoSendMaxChars, setAiAutoSendMaxChars] = useState("180");
  const [aiAutoRequireContext, setAiAutoRequireContext] = useState(true);
  const [aiAutoMonitorNotices, setAiAutoMonitorNotices] = useState(false);
  const [aiAutoMonitorFriends, setAiAutoMonitorFriends] = useState(false);
  const [aiAutoMonitorComments, setAiAutoMonitorComments] = useState(false);
  const [aiAutoMonitorFeed, setAiAutoMonitorFeed] = useState(false);
  const [aiAutoMatchKeywords, setAiAutoMatchKeywords] = useState("");
  const [aiAutoExcludeKeywords, setAiAutoExcludeKeywords] = useState("");
  const [aiAutoMinDiggCount, setAiAutoMinDiggCount] = useState("0");
  const [aiAutoMinCommentCount, setAiAutoMinCommentCount] = useState("0");
  const [aiAutoMinPlayCount, setAiAutoMinPlayCount] = useState("0");
  const [aiAutoScanIntervalSeconds, setAiAutoScanIntervalSeconds] = useState("30");
  const [aiAutoMaxActionsPerRun, setAiAutoMaxActionsPerRun] = useState("5");
  const [savingProxy, setSavingProxy] = useState(false);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const [savingFields, setSavingFields] = useState<SavingFields>({});
  const [savedFields, setSavedFields] = useState<SavingFields>({});
  const [failedFields, setFailedFields] = useState<SavingFields>({});
  const [aiTestStatus, setAiTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [aiTestMessage, setAiTestMessage] = useState("");
  const statusTimersRef = useRef<Partial<Record<SettingsField, ReturnType<typeof setTimeout>>>>({});
  const savedSettingsRef = useRef({
    downloadPath: "",
    downloadQuality: "auto",
    downloadLivePhotoVideo: true,
    downloadLivePhotoImage: true,
    maxConcurrent: "3",
    filenameTemplate: "{title}_{aweme_id}",
    folderNameTemplate: "{author}",
    autoCreateFolder: true,
    sslVerify: true,
    updateProxy: "",
    aiEnabled: false,
    aiProvider: "openai",
    aiApiBase: "https://api.openai.com/v1",
    aiApiKeySet: false,
    aiModel: "gpt-4o-mini",
    aiSystemPrompt: "",
    aiAutoSendComments: false,
    aiAutoSendPrivateMessages: false,
    aiAutoLike: false,
    aiAutoCollect: false,
    aiAutoSendDelayMs: "0",
    aiAutoSendMaxChars: "180",
    aiAutoRequireContext: true,
    aiAutoMonitorNotices: false,
    aiAutoMonitorFriends: false,
    aiAutoMonitorComments: false,
    aiAutoMonitorFeed: false,
    aiAutoMatchKeywords: "",
    aiAutoExcludeKeywords: "",
    aiAutoPrivateMatchKeywords: "",
    aiAutoPrivateExcludeKeywords: "",
    aiAutoCommentMatchKeywords: "",
    aiAutoCommentExcludeKeywords: "",
    aiAutoLikeMatchKeywords: "",
    aiAutoLikeExcludeKeywords: "",
    aiAutoCollectMatchKeywords: "",
    aiAutoCollectExcludeKeywords: "",
    aiAutoMinDiggCount: "0",
    aiAutoMinCommentCount: "0",
    aiAutoMinPlayCount: "0",
    aiAutoScanIntervalSeconds: "30",
    aiAutoMaxActionsPerRun: "5",
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
        const nextDownloadLivePhotoVideo = config.download_live_photo_video ?? true;
        const nextDownloadLivePhotoImage = config.download_live_photo_image ?? true;
        const nextMaxConcurrent = String(config.max_concurrent || 3);
        const nextFilenameTemplate = config.filename_template || "{title}_{aweme_id}";
        const nextFolderNameTemplate = config.folder_name_template || "{author}";
        const nextAutoCreateFolder = config.auto_create_folder ?? true;
        const nextSslVerify = config.ssl_verify ?? true;
        const nextUpdateProxy = config.proxy || "";
        const nextAi = config.ai_interaction || {
          enabled: false,
          provider: "openai",
          api_base: "https://api.openai.com/v1",
          api_key_set: false,
          model: "gpt-4o-mini",
          system_prompt: "",
          provider_presets: [],
          auto_send_comments: false,
          auto_send_private_messages: false,
          auto_like: false,
          auto_collect: false,
          auto_send_delay_ms: 0,
          auto_send_max_chars: 180,
          auto_require_context: true,
          auto_monitor_notices: false,
          auto_monitor_friends: false,
          auto_monitor_comments: false,
          auto_monitor_feed: false,
          auto_match_keywords: "",
          auto_exclude_keywords: "",
          auto_private_match_keywords: "",
          auto_private_exclude_keywords: "",
          auto_comment_match_keywords: "",
          auto_comment_exclude_keywords: "",
          auto_like_match_keywords: "",
          auto_like_exclude_keywords: "",
          auto_collect_match_keywords: "",
          auto_collect_exclude_keywords: "",
          auto_min_digg_count: 0,
          auto_min_comment_count: 0,
          auto_min_play_count: 0,
          auto_scan_interval_seconds: 30,
          auto_max_actions_per_run: 5,
        };
        setDownloadPath(nextDownloadPath);
        setDownloadQuality(nextDownloadQuality);
        setDownloadLivePhotoVideo(nextDownloadLivePhotoVideo);
        setDownloadLivePhotoImage(nextDownloadLivePhotoImage);
        setMaxConcurrent(nextMaxConcurrent);
        setFilenameTemplate(nextFilenameTemplate);
        setFolderNameTemplate(nextFolderNameTemplate);
        setAutoCreateFolder(nextAutoCreateFolder);
        setSslVerify(nextSslVerify);
        setUpdateProxy(nextUpdateProxy);
        setAiEnabled(Boolean(nextAi.enabled));
        setAiProvider(nextAi.provider || "openai");
        setAiProviderPresets(nextAi.provider_presets || []);
        setAiApiBase(nextAi.api_base || "https://api.openai.com/v1");
        setAiApiKey("");
        setAiApiKeySet(Boolean(nextAi.api_key_set));
        setAiModel(nextAi.model || "gpt-4o-mini");
        setAiSystemPrompt(nextAi.system_prompt || "");
        setAiAutoSendComments(Boolean(nextAi.auto_send_comments));
        setAiAutoSendPrivateMessages(Boolean(nextAi.auto_send_private_messages));
        setAiAutoLike(Boolean(nextAi.auto_like));
        setAiAutoCollect(Boolean(nextAi.auto_collect));
        setAiAutoSendDelayMs(String(nextAi.auto_send_delay_ms ?? 0));
        setAiAutoSendMaxChars(String(nextAi.auto_send_max_chars ?? 180));
        setAiAutoRequireContext(Boolean(nextAi.auto_require_context ?? true));
        setAiAutoMonitorNotices(Boolean(nextAi.auto_monitor_notices ?? false));
        setAiAutoMonitorFriends(Boolean(nextAi.auto_monitor_friends ?? false));
        setAiAutoMonitorComments(Boolean(nextAi.auto_monitor_comments ?? false));
        setAiAutoMonitorFeed(Boolean(nextAi.auto_monitor_feed ?? false));
        setAiAutoMatchKeywords(String(nextAi.auto_match_keywords ?? ""));
        setAiAutoExcludeKeywords(String(nextAi.auto_exclude_keywords ?? ""));
        setAiAutoMinDiggCount(String(nextAi.auto_min_digg_count ?? 0));
        setAiAutoMinCommentCount(String(nextAi.auto_min_comment_count ?? 0));
        setAiAutoMinPlayCount(String(nextAi.auto_min_play_count ?? 0));
        setAiAutoScanIntervalSeconds(String(nextAi.auto_scan_interval_seconds ?? 30));
        setAiAutoMaxActionsPerRun(String(nextAi.auto_max_actions_per_run ?? 5));
        savedSettingsRef.current = {
          ...savedSettingsRef.current,
          downloadPath: nextDownloadPath,
          downloadQuality: nextDownloadQuality,
          downloadLivePhotoVideo: nextDownloadLivePhotoVideo,
          downloadLivePhotoImage: nextDownloadLivePhotoImage,
          maxConcurrent: nextMaxConcurrent,
          filenameTemplate: nextFilenameTemplate,
          folderNameTemplate: nextFolderNameTemplate,
          autoCreateFolder: nextAutoCreateFolder,
          sslVerify: nextSslVerify,
          updateProxy: nextUpdateProxy,
          aiEnabled: Boolean(nextAi.enabled),
          aiProvider: nextAi.provider || "openai",
          aiApiBase: nextAi.api_base || "https://api.openai.com/v1",
          aiApiKeySet: Boolean(nextAi.api_key_set),
          aiModel: nextAi.model || "gpt-4o-mini",
          aiSystemPrompt: nextAi.system_prompt || "",
          aiAutoSendComments: Boolean(nextAi.auto_send_comments),
          aiAutoSendPrivateMessages: Boolean(nextAi.auto_send_private_messages),
          aiAutoLike: Boolean(nextAi.auto_like),
          aiAutoCollect: Boolean(nextAi.auto_collect),
          aiAutoSendDelayMs: String(nextAi.auto_send_delay_ms ?? 0),
          aiAutoSendMaxChars: String(nextAi.auto_send_max_chars ?? 180),
          aiAutoRequireContext: Boolean(nextAi.auto_require_context ?? true),
          aiAutoMonitorNotices: Boolean(nextAi.auto_monitor_notices ?? false),
          aiAutoMonitorFriends: Boolean(nextAi.auto_monitor_friends ?? false),
          aiAutoMonitorComments: Boolean(nextAi.auto_monitor_comments ?? false),
          aiAutoMonitorFeed: Boolean(nextAi.auto_monitor_feed ?? false),
          aiAutoMatchKeywords: String(nextAi.auto_match_keywords ?? ""),
          aiAutoExcludeKeywords: String(nextAi.auto_exclude_keywords ?? ""),
          aiAutoPrivateMatchKeywords: String(nextAi.auto_private_match_keywords ?? ""),
          aiAutoPrivateExcludeKeywords: String(nextAi.auto_private_exclude_keywords ?? ""),
          aiAutoCommentMatchKeywords: String(nextAi.auto_comment_match_keywords ?? ""),
          aiAutoCommentExcludeKeywords: String(nextAi.auto_comment_exclude_keywords ?? ""),
          aiAutoLikeMatchKeywords: String(nextAi.auto_like_match_keywords ?? ""),
          aiAutoLikeExcludeKeywords: String(nextAi.auto_like_exclude_keywords ?? ""),
          aiAutoCollectMatchKeywords: String(nextAi.auto_collect_match_keywords ?? ""),
          aiAutoCollectExcludeKeywords: String(nextAi.auto_collect_exclude_keywords ?? ""),
          aiAutoMinDiggCount: String(nextAi.auto_min_digg_count ?? 0),
          aiAutoMinCommentCount: String(nextAi.auto_min_comment_count ?? 0),
          aiAutoMinPlayCount: String(nextAi.auto_min_play_count ?? 0),
          aiAutoScanIntervalSeconds: String(nextAi.auto_scan_interval_seconds ?? 30),
          aiAutoMaxActionsPerRun: String(nextAi.auto_max_actions_per_run ?? 5),
        };
        if (config.cookie_set) {
          verifyCookie()
            .then((status) => {
              if (disposed) return;
              setCookieLoggedIn(status.valid, status.user_name || undefined, status.sec_uid || status.user_id || undefined);
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
                  setCookieLoggedIn(status.valid, status.user_name || undefined, status.sec_uid || status.user_id || undefined);
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

  const handleFontSizeChange = async (value: FontSizeMode) => {
    setFontSize(value);
    reportSettingSaved("font_size", "字体大小已保存");
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

  const handleLivePhotoContentChange = async (kind: "video" | "image", value: boolean) => {
    const previousVideo = savedSettingsRef.current.downloadLivePhotoVideo;
    const previousImage = savedSettingsRef.current.downloadLivePhotoImage;
    let nextVideo = kind === "video" ? value : downloadLivePhotoVideo;
    let nextImage = kind === "image" ? value : downloadLivePhotoImage;
    if (!nextVideo && !nextImage) nextVideo = true;

    setDownloadLivePhotoVideo(nextVideo);
    setDownloadLivePhotoImage(nextImage);

    const field = kind === "video" ? "download_live_photo_video" : "download_live_photo_image";
    if (
      (nextVideo === previousVideo && nextImage === previousImage) ||
      savingFields.download_live_photo_video ||
      savingFields.download_live_photo_image
    ) {
      return;
    }

    const saved = await saveSetting(
      field,
      { download_live_photo_video: nextVideo, download_live_photo_image: nextImage },
      "实况图下载内容已保存"
    );
    if (saved) {
      savedSettingsRef.current.downloadLivePhotoVideo = nextVideo;
      savedSettingsRef.current.downloadLivePhotoImage = nextImage;
    } else {
      setDownloadLivePhotoVideo(previousVideo);
      setDownloadLivePhotoImage(previousImage);
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

  const handleSslVerifyChange = async (value: boolean) => {
    const previousValue = savedSettingsRef.current.sslVerify;
    setSslVerify(value);
    if (value === previousValue || savingFields.ssl_verify) return;

    const saved = await saveSetting(
      "ssl_verify",
      { ssl_verify: value },
      value ? "SSL 证书校验已开启" : "SSL 证书校验已关闭",
      value ? "SSL 证书校验已开启" : "SSL 证书校验已关闭"
    );
    if (saved) {
      savedSettingsRef.current.sslVerify = value;
    } else {
      setSslVerify(previousValue);
    }
  };

  const handleSaveAiInteraction = async () => {
    const trimmedApiKey = aiApiKey.trim();
    const nextAi = {
      enabled: aiEnabled,
      provider: aiProvider,
      api_base: aiApiBase.trim() || "https://api.openai.com/v1",
      api_key: trimmedApiKey || undefined,
      api_key_set: trimmedApiKey ? true : aiApiKeySet,
      model: aiModel.trim() || "gpt-4o-mini",
      system_prompt: aiSystemPrompt.trim(),
      auto_send_comments: aiAutoSendComments,
      auto_send_private_messages: aiAutoSendPrivateMessages,
      auto_like: aiAutoLike,
      auto_collect: aiAutoCollect,
      auto_send_delay_ms: Math.max(0, Math.min(10000, Number(aiAutoSendDelayMs || 0))),
      auto_send_max_chars: Math.max(20, Math.min(500, Number(aiAutoSendMaxChars || 180))),
      auto_require_context: aiAutoRequireContext,
      auto_monitor_notices: aiAutoMonitorNotices,
      auto_monitor_friends: aiAutoMonitorFriends,
      auto_monitor_comments: aiAutoMonitorComments,
      auto_monitor_feed: aiAutoMonitorFeed,
      auto_match_keywords: aiAutoMatchKeywords.trim(),
      auto_exclude_keywords: aiAutoExcludeKeywords.trim(),
      auto_private_match_keywords: savedSettingsRef.current.aiAutoPrivateMatchKeywords,
      auto_private_exclude_keywords: savedSettingsRef.current.aiAutoPrivateExcludeKeywords,
      auto_comment_match_keywords: savedSettingsRef.current.aiAutoCommentMatchKeywords,
      auto_comment_exclude_keywords: savedSettingsRef.current.aiAutoCommentExcludeKeywords,
      auto_like_match_keywords: savedSettingsRef.current.aiAutoLikeMatchKeywords,
      auto_like_exclude_keywords: savedSettingsRef.current.aiAutoLikeExcludeKeywords,
      auto_collect_match_keywords: savedSettingsRef.current.aiAutoCollectMatchKeywords,
      auto_collect_exclude_keywords: savedSettingsRef.current.aiAutoCollectExcludeKeywords,
      auto_min_digg_count: Math.max(0, Number(aiAutoMinDiggCount || 0)),
      auto_min_comment_count: Math.max(0, Number(aiAutoMinCommentCount || 0)),
      auto_min_play_count: Math.max(0, Number(aiAutoMinPlayCount || 0)),
      auto_scan_interval_seconds: Math.max(10, Math.min(300, Number(aiAutoScanIntervalSeconds || 30))),
      auto_max_actions_per_run: Math.max(1, Math.min(50, Number(aiAutoMaxActionsPerRun || 5))),
    };
    const saved = await saveSetting(
      "ai_interaction",
      { ai_interaction: nextAi },
      "AI 互动配置已保存",
      "AI 互动配置已保存：自动完成按你的开关执行",
      false
    );
    if (saved) {
      setAiProvider(nextAi.provider);
      setAiApiBase(nextAi.api_base);
      setAiModel(nextAi.model);
      setAiSystemPrompt(nextAi.system_prompt);
      setAiApiKey("");
      setAiApiKeySet(nextAi.api_key_set);
      savedSettingsRef.current.aiEnabled = nextAi.enabled;
      savedSettingsRef.current.aiProvider = nextAi.provider;
      savedSettingsRef.current.aiApiBase = nextAi.api_base;
      savedSettingsRef.current.aiApiKeySet = nextAi.api_key_set;
      savedSettingsRef.current.aiModel = nextAi.model;
      savedSettingsRef.current.aiSystemPrompt = nextAi.system_prompt;
      savedSettingsRef.current.aiAutoSendComments = nextAi.auto_send_comments;
      savedSettingsRef.current.aiAutoSendPrivateMessages = nextAi.auto_send_private_messages;
      savedSettingsRef.current.aiAutoLike = nextAi.auto_like;
      savedSettingsRef.current.aiAutoCollect = nextAi.auto_collect;
      savedSettingsRef.current.aiAutoSendDelayMs = String(nextAi.auto_send_delay_ms);
      savedSettingsRef.current.aiAutoSendMaxChars = String(nextAi.auto_send_max_chars);
      savedSettingsRef.current.aiAutoRequireContext = nextAi.auto_require_context;
      savedSettingsRef.current.aiAutoMonitorNotices = nextAi.auto_monitor_notices;
      savedSettingsRef.current.aiAutoMonitorFriends = nextAi.auto_monitor_friends;
      savedSettingsRef.current.aiAutoMonitorComments = nextAi.auto_monitor_comments;
      savedSettingsRef.current.aiAutoMonitorFeed = nextAi.auto_monitor_feed;
      savedSettingsRef.current.aiAutoMatchKeywords = nextAi.auto_match_keywords;
      savedSettingsRef.current.aiAutoExcludeKeywords = nextAi.auto_exclude_keywords;
      savedSettingsRef.current.aiAutoPrivateMatchKeywords = nextAi.auto_private_match_keywords;
      savedSettingsRef.current.aiAutoPrivateExcludeKeywords = nextAi.auto_private_exclude_keywords;
      savedSettingsRef.current.aiAutoCommentMatchKeywords = nextAi.auto_comment_match_keywords;
      savedSettingsRef.current.aiAutoCommentExcludeKeywords = nextAi.auto_comment_exclude_keywords;
      savedSettingsRef.current.aiAutoLikeMatchKeywords = nextAi.auto_like_match_keywords;
      savedSettingsRef.current.aiAutoLikeExcludeKeywords = nextAi.auto_like_exclude_keywords;
      savedSettingsRef.current.aiAutoCollectMatchKeywords = nextAi.auto_collect_match_keywords;
      savedSettingsRef.current.aiAutoCollectExcludeKeywords = nextAi.auto_collect_exclude_keywords;
      savedSettingsRef.current.aiAutoMinDiggCount = String(nextAi.auto_min_digg_count);
      savedSettingsRef.current.aiAutoMinCommentCount = String(nextAi.auto_min_comment_count);
      savedSettingsRef.current.aiAutoMinPlayCount = String(nextAi.auto_min_play_count);
      savedSettingsRef.current.aiAutoScanIntervalSeconds = String(nextAi.auto_scan_interval_seconds);
      savedSettingsRef.current.aiAutoMaxActionsPerRun = String(nextAi.auto_max_actions_per_run);
    }
    return saved;
  };

  const handleTestAiInteraction = async () => {
    setAiTestStatus("testing");
    setAiTestMessage("正在保存配置并测试模型连接...");
    try {
      const saved = await handleSaveAiInteraction();
      if (!saved) {
        throw new Error("配置保存失败，未发起测试");
      }
      const result = await suggestAiInteraction({
        target: "private_message",
        context: "这是一次配置连通性测试，请只返回一条简短中文回复。",
        incoming_text: "你好，请确认 AI 服务可用。",
        author_name: "测试用户",
        tone: "concise",
        language: "zh-CN",
        max_suggestions: 1,
      });
      const providerError = String(result.provider_error || "").trim();
      if (!result.success) {
        throw new Error(result.message || "AI 服务测试失败");
      }
      if (providerError || result.source === "fallback") {
        throw new Error(providerError || "AI 服务未返回模型结果，已降级为本地兜底");
      }
      setAiTestStatus("success");
      setAiTestMessage(`连接成功：${result.suggestions?.[0] || result.draft || "模型已返回结果"}`);
      toast.success("AI 服务连接测试通过", "测试成功");
      addLog("AI 服务连接测试通过", "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : "AI 服务测试失败";
      setAiTestStatus("error");
      setAiTestMessage(message);
      toast.error(message, "测试失败");
      addLog(`AI 服务连接测试失败：${message}`, "warning");
    }
  };

  const handleAiProviderChange = (value: string, preset?: AiProviderPreset) => {
    setAiProvider(value);
    if (preset?.api_base) setAiApiBase(preset.api_base);
    if (preset?.default_model) setAiModel(preset.default_model);
  };

  const handleSaveUpdateProxy = async (proxy: string | null) => {
    const nextProxy = (proxy || "").trim();
    const previousProxy = savedSettingsRef.current.updateProxy;
    setSavingProxy(true);
    try {
      const result = await saveConfig({ proxy: nextProxy || null });
      if (!result.success) throw new Error(result.message || "保存代理设置失败");
      savedSettingsRef.current.updateProxy = nextProxy;
      setUpdateProxy(nextProxy);
      await initClient().catch(() => {});
      toast.success(nextProxy ? "更新代理已保存" : "更新代理已清空", "已保存");
      addLog(nextProxy ? `更新代理已保存: ${nextProxy}` : "更新代理已清空", "success");
      return true;
    } catch (error) {
      setUpdateProxy(previousProxy);
      const message = error instanceof Error ? error.message : "保存代理设置失败";
      toast.error(message, "保存失败");
      addLog(message, "error");
      return false;
    } finally {
      setSavingProxy(false);
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

  const [activeTab, setActiveTab] = useState<"accounts" | "download" | "preferences" | "ai" | "about">("accounts");

  const TABS = [
    { id: "accounts", label: "账号管理", icon: Key },
    { id: "download", label: "下载配置", icon: FolderOpen },
    { id: "preferences", label: "外观偏好", icon: Palette },
    { id: "ai", label: "AI 互动", icon: Sparkles },
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
                  <AccountListSection accounts={accounts} currentSecUid={currentSecUid} startLogin={startLogin} switchAccount={async (secUid) => { try { const res = await switchAccount(secUid); if (res.success) { toast.success(`已切换为: ${res.nickname}`, "切换成功"); await loadAccounts(); await initClient().catch(() => {}); } else { toast.error(res.message, "切换失败"); } } catch (e) { toast.error(e instanceof Error ? e.message : "切换失败", "错误"); } }} deleteAccount={async (secUid) => { try { const res = await deleteAccount(secUid); if (res.success) { toast.success("Cookie 已清空", "注销成功"); await loadAccounts(); await initClient().catch(() => {}); } else { toast.error(res.message, "注销失败"); } } catch (e) { toast.error(e instanceof Error ? e.message : "删除失败", "错误"); } }} showAlert={showAlert} />
                  <LoginSection loginStatus={loginStatus} loginMessage={loginMessage} countdown={countdown} browserType={browserType} setBrowserType={setBrowserType} startLogin={() => startLogin()} handleCancel={handleCancel} resetLogin={resetLogin} />
                  {loginStatus === "idle" && (<CookieInputSection cookieValue={cookieValue} setCookieValue={setCookieValue} cookieInputStatus={cookieInputStatus} savingCookie={savingCookie} loginMessage={loginMessage} handleValidateCookie={handleValidateCookie} handleSaveCookie={handleSaveCookie} />)}
                </div>
              )}

              {activeTab === "download" && (
                <SettingsDownloadTab downloadPath={downloadPath} setDownloadPath={setDownloadPath} downloadQuality={downloadQuality} downloadLivePhotoVideo={downloadLivePhotoVideo} downloadLivePhotoImage={downloadLivePhotoImage} maxConcurrent={maxConcurrent} filenameTemplate={filenameTemplate} setFilenameTemplate={setFilenameTemplate} folderNameTemplate={folderNameTemplate} setFolderNameTemplate={setFolderNameTemplate} autoCreateFolder={autoCreateFolder} sslVerify={sslVerify} choosingDirectory={choosingDirectory} savingFields={savingFields} fieldStatus={fieldStatus} handleChooseDirectory={handleChooseDirectory} handleQualityChange={handleQualityChange} handleLivePhotoContentChange={handleLivePhotoContentChange} handleMaxConcurrentChange={handleMaxConcurrentChange} handleAutoCreateFolderChange={handleAutoCreateFolderChange} handleSslVerifyChange={handleSslVerifyChange} saveFilenameTemplate={saveFilenameTemplate} saveFolderNameTemplate={saveFolderNameTemplate} appendFilenameToken={appendFilenameToken} appendFolderToken={appendFolderToken} />
              )}

              {activeTab === "preferences" && (
                <SettingsAppearanceTab theme={theme} fontSize={fontSize} savingFields={savingFields} fieldStatus={fieldStatus} handleThemeChange={handleThemeChange} handleFontSizeChange={handleFontSizeChange} />
              )}

              {activeTab === "ai" && (
                <SettingsAiTab
                  enabled={aiEnabled}
                  provider={aiProvider}
                  providerPresets={aiProviderPresets}
                  apiBase={aiApiBase}
                  apiKey={aiApiKey}
                  apiKeySet={aiApiKeySet}
                  model={aiModel}
                  systemPrompt={aiSystemPrompt}
                  autoSendComments={aiAutoSendComments}
                  autoSendPrivateMessages={aiAutoSendPrivateMessages}
                  autoLike={aiAutoLike}
                  autoCollect={aiAutoCollect}
                  autoSendDelayMs={aiAutoSendDelayMs}
                  autoSendMaxChars={aiAutoSendMaxChars}
                  autoRequireContext={aiAutoRequireContext}
                  autoMonitorNotices={aiAutoMonitorNotices}
                  autoMonitorFriends={aiAutoMonitorFriends}
                  autoMonitorComments={aiAutoMonitorComments}
                  autoMonitorFeed={aiAutoMonitorFeed}
                  autoMatchKeywords={aiAutoMatchKeywords}
                  autoExcludeKeywords={aiAutoExcludeKeywords}
                  autoMinDiggCount={aiAutoMinDiggCount}
                  autoMinCommentCount={aiAutoMinCommentCount}
                  autoMinPlayCount={aiAutoMinPlayCount}
                  autoScanIntervalSeconds={aiAutoScanIntervalSeconds}
                  autoMaxActionsPerRun={aiAutoMaxActionsPerRun}
                  status={fieldStatus("ai_interaction")}
                  testStatus={aiTestStatus}
                  testMessage={aiTestMessage}
                  onEnabledChange={setAiEnabled}
                  onProviderChange={handleAiProviderChange}
                  onApiBaseChange={setAiApiBase}
                  onApiKeyChange={setAiApiKey}
                  onModelChange={setAiModel}
                  onSystemPromptChange={setAiSystemPrompt}
                  onAutoSendCommentsChange={setAiAutoSendComments}
                  onAutoSendPrivateMessagesChange={setAiAutoSendPrivateMessages}
                  onAutoLikeChange={setAiAutoLike}
                  onAutoCollectChange={setAiAutoCollect}
                  onAutoSendDelayMsChange={setAiAutoSendDelayMs}
                  onAutoSendMaxCharsChange={setAiAutoSendMaxChars}
                  onAutoRequireContextChange={setAiAutoRequireContext}
                  onAutoMonitorNoticesChange={setAiAutoMonitorNotices}
                  onAutoMonitorFriendsChange={setAiAutoMonitorFriends}
                  onAutoMonitorCommentsChange={setAiAutoMonitorComments}
                  onAutoMonitorFeedChange={setAiAutoMonitorFeed}
                  onAutoMatchKeywordsChange={setAiAutoMatchKeywords}
                  onAutoExcludeKeywordsChange={setAiAutoExcludeKeywords}
                  onAutoMinDiggCountChange={setAiAutoMinDiggCount}
                  onAutoMinCommentCountChange={setAiAutoMinCommentCount}
                  onAutoMinPlayCountChange={setAiAutoMinPlayCount}
                  onAutoScanIntervalSecondsChange={setAiAutoScanIntervalSeconds}
                  onAutoMaxActionsPerRunChange={setAiAutoMaxActionsPerRun}
                  onSave={() => void handleSaveAiInteraction()}
                  onTest={() => void handleTestAiInteraction()}
                />
              )}

              {activeTab === "about" && (
                <SettingsAboutTab appVersion={appVersion} updateStatus={updateStatus} updateMessage={updateMessage} updateInfo={updateInfo} updateProgress={updateProgress} updateCanRestart={updateCanRestart} handleCheckUpdate={handleCheckUpdate} handleDownloadUpdate={handleDownloadUpdate} handleRestart={handleRestart} updateProxy={updateProxy} savingProxy={savingProxy} handleSaveUpdateProxy={handleSaveUpdateProxy} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
