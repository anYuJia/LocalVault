import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, ArrowDown, CheckCircle2, Info, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAlertStore, useAppStore, useLoaderStore, useVerifyRecoveryStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";

const variantIcons = {
  info: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  error: AlertCircle,
  danger: AlertCircle,
};

const variantColors = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
  danger: "text-danger",
};

export function GlobalAlert() {
  const { isOpen, config, hideAlert } = useAlertStore();

  if (!config) return null;

  const Icon = variantIcons[config.variant || "info"];
  const iconColor = variantColors[config.variant || "info"];

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && hideAlert()}>
      <DialogContent className="max-w-[420px] glass-premium">
        <DialogHeader className="flex-row items-start gap-5 space-y-0 pt-2">
          <motion.div
            initial={{ scale: 0.5, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 20, delay: 0.1 }}
            className={cn(
              "mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] bg-surface-raised shadow-sm",
              iconColor
            )}
          >
            <Icon className="h-6 w-6" />
          </motion.div>
          <div className="flex-1 min-w-0 pt-0.5">
            <DialogTitle className="text-[1.1rem] font-bold tracking-tight">
              {config.title}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="mt-2.5 text-[0.85rem] leading-relaxed text-text-secondary">
                {config.description}
              </div>
            </DialogDescription>
          </div>
        </DialogHeader>
        <DialogFooter className="mt-8 gap-2.5 sm:flex-row">
          {config.onCancel && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                hideAlert();
                config.onCancel?.();
              }}
              className="h-11 flex-1 rounded-[14px] font-bold"
            >
              {config.cancelLabel || "取消"}
            </Button>
          )}
          <Button
            type="button"
            variant={config.variant === "danger" ? "danger" : "default"}
            onClick={() => {
              hideAlert();
              config.onAction?.();
            }}
            className="h-11 flex-1 rounded-[14px] font-bold shadow-md active:scale-[0.98] transition-transform"
          >
            {config.actionLabel || "确认"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GlobalLoader() {
  const { isLoading, message, startedAt } = useLoaderStore();
  const setBottomBarExpanded = useAppStore((s) => s.setBottomBarExpanded);

  return (
    <AnimatePresence>
      {isLoading && (
        <motion.div
          role="status"
          aria-live="polite"
          aria-busy="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex flex-col items-center justify-center bg-background/50 backdrop-blur-[14px]"
        >
          <motion.div
            initial={{ scale: 0.96, opacity: 0, y: 8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.98, opacity: 0, y: 4 }}
            transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
            className="relative flex w-[min(360px,calc(100vw-32px))] flex-col items-center rounded-[18px] bg-surface-solid px-6 py-5 text-center shadow-[0_28px_70px_rgba(0,0,0,0.35),0_0_0_1px_var(--color-border)]"
          >
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-[14px] bg-accent-soft text-accent">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
            <h2 className="text-[1rem] font-bold text-text">
              {message || "正在处理"}
            </h2>
            <p className="mt-1 text-[0.78rem] leading-relaxed text-text-muted">
              {startedAt > 0 ? "正在准备本地服务和登录状态。长时间无响应时可查看底部日志。" : "正在处理当前操作。"}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => setBottomBarExpanded(true)}
            >
              <ArrowDown className="h-3.5 w-3.5" />
              查看日志
            </Button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function GlobalVerifyRecovery() {
  const { isOpen, config, resume, dismiss } = useVerifyRecoveryStore();

  return (
    <AnimatePresence initial={false}>
      {isOpen && config && (
        <motion.div
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: -12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
          className="fixed left-1/2 top-4 z-[8600] flex w-[min(520px,calc(100vw-32px))] -translate-x-1/2 items-center gap-3 rounded-[16px] bg-surface-solid px-3.5 py-3 shadow-[0_18px_50px_rgba(0,0,0,0.28),0_0_0_1px_var(--color-border)]"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-warning-soft text-warning">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[0.86rem] font-semibold text-text">
              {config.title || "需要验证"}
            </div>
            <div className="truncate text-[0.74rem] text-text-muted">
              {config.message}
            </div>
          </div>
          <Button size="sm" variant="success-outline" onClick={resume}>
            <ShieldCheck className="h-3.5 w-3.5" />
            {config.actionLabel || "已完成验证"}
          </Button>
          <button
            type="button"
            aria-label="关闭验证提示"
            onClick={dismiss}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-text-muted transition-[background-color,color,transform] hover:bg-surface-raised hover:text-text active:scale-[0.96]"
          >
            <X className="h-4 w-4" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
