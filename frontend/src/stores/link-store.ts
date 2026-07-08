import { create } from "zustand";
import { getErrorMessage, parseLink, type UserInfo, type VideoInfo } from "@/lib/tauri";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { useToastStore } from "@/components/ui/toast";
import { saveRecentParsedLink } from "@/lib/recent-searches";
import { requestVerifyRecovery } from "@/lib/verify-recovery";

interface LinkStoreState {
  link: string;
  parsing: boolean;
  videos: VideoInfo[];
  user: UserInfo | null;
  error: string | null;
  parse: (link: string) => Promise<void>;
  clear: () => void;
}

export const useLinkStore = create<LinkStoreState>((set) => ({
  link: "",
  parsing: false,
  videos: [],
  user: null,
  error: null,

  parse: async (rawLink) => {
    const link = rawLink.trim();
    if (!link) {
      set({ error: "请粘贴抖音链接" });
      return;
    }

    const addLog = useLogStore.getState().addLog;
    const toast = useToastStore.getState().toast;
    useAppStore.getState().setView("link");
    set({ link, parsing: true, videos: [], user: null, error: null });
    addLog("解析链接...", "info");
    const loadingToastId = toast("正在解析链接...", "loading");

    try {
      const result = await parseLink(link);
      useToastStore.getState().dismiss(loadingToastId);
      
      if (!result.success) {
        const message = result.message || "链接解析失败";
        if (result.need_login) {
          window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
          set({ parsing: false, error: message });
          addLog(message, "warning");
          return;
        }
        if (result.need_verify) {
          requestVerifyRecovery({
            verifyUrl: result.verify_url,
            message,
            title: "解析链接需要验证",
            onResume: () => void useLinkStore.getState().parse(link),
          });
        }
        set({ parsing: false, error: message });
        addLog(message, result.need_verify ? "warning" : "error");
        if (!result.need_verify) toast(message, "error", "解析失败");
        return;
      }

      const videos = result.videos?.length
        ? result.videos
        : result.video
          ? [result.video]
          : [];

      saveRecentParsedLink(link, { videos, user: result.user || null });

      set({
        parsing: false,
        videos,
        user: result.user || null,
        error: videos.length > 0 || result.user ? null : "没有解析到可下载内容",
      });

      const msg = videos.length > 0
        ? `链接解析完成，获取到 ${videos.length} 个作品`
        : result.user
          ? `已找到用户: ${result.user.nickname}`
          : "链接解析完成";
      
      const type = videos.length > 0 || result.user ? "success" : "warning";
      addLog(msg, type);
      toast(msg, type, "解析完成");
    } catch (error) {
      useToastStore.getState().dismiss(loadingToastId);
      const message = getErrorMessage(error, "链接解析失败");
      set({ parsing: false, error: message });
      addLog(message, "error");
      toast(message, "error", "解析异常");
    }
  },

  clear: () => set({ link: "", parsing: false, videos: [], user: null, error: null }),
}));
