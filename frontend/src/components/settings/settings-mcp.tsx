import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clipboard,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearMcpLogs,
  copyTextToClipboard,
  getConfig,
  getMcpConnectionInfo,
  getMcpLogs,
  getMcpStatus,
  regenerateMcpToken,
  restartMcpServer,
  saveConfig,
} from "@/lib/tauri";
import type { McpConfig, McpConnectionInfo, McpLogEntry, McpStatus } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { SettingGroup } from "./settings-components";

const DEFAULT_CONFIG: McpConfig = {
  enabled: false,
  preferred_port: 39144,
  allow_write_actions: false,
  require_confirmation: true,
  log_retention: 300,
};

const LOG_LIMIT_OPTIONS = [20, 50, 100] as const;

function ToggleRow({
  title,
  description,
  checked,
  onChange,
  danger = false,
  disabled = false,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center justify-between gap-4 rounded-[8px] border border-border bg-surface/30 px-3 py-3 text-left transition-colors hover:bg-surface/60 disabled:cursor-not-allowed disabled:opacity-60",
        checked && danger && "border-danger/25 bg-danger/5"
      )}
    >
      <span className="min-w-0">
        <span className="block text-[0.78rem] font-semibold text-text">{title}</span>
        <span className="mt-0.5 block text-[0.66rem] leading-relaxed text-text-muted">{description}</span>
      </span>
      <span
        className={cn(
          "flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors",
          checked
            ? danger
              ? "border-danger bg-danger"
              : "border-accent bg-accent"
            : "border-border bg-subtle-bg"
        )}
      >
        <span
          className={cn(
            "h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-[margin]",
            checked ? "ml-auto" : "ml-0"
          )}
        />
      </span>
    </button>
  );
}

function MiniBadge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "success" | "danger" | "info" | "muted";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-[0.64rem] font-semibold tabular-nums",
        tone === "success" && "border-success/20 bg-success-soft text-success",
        tone === "danger" && "border-danger/20 bg-danger-soft text-danger",
        tone === "info" && "border-info/20 bg-info-soft text-info",
        tone === "muted" && "border-border bg-surface-raised/70 text-text-muted"
      )}
    >
      {children}
    </span>
  );
}

function formatLogTime(timestamp: string) {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) return timestamp;
  return value.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function SettingsMcpTab() {
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const [config, setConfig] = useState<McpConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [connection, setConnection] = useState<McpConnectionInfo | null>(null);
  const [logs, setLogs] = useState<McpLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [visibleLogLimit, setVisibleLogLimit] = useState<(typeof LOG_LIMIT_OPTIONS)[number]>(50);
  const copyResetTimerRef = useRef<number | null>(null);

  const refreshRuntime = useCallback(async () => {
    const [nextStatus, nextLogs] = await Promise.all([
      getMcpStatus(),
      getMcpLogs(visibleLogLimit).catch(() => []),
    ]);
    setStatus(nextStatus);
    setLogs(nextLogs);
    if (!nextStatus.running) {
      setConnection(null);
      return;
    }
    try {
      setConnection(await getMcpConnectionInfo());
    } catch {
      // Keep the last valid credentials during a transient local bridge failure.
    }
  }, [visibleLogLimit]);

  useEffect(() => {
    let disposed = false;
    Promise.all([getConfig(), getMcpStatus(), getMcpLogs(visibleLogLimit).catch(() => [])])
      .then(async ([appConfig, nextStatus, nextLogs]) => {
        const nextConnection = nextStatus.running
          ? await getMcpConnectionInfo().catch(() => null)
          : null;
        if (disposed) return;
        setConfig({ ...DEFAULT_CONFIG, ...(appConfig.mcp || {}) });
        setStatus(nextStatus);
        setLogs(nextLogs);
        setConnection(nextConnection);
      })
      .catch((error) => {
        if (!disposed) toastRef.current.error(error instanceof Error ? error.message : "加载 MCP 配置失败", "加载失败");
      })
      .finally(() => !disposed && setLoading(false));
    const timer = window.setInterval(() => void refreshRuntime().catch(() => undefined), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [refreshRuntime, visibleLogLimit]);

  useEffect(() => () => {
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const patchConfig = async (patch: Partial<McpConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    setSaving(true);
    try {
      const result = await saveConfig({ mcp: next });
      if (!result.success) throw new Error(result.message || "保存 MCP 配置失败");
      await refreshRuntime();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存 MCP 配置失败", "保存失败");
      const latest = await getConfig().catch(() => null);
      if (latest?.mcp) setConfig({ ...DEFAULT_CONFIG, ...latest.mcp });
    } finally {
      setSaving(false);
    }
  };

  const copyText = async (value: string, label: string) => {
    try {
      const copied = await copyTextToClipboard(value);
      if (!copied) throw new Error(`${label}复制失败，请手动选择文本复制`);
      setCopiedText(value);
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedText(null);
        copyResetTimerRef.current = null;
      }, 2000);
      toast.success(`${label}已复制`, "已复制");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `${label}复制失败`, "复制失败");
    }
  };

  const rotateToken = async () => {
    setSaving(true);
    try {
      const result = await regenerateMcpToken();
      setConnection((current) => current ? { ...current, token: result.token } : current);
      setShowToken(false);
      await refreshRuntime();
      toast.success("旧令牌已立即失效", "令牌已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "更新令牌失败", "更新失败");
    } finally {
      setSaving(false);
    }
  };

  const restartServer = async () => {
    setSaving(true);
    try {
      await restartMcpServer();
      await refreshRuntime();
      toast.success("MCP 服务已重新启动", "重启成功");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重启 MCP 服务失败", "重启失败");
    } finally {
      setSaving(false);
    }
  };

  const clearLogs = async () => {
    try {
      await clearMcpLogs();
      setLogs([]);
      toast.success("调用日志已清空", "清理完成");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清空调用日志失败", "清理失败");
    }
  };

  const running = Boolean(status?.running);
  const mcpEndpoint = connection?.endpoint || status?.endpoint || "";
  const imWsEndpoint = connection?.im_ws_endpoint || "";
  const mcpToken = connection?.token || "";
  const httpMcpConfig = mcpEndpoint && mcpToken
    ? `URL: ${mcpEndpoint}\nHeader: Authorization: Bearer ${mcpToken}`
    : "";
  const imWsConfig = imWsEndpoint && mcpToken
    ? `WS: ${imWsEndpoint}\nHeader: Authorization: Bearer ${mcpToken}`
    : "";
  const endpointDisplay = mcpEndpoint || "启用服务后显示地址";
  const imWsDisplay = imWsEndpoint || "启用服务后显示实时私信 WS 地址";
  const statusLabel = running ? `运行中 · ${status?.port}` : config.enabled ? "等待启动" : "未启用";
  const statusDescription = running
    ? "本机 HTTP MCP 已可连接。"
    : config.enabled
      ? "服务正在启动，若失败会在这里显示原因。"
      : "开启后 AI 客户端可通过本机地址调用工具。";
  const visibleLogs = logs.slice(0, visibleLogLimit);

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center text-text-muted">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SettingGroup icon={SquareTerminal} label="AI 工具接入">
        <div className="space-y-3">
          <div className="rounded-[10px] border border-border bg-surface/35 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[0.84rem] font-semibold">
                  {running
                    ? <CheckCircle2 className="h-4 w-4 text-success" />
                    : <XCircle className="h-4 w-4 text-text-muted" />}
                  <span className={running ? "text-success" : "text-text-secondary"}>{statusLabel}</span>
                </div>
                <div className="mt-1 text-[0.66rem] leading-relaxed text-text-muted">{statusDescription}</div>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                <MiniBadge tone={running ? "success" : "muted"}>{status?.tool_count || 0} 个工具</MiniBadge>
                <MiniBadge tone="info">127.0.0.1</MiniBadge>
                <MiniBadge tone={config.allow_write_actions ? "danger" : "success"}>
                  {config.allow_write_actions ? "写操作开启" : "默认只读"}
                </MiniBadge>
              </div>
            </div>

            <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className={cn("grid min-w-0 gap-2", imWsEndpoint && "sm:grid-cols-2")}>
                <div className="min-w-0 rounded-[8px] border border-border bg-subtle-bg/70 px-3 py-2">
                  <div className="text-[0.58rem] font-semibold uppercase tracking-[0.08em] text-text-muted">MCP Endpoint</div>
                  <div className="mt-1 truncate font-mono text-[0.68rem] text-text-secondary" title={endpointDisplay}>
                    {endpointDisplay}
                  </div>
                </div>
                {imWsEndpoint && (
                  <div className="min-w-0 rounded-[8px] border border-border bg-subtle-bg/70 px-3 py-2">
                    <div className="text-[0.58rem] font-semibold uppercase tracking-[0.08em] text-text-muted">实时私信 WS</div>
                    <div className="mt-1 truncate font-mono text-[0.68rem] text-text-secondary" title={imWsDisplay}>
                      {imWsDisplay}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={!httpMcpConfig}
                  onClick={() => void copyText(httpMcpConfig, "客户端配置")}
                  title="复制 URL 和 Authorization Header"
                >
                  {copiedText === httpMcpConfig
                    ? <CheckCircle2 className="h-3.5 w-3.5" />
                    : <Clipboard className="h-3.5 w-3.5" />}
                  {copiedText === httpMcpConfig ? "已复制" : "复制配置"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!mcpEndpoint}
                  onClick={() => void copyText(mcpEndpoint, "地址")}
                  title="复制 MCP 地址"
                >
                  <Clipboard className="h-3.5 w-3.5" />
                  地址
                </Button>
                {imWsEndpoint && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!imWsConfig}
                    onClick={() => void copyText(imWsConfig, "实时私信 WS 配置")}
                    title="复制实时私信 WebSocket 地址和 Authorization Header"
                  >
                    {copiedText === imWsConfig
                      ? <CheckCircle2 className="h-3.5 w-3.5" />
                      : <Clipboard className="h-3.5 w-3.5" />}
                    WS
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || !config.enabled}
                  onClick={() => void restartServer()}
                  title="重启 MCP 服务"
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", saving && "animate-spin")} />
                  重启
                </Button>
              </div>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <ToggleRow
              title="启用本地 MCP 服务"
              description="仅监听本机；端口占用时自动向后探测。"
              checked={config.enabled}
              onChange={(enabled) => void patchConfig({ enabled })}
              disabled={saving}
            />
            <label className="rounded-[8px] border border-border bg-surface/30 px-3 py-2">
              <span className="text-[0.68rem] font-semibold text-text-secondary">首选端口</span>
              <Input
                type="number"
                min={1}
                max={65535}
                value={config.preferred_port}
                onChange={(event) => setConfig((current) => ({
                  ...current,
                  preferred_port: Number(event.target.value) || 39144,
                }))}
                onBlur={() => void patchConfig({ preferred_port: config.preferred_port })}
                disabled={saving}
                className="mt-1 h-8 font-mono text-[0.76rem]"
              />
            </label>
          </div>

          <div className="rounded-[8px] border border-border bg-surface/30 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[0.72rem] font-semibold text-text-secondary">Bearer Token</div>
              <div className="text-[0.62rem] text-text-muted">轮换后旧令牌立即失效</div>
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                readOnly
                type={showToken ? "text" : "password"}
                value={mcpToken}
                placeholder="服务启动后显示令牌"
                className="h-9 font-mono text-[0.7rem]"
              />
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-[8px]"
                disabled={!mcpToken}
                onClick={() => setShowToken((current) => !current)}
                title={showToken ? "隐藏 Bearer 令牌" : "显示 Bearer 令牌"}
                aria-label={showToken ? "隐藏 Bearer 令牌" : "显示 Bearer 令牌"}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-[8px]"
                disabled={!mcpToken}
                onClick={() => void copyText(mcpToken, "令牌")}
                title="复制 Bearer 令牌"
                aria-label="复制 Bearer 令牌"
              >
                {Boolean(mcpToken) && copiedText === mcpToken
                  ? <CheckCircle2 className="h-4 w-4 text-success" />
                  : <Clipboard className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 rounded-[8px]"
                disabled={saving}
                onClick={() => void rotateToken()}
                title="重新生成令牌"
                aria-label="重新生成令牌"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {status?.last_error && (
            <div className="rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-[0.7rem] text-danger">
              {status.last_error}
            </div>
          )}
        </div>
      </SettingGroup>

      <SettingGroup icon={ShieldCheck} label="权限与安全">
        <div className="grid gap-2.5 sm:grid-cols-2">
          <ToggleRow
            title="允许写操作"
            description="下载、点赞、收藏、关注、私信等工具才会真正执行。"
            checked={config.allow_write_actions}
            onChange={(allow_write_actions) => void patchConfig({ allow_write_actions })}
            danger
            disabled={saving}
          />
          <ToggleRow
            title="要求 confirm=true"
            description="AI 每次调用写操作都必须显式确认。"
            checked={config.require_confirmation}
            onChange={(require_confirmation) => void patchConfig({ require_confirmation })}
            disabled={saving}
          />
        </div>
      </SettingGroup>

      <SettingGroup icon={Activity} label="调用日志">
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-[0.72rem] font-semibold text-text-secondary">{visibleLogs.length} 条最近调用</div>
              <div className="mt-0.5 text-[0.62rem] text-text-muted">脱敏记录工具名、字段摘要、耗时和错误码。</div>
            </div>
            <Button variant="ghost" size="sm" disabled={logs.length === 0} onClick={() => void clearLogs()}>
              <Trash2 className="h-3.5 w-3.5" />
              清空
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="flex items-center gap-2 rounded-[8px] border border-border bg-surface/20 px-3 py-2">
              <span className="shrink-0 text-[0.64rem] font-semibold text-text-secondary">保留条数</span>
              <Input
                type="number"
                min={50}
                max={2000}
                value={config.log_retention}
                onChange={(event) => setConfig((current) => ({
                  ...current,
                  log_retention: Math.max(50, Math.min(2000, Number(event.target.value) || 300)),
                }))}
                onBlur={() => void patchConfig({ log_retention: config.log_retention })}
                disabled={saving}
                className="h-8 font-mono text-[0.72rem]"
              />
              <span className="text-[0.62rem] text-text-muted">50-2000</span>
            </label>
            <div className="flex items-center gap-1 rounded-[8px] border border-border bg-surface/20 p-1" aria-label="日志显示数量">
              {LOG_LIMIT_OPTIONS.map((limit) => (
                <button
                  key={limit}
                  type="button"
                  onClick={() => setVisibleLogLimit(limit)}
                  className={cn(
                    "rounded px-2 py-1 text-[0.62rem] font-semibold transition-colors",
                    visibleLogLimit === limit
                      ? "bg-accent text-white"
                      : "text-text-muted hover:bg-surface/60 hover:text-text"
                  )}
                >
                  {limit}
                </button>
              ))}
            </div>
          </div>
          <div className="max-h-72 overflow-auto rounded-[8px] border border-border">
            {logs.length === 0 ? (
              <div className="px-3 py-8 text-center text-[0.7rem] text-text-muted">暂无调用记录</div>
            ) : visibleLogs.map((entry, index) => (
              <div key={`${entry.timestamp}-${index}`} className="grid grid-cols-[auto_1fr_auto] gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
                {entry.success
                  ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-success" />
                  : <XCircle className="mt-0.5 h-3.5 w-3.5 text-danger" />}
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-[0.68rem] text-text">{entry.tool_name}</span>
                    <span className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[0.56rem] font-semibold",
                      entry.success ? "bg-success/10 text-success" : "bg-danger/10 text-danger"
                    )}>
                      {entry.success ? "成功" : entry.error_code || "失败"}
                    </span>
                  </div>
                  <div className="truncate text-[0.62rem] text-text-muted">
                    {entry.transport} · {entry.client_name} · {entry.argument_summary}
                  </div>
                  {!entry.success && entry.message && (
                    <div className="mt-0.5 truncate text-[0.6rem] text-danger" title={entry.message}>
                      {entry.message}
                    </div>
                  )}
                </div>
                <div className="text-right text-[0.6rem] tabular-nums text-text-muted">
                  <div>{formatLogTime(entry.timestamp)}</div>
                  <div>{entry.elapsed_ms}ms</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
