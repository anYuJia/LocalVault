import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Clipboard,
  Eye,
  EyeOff,
  KeyRound,
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
      className="flex w-full items-center justify-between gap-4 rounded-[8px] border border-border bg-surface/30 px-3 py-3 text-left transition-colors hover:bg-surface/60 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-[0.78rem] font-semibold text-text">{title}</span>
        <span className="mt-0.5 block text-[0.66rem] leading-relaxed text-text-muted">{description}</span>
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
          checked
            ? danger
              ? "border-danger bg-danger"
              : "border-accent bg-accent"
            : "border-border bg-subtle-bg"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform",
            checked ? "translate-x-[17px]" : "translate-x-0.5"
          )}
        />
      </span>
    </button>
  );
}

function GuideCommand({
  label,
  description,
  command,
  copied,
  onCopy,
  copyLabel = `${label}配置`,
  disabled = false,
}: {
  label: string;
  description: string;
  command: string;
  copied: boolean;
  onCopy: () => void;
  copyLabel?: string;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-[8px] border border-border bg-surface/30 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[0.72rem] font-semibold text-text">{label}</div>
          <div className="mt-0.5 text-[0.62rem] leading-relaxed text-text-muted">{description}</div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={onCopy}
          disabled={disabled}
          title={copied ? `${copyLabel}已复制` : `复制${copyLabel}`}
          aria-label={copied ? `${copyLabel}已复制` : `复制${copyLabel}`}
        >
          {copied
            ? <CheckCircle2 className="h-3.5 w-3.5 text-success" />
            : <Clipboard className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <code className="mt-2 block overflow-x-auto whitespace-pre-wrap break-all rounded bg-subtle-bg px-2 py-1.5 font-mono text-[0.62rem] leading-relaxed text-text-secondary">
        {command}
      </code>
    </div>
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

  const mcpEndpoint = connection?.endpoint || status?.endpoint || "http://127.0.0.1:<实际端口>/mcp";
  const mcpToken = connection?.token || "";
  const httpMcpConfig = `URL: ${mcpEndpoint}\nHeader: Authorization: Bearer ${mcpToken || "<服务启动后显示令牌>"}`;
  const visibleLogs = logs.slice(0, visibleLogLimit);
  const hiddenLogCount = Math.max(0, logs.length - visibleLogs.length);

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
          <ToggleRow
            title="启用本地 MCP 服务"
            description="仅监听 127.0.0.1；首选端口占用时自动尝试后续 32 个端口。"
            checked={config.enabled}
            onChange={(enabled) => void patchConfig({ enabled })}
            disabled={saving}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-[0.72rem] font-semibold text-text-secondary">首选端口</span>
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
                className="h-9 font-mono text-[0.78rem]"
              />
            </label>
            <div className="rounded-[8px] border border-border bg-surface/30 px-3 py-2">
              <div className="text-[0.68rem] text-text-muted">运行状态</div>
              <div className="mt-1 flex items-center gap-2 text-[0.78rem] font-semibold">
                {status?.running
                  ? <CheckCircle2 className="h-4 w-4 text-success" />
                  : <XCircle className="h-4 w-4 text-text-muted" />}
                <span className={status?.running ? "text-success" : "text-text-secondary"}>
                  {status?.running ? `运行中 · ${status.port}` : config.enabled ? "启动失败或等待中" : "未启用"}
                </span>
              </div>
              <div className="mt-1 text-[0.64rem] text-text-muted">{status?.tool_count || 0} 个工具可用</div>
            </div>
          </div>
          {status?.last_error && (
            <div className="rounded-[8px] border border-danger/30 bg-danger/10 px-3 py-2 text-[0.7rem] text-danger">
              {status.last_error}
            </div>
          )}
        </div>
      </SettingGroup>

      <SettingGroup icon={ShieldCheck} label="写操作安全">
        <div className="space-y-2.5">
          <ToggleRow
            title="允许下载、点赞、收藏、关注和私信"
            description="关闭时所有修改账号或本地状态的工具都会返回 WRITE_DISABLED。"
            checked={config.allow_write_actions}
            onChange={(allow_write_actions) => void patchConfig({ allow_write_actions })}
            danger
            disabled={saving}
          />
          <ToggleRow
            title="每次写操作要求显式确认"
            description="开启后调用参数必须包含 confirm=true，可防止 AI 误触发。"
            checked={config.require_confirmation}
            onChange={(require_confirmation) => void patchConfig({ require_confirmation })}
            disabled={saving}
          />
        </div>
      </SettingGroup>

      <SettingGroup icon={KeyRound} label="连接信息">
        <div className="space-y-2.5">
          <div className="flex gap-2">
            <Input readOnly value={connection?.endpoint || status?.endpoint || "服务启动后显示地址"} className="h-9 font-mono text-[0.7rem]" />
            <Button variant="outline" size="icon" disabled={!connection?.endpoint} onClick={() => void copyText(connection?.endpoint || "", "地址")} title="复制 MCP 地址">
              <Clipboard className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Input readOnly type={showToken ? "text" : "password"} value={connection?.token || ""} placeholder="服务启动后显示令牌" className="h-9 font-mono text-[0.7rem]" />
            <Button
              variant="outline"
              size="icon"
              disabled={!connection?.token}
              onClick={() => setShowToken((current) => !current)}
              title={showToken ? "隐藏 Bearer 令牌" : "显示 Bearer 令牌"}
              aria-label={showToken ? "隐藏 Bearer 令牌" : "显示 Bearer 令牌"}
            >
              {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
            <Button variant="outline" size="icon" disabled={!connection?.token} onClick={() => void copyText(connection?.token || "", "令牌")} title="复制 Bearer 令牌">
              <Clipboard className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="icon" disabled={saving} onClick={() => void rotateToken()} title="重新生成令牌">
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.66rem] text-text-muted">支持兼容 Streamable HTTP MCP 的 AI 客户端。</span>
            <Button
              variant="outline"
              size="sm"
              disabled={saving || !config.enabled}
              onClick={() => void restartServer()}
            >
              <RefreshCw className={cn("h-3.5 w-3.5", saving && "animate-spin")} />
              重启服务
            </Button>
          </div>

          <div className="space-y-2">
            <div className="text-[0.68rem] font-semibold text-text-secondary">HTTP MCP 接入</div>
            <GuideCommand
              label="HTTP MCP"
              description="复制后可直接粘贴到 AI 客户端，已包含当前实际 Endpoint 和 Bearer Token。"
              command={httpMcpConfig}
              copied={copiedText === httpMcpConfig}
              onCopy={() => void copyText(httpMcpConfig, "HTTP MCP 配置")}
              copyLabel="HTTP MCP 配置"
            />
            <GuideCommand
              label="Bearer Token"
              description="只复制密钥本身，适合客户端单独填写 Authorization Token 的场景。"
              command={mcpToken || "服务启动后显示令牌"}
              copied={Boolean(mcpToken) && copiedText === mcpToken}
              onCopy={() => {
                if (!mcpToken) return;
                void copyText(mcpToken, "Bearer Token");
              }}
              copyLabel="Bearer Token"
              disabled={!mcpToken}
            />
          </div>
        </div>
      </SettingGroup>

      <SettingGroup icon={Activity} label="调用日志">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[0.68rem] text-text-muted">
              仅拉取最近 {visibleLogLimit} 条，当前显示 {visibleLogs.length} 条；最多保留 {config.log_retention} 条，只记录字段名，不记录 Cookie、Token 或正文。
            </span>
            <Button variant="ghost" size="sm" disabled={logs.length === 0} onClick={() => void clearLogs()}>
              <Trash2 className="h-3.5 w-3.5" />
              清空
            </Button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <label className="flex items-center gap-2 rounded-[8px] border border-border bg-surface/20 px-3 py-2">
              <span className="shrink-0 text-[0.64rem] font-semibold text-text-secondary">最多保留</span>
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
            <div className="flex items-center gap-1 rounded-[8px] border border-border bg-surface/20 p-1">
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
            {hiddenLogCount > 0 && (
              <div className="px-3 py-2 text-center text-[0.62rem] text-text-muted">
                已隐藏 {hiddenLogCount} 条较早记录，可切换显示数量或清空日志。
              </div>
            )}
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
