import {
  getConfig,
  setVideoCollected,
  setVideoLiked,
  type AiInteractionSuggestResponse,
  type AiInteractionConfig,
  type VideoInfo,
} from "@/lib/tauri";

export const DEFAULT_AI_AUTOMATION: Pick<
  AiInteractionConfig,
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
  | "auto_min_digg_count"
  | "auto_min_comment_count"
  | "auto_min_play_count"
  | "auto_scan_interval_seconds"
  | "auto_max_actions_per_run"
  | "auto_return_shared_media"
  | "auto_return_shared_allow_images"
  | "auto_return_shared_allow_videos"
  | "auto_return_shared_max_size_mb"
  | "auto_return_shared_max_media_count"
> = {
  auto_monitor_notices: false,
  auto_monitor_friends: false,
  auto_monitor_comments: false,
  auto_monitor_feed: false,
  auto_match_keywords: "",
  auto_exclude_keywords: "",
  auto_private_match_keywords: "",
  auto_private_exclude_keywords: "",
  auto_comment_match_keywords: "",
  auto_comment_exclude_keywords: "",
  auto_like_match_keywords: "",
  auto_like_exclude_keywords: "",
  auto_collect_match_keywords: "",
  auto_collect_exclude_keywords: "",
  auto_min_digg_count: 0,
  auto_min_comment_count: 0,
  auto_min_play_count: 0,
  auto_scan_interval_seconds: 30,
  auto_max_actions_per_run: 5,
  auto_return_shared_media: false,
  auto_return_shared_allow_images: true,
  auto_return_shared_allow_videos: true,
  auto_return_shared_max_size_mb: 20,
  auto_return_shared_max_media_count: 9,
};

export const AI_AUTOMATION_DEDUPE_LIMIT = 1000;

export function rememberAutomationKey(seen: Set<string>, key: string, limit = AI_AUTOMATION_DEDUPE_LIMIT) {
  const normalized = String(key || "").trim();
  if (!normalized || seen.has(normalized)) return false;

  seen.add(normalized);
  while (seen.size > limit) {
    const oldest = seen.values().next().value;
    if (oldest === undefined) break;
    seen.delete(oldest);
  }
  return true;
}

export function clampAutomationInterval(value: unknown) {
  const seconds = Math.floor(Number(value) || DEFAULT_AI_AUTOMATION.auto_scan_interval_seconds);
  return Math.max(10, Math.min(300, seconds));
}

export function clampAutomationBatch(value: unknown) {
  const count = Math.floor(Number(value) || DEFAULT_AI_AUTOMATION.auto_max_actions_per_run);
  return Math.max(1, Math.min(50, count));
}

export function getAiAutoSendDelayMs(value?: number) {
  const delay = Number(value ?? 0);
  if (!Number.isFinite(delay)) return 0;
  return Math.max(0, Math.min(10000, Math.trunc(delay)));
}

export function waitForAiAutoSend(delayMs: number) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
}

export function normalizeAiSuggestions(response: Pick<AiInteractionSuggestResponse, "draft" | "suggestions">) {
  const items = response.suggestions && response.suggestions.length > 0
    ? response.suggestions
    : [response.draft || ""];
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, 3);
}

export function normalizeAiAutomationConfig(config?: Partial<AiInteractionConfig> | null): AiInteractionConfig | null {
  if (!config) return null;
  return {
    ...DEFAULT_AI_AUTOMATION,
    ...config,
    auto_scan_interval_seconds: clampAutomationInterval(config.auto_scan_interval_seconds),
    auto_max_actions_per_run: clampAutomationBatch(config.auto_max_actions_per_run),
    auto_min_digg_count: Math.max(0, Number(config.auto_min_digg_count || 0)),
    auto_min_comment_count: Math.max(0, Number(config.auto_min_comment_count || 0)),
    auto_min_play_count: Math.max(0, Number(config.auto_min_play_count || 0)),
    auto_return_shared_max_size_mb: Math.max(1, Math.min(200, Math.trunc(Number(config.auto_return_shared_max_size_mb || 20)))),
    auto_return_shared_max_media_count: Math.max(1, Math.min(20, Math.trunc(Number(config.auto_return_shared_max_media_count || 9)))),
  } as AiInteractionConfig;
}

export async function readAiAutomationConfig() {
  const config = await getConfig().catch(() => null);
  return normalizeAiAutomationConfig(config?.ai_interaction);
}

export type AutomationFilterTarget = "private" | "comment" | "like" | "collect";

type AutomationKeywordConfig = Pick<
  AiInteractionConfig,
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
>;

function tokens(value: string | undefined) {
  return String(value || "")
    .split(/[,，\n\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function targetKeywords(config: AutomationKeywordConfig, target: AutomationFilterTarget) {
  const matchKey = `auto_${target}_match_keywords` as keyof AutomationKeywordConfig;
  const excludeKey = `auto_${target}_exclude_keywords` as keyof AutomationKeywordConfig;
  return {
    match: String(config[matchKey] || config.auto_match_keywords || ""),
    exclude: String(config[excludeKey] || config.auto_exclude_keywords || ""),
  };
}

export function matchesAutomationText(text: string, config: AutomationKeywordConfig, target: AutomationFilterTarget = "comment") {
  const normalized = text.toLowerCase();
  const keywords = targetKeywords(config, target);
  const includes = tokens(keywords.match);
  const excludes = tokens(keywords.exclude);
  if (excludes.some((token) => normalized.includes(token))) return false;
  if (includes.length === 0) return true;
  return includes.some((token) => normalized.includes(token));
}

export function shouldAutomateText(text: string, config: AutomationKeywordConfig, target: AutomationFilterTarget = "comment") {
  return Boolean(text.trim()) && matchesAutomationText(text, config, target);
}

export function videoAutomationText(video: VideoInfo) {
  return [
    video.desc,
    video.author?.nickname,
    video.author?.signature,
    video.music?.title,
    video.music?.author,
    video.aweme_id,
  ].filter(Boolean).join(" ");
}

function meetsVideoAutomationMetrics(video: VideoInfo, config: AiInteractionConfig) {
  const stats = video.statistics || {};
  if ((stats.digg_count || 0) < config.auto_min_digg_count) return false;
  if ((stats.comment_count || 0) < config.auto_min_comment_count) return false;
  if ((stats.play_count || 0) < config.auto_min_play_count) return false;
  return true;
}

export function shouldAutomateVideo(video: VideoInfo, config: AiInteractionConfig, target: "like" | "collect" = "like") {
  return meetsVideoAutomationMetrics(video, config) && matchesAutomationText(videoAutomationText(video), config, target);
}

export async function runVideoAutomation(video: VideoInfo, config: AiInteractionConfig) {
  const actions: string[] = [];
  let nextVideo = video;
  if (!meetsVideoAutomationMetrics(video, config)) return { video: nextVideo, actions };
  const text = videoAutomationText(video);
  if (config.auto_like && !video.is_liked && matchesAutomationText(text, config, "like")) {
    const result = await setVideoLiked(video.aweme_id, true);
    if (result.success) {
      actions.push("liked");
      nextVideo = { ...nextVideo, is_liked: result.is_liked ?? true };
    }
  }
  if (config.auto_collect && !video.is_collected && matchesAutomationText(text, config, "collect")) {
    const result = await setVideoCollected(video.aweme_id, true);
    if (result.success) {
      actions.push("collected");
      nextVideo = { ...nextVideo, is_collected: result.is_collected ?? true };
    }
  }
  return { video: nextVideo, actions };
}
