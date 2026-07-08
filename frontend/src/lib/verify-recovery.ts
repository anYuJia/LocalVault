import { useToastStore } from "@/components/ui/toast";
import { openVerifyBrowser, verifyCookie } from "@/lib/tauri";
import { useLogStore, useVerifyRecoveryStore } from "@/stores/app-store";

interface VerifyRecoveryOptions {
  verifyUrl?: string;
  message?: string;
  title?: string;
  actionLabel?: string;
  onResume: () => void;
}

export function requestVerifyRecovery({
  verifyUrl,
  message = "需要完成抖音验证",
  title = "需要验证",
  actionLabel = "已完成验证",
  onResume,
}: VerifyRecoveryOptions) {
  const addLog = useLogStore.getState().addLog;
  const toast = useToastStore.getState().toast;

  const resumeAfterVerify = async () => {
    try {
      const status = await verifyCookie();
      if (status.valid) {
        onResume();
        return;
      }

      if (status.need_verify) {
        const message = status.message || "验证尚未完成，请在窗口中完成后重试";
        addLog(message, "warning");
        toast(message, "warning", title);
        return;
      }

      const message = status.message || "Cookie 已失效，请重新登录";
      window.dispatchEvent(new CustomEvent("dy-cookie-invalid", { detail: { message } }));
    } catch {
      onResume();
    }
  };

  void openVerifyBrowser(verifyUrl)
    .then((result) => addLog(result.message, result.success ? "info" : "warning"))
    .catch(() => addLog("无法打开应用内验证窗口，请用桌面模式启动后重试", "warning"));

  useVerifyRecoveryStore.getState().showRecovery({
    title,
    message,
    actionLabel,
    onResume: resumeAfterVerify,
  });

  toast(message, "warning", title, {
    label: actionLabel,
    onClick: resumeAfterVerify,
  });
}
