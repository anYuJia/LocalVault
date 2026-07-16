import type { ElementType, ReactNode } from "react";
import { motion } from "framer-motion";
import { AlertCircle, Key, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { cn } from "@/lib/utils";

const LOGIN_REQUIRED_PATTERN = /请登录后获取|请先设置\s*Cookie|未登录|登录态|decoding response body/i;

type PageStateTone = "neutral" | "danger" | "warning";

type PageStateAction = {
  label: string;
  icon?: ElementType;
  onClick: () => void;
  variant?: "default" | "outline" | "danger-outline";
};

type PageStateProps = {
  title: string;
  description: ReactNode;
  icon?: ElementType;
  tone?: PageStateTone;
  minHeight?: "md" | "lg";
  action?: PageStateAction;
  className?: string;
};

export function PageState({
  title,
  description,
  icon: Icon = AlertCircle,
  tone = "neutral",
  minHeight = "lg",
  action,
  className,
}: PageStateProps) {
  const ActionIcon = action?.icon;
  const isDanger = tone === "danger";
  const isWarning = tone === "warning";

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-xl)] border p-8 text-center sm:p-12",
        minHeight === "lg" ? "min-h-[360px]" : "min-h-[300px]",
        isDanger
          ? "border-danger/20 bg-danger-soft"
          : isWarning
            ? "border-warning/20 bg-warning-soft"
            : "border-border/50 bg-surface-solid/40",
        className
      )}
    >
      <div
        className={cn(
          "mb-6 flex h-16 w-16 items-center justify-center rounded-[20px] border shadow-[0_8px_20px_rgba(0,0,0,0.08)]",
          isDanger
            ? "border-danger/15 bg-danger/10"
            : isWarning
              ? "border-warning/15 bg-warning-soft"
              : "border-accent/10 bg-accent-soft shadow-[0_8px_20px_rgba(254,44,85,0.1)]"
        )}
      >
        <Icon className={cn("h-8 w-8", isDanger ? "text-danger" : isWarning ? "text-warning" : "text-accent")} />
      </div>
      <h3 className={cn("mb-2 text-[1.05rem] font-bold", isDanger ? "text-danger" : "text-text")}>{title}</h3>
      <p className="max-w-[360px] text-[0.82rem] leading-relaxed text-text-muted">{description}</p>
      {action && (
        <Button
          variant={action.variant ?? (isDanger ? "danger-outline" : "outline")}
          size={isDanger ? "sm" : "lg"}
          onClick={action.onClick}
          className={cn("mt-8 gap-2", isDanger ? "rounded-[10px]" : "rounded-[14px] border-accent/20 px-8 hover:bg-accent-soft hover:text-accent")}
        >
          {ActionIcon && <ActionIcon className="h-4 w-4" />}
          {action.label}
        </Button>
      )}
    </motion.div>
  );
}

export function LoginRequiredState({
  title,
  description,
  icon,
  loggedIn = false,
}: {
  title: string;
  description: string;
  icon?: ElementType;
  loggedIn?: boolean;
}) {
  const setView = useAppStore((s) => s.setView);
  return (
    <PageState
      title={title}
      description={description}
      icon={icon}
      action={
        loggedIn
          ? undefined
          : {
              label: "前往登录 Cookie",
              icon: Key,
              onClick: () => setView("settings"),
              variant: "outline",
            }
      }
    />
  );
}

export function ErrorState({
  message,
  icon = AlertCircle,
  retry,
}: {
  message: string;
  icon?: ElementType;
  retry?: () => void;
}) {
  const setView = useAppStore((s) => s.setView);
  const needsLogin = LOGIN_REQUIRED_PATTERN.test(message);

  return (
    <PageState
      title="读取失败"
      description={message}
      icon={icon}
      tone="danger"
      minHeight="md"
      action={
        needsLogin
          ? { label: "去登录", icon: Key, onClick: () => setView("settings"), variant: "default" }
          : retry
            ? { label: "重试", icon: RefreshCw, onClick: retry, variant: "danger-outline" }
            : undefined
      }
    />
  );
}

export function InlineStatus({
  tone = "warning",
  children,
  className,
}: {
  tone?: "warning" | "danger" | "info";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-3 rounded-[12px] border px-3 py-2 text-[0.75rem]",
        tone === "danger"
          ? "border-danger/20 bg-danger-soft text-danger"
          : tone === "info"
            ? "border-info/20 bg-info-soft text-text-secondary"
            : "border-warning/20 bg-warning-soft text-text-secondary",
        className
      )}
    >
      {children}
    </div>
  );
}
