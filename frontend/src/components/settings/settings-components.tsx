import { motion } from "framer-motion";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingStatus } from "./settings-utils";

export function SettingGroup({
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
    <div className={cn("p-4 rounded-[12px] bg-white/[0.02] border border-white/[0.04]", className)}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <label className="flex items-center gap-2 text-[0.8rem] font-semibold text-text">
          <Icon className="w-4 h-4 text-text-muted" />
          {label}
        </label>
        {status && <SettingStatusPill status={status} />}
      </div>
      {children}
    </div>
  );
}

export function SettingStatusPill({ status }: { status: SettingStatus }) {
  const config = {
    saving: {
      label: "保存中",
      className: "border-info/20 bg-info-soft text-info",
      icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />,
    },
    saved: {
      label: "已保存",
      className: "border-success/20 bg-success-soft text-success",
      icon: <CheckCircle2 className="w-3.5 h-3.5" />,
    },
    error: {
      label: "保存失败",
      className: "border-danger/20 bg-danger-soft text-danger",
      icon: <XCircle className="w-3.5 h-3.5" />,
    },
  }[status];

  return (
    <motion.span
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -2 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[0.68rem] font-semibold tabular-nums",
        config.className
      )}
    >
      {config.icon}
      {config.label}
    </motion.span>
  );
}
