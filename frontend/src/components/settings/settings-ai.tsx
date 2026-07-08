import {
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquare,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { SettingGroup } from "./settings-components";
import type { SettingStatus } from "./settings-utils";

interface SettingsAiTabProps {
  enabled: boolean;
  provider: string;
  providerPresets?: any[];
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
  onProviderChange: (value: string) => void;
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

export function SettingsAiTab({
  enabled,
  provider,
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
  const setView = useAppStore((s) => s.setView);

  const normalized = provider.trim().toLowerCase().replace("-", "_");
  let currentFormat = "openai_chat";
  if (normalized.includes("anthropic") || normalized.includes("claude")) {
    currentFormat = "anthropic_messages";
  } else if (normalized.includes("gemini") || normalized.includes("google")) {
    currentFormat = "gemini_generate_content";
  }

  const handleFormatChange = (format: string) => {
    if (format === "anthropic_messages") {
      onProviderChange("anthropic");
      onApiBaseChange("https://api.anthropic.com/v1");
      onModelChange("claude-3-5-haiku-latest");
    } else if (format === "gemini_generate_content") {
      onProviderChange("gemini");
      onApiBaseChange("https://generativelanguage.googleapis.com/v1beta");
      onModelChange("gemini-1.5-flash");
    } else {
      onProviderChange("openai_compatible");
      onApiBaseChange("https://api.openai.com/v1");
      onModelChange("gpt-4o-mini");
    }
  };

  return (
    <div className="space-y-4">
      <SettingGroup icon={Sparkles} label="AI 建议与服务配置" status={status}>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className={cn(
              "flex w-full items-center justify-between rounded-[12px] border p-4 transition-all duration-300 select-none cursor-pointer transform active:scale-[0.99]",
              enabled
                ? "bg-gradient-to-r from-accent to-[#ff4d73] text-white border-transparent shadow-[0_12px_24px_-8px_rgba(254,44,85,0.4)]"
                : "border-border bg-zinc-50/50 dark:bg-zinc-900/40 hover:bg-zinc-100/80 dark:hover:bg-zinc-900/70"
            )}
          >
            <div className="flex items-center gap-3.5">
              <div className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
                enabled ? "bg-white/20 text-white" : "bg-zinc-100 dark:bg-zinc-800 text-text-secondary"
              )}>
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="text-left">
                <div className={cn("text-[0.84rem] font-bold tracking-wide", enabled ? "text-white" : "text-text")}>
                  启用 AI 智能交互建议
                </div>
                <div className={cn("text-[0.66rem] mt-0.5 leading-normal", enabled ? "text-white/85" : "text-text-muted")}>
                  启用后由大语言模型提供实时视频分析、私信回复与评论草稿生成。
                </div>
              </div>
            </div>
            <div className={cn(
              "rounded-full px-2.5 py-0.5 text-[0.62rem] font-black tracking-wider border transition-all duration-300",
              enabled ? "border-white/30 bg-white/20 text-white" : "border-border bg-subtle-bg text-text-muted"
            )}>
              {enabled ? "ACTIVE" : "OFFLINE"}
            </div>
          </button>

          <div className="space-y-3.5 pt-1">
            <div className="grid gap-3.5 sm:grid-cols-3">
              <label className="flex flex-col">
                <FieldLabel icon={Server}>提供商名字</FieldLabel>
                <Input value={provider} onChange={(event) => onProviderChange(event.target.value)} placeholder="例如：OpenAI, DeepSeek" className="h-9 text-[0.78rem] rounded-[8px]" />
              </label>

              <label className="flex flex-col">
                <FieldLabel icon={Server}>选择格式</FieldLabel>
                <Select value={currentFormat} onValueChange={handleFormatChange}>
                  <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai_chat">OpenAI Chat 格式</SelectItem>
                    <SelectItem value="anthropic_messages">Anthropic Messages 格式</SelectItem>
                    <SelectItem value="gemini_generate_content">Google Gemini 格式</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              <label className="flex flex-col">
                <FieldLabel icon={Sparkles}>输入模型名字</FieldLabel>
                <Input value={model} onChange={(event) => onModelChange(event.target.value)} placeholder="例如：gpt-4o-mini, deepseek-chat" className="h-9 text-[0.78rem] rounded-[8px] font-mono" />
              </label>
            </div>

            <label className="flex flex-col">
              <FieldLabel icon={Server}>Base URL 地址</FieldLabel>
              <Input value={apiBase} onChange={(event) => onApiBaseChange(event.target.value)} placeholder="https://api.openai.com/v1" className="h-9 text-[0.78rem] rounded-[8px] font-mono" />
            </label>

            <label className="flex flex-col">
              <FieldLabel icon={KeyRound}>API 密钥 (Key)</FieldLabel>
              <Input
                type="password"
                value={apiKey}
                onChange={(event) => onApiKeyChange(event.target.value)}
                placeholder={apiKeySet ? "已保存现有密钥；输入新密钥以覆盖配置" : "sk-..."}
                autoComplete="off"
                className="h-9 text-[0.78rem] rounded-[8px] font-mono"
              />
              {apiKeySet && !apiKey.trim() && (
                <span className="inline-flex items-center gap-1 mt-1.5 text-[0.68rem] text-success select-none">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  已配置有效密钥；若留空则继续使用已保存的值
                </span>
              )}
            </label>
          </div>
        </div>
      </SettingGroup>

      <SettingGroup icon={ShieldAlert} label="自动监控与过滤">
        <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface/25 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-[0.78rem] font-semibold text-text">监控配置已移至独立页面</div>
            <p className="mt-0.5 text-[0.66rem] leading-relaxed text-text-muted">
              自动动作、过滤规则、频率限制和监测日志统一在左侧「监控」中管理。
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setView("automation")} className="h-8 px-3">
            <Search className="h-3.5 w-3.5" />
            打开监控
          </Button>
        </div>
      </SettingGroup>

      <SettingGroup icon={MessageSquare} label="AI 行为准则与提示词 (System Prompt)">
        <div className="space-y-2">
          <p className="text-[0.66rem] text-text-secondary leading-relaxed select-none">
            自定义系统设定 (System Role) 指导 AI 生成的内容风格。建议保持自然、友好、生动的语言特征，避免过多营销语调。
          </p>
          <Textarea
            value={systemPrompt}
            onChange={(event) => onSystemPromptChange(event.target.value)}
            placeholder="用自然、克制、友好的中文生成可编辑草稿。"
            className="min-h-24 resize-y text-[0.78rem] rounded-[8px] focus-visible:ring-accent"
          />
        </div>
      </SettingGroup>

      <div className="flex items-center justify-between gap-3 p-3 rounded-[12px] border border-border bg-white/[0.01]">
        <div className="min-w-0 text-[0.7rem] text-text-muted select-none">
          <div>{enabled ? "AI 智能交互建议已开启" : "AI 智能交互建议已关闭 (未启用)"}</div>
          {testMessage && (
            <div className={cn(
              "mt-1 flex items-center gap-1.5 truncate",
              testStatus === "success" ? "text-success" : testStatus === "error" ? "text-destructive" : "text-text-muted"
            )}>
              {testStatus === "success" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
              {testStatus === "error" && <ShieldAlert className="h-3.5 w-3.5 shrink-0" />}
              <span className="truncate">{testMessage}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={onTest}
            disabled={saving || testing}
            className="h-9 rounded-[8px] px-4 text-[0.76rem] font-semibold gap-1.5"
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
            {testing ? "测试中" : "测试连接"}
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || testing}
            className="h-9 rounded-[8px] px-5 text-[0.76rem] font-semibold gap-1.5 shadow-sm transition-all active:scale-[0.98] cursor-pointer bg-accent text-white hover:bg-accent-hover"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {saving ? "保存中" : "保存 AI 配置"}
          </Button>
        </div>
      </div>
    </div>
  );
}
