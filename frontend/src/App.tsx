import { useCallback, useEffect, useRef } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { AppShell } from "@/components/layout/app-shell";
import { GlobalAlert, GlobalLoader, GlobalVerifyRecovery } from "@/components/layout/global-feedback";
import { useAlertStore, useAppStore, useLoaderStore, useLogStore, useUpdateStore } from "@/stores/app-store";
import { useSocket } from "@/lib/socket";
import { useKeyboard } from "@/hooks/use-keyboard";
import { checkUpdate, downloadUpdate, getConfig, getFriendChatState, initClient, listenEvent, openExternalUrl, restartApp, verifyCookie } from "@/lib/tauri";
import { normalizeUpdateNotes } from "@/lib/update-notes";
import { useRecommendedStore } from "@/stores/recommended-store";

const BOOTSTRAP_STEP_TIMEOUT_MS = 8_000;
const BOOTSTRAP_NETWORK_TIMEOUT_MS = 6_000;
const BOOTSTRAP_COOKIE_TIMEOUT_MS = 10_000;
const STAR_PROMPT_STORAGE_KEY = "better-douyin.starPrompt.dismissed.v1";
const STAR_PROMPT_GITHUB_URL = "https://github.com/anYuJia/better-douyin";
const UPDATE_PROMPT_DISMISSED_VERSION_KEY = "better-douyin.updatePrompt.dismissedVersion.v1";

function withBootstrapTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = BOOTSTRAP_STEP_TIMEOUT_MS
): Promise<T> {
  let timer: number | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`${label}超时`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  });
}

export default function App() {
  const setCookieLoggedIn = useAppStore((s) => s.setCookieLoggedIn);
  const setFriendUnreadCount = useAppStore((s) => s.setFriendUnreadCount);
  const showAlert = useAlertStore((s) => s.showAlert);
  const { showLoader, hideLoader } = useLoaderStore();
  const lastCookieInvalidLogAt = useRef(0);
  const updateInFlightRef = useRef(false);
  const updateReadyPromptShownRef = useRef(false);

  const showUpdateReadyPrompt = useCallback((message?: string) => {
    if (updateReadyPromptShownRef.current) return;
    updateReadyPromptShownRef.current = true;

    showAlert({
      title: "更新安装完成",
      variant: "success",
      description: (
        <div>
          <p>{message || "新版本已在后台下载并安装完成，重启后即可使用。"}</p>
          <p className="mt-2 text-text-muted">可以稍后手动重启，也可以现在立即重启应用。</p>
        </div>
      ),
      cancelLabel: "稍后重启",
      actionLabel: "立即重启",
      onCancel: () => {},
      onAction: () => {
        void restartApp().catch((error) => {
          const errorMessage = error instanceof Error ? error.message : "重启失败";
          useLogStore.getState().addLog(errorMessage, "error");
          updateReadyPromptShownRef.current = false;
          showAlert({
            title: "重启失败",
            variant: "error",
            description: errorMessage,
            actionLabel: "知道了",
          });
        });
      },
    });
  }, [showAlert]);

  const startBackgroundUpdate = useCallback(async () => {
    if (updateInFlightRef.current) return;
    updateInFlightRef.current = true;
    updateReadyPromptShownRef.current = false;
    const updateStore = useUpdateStore.getState();
    updateStore.setStatus("downloading");
    updateStore.resetProgress();
    updateStore.setMessage("正在下载更新包...");

    useLogStore.getState().addLog("开始后台下载更新", "info");
    showAlert({
      title: "正在后台更新",
      variant: "info",
      description: (
        <div>
          <p>更新会在后台自动下载并安装，你可以继续使用应用。</p>
          <p className="mt-2 text-text-muted">完成后会提示你重启以使用新版本。</p>
        </div>
      ),
      actionLabel: "知道了",
    });

    try {
      const result = await downloadUpdate();
      if (!result.success) {
        throw new Error(result.message || "更新下载失败");
      }

      const autoClosing = result.message.includes("自动关闭") || result.message.includes("即将关闭");
      useLogStore.getState().addLog(result.message || "更新下载完成", "success");
      useUpdateStore.getState().setProgress({ progress: 100, speed_bps: 0 });

      if (!autoClosing && result.restart_required !== false) {
        useUpdateStore.getState().setStatus("ready");
        useUpdateStore.getState().setCanRestart(true);
        useUpdateStore.getState().setMessage(result.message || "新版本已在后台下载并安装完成，重启后即可使用。");
        showUpdateReadyPrompt(result.message || "新版本已在后台下载并安装完成，重启后即可使用。");
      } else if (!autoClosing) {
        useUpdateStore.getState().setStatus("ready");
        useUpdateStore.getState().setCanRestart(false);
        useUpdateStore.getState().setMessage(result.message || "更新包已下载完成，请按提示完成安装。");
        showAlert({
          title: "更新已下载",
          variant: "success",
          description: result.message || "更新包已下载完成，请按提示完成安装。",
          actionLabel: "知道了",
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "更新下载失败";
      useLogStore.getState().addLog(message, "error");
      updateReadyPromptShownRef.current = false;
      useUpdateStore.getState().setStatus("error");
      useUpdateStore.getState().setMessage(message);
      useUpdateStore.getState().setCanRestart(false);
      showAlert({
        title: "更新失败",
        variant: "error",
        description: message,
        actionLabel: "知道了",
      });
    } finally {
      updateInFlightRef.current = false;
    }
  }, [showAlert, showUpdateReadyPrompt]);

  useEffect(() => {
    // Disable star prompt popup to avoid potential GIL contention on Windows startup
    // Users can still star the project from the settings page
    try {
      window.localStorage.setItem(STAR_PROMPT_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures.
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void getFriendChatState()
      .then((state) => {
        if (disposed) return;
        const unreadCounts = state.unreadCounts && typeof state.unreadCounts === "object" ? state.unreadCounts : {};
        const total = Object.values(unreadCounts).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
        setFriendUnreadCount(total);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [setFriendUnreadCount]);

  useEffect(() => {
    const handleCookieInvalid = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail || {};
      const message = detail.message || "Cookie 已失效，请重新登录以继续使用搜索和推荐功能。";
      setCookieLoggedIn(false);

      const now = Date.now();
      if (now - lastCookieInvalidLogAt.current <= 12_000) {
        return;
      }

      lastCookieInvalidLogAt.current = now;
      useLogStore.getState().addLog(message, "warning");

      if (useAppStore.getState().currentView === "settings") {
        return;
      }

      showAlert({
        title: "登录已失效",
        variant: "warning",
        description: message,
        actionLabel: "前往设置",
        onAction: () => {
          useAppStore.getState().setView("settings");
        }
      });
    };

    window.addEventListener("dy-cookie-invalid", handleCookieInvalid);
    return () => window.removeEventListener("dy-cookie-invalid", handleCookieInvalid);
  }, [setCookieLoggedIn, showAlert]);

  useEffect(() => {
    let disposed = false;
    let prefetchTimer: number | null = null;

    const checkForUpdatesInBackground = async () => {
      try {
        const update = await withBootstrapTimeout(
          checkUpdate(),
          "检查更新",
          BOOTSTRAP_NETWORK_TIMEOUT_MS
        );
        if (!disposed && update.has_update) {
          // Skip if the user already dismissed this specific version
          try {
            if (window.localStorage.getItem(UPDATE_PROMPT_DISMISSED_VERSION_KEY) === update.version) {
              return;
            }
          } catch {
            // ignore storage errors
          }
          const updateNotes = normalizeUpdateNotes(update.notes);
          const updateStore = useUpdateStore.getState();
          updateStore.setStatus("available");
          updateStore.setInfo({
            version: update.version,
            current_version: update.current_version,
            notes: updateNotes || undefined,
            asset_name: update.asset_name,
            asset_size: update.asset_size,
            download_url: update.download_url,
            install_mode: update.install_mode,
            portable: update.portable,
          });
          updateStore.setMessage(`发现新版本 ${update.version || ""}`.trim());
          showAlert({
            title: "发现新版本",
            variant: "info",
            description: (
              <div>
                <p>程序有新版本可用: <span className="font-bold text-text">v{update.version}</span></p>
                {updateNotes && (
                  <div className="mt-3 rounded-lg border border-border/50 bg-surface-raised p-3 text-text-secondary">
                    <div className="mb-2 text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-text-muted">新版本内容</div>
                    <div className="max-h-[220px] overflow-y-auto whitespace-pre-wrap text-[0.76rem] leading-relaxed">
                      {updateNotes}
                    </div>
                  </div>
                )}
                <p className="mt-2 opacity-80">点击立即更新后会在后台自动下载并安装，完成后会提示重启。</p>
              </div>
            ),
            cancelLabel: "取消",
            actionLabel: "立即更新",
            onCancel: () => {
              if (update.version) {
                try {
                  window.localStorage.setItem(UPDATE_PROMPT_DISMISSED_VERSION_KEY, update.version);
                } catch {
                  // ignore storage errors
                }
              }
            },
            onAction: () => {
              void startBackgroundUpdate();
            },
          });
        }
      } catch {
        // Silent fail for update check.
      }
    };

    const bootstrap = async () => {
      showLoader("正在初始化引擎...");
      try {
        await withBootstrapTimeout(initClient(), "初始化客户端");
      } catch (error) {
        if (!disposed) {
          useLogStore
            .getState()
            .addLog(error instanceof Error ? error.message : "初始化客户端失败", "error");
        }
      }

      try {
        showLoader("正在读取配置...");
        const config = await withBootstrapTimeout(getConfig(), "读取配置");
        if (disposed) {
          hideLoader();
          return;
        }

        if (config.cookie_set) {
          try {
            showLoader("正在校验登录状态...");
            const status = await withBootstrapTimeout(
              verifyCookie(),
              "Cookie 校验",
              BOOTSTRAP_COOKIE_TIMEOUT_MS
            );
            if (disposed) {
              hideLoader();
              return;
            }

            setCookieLoggedIn(status.valid, status.user_name || undefined);

            if (status.valid) {
              prefetchTimer = window.setTimeout(() => {
                void useRecommendedStore.getState().loadFeed();
              }, 1200);
            } else {
              useLogStore.getState().addLog(status.message || "Cookie 可能已失效", "warning");
            }
          } catch (error) {
            if (!disposed) {
              setCookieLoggedIn(false);
              useLogStore
                .getState()
                .addLog(error instanceof Error ? error.message : "Cookie 校验失败", "warning");
            }
          }
        } else {
          setCookieLoggedIn(false);
        }
      } catch {
        if (!disposed) {
          setCookieLoggedIn(false);
        }
      } finally {
        hideLoader();
        // Delay update check to avoid GIL contention on startup (Windows WebView2)
        updateCheckTimer = window.setTimeout(() => {
          if (!disposed) {
            void checkForUpdatesInBackground();
          }
        }, 15000);
      }
    };

    let updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
    void bootstrap();

    return () => {
      disposed = true;
      if (prefetchTimer) {
        window.clearTimeout(prefetchTimer);
      }
      if (updateCheckTimer) {
        window.clearTimeout(updateCheckTimer);
      }
    };
  }, [setCookieLoggedIn, showAlert, showLoader, hideLoader, startBackgroundUpdate]);

  useEffect(() => {
    let disposed = false;
    let removeProgress: (() => void) | null = null;
    let removeFinished: (() => void) | null = null;
    let removeError: (() => void) | null = null;

    const setup = async () => {
      removeProgress = await listenEvent<{
        progress?: number | null;
        downloaded?: number | null;
        total?: number | null;
        speed_bps?: number | null;
        speedBps?: number | null;
      }>("update-download-progress", (payload) => {
        if (disposed) return;
        const updateStore = useUpdateStore.getState();
        updateStore.setStatus("downloading");
        updateStore.setProgress(payload || {});
      });
      removeFinished = await listenEvent<{
        message?: string;
        restart_required?: boolean;
        install_mode?: string;
      }>("update-download-finished", (payload) => {
        if (disposed) return;
        const updateStore = useUpdateStore.getState();
        updateStore.setStatus("ready");
        updateStore.setProgress({ progress: 100, speed_bps: 0 });
        updateStore.setMessage((current) => current || payload?.message || "更新已下载");
        updateStore.setCanRestart(Boolean(payload?.restart_required ?? true));
        if (payload?.restart_required === false) {
          showAlert({
            title: "更新已下载",
            variant: "success",
            description: payload.message || "更新包已下载完成，请按提示完成安装。",
            actionLabel: "知道了",
          });
          return;
        }
        showUpdateReadyPrompt(payload?.message || "新版本已在后台下载并安装完成，重启后即可使用。");
      });
      removeError = await listenEvent<{ message?: string }>("update-download-error", (payload) => {
        if (disposed) return;
        updateInFlightRef.current = false;
        updateReadyPromptShownRef.current = false;
        const message = payload?.message || "更新下载失败";
        const updateStore = useUpdateStore.getState();
        updateStore.setStatus("error");
        updateStore.setMessage(message);
        updateStore.setCanRestart(false);
        useLogStore.getState().addLog(message, "error");
        showAlert({
          title: "更新失败",
          variant: "error",
          description: message,
          actionLabel: "知道了",
        });
      });
    };

    void setup();

    return () => {
      disposed = true;
      removeProgress?.();
      removeFinished?.();
      removeError?.();
    };
  }, [showAlert, showUpdateReadyPrompt]);

  useSocket();
  useKeyboard();

  return (
    <TooltipProvider delayDuration={300}>
      <AppShell />
      <GlobalAlert />
      <GlobalVerifyRecovery />
      <GlobalLoader />
      <Toaster />
    </TooltipProvider>
  );
}
