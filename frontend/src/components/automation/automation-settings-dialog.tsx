import { useEffect, useState } from "react";
import {
  Bell,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  ThumbsUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AiInteractionConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type AutomationForm = Pick<
  AiInteractionConfig,
  | "enabled"
  | "auto_send_comments"
  | "auto_send_private_messages"
  | "auto_like"
  | "auto_collect"
  | "auto_require_context"
  | "auto_monitor_notices"
  | "auto_monitor_friends"
  | "auto_monitor_comments"
  | "auto_monitor_feed"
  | "auto_match_keywords"
  | "auto_exclude_keywords"
  | "auto_private_match_keywords"
  | "auto_private_exclude_keywords"
  | "auto_comment_match_keywords"
  | "auto_comment_exclude_keywords"
  | "auto_like_match_keywords"
  | "auto_like_exclude_keywords"
  | "auto_collect_match_keywords"
  | "auto_collect_exclude_keywords"
> & {
  auto_send_delay_ms: string;
  auto_send_max_chars: string;
  auto_min_digg_count: string;
  auto_min_comment_count: string;
  auto_min_play_count: string;
  auto_scan_interval_seconds: string;
  auto_max_actions_per_run: string;
};

interface AutomationSettingsDialogProps {
  open: boolean;
  config: AiInteractionConfig | null;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (patch: Partial<AiInteractionConfig>) => Promise<void>;
}

function toForm(config: AiInteractionConfig | null): AutomationForm {
  return {
    enabled: Boolean(config?.enabled ?? false),
    auto_send_comments: Boolean(config?.auto_send_comments ?? false),
    auto_send_private_messages: Boolean(config?.auto_send_private_messages ?? false),
    auto_like: Boolean(config?.auto_like ?? false),
    auto_collect: Boolean(config?.auto_collect ?? false),
    auto_require_context: Boolean(config?.auto_require_context ?? true),
    auto_monitor_notices: Boolean(config?.auto_monitor_notices ?? false),
    auto_monitor_friends: Boolean(config?.auto_monitor_friends ?? false),
    auto_monitor_comments: Boolean(config?.auto_monitor_comments ?? false),
    auto_monitor_feed: Boolean(config?.auto_monitor_feed ?? false),
    auto_match_keywords: String(config?.auto_match_keywords ?? ""),
    auto_exclude_keywords: String(config?.auto_exclude_keywords ?? ""),
    auto_private_match_keywords: String(config?.auto_private_match_keywords || config?.auto_match_keywords || ""),
    auto_private_exclude_keywords: String(config?.auto_private_exclude_keywords || config?.auto_exclude_keywords || ""),
    auto_comment_match_keywords: String(config?.auto_comment_match_keywords || config?.auto_match_keywords || ""),
    auto_comment_exclude_keywords: String(config?.auto_comment_exclude_keywords || config?.auto_exclude_keywords || ""),
    auto_like_match_keywords: String(config?.auto_like_match_keywords || config?.auto_match_keywords || ""),
    auto_like_exclude_keywords: String(config?.auto_like_exclude_keywords || config?.auto_exclude_keywords || ""),
    auto_collect_match_keywords: String(config?.auto_collect_match_keywords || config?.auto_match_keywords || ""),
    auto_collect_exclude_keywords: String(config?.auto_collect_exclude_keywords || config?.auto_exclude_keywords || ""),
    auto_send_delay_ms: String(config?.auto_send_delay_ms ?? 0),
    auto_send_max_chars: String(config?.auto_send_max_chars ?? 180),
    auto_min_digg_count: String(config?.auto_min_digg_count ?? 0),
    auto_min_comment_count: String(config?.auto_min_comment_count ?? 0),
    auto_min_play_count: String(config?.auto_min_play_count ?? 0),
    auto_scan_interval_seconds: String(config?.auto_scan_interval_seconds ?? 30),
    auto_max_actions_per_run: String(config?.auto_max_actions_per_run ?? 5),
  };
}

function clampNumber(value: string, fallback: number, min: number, max: number) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(next)));
}

function ToggleLine({
  label,
  description,
  checked,
  icon: Icon,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  icon: React.ElementType;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 border-b border-border py-2 text-left last:border-b-0"
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", checked ? "text-accent" : "text-text-muted")} />
        <span className="min-w-0">
          <span className={cn("block truncate text-[0.74rem] font-semibold", checked ? "text-text" : "text-text-secondary")}>
            {label}
          </span>
          {description && (
            <span className="block text-[0.62rem] leading-relaxed text-text-muted">
              {description}
            </span>
          )}
        </span>
      </span>
      <span
        className={cn(
          "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors",
          checked ? "border-transparent bg-accent" : "border-border-strong bg-surface-raised"
        )}
      >
        <span
          className={cn(
            "absolute left-[2px] top-[2px] h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
            checked && "translate-x-[14px]"
          )}
        />
      </span>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[0.68rem] font-black uppercase tracking-[0.06em] text-text-muted">{title}</div>
      <div className="rounded-[10px] border border-border bg-surface/20 px-2.5">
        {children}
      </div>
    </section>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-[0.66rem] font-semibold text-text-secondary">{children}</span>;
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max?: number;
  step?: number;
  suffix?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0">
      <FieldLabel>{label}</FieldLabel>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn("h-8 pr-9 font-mono text-[0.72rem]", suffix && "pr-11")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.62rem] font-semibold text-text-muted">
            {suffix}
          </span>
        )}
      </div>
    </label>
  );
}

function FilterRow({
  label,
  matchValue,
  excludeValue,
  onMatchChange,
  onExcludeChange,
}: {
  label: string;
  matchValue: string;
  excludeValue: string;
  onMatchChange: (value: string) => void;
  onExcludeChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[42px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
      <span className="text-[0.68rem] font-semibold text-text-secondary">{label}</span>
      <Input
        value={matchValue}
        onChange={(event) => onMatchChange(event.target.value)}
        placeholder="匹配关键词"
        className="h-8 text-[0.72rem]"
      />
      <Input
        value={excludeValue}
        onChange={(event) => onExcludeChange(event.target.value)}
        placeholder="排除关键词"
        className="h-8 text-[0.72rem]"
      />
    </div>
  );
}

export function AutomationSettingsDialog({
  open,
  config,
  saving,
  onOpenChange,
  onSave,
}: AutomationSettingsDialogProps) {
  const [form, setForm] = useState<AutomationForm>(() => toForm(config));

  useEffect(() => {
    if (open) setForm(toForm(config));
  }, [config, open]);

  const update = <K extends keyof AutomationForm>(key: K, value: AutomationForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    await onSave({
      enabled: form.enabled,
      auto_send_comments: form.auto_send_comments,
      auto_send_private_messages: form.auto_send_private_messages,
      auto_like: form.auto_like,
      auto_collect: form.auto_collect,
      auto_require_context: form.auto_require_context,
      auto_monitor_notices: form.auto_monitor_notices,
      auto_monitor_friends: form.auto_monitor_friends,
      auto_monitor_comments: form.auto_monitor_comments,
      auto_monitor_feed: form.auto_monitor_feed,
      auto_match_keywords: form.auto_match_keywords.trim(),
      auto_exclude_keywords: form.auto_exclude_keywords.trim(),
      auto_private_match_keywords: form.auto_private_match_keywords.trim(),
      auto_private_exclude_keywords: form.auto_private_exclude_keywords.trim(),
      auto_comment_match_keywords: form.auto_comment_match_keywords.trim(),
      auto_comment_exclude_keywords: form.auto_comment_exclude_keywords.trim(),
      auto_like_match_keywords: form.auto_like_match_keywords.trim(),
      auto_like_exclude_keywords: form.auto_like_exclude_keywords.trim(),
      auto_collect_match_keywords: form.auto_collect_match_keywords.trim(),
      auto_collect_exclude_keywords: form.auto_collect_exclude_keywords.trim(),
      auto_send_delay_ms: clampNumber(form.auto_send_delay_ms, 0, 0, 10000),
      auto_send_max_chars: clampNumber(form.auto_send_max_chars, 180, 20, 500),
      auto_min_digg_count: clampNumber(form.auto_min_digg_count, 0, 0, Number.MAX_SAFE_INTEGER),
      auto_min_comment_count: clampNumber(form.auto_min_comment_count, 0, 0, Number.MAX_SAFE_INTEGER),
      auto_min_play_count: clampNumber(form.auto_min_play_count, 0, 0, Number.MAX_SAFE_INTEGER),
      auto_scan_interval_seconds: clampNumber(form.auto_scan_interval_seconds, 30, 10, 300),
      auto_max_actions_per_run: clampNumber(form.auto_max_actions_per_run, 5, 1, 50),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-[660px] overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3 pr-14">
          <DialogTitle className="flex items-center gap-2 text-[0.9rem]">
            <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />
            自动监控设置
          </DialogTitle>
          <DialogDescription className="text-[0.7rem]">
            调整后台监控、过滤条件和自动执行权限。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[calc(100vh-190px)] overflow-y-auto px-4 py-3">
          <div className="mb-3 rounded-[10px] border border-border bg-surface/20 px-2.5">
            <ToggleLine
              label="启用自动监控"
              description="关闭后不会执行自动回复、点赞或收藏。"
              checked={form.enabled}
              onChange={(checked) => update("enabled", checked)}
              icon={Sparkles}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <Section title="监控范围">
                <ToggleLine label="推荐流" checked={form.auto_monitor_feed} onChange={(checked) => update("auto_monitor_feed", checked)} icon={RefreshCw} />
                <ToggleLine label="好友私信" checked={form.auto_monitor_friends} onChange={(checked) => update("auto_monitor_friends", checked)} icon={Users} />
                <ToggleLine label="通知回复" checked={form.auto_monitor_notices} onChange={(checked) => update("auto_monitor_notices", checked)} icon={Bell} />
                <ToggleLine label="评论区" checked={form.auto_monitor_comments} onChange={(checked) => update("auto_monitor_comments", checked)} icon={MessageSquare} />
              </Section>

              <Section title="自动动作">
                <ToggleLine label="发送评论" checked={form.auto_send_comments} onChange={(checked) => update("auto_send_comments", checked)} icon={Send} />
                <ToggleLine label="发送私信" checked={form.auto_send_private_messages} onChange={(checked) => update("auto_send_private_messages", checked)} icon={Send} />
                <ToggleLine label="点赞视频" checked={form.auto_like} onChange={(checked) => update("auto_like", checked)} icon={ThumbsUp} />
                <ToggleLine label="收藏视频" checked={form.auto_collect} onChange={(checked) => update("auto_collect", checked)} icon={Star} />
                <ToggleLine label="仅有上下文时发送" checked={form.auto_require_context} onChange={(checked) => update("auto_require_context", checked)} icon={ShieldCheck} />
              </Section>
            </div>

            <div className="space-y-3">
              <section className="space-y-2">
                <div className="text-[0.68rem] font-black uppercase tracking-[0.06em] text-text-muted">过滤条件</div>
                <div className="grid gap-2">
                  <div className="grid grid-cols-[42px_minmax(0,1fr)_minmax(0,1fr)] gap-2 text-[0.62rem] font-semibold text-text-muted">
                    <span />
                    <span>匹配</span>
                    <span>排除</span>
                  </div>
                  <FilterRow label="私信" matchValue={form.auto_private_match_keywords} excludeValue={form.auto_private_exclude_keywords} onMatchChange={(value) => update("auto_private_match_keywords", value)} onExcludeChange={(value) => update("auto_private_exclude_keywords", value)} />
                  <FilterRow label="评论" matchValue={form.auto_comment_match_keywords} excludeValue={form.auto_comment_exclude_keywords} onMatchChange={(value) => update("auto_comment_match_keywords", value)} onExcludeChange={(value) => update("auto_comment_exclude_keywords", value)} />
                  <FilterRow label="点赞" matchValue={form.auto_like_match_keywords} excludeValue={form.auto_like_exclude_keywords} onMatchChange={(value) => update("auto_like_match_keywords", value)} onExcludeChange={(value) => update("auto_like_exclude_keywords", value)} />
                  <FilterRow label="收藏" matchValue={form.auto_collect_match_keywords} excludeValue={form.auto_collect_exclude_keywords} onMatchChange={(value) => update("auto_collect_match_keywords", value)} onExcludeChange={(value) => update("auto_collect_exclude_keywords", value)} />
                  <div className="grid grid-cols-3 gap-2">
                    <NumberField label="点赞" min={0} value={form.auto_min_digg_count} onChange={(value) => update("auto_min_digg_count", value)} />
                    <NumberField label="评论" min={0} value={form.auto_min_comment_count} onChange={(value) => update("auto_min_comment_count", value)} />
                    <NumberField label="播放" min={0} value={form.auto_min_play_count} onChange={(value) => update("auto_min_play_count", value)} />
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="text-[0.68rem] font-black uppercase tracking-[0.06em] text-text-muted">频率限制</div>
                <div className="grid grid-cols-2 gap-2.5">
                  <NumberField label="扫描间隔" min={10} max={300} suffix="秒" value={form.auto_scan_interval_seconds} onChange={(value) => update("auto_scan_interval_seconds", value)} />
                  <NumberField label="单轮上限" min={1} max={50} suffix="条" value={form.auto_max_actions_per_run} onChange={(value) => update("auto_max_actions_per_run", value)} />
                  <NumberField label="发送延迟" min={0} max={10000} step={250} suffix="ms" value={form.auto_send_delay_ms} onChange={(value) => update("auto_send_delay_ms", value)} />
                  <NumberField label="最大字数" min={20} max={500} step={10} suffix="字" value={form.auto_send_max_chars} onChange={(value) => update("auto_send_max_chars", value)} />
                </div>
              </section>
            </div>
          </div>
        </div>

        <DialogFooter className="mt-0 border-t border-border px-4 py-2.5">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
            {saving ? "保存中" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
