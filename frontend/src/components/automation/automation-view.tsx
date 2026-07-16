import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Clock3,
  Filter,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Star,
  Square,
  ThumbsUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionSurface } from "@/components/common/surface";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { getConfig, saveConfig, type AiInteractionConfig } from "@/lib/tauri";
import { DEFAULT_AI_AUTOMATION, normalizeAiAutomationConfig } from "@/lib/ai-automation";
import { cn } from "@/lib/utils";
import { AutomationSettingsDialog } from "./automation-settings-dialog";

type MonitorSource = "all" | "feed" | "friends" | "notices" | "comments";

const SOURCE_LABELS: Record<MonitorSource, string> = {
  all: "全部",
  feed: "推荐流",
  friends: "好友",
  notices: "通知",
  comments: "评论区",
};

const DEFAULT_AI_CONFIG: AiInteractionConfig = {
  enabled: false,
  provider: "openai",
  api_base: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  system_prompt: "",
  auto_send_comments: false,
  auto_send_private_messages: false,
  auto_like: false,
  auto_collect: false,
  auto_send_delay_ms: 0,
  auto_send_max_chars: 180,
  auto_require_context: true,
  ...DEFAULT_AI_AUTOMATION,
};

function formatTime(timestamp?: number) {
  if (!timestamp) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function formatDateTime(timestamp?: number) {
  if (!timestamp) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function splitKeywords(value?: string) {
  return String(value || "")
    .split(/[,，\n\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function classifyLog(message: string): MonitorSource | null {
  if (/推荐流|后台推荐|视频自动处理/.test(message)) return "feed";
  if (/好友私信|私信/.test(message)) return "friends";
  if (/通知/.test(message)) return "notices";
  if (/评论|跟评/.test(message)) return "comments";
  if (/自动|监测|监控/.test(message)) return "all";
  return null;
}

function isAutomationLog(message: string) {
  return Boolean(classifyLog(message)) || /自动处理|自动回复|自动发送|后台/.test(message);
}

function LineItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-[0.72rem]">
      <span className="text-text-muted">{label}</span>
      <span className="min-w-0 truncate text-right font-semibold text-text">{value}</span>
    </div>
  );
}

function PanelTitle({ icon: Icon, title, detail }: { icon: React.ElementType; title: string; detail?: string }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        <span className="truncate text-[0.78rem] font-semibold text-text">{title}</span>
      </div>
      {detail && <span className="shrink-0 text-[0.64rem] font-medium text-text-muted">{detail}</span>}
    </div>
  );
}

function StatPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/55 px-2 py-0.5 text-[0.66rem] text-text-muted">
      <span>{label}</span>
      <span className="font-semibold text-text">{value}</span>
    </span>
  );
}

export function AutomationView() {
  const logs = useLogStore((s) => s.logs);
  const clearLogs = useLogStore((s) => s.clearLogs);
  const addLog = useLogStore((s) => s.addLog);
  const feedAutomationRunning = useAppStore((s) => s.feedAutomationRunning);
  const setFeedAutomationRunning = useAppStore((s) => s.setFeedAutomationRunning);
  const [config, setConfig] = useState<AiInteractionConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sourceFilter, setSourceFilter] = useState<MonitorSource>("all");

  const loadConfig = async () => {
    setLoading(true);
    try {
      const next = await getConfig();
      setConfig(normalizeAiAutomationConfig(next.ai_interaction) || DEFAULT_AI_CONFIG);
    } catch (error) {
      addLog(error instanceof Error ? error.message : "读取自动监控配置失败", "warning");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  const automationLogs = useMemo(() => {
    return logs
      .map((log) => ({ ...log, source: classifyLog(log.message) }))
      .filter((log) => isAutomationLog(log.message))
      .filter((log) => sourceFilter === "all" || log.source === sourceFilter);
  }, [logs, sourceFilter]);

  const monitorCount = [
    config?.auto_monitor_feed,
    config?.auto_monitor_friends,
    config?.auto_monitor_notices,
    config?.auto_monitor_comments,
  ].filter(Boolean).length;

  const actionCount = [
    config?.auto_send_comments,
    config?.auto_send_private_messages,
    config?.auto_like,
    config?.auto_collect,
  ].filter(Boolean).length;

  const lastLogTime = automationLogs[automationLogs.length - 1]?.timestamp;
  const filterRows = [
    {
      label: "私信过滤",
      match: splitKeywords(config?.auto_private_match_keywords || config?.auto_match_keywords),
      exclude: splitKeywords(config?.auto_private_exclude_keywords || config?.auto_exclude_keywords),
    },
    {
      label: "评论过滤",
      match: splitKeywords(config?.auto_comment_match_keywords || config?.auto_match_keywords),
      exclude: splitKeywords(config?.auto_comment_exclude_keywords || config?.auto_exclude_keywords),
    },
    {
      label: "点赞过滤",
      match: splitKeywords(config?.auto_like_match_keywords || config?.auto_match_keywords),
      exclude: splitKeywords(config?.auto_like_exclude_keywords || config?.auto_exclude_keywords),
    },
    {
      label: "收藏过滤",
      match: splitKeywords(config?.auto_collect_match_keywords || config?.auto_match_keywords),
      exclude: splitKeywords(config?.auto_collect_exclude_keywords || config?.auto_exclude_keywords),
    },
  ];
  const feedActionReady = Boolean(config?.enabled && config.auto_monitor_feed && (config.auto_like || config.auto_collect));

  const saveAutomation = async (patch: Partial<AiInteractionConfig>) => {
    if (!config) return;
    setSaving(true);
    try {
      const nextAi = { ...config, ...patch };
      const result = await saveConfig({ ai_interaction: nextAi });
      if (!result.success) throw new Error(result.message || "自动监控配置保存失败");
      setConfig(normalizeAiAutomationConfig(nextAi) || DEFAULT_AI_CONFIG);
      setSettingsOpen(false);
      addLog("自动监控配置已保存", "success");
    } catch (error) {
      addLog(error instanceof Error ? error.message : "自动监控配置保存失败", "error");
    } finally {
      setSaving(false);
    }
  };

  const channels = [
    {
      title: "推荐流",
      description: "视频扫描、点赞、收藏",
      active: Boolean(config?.enabled && config.auto_monitor_feed),
      icon: RefreshCw,
    },
    {
      title: "好友私信",
      description: "新消息监听、自动回复",
      active: Boolean(config?.enabled && config.auto_monitor_friends),
      icon: Users,
    },
    {
      title: "通知回复",
      description: "评论通知、回复处理",
      active: Boolean(config?.enabled && config.auto_monitor_notices),
      icon: Bell,
    },
    {
      title: "评论区",
      description: "评论分析、跟评辅助",
      active: Boolean(config?.enabled && config.auto_monitor_comments),
      icon: MessageSquare,
    },
  ];

  const actions = [
    { label: "评论", active: Boolean(config?.auto_send_comments), icon: Send },
    { label: "私信", active: Boolean(config?.auto_send_private_messages), icon: Send },
    { label: "点赞", active: Boolean(config?.auto_like), icon: ThumbsUp },
    { label: "收藏", active: Boolean(config?.auto_collect), icon: Star },
    { label: "上下文保护", active: Boolean(config?.auto_require_context), icon: ShieldCheck },
  ];

  const toggleFeedAutomation = () => {
    if (feedAutomationRunning) {
      setFeedAutomationRunning(false);
      return;
    }
    if (!config?.enabled) {
      addLog("推荐流自动刷视频无法开始：自动监控总开关未开启", "warning");
      return;
    }
    if (!config.auto_monitor_feed) {
      addLog("推荐流自动刷视频无法开始：推荐流监控未开启", "warning");
      return;
    }
    if (!config.auto_like && !config.auto_collect) {
      addLog("推荐流自动刷视频无法开始：点赞/收藏动作未开启", "warning");
      return;
    }
    setSourceFilter("feed");
    setFeedAutomationRunning(true);
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col select-text">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Activity className="h-3.5 w-3.5 text-accent" />
            <h3 className="text-[0.88rem] font-semibold text-text">自动后台监测与过滤</h3>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <StatPill label="状态" value={config?.enabled ? "运行中" : "已暂停"} />
            <StatPill label="通道" value={`${monitorCount}/4`} />
            <StatPill label="动作" value={`${actionCount}/4`} />
            <StatPill label="最近" value={formatTime(lastLogTime)} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => void loadConfig()} disabled={loading} className="h-7 px-2.5 text-[0.72rem]">
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            同步
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} disabled={!config} className="h-7 px-2.5 text-[0.72rem]">
            <Settings2 className="h-3.5 w-3.5" />
            设置
          </Button>
        </div>
      </div>

      <div className="mb-3 grid gap-3 lg:grid-cols-[1.02fr_0.98fr]">
        <SectionSurface density="compact" tone="muted" className="lg:col-span-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <PanelTitle icon={RefreshCw} title="推荐流自动刷视频" detail={feedAutomationRunning ? "运行中" : "已停止"} />
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.66rem] text-text-muted">
                <span>动作：{config?.auto_like ? "点赞" : "不点赞"} / {config?.auto_collect ? "收藏" : "不收藏"}</span>
                <span>间隔：{config?.auto_scan_interval_seconds ?? 30}s</span>
                <span>单轮：{config?.auto_max_actions_per_run ?? 5} 条</span>
                <span className={cn(feedActionReady ? "text-success" : "text-warning")}>
                  {feedActionReady ? "配置就绪" : "需要开启总开关、推荐流和点赞/收藏"}
                </span>
              </div>
            </div>
            <Button
              variant={feedAutomationRunning ? "outline" : "default"}
              size="sm"
              onClick={toggleFeedAutomation}
              disabled={!config}
              className="shrink-0"
            >
              {feedAutomationRunning ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {feedAutomationRunning ? "停止" : "开始"}
            </Button>
          </div>
        </SectionSurface>

        <SectionSurface density="compact" tone="muted">
          <PanelTitle icon={Activity} title="监控状态" detail="后台任务" />
          <div className="divide-y divide-border">
            {channels.map(({ title, description, active, icon: Icon }) => (
              <div key={title} className="flex items-center justify-between gap-3 py-2">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-raised text-text-muted">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[0.76rem] font-semibold text-text">{title}</span>
                    <span className="block truncate text-[0.64rem] text-text-muted">{description}</span>
                  </span>
                </div>
                <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[0.62rem] font-semibold", active ? "bg-success-soft text-success" : "bg-surface-raised text-text-muted")}>
                  {active ? "开启" : "关闭"}
                </span>
              </div>
            ))}
          </div>
        </SectionSurface>

        <SectionSurface density="compact" tone="muted">
          <PanelTitle icon={Filter} title="规则摘要" detail="过滤与限流" />
          <div className="divide-y divide-border">
            <LineItem label="扫描间隔" value={`${config?.auto_scan_interval_seconds ?? 30}s`} />
            <LineItem label="单轮上限" value={`${config?.auto_max_actions_per_run ?? 5} 条`} />
            <LineItem label="发送延迟" value={`${config?.auto_send_delay_ms ?? 0}ms`} />
            {filterRows.map(({ label, match, exclude }) => (
              <LineItem
                key={label}
                label={label}
                value={`匹配 ${match.length ? match.join("、") : "不限"} · 排除 ${exclude.length ? exclude.join("、") : "无"}`}
              />
            ))}
            <LineItem
              label="执行动作"
              value={
                <span className="inline-flex max-w-full flex-wrap justify-end gap-x-2 gap-y-1">
                  {actions.filter((item) => item.active).length
                    ? actions.filter((item) => item.active).map(({ label }) => <span key={label}>{label}</span>)
                    : "未开启"}
                </span>
              }
            />
          </div>
        </SectionSurface>
      </div>

      <SectionSurface density="compact" tone="muted">
        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <PanelTitle icon={Search} title="监测日志" detail={`${automationLogs.length} 条`} />
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-[9px] bg-surface p-0.5">
              {(Object.keys(SOURCE_LABELS) as MonitorSource[]).map((source) => (
                <button
                  key={source}
                  type="button"
                  onClick={() => setSourceFilter(source)}
                  className={cn(
                    "rounded-[7px] px-2 py-0.5 text-[0.64rem] font-semibold transition-colors",
                    sourceFilter === source ? "bg-surface-raised text-text" : "text-text-muted hover:text-text"
                  )}
                >
                  {SOURCE_LABELS[source]}
                </button>
              ))}
            </div>
            <Button variant="ghost" size="sm" onClick={clearLogs} className="h-6 px-2 text-[0.66rem]">
              清空
            </Button>
          </div>
        </div>

        <ScrollArea className="h-[240px] rounded-[var(--radius-md)] border border-border bg-surface/30 px-2.5 py-1.5 font-mono text-[0.68rem]">
          <div className="space-y-1">
            {automationLogs.length > 0 ? (
              automationLogs.map((log) => (
                <div key={log.id} className="grid grid-cols-[70px_46px_minmax(0,1fr)] items-start gap-2.5 rounded-[7px] py-1 hover:bg-surface-raised/45">
                  <span className="select-none text-text-muted">{formatDateTime(log.timestamp)}</span>
                  <span className="select-none text-text-muted">{SOURCE_LABELS[(log.source || "all") as MonitorSource]}</span>
                  <span className="min-w-0 break-words leading-relaxed text-text-secondary">{log.message}</span>
                </div>
              ))
            ) : (
              <div className="flex h-[200px] flex-col items-center justify-center text-center select-none">
                <Clock3 className="mb-2 h-5 w-5 text-text-muted/70" />
                <div className="text-[0.76rem] font-semibold text-text">暂无监控日志</div>
                <div className="mt-1 text-[0.66rem] text-text-muted">后台监控触发后会显示在这里。</div>
              </div>
            )}
          </div>
        </ScrollArea>
      </SectionSurface>

      <AutomationSettingsDialog
        open={settingsOpen}
        config={config}
        saving={saving}
        onOpenChange={setSettingsOpen}
        onSave={saveAutomation}
      />
    </div>
  );
}
