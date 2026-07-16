import {
  CircleAlert,
  CheckCircle2,
  Clock3,
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
  const setView = useAppStore((s) => s.setView);
  const currentPreset = providerPresets.find((preset) => preset.id === provider);
  const providerOptions = providerPresets.length > 0
    ? providerPresets
    : [{ id: provider, label: provider || "OpenAI", api_base: apiBase, default_model: model, format: "openai_chat" }];
  const formatLabel = currentPreset?.format === "anthropic_messages"
    ? "Anthropic Messages"
    : currentPreset?.format === "gemini_generate_content"
      ? "Gemini GenerateContent"
      : "OpenAI Chat Completions";

  return (
    <div className="space-y-4">
      <SettingGroup icon={Sparkles} label="AI 建议与服务配置" status={status}>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => onEnabledChange(!enabled)}
            className={cn(
              "flex w-full items-center justify-between rounded-[8px] border p-3.5 transition-colors select-none cursor-pointer",
              enabled
                ? "border-accent/40 bg-accent/[0.07]"
                : "border-border bg-subtle-bg/45 hover:bg-subtle-bg/70"
            )}
          >
            <div className="flex items-center gap-3.5">
              <div className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors",
                enabled ? "bg-accent/15 text-accent" : "bg-zinc-100 dark:bg-zinc-800 text-text-secondary"
              )}>
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="text-left">
                <div className="text-[0.84rem] font-bold text-text">
                  启用 AI 智能交互建议
                </div>
                <div className="mt-0.5 text-[0.66rem] leading-normal text-text-muted">
                  启用后由大语言模型提供实时视频分析、私信回复与评论草稿生成。
                </div>
              </div>
            </div>
            <div className={cn(
              "rounded-full px-2.5 py-0.5 text-[0.62rem] font-semibold border transition-colors",
              enabled ? "border-success/30 bg-success/10 text-success" : "border-border bg-surface text-text-muted"
            )}>
              {enabled ? "已启用" : "未启用"}
            </div>
          </button>

          <div className="space-y-3.5 pt-1">
            <div className="grid gap-3.5 sm:grid-cols-2">
              <label className="flex flex-col">
                <FieldLabel icon={Server}>AI 提供商</FieldLabel>
                <Select
                  value={provider}
                  onValueChange={(value) => onProviderChange(value, providerOptions.find((preset) => preset.id === value))}
                >
                  <SelectTrigger className="h-9 text-[0.76rem] rounded-[8px]">
                    <SelectValue placeholder="选择提供商" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerOptions.map((preset) => (
                      <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
                    ))}
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
              <span className="mt-1.5 text-[0.66rem] text-text-muted">
                请求格式：{formatLabel}。填写 API 根地址，无需添加具体接口路径。
              </span>
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
                  已保存密钥；留空不会修改。切换提供商时需要填写对应的新密钥
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

      <div className="flex flex-col gap-3 rounded-[8px] border border-border bg-surface/35 p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 text-[0.7rem] text-text-muted select-none">
          <div className="flex items-center gap-1.5 font-medium text-text-secondary">
            <Clock3 className="h-3.5 w-3.5" />
            连接测试会保存当前配置并发起一次真实模型请求
          </div>
          {testMessage && (
            <div className={cn(
              "mt-2 flex items-start gap-1.5 rounded-[6px] border px-2.5 py-2 leading-relaxed",
              testStatus === "success"
                ? "border-success/25 bg-success/[0.06] text-success"
                : testStatus === "error"
                  ? "border-destructive/25 bg-destructive/[0.06] text-destructive"
                  : "border-border bg-subtle-bg/40 text-text-muted"
            )}>
              {testStatus === "success" && <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              {testStatus === "error" && <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0 whitespace-pre-wrap break-words">{testMessage}</span>
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
            {testing ? "测试中" : "测试连接"}
          </Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={saving || testing}
            className="h-9 rounded-[8px] px-2 text-[0.76rem] font-semibold gap-1.5 shadow-sm transition-all active:scale-[0.98] cursor-pointer bg-accent text-white hover:bg-accent-hover sm:px-5"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {saving ? "保存中" : "保存 AI 配置"}
          </Button>
        </div>
      </div>
    </div>
  );
}
