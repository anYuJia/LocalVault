import { useState } from "react";
import {
  CircleAlert,
  CheckCircle2,
  Clipboard,
  Clock3,
  KeyRound,
  Loader2,
  MessageSquare,
  Server,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";
import { copyTextToClipboard } from "@/lib/tauri";
import type { AiProviderPreset } from "@/lib/contracts";
import { SettingGroup } from "./settings-components";
import type { SettingStatus } from "./settings-utils";

interface SettingsAiTabProps {
  enabled: boolean;
  provider: string;
  providerPresets?: AiProviderPreset[];
  apiBase: string;
  apiKey: string;
  apiKeySet: boolean;
  model: string;
  systemPrompt: string;
  autoSendComments: boolean;
  autoSendPrivateMessages: boolean;
  autoLike: boolean;
  autoCollect: boolean;
  autoSendDelayMs: string;
  autoSendMaxChars: string;
  autoRequireContext: boolean;
  autoMonitorNotices: boolean;
  autoMonitorFriends: boolean;
  autoMonitorComments: boolean;
  autoMonitorFeed: boolean;
  autoMatchKeywords: string;
  autoExcludeKeywords: string;
  autoMinDiggCount: string;
  autoMinCommentCount: string;
  autoMinPlayCount: string;
  autoScanIntervalSeconds: string;
  autoMaxActionsPerRun: string;
  status?: SettingStatus;
  testStatus?: "idle" | "testing" | "success" | "error";
  testMessage?: string;
  onEnabledChange: (value: boolean) => void;
  onProviderChange: (value: string, preset?: AiProviderPreset) => void;
  onApiBaseChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onSystemPromptChange: (value: string) => void;
  onAutoSendCommentsChange: (value: boolean) => void;
  onAutoSendPrivateMessagesChange: (value: boolean) => void;
  onAutoLikeChange: (value: boolean) => void;
  onAutoCollectChange: (value: boolean) => void;
  onAutoSendDelayMsChange: (value: string) => void;
  onAutoSendMaxCharsChange: (value: string) => void;
  onAutoRequireContextChange: (value: boolean) => void;
  onAutoMonitorNoticesChange: (value: boolean) => void;
  onAutoMonitorFriendsChange: (value: boolean) => void;
  onAutoMonitorCommentsChange: (value: boolean) => void;
  onAutoMonitorFeedChange: (value: boolean) => void;
  onAutoMatchKeywordsChange: (value: string) => void;
  onAutoExcludeKeywordsChange: (value: string) => void;
  onAutoMinDiggCountChange: (value: string) => void;
  onAutoMinCommentCountChange: (value: string) => void;
  onAutoMinPlayCountChange: (value: string) => void;
  onAutoScanIntervalSecondsChange: (value: string) => void;
  onAutoMaxActionsPerRunChange: (value: string) => void;
  onSave: () => void;
  onTest: () => void;
}

function FieldLabel({ icon: Icon, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[0.74rem] font-semibold text-text-secondary mb-1.5 select-none">
      {Icon && <Icon className="h-3.5 w-3.5 text-text-muted" />}
      {children}
    </span>
  );
}

function MiniBadge({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
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

function normalizeProviderFormat(format?: string) {
  if (format === "anthropic_messages") return "anthropic_messages";
  if (format === "gemini_generate_content") return "gemini_generate_content";
  return "openai_chat";
}

function formatMeta(format: string) {
  if (format === "anthropic_messages") {
    return {
      label: "Anthropic Messages",
      endpoint: "/v1/messages",
      method: "POST",
      baseHint: "填写服务根地址即可，例如 https://api.anthropic.com；若是中转地址带 /anthropic/v1，也会直接请求 /messages。",
      modelHint: "模型名按服务商后台填写，不会因为模型名自动切换协议。",
    };
  }
  if (format === "gemini_generate_content") {
    return {
      label: "Gemini GenerateContent",
      endpoint: "models/{model}:generateContent",
      method: "POST",
      baseHint: "填写 Gemini API 根地址，例如 https://generativelanguage.googleapis.com/v1beta。",
      modelHint: "模型名会写进 URL 路径，包含斜杠时会自动编码。",
    };
  }
  return {
    label: "OpenAI Compatible",
    endpoint: "/v1/chat/completions",
    method: "POST",
    baseHint: "填写 OpenAI 兼容根地址；若只填域名，保存后会规范化到 /v1。",
    modelHint: "适合 OpenAI、DeepSeek、通义千问、硅基流动、火山/豆包等 Chat Completions 兼容接口。",
  };
}

function withScheme(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

function apiEndpointPreview(apiBase: string, model: string, format: string) {
  const baseInput = withScheme(apiBase);
  if (!baseInput) return "填写 Base URL 后显示实际请求地址";
  try {
    const url = new URL(baseInput);
    const base = url.toString().replace(/\/$/, "");
    if (format === "anthropic_messages") {
      if (base.endsWith("/v1/messages") || base.endsWith("/messages")) return base;
      if (base.endsWith("/v1")) return `${base}/messages`;
      return `${base}/v1/messages`;
    }
    if (format === "gemini_generate_content") {
      const encodedModel = encodeURIComponent(model.trim() || "{model}");
      return base.endsWith(`/models/${encodedModel}:generateContent`)
        ? base
        : `${base}/models/${encodedModel}:generateContent`;
    }
    if (base.endsWith("/v1/chat/completions") || base.endsWith("/chat/completions")) return base;
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  } catch {
    return "Base URL 格式不正确，无法预览实际请求地址";
  }
}

export function SettingsAiTab({
  enabled,
  provider,
  providerPresets = [],
  apiBase,
  apiKey,
  apiKeySet,
  model,
  systemPrompt,
  status,
  testStatus = "idle",
  testMessage = "",
  onEnabledChange,
  onProviderChange,
  onApiBaseChange,
  onApiKeyChange,
  onModelChange,
  onSystemPromptChange,
  onSave,
  onTest,
}: SettingsAiTabProps) {
  const saving = status === "saving";
  const testing = testStatus === "testing";
  const [copiedTestMessage, setCopiedTestMessage] = useState(false);
  const toast = useToast();
  const currentPreset = providerPresets.find((preset) => preset.id === provider);
  const providerOptions = providerPresets.length > 0
    ? providerPresets
    : [{ id: provider, label: provider || "OpenAI Compatible / Chat Completions", api_base: apiBase, default_model: model, format: "openai_chat" }];
  const selectedFormat = normalizeProviderFormat(currentPreset?.format || providerOptions.find((preset) => preset.id === provider)?.format);
  const meta = formatMeta(selectedFormat);
  const endpointPreview = apiEndpointPreview(apiBase, model, selectedFormat);
  const hasApiKey = apiKey.trim().length > 0 || apiKeySet;
  const keyStatusLabel = apiKey.trim() ? "新密钥待保存" : apiKeySet ? "密钥已保存" : "未设置密钥";
  const diagnosticText = [
    `请求格式：${meta.label}`,
    `模型：${model.trim() || "(未填写)"}`,
    `Base URL：${apiBase.trim() || "(未填写)"}`,
    `实际请求：${endpointPreview}`,
    testMessage.trim() ? `测试结果：${testMessage.trim()}` : "",
  ].filter(Boolean).join("\n");

  const copyTestMessage = async () => {
    if (!diagnosticText.trim()) return;
    const copied = await copyTextToClipboard(diagnosticText);
    setCopiedTestMessage(copied);
    if (copied) {
      toast.success("测试结果已复制", "已复制");
    } else {
      toast.error("复制失败", "复制失败");
    }
    if (copied) {
      window.setTimeout(() => setCopiedTestMessage(false), 1500);
    }
  };

  return (
    <div className="space-y-4">
      <SettingGroup icon={Sparkles} label="AI 互动" status={status}>
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className={cn(
              "flex w-full items-start justify-between gap-4 rounded-[10px] border p-3 transition-colors select-none cursor-pointer",
              enabled
                ? "border-accent/35 bg-accent/[0.06]"
                : "border-border bg-surface/30 hover:bg-surface/60"
            )}
          >
            <div className="flex min-w-0 items-start gap-3">
              <div className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] transition-colors",
                enabled ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-secondary"
              )}>
                <Sparkles className="h-4.5 w-4.5" />
              </div>
              <div className="min-w-0 text-left">
                <div className="text-[0.82rem] font-bold text-text">AI 智能互动</div>
                <div className="mt-0.5 text-[0.66rem] leading-normal text-text-muted">
                  生成评论草稿、私信回复和内容分析，配置后即可测试。
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MiniBadge tone={enabled ? "success" : "muted"}>{enabled ? "已启用" : "未启用"}</MiniBadge>
                  <MiniBadge tone="info">{meta.label}</MiniBadge>
                  <MiniBadge tone={hasApiKey ? "success" : "danger"}>{keyStatusLabel}</MiniBadge>
                </div>
              </div>
            </div>
            <span
              className={cn(
                "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border p-0.5 transition-colors",
                enabled ? "border-accent bg-accent" : "border-border bg-subtle-bg"
              )}
            >
              <span className={cn(
                "h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-[margin]",
                enabled ? "ml-auto" : "ml-0"
              )} />
            </span>
          </button>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col">
                <FieldLabel icon={Server}>请求格式</FieldLabel>
                <Select
                  value={provider}
                  onValueChange={(value) => onProviderChange(value, providerOptions.find((preset) => preset.id === value))}
                >
                  <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]">
                    <SelectValue placeholder="选择请求格式" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>

              <label className="flex flex-col">
                <FieldLabel icon={Sparkles}>模型</FieldLabel>
                <Input value={model} onChange={(event) => onModelChange(event.target.value)} placeholder="例如 gpt-4.1-mini" className="h-9 rounded-[8px] font-mono text-[0.78rem]" />
              </label>
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(220px,0.7fr)]">
              <label className="flex flex-col">
                <FieldLabel icon={Server}>Base URL</FieldLabel>
                <Input value={apiBase} onChange={(event) => onApiBaseChange(event.target.value)} placeholder="https://api.openai.com/v1" className="h-9 rounded-[8px] font-mono text-[0.78rem]" />
                <span className="mt-1.5 line-clamp-2 text-[0.64rem] leading-relaxed text-text-muted" title={meta.baseHint}>
                  {meta.baseHint}
                </span>
              </label>

              <label className="flex flex-col">
                <FieldLabel icon={KeyRound}>API Key</FieldLabel>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                  placeholder={apiKeySet ? "留空保留现有密钥" : "sk-..."}
                  autoComplete="off"
                  className="h-9 rounded-[8px] font-mono text-[0.78rem]"
                />
                <span className={cn("mt-1.5 inline-flex items-center gap-1 text-[0.64rem]", hasApiKey ? "text-success" : "text-danger")}>
                  {hasApiKey && <CheckCircle2 className="h-3.5 w-3.5" />}
                  {keyStatusLabel}
                </span>
              </label>
            </div>

            <div className="rounded-[8px] border border-border bg-subtle-bg/35 px-3 py-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-[0.66rem]">
                  <span className="rounded-full border border-border bg-surface px-2 py-0.5 font-semibold text-text-secondary">{meta.label}</span>
                  <span className="rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-text-muted">{meta.method}</span>
                  <span className="font-mono text-text-secondary">{meta.endpoint}</span>
                </div>
                <span className="text-[0.62rem] text-text-muted" title={meta.modelHint}>实际请求地址</span>
              </div>
              <div className="mt-2 min-w-0 truncate rounded-[6px] bg-surface px-2 py-1.5 font-mono text-[0.66rem] text-text-secondary select-text" title={endpointPreview}>
                {endpointPreview}
              </div>
            </div>
          </div>
        </div>
      </SettingGroup>

      <SettingGroup icon={MessageSquare} label="回复风格">
        <div className="space-y-2">
          <p className="text-[0.66rem] text-text-secondary leading-relaxed select-none">
            控制 AI 回复的口吻、边界和表达习惯，建议保持自然、友好、克制。
          </p>
          <Textarea
            value={systemPrompt}
            onChange={(event) => onSystemPromptChange(event.target.value)}
            placeholder="用自然、克制、友好的中文生成可编辑草稿。"
            className="min-h-28 resize-y rounded-[8px] text-[0.78rem] focus-visible:ring-accent"
          />
        </div>
      </SettingGroup>

      <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface/35 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-[0.7rem] text-text-muted select-none">
          <div className="flex items-center gap-1.5 font-medium text-text-secondary">
            <Clock3 className="h-3.5 w-3.5" />
            测试会先保存当前配置，再发起一次轻量模型请求
          </div>
          {testMessage && (
            <div className={cn(
              "mt-2 flex items-start gap-1.5 rounded-[6px] border px-2.5 py-2 leading-relaxed",
              testStatus === "success"
                ? "border-success/25 bg-success/[0.06] text-success"
                : testStatus === "error"
                  ? "border-danger/25 bg-danger/[0.06] text-danger"
                  : "border-border bg-subtle-bg/40 text-text-muted"
            )}>
              {testStatus === "success" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {testStatus === "error" && <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words select-text">{testMessage}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => void copyTestMessage()}
                className="-mr-1 -mt-1 h-7 w-7 shrink-0 rounded-[6px] text-current opacity-75 hover:opacity-100"
                title={copiedTestMessage ? "已复制测试结果" : "复制测试结果"}
                aria-label={copiedTestMessage ? "已复制测试结果" : "复制测试结果"}
              >
                {copiedTestMessage ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
              </Button>
            </div>
          )}
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:shrink-0 sm:items-center">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={saving || testing}
            className="h-9 rounded-[8px] px-2 text-[0.76rem] font-semibold gap-1.5 sm:px-4"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {testing ? "测试中" : "测试"}
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || testing}
            className="h-9 rounded-[8px] px-2 text-[0.76rem] font-semibold gap-1.5 shadow-sm transition-all active:scale-[0.98] cursor-pointer bg-accent text-white hover:bg-accent-hover sm:px-5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {saving ? "保存中" : "保存配置"}
          </Button>
        </div>
      </div>
    </div>
  );
}
