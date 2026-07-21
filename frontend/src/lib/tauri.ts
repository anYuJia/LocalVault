// Public shell mock bridge.
// This file intentionally contains no real platform endpoints, signing, cookies, or upload logic.

import type {
  AccountInfo,
  AiInteractionConfig,
  AiInteractionSuggestPayload,
  AiInteractionSuggestResponse,
  ApiResponse,
  AppConfig,
  AuthorInfo,
  CollectedMixItem,
  CollectedMixesResponse,
  CollectedVideosResponse,
  CommentDiggResponse,
  CommentInfo,
  CommentsResponse,
  CookieStatus,
  DownloadFilesResult,
  FollowResponse,
  FriendChatStateResponse,
  FriendMessageHistoryResponse,
  FriendOnlineStatusResponse,
  HistoryItem,
  LikedAuthorsResponse,
  LikedVideosResponse,
  LinkParseResponse,
  McpConnectionInfo,
  McpLogEntry,
  McpStatus,
  MixVideosResponse,
  NoticesResponse,
  PublishCommentResponse,
  RecommendedFeedType,
  RecommendedResponse,
  SearchUserResponse,
  SendFriendMessageResponse,
  ShareFriend,
  ShareFriendsResponse,
  UserDetailResponse,
  UserInfo,
  UserVideosResponse,
  VideoDetailResponse,
  VideoInfo,
  VideoRelationResponse,
} from "./contracts";

export type * from "./contracts";

export {
  getErrorMessage,
  normalizeHistoryItem,
  normalizeLikedVideo,
  normalizeUser,
  normalizeVideo,
  normalizeVideos,
} from "./normalizers";

type Listener = (payload: unknown) => void;
type DemoTask = {
  id: string;
  task_id: string;
  desc: string;
  display_name: string;
  progress: number;
  status: string;
  total: number;
  completed: number;
  message?: string;
};

const demoCover = "/animated_icon.svg";
const demoVideoUrl = "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4";
const now = Math.floor(Date.now() / 1000);
const listeners = new Map<string, Set<Listener>>();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function ok(message = "Demo shell response"): ApiResponse {
  return { success: true, message };
}

const demoAuthor: AuthorInfo = {
  uid: "demo_uid_001",
  sec_uid: "demo_sec_uid_001",
  nickname: "Demo Creator",
  avatar_thumb: demoCover,
  avatar_medium: demoCover,
  signature: "Public shell demo account. Replace the mock bridge with your own authorized provider.",
  follower_count: 12800,
  following_count: 128,
  aweme_count: 36,
  favoriting_count: 12,
  is_follow: false,
  follow_status: 0,
  verify_status: 0,
  unique_id: "demo_creator",
};

const demoUser: UserInfo = {
  uid: demoAuthor.uid,
  sec_uid: demoAuthor.sec_uid,
  nickname: demoAuthor.nickname,
  avatar_thumb: demoCover,
  avatar_medium: demoCover,
  avatar_larger: demoCover,
  signature: demoAuthor.signature,
  follower_count: demoAuthor.follower_count,
  following_count: demoAuthor.following_count,
  total_favorited: 52000,
  aweme_count: demoAuthor.aweme_count,
  favoriting_count: demoAuthor.favoriting_count,
  is_follow: false,
  follow_status: 0,
  verify_status: 0,
  unique_id: demoAuthor.unique_id,
  short_id: "10001",
};

function makeVideo(index: number): VideoInfo {
  return {
    aweme_id: `demo_video_${index}`,
    desc: `开源壳 Demo 视频 ${index}: UI 可以完整运行，真实平台连接由私有适配器实现。`,
    create_time: now - index * 3600,
    author: { ...demoAuthor, nickname: index % 2 ? "Demo Creator" : "Open Shell" },
    video: {
      preview_addr: demoVideoUrl,
      play_addr: demoVideoUrl,
      play_addr_candidates: [demoVideoUrl],
      dash_addr: null,
      audio_addr: null,
      play_addr_h264: demoVideoUrl,
      play_addr_lowbr: demoVideoUrl,
      download_addr: demoVideoUrl,
      cover: demoCover,
      dynamic_cover: demoCover,
      origin_cover: demoCover,
      width: 720,
      height: 1280,
      duration: 12,
      duration_unit: "seconds",
      ratio: "720p",
      bit_rate: [
        {
          gear_name: "demo",
          bit_rate: 900000,
          quality_type: 1,
          is_h265: false,
          data_size: 1024 * 1024,
          width: 720,
          height: 1280,
          play_addr: demoVideoUrl,
          play_addr_h264: demoVideoUrl,
          play_addr_candidates: [demoVideoUrl],
          play_addr_h264_candidates: [demoVideoUrl],
        },
      ],
    },
    statistics: {
      play_count: 10000 + index * 1200,
      digg_count: 900 + index * 37,
      comment_count: 40 + index,
      share_count: 8 + index,
      collect_count: 120 + index * 5,
      forward_count: 0,
    },
    media_urls: [{ type: "video", url: demoVideoUrl }],
    image_urls: null,
    images: null,
    live_photo_urls: null,
    live_photos: null,
    has_live_photo: false,
    is_liked: false,
    is_collected: false,
    is_image: false,
    media_type: "video",
    raw_media_type: "video",
    status: null,
    bgm_url: null,
    cover_url: demoCover,
    music: {
      title: "Demo BGM",
      author: "Open Shell",
      play_url: demoVideoUrl,
      cover: demoCover,
      duration: 12,
    },
  };
}

const demoVideos = Array.from({ length: 12 }, (_, index) => makeVideo(index + 1));
const demoAccount: AccountInfo = {
  sec_uid: demoUser.sec_uid,
  uid: demoUser.uid,
  user_id: demoUser.uid,
  nickname: demoUser.nickname,
  avatar_thumb: demoCover,
  is_valid: true,
};

const defaultAi: AiInteractionConfig = {
  enabled: true,
  provider: "mock",
  api_base: "local://mock-ai",
  api_key: "",
  api_key_set: false,
  model: "mock-assistant",
  system_prompt: "用自然、克制、友好的中文生成可编辑草稿。",
  provider_presets: [
    { id: "openai_compatible", label: "OpenAI Compatible", api_base: "https://api.openai.com/v1", default_model: "gpt-4o-mini", format: "openai_chat" },
    { id: "anthropic", label: "Anthropic", api_base: "https://api.anthropic.com/v1", default_model: "claude-haiku-4-5-20251001", format: "anthropic_messages" },
    { id: "gemini", label: "Google Gemini", api_base: "https://generativelanguage.googleapis.com/v1beta", default_model: "gemini-2.5-flash", format: "gemini_generate_content" },
  ],
  auto_send_comments: false,
  auto_send_private_messages: false,
  auto_like: false,
  auto_collect: false,
  auto_send_delay_ms: 0,
  auto_send_max_chars: 180,
  auto_require_context: true,
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
};

const state: {
  config: AppConfig;
  tasks: DemoTask[];
  history: HistoryItem[];
  liked: Set<string>;
  collected: Set<string>;
  followed: Set<string>;
} = {
  config: {
    download_path: "Demo Downloads",
    download_dir: "Demo Downloads",
    filename_template: "{author}_{title}",
    max_concurrent: 3,
    download_quality: "auto",
    download_live_photo_video: true,
    download_live_photo_image: true,
    auto_create_folder: true,
    folder_name_template: "{author}",
    save_metadata: true,
    proxy: null,
    ssl_verify: true,
    cookie: "",
    accounts: [demoAccount],
    current_sec_uid: demoAccount.sec_uid,
    im_friend_sec_user_ids: [demoAccount.sec_uid],
    im_friend_include_all_users: false,
    im_friend_refresh_interval_seconds: 30,
    ai_interaction: defaultAi,
    mcp: {
      enabled: false,
      preferred_port: 39144,
      allow_write_actions: false,
      require_confirmation: true,
      token: "public-shell-demo-token",
      token_set: true,
      log_retention: 300,
    },
    theme: "dark",
    language: "zh-CN",
    cookie_set: true,
  },
  tasks: [],
  history: [],
  liked: new Set<string>(),
  collected: new Set<string>(),
  followed: new Set<string>(),
};

function emit(event: string, payload: unknown) {
  listeners.get(event)?.forEach((listener) => listener(payload));
  window.dispatchEvent(new CustomEvent(event, { detail: payload }));
}

function upsertTask(video: VideoInfo, status = "completed") {
  const id = `demo_task_${video.aweme_id}`;
  const task: DemoTask = {
    id,
    task_id: id,
    desc: video.desc,
    display_name: video.desc,
    progress: 100,
    status,
    total: 1,
    completed: 1,
    message: "Demo shell does not download real media.",
  };
  state.tasks = [task, ...state.tasks.filter((item) => item.task_id !== id)].slice(0, 20);
  const history: HistoryItem = {
    id,
    aweme_id: video.aweme_id,
    filename: `${video.aweme_id}.mp4`,
    title: video.desc,
    path: `/demo/${video.aweme_id}.mp4`,
    file_path: `/demo/${video.aweme_id}.mp4`,
    author: video.author.nickname,
    desc: video.desc,
    size: 1024 * 1024,
    file_size: 1024 * 1024,
    timestamp: Date.now(),
    create_time: video.create_time,
    file_type: "video",
    media_type: video.media_type,
    cover: video.cover_url || demoCover,
    author_id: video.author.sec_uid,
  };
  state.history = [history, ...state.history.filter((item) => item.id !== id)].slice(0, 50);
  emit("download-completed", task);
  return task;
}

export function mediaProxyUrl(url: string | null | undefined, _mediaType = "image", _extraParams: Record<string, string | undefined> = {}): string {
  return url || demoCover;
}

export function localFileAssetUrl(path: string | null | undefined): string {
  return path || demoCover;
}

export function isBrowserBridgeRuntime() {
  return true;
}

export async function initClient(): Promise<{ success: boolean }> {
  return { success: true };
}

export async function getAppVersion(): Promise<string> {
  return "public-shell";
}

export async function checkUpdate(): Promise<{ success: boolean; has_update: boolean; version?: string; current_version?: string; notes?: string; message?: string; html_url?: string; download_url?: string; asset_name?: string; asset_size?: number; portable?: boolean; install_mode?: string }> {
  return { success: true, has_update: false, version: "public-shell", current_version: "public-shell", notes: "Public shell demo is up to date.", message: "Public shell demo is up to date.", html_url: "https://github.com/anYuJia", download_url: "", asset_name: "", asset_size: 0, portable: true, install_mode: "demo" };
}

export async function downloadUpdate() {
  return { success: false, message: "Public shell demo does not include updater downloads.", restart_required: false };
}

export async function restartApp(): Promise<void> {
  window.location.reload();
}

export async function getConfig(): Promise<AppConfig> {
  return clone(state.config);
}

export async function saveConfig(config: Partial<AppConfig>): Promise<{ success: boolean; message: string }> {
  state.config = { ...state.config, ...config, ai_interaction: { ...defaultAi, ...state.config.ai_interaction, ...config.ai_interaction } };
  return { success: true, message: "Demo configuration saved locally for this session." };
}

export async function getMcpStatus(): Promise<McpStatus> {
  return {
    enabled: Boolean(state.config.mcp?.enabled),
    running: false,
    port: state.config.mcp?.preferred_port || 39144,
    endpoint: null,
    started_at: null,
    last_error: "Public shell only includes a frontend mock bridge.",
    tool_count: 41,
  };
}

export async function getMcpLogs(_limit = 50): Promise<McpLogEntry[]> {
  return [
    {
      timestamp: new Date().toISOString(),
      transport: "mock",
      client_name: "public-shell",
      tool_name: "demo",
      category: "read",
      argument_summary: "public frontend mock",
      success: true,
      elapsed_ms: 0,
      error_code: null,
      message: "Public shell does not start a real MCP backend.",
    },
  ];
}

export async function clearMcpLogs(): Promise<void> {}

export async function getMcpConnectionInfo(): Promise<McpConnectionInfo> {
  return {
    endpoint: null,
    im_ws_endpoint: null,
    token: state.config.mcp?.token || "public-shell-demo-token",
    running: false,
    port: state.config.mcp?.preferred_port || 39144,
  };
}

export async function regenerateMcpToken(): Promise<{ success: boolean; token: string }> {
  const token = `public-shell-${Date.now().toString(36)}`;
  state.config.mcp = { ...(state.config.mcp || {
    enabled: false,
    preferred_port: 39144,
    allow_write_actions: false,
    require_confirmation: true,
    log_retention: 300,
  }), token, token_set: true };
  return { success: true, token };
}

export async function restartMcpServer(): Promise<McpStatus> {
  return getMcpStatus();
}

export async function suggestAiInteraction(payload: AiInteractionSuggestPayload): Promise<AiInteractionSuggestResponse> {
  const target = payload.target || "comment";
  const incoming = payload.incoming_text || payload.context || "这个内容很有意思";
  const draft = target === "private_message"
    ? `你好，看到你提到「${incoming.slice(0, 24)}」，我整理了一个友好的私信草稿。`
    : `这个角度很有意思，尤其是「${incoming.slice(0, 24)}」这部分，很适合继续聊聊。`;
  return {
    success: true,
    message: "Generated by public shell mock AI.",
    target,
    source: "fallback",
    draft,
    suggestions: [draft, "很喜欢这个表达，信息清楚又自然。", "这个内容挺有启发，先收藏慢慢看。"],
    actions: { send_comment: false, send_private_message: false, like: false, collect: false },
    auto_send: false,
    auto_send_delay_ms: 0,
    auto_send_max_chars: 180,
    auto_require_context: true,
    auto_block_reasons: [],
    warnings: ["Public shell uses mock AI suggestions only."],
    generated_at: Date.now(),
  };
}

export async function selectDirectory(): Promise<string | null> {
  return "Demo Downloads";
}

export async function searchUser(keyword: string): Promise<SearchUserResponse> {
  return { ...ok("Demo users returned."), type: "multiple", users: [{ ...demoUser, nickname: keyword ? `${keyword} Demo` : demoUser.nickname }] };
}

export async function getUserDetail(_secUid?: string, _nickname?: string): Promise<UserDetailResponse> {
  return { ...ok(), user: clone(demoUser) };
}

export async function getUserVideos(_secUid: string, count: number, cursor: number): Promise<UserVideosResponse> {
  const start = Math.max(0, cursor || 0);
  const items = demoVideos.slice(start, start + Math.max(1, count || 12));
  return { ...ok(), videos: clone(items), cursor: start + items.length, has_more: start + items.length < demoVideos.length, total_count: demoVideos.length };
}

export async function getVideoDetail(awemeId: string): Promise<VideoDetailResponse> {
  return { ...ok(), video: clone(demoVideos.find((video) => video.aweme_id === awemeId) || demoVideos[0]) };
}

export async function parseUrl(url: string): Promise<VideoInfo> {
  return { ...clone(demoVideos[0]), desc: `Demo parsed URL: ${url}` };
}

export async function parseLink(link: string): Promise<LinkParseResponse> {
  return { ...ok("Demo link parsed."), type: "video", video: await parseUrl(link) };
}

export async function setVideoLiked(awemeId: string, liked: boolean): Promise<VideoRelationResponse> {
  if (liked) state.liked.add(awemeId); else state.liked.delete(awemeId);
  return { ...ok(liked ? "Liked in demo state." : "Unliked in demo state."), aweme_id: awemeId, is_liked: liked };
}

export async function setVideoCollected(awemeId: string, collected: boolean): Promise<VideoRelationResponse> {
  if (collected) state.collected.add(awemeId); else state.collected.delete(awemeId);
  return { ...ok(collected ? "Collected in demo state." : "Removed from demo collection."), aweme_id: awemeId, is_collected: collected };
}

export async function setUserFollowed(userId: string, follow: boolean): Promise<FollowResponse> {
  if (follow) state.followed.add(userId); else state.followed.delete(userId);
  return { ...ok(follow ? "Followed in demo state." : "Unfollowed in demo state."), user_id: userId, is_follow: follow, follow_status: follow ? 1 : 0 };
}

export async function downloadVideo(video: VideoInfo): Promise<ApiResponse & { task_id?: string }> {
  const task = upsertTask(video);
  return { ...ok("Demo task created. No real media was downloaded."), task_id: task.task_id };
}

export async function downloadUserVideos(_secUid?: string, _nickname?: string, _count?: number): Promise<{ success: boolean; message: string; task_id?: string; total_videos?: number; nickname?: string }> {
  demoVideos.slice(0, 3).forEach((video) => upsertTask(video));
  return { success: true, message: "Created demo batch download tasks.", task_id: state.tasks[0]?.task_id, total_videos: 3, nickname: demoUser.nickname };
}

export async function downloadVideos(videos: VideoInfo[], _name?: string): Promise<{ success: boolean; message: string; task_id?: string; total_videos?: number; nickname?: string }> {
  videos.slice(0, 10).forEach((video) => upsertTask(video));
  return { success: true, message: "Created demo download tasks.", task_id: state.tasks[0]?.task_id, total_videos: videos.length, nickname: "Demo" };
}

export async function downloadLikedVideos(_count?: number, _cursor?: number, _name?: string): Promise<{ success: boolean; message: string; task_id?: string; total_videos?: number; nickname?: string }> {
  demoVideos.slice(0, 2).forEach((video) => upsertTask(video));
  return { success: true, message: "Created demo liked-video tasks.", task_id: state.tasks[0]?.task_id, total_videos: 2, nickname: demoUser.nickname };
}

export async function downloadLikedAuthors(_count?: number, _cursor?: number, _name?: string): Promise<{ success: boolean; message: string; task_id?: string; total_videos?: number; nickname?: string }> {
  return { success: true, message: "Demo shell has no real author archive download.", task_id: "demo_authors", total_videos: 0, nickname: demoUser.nickname };
}

export async function addDownloadTask(video: VideoInfo): Promise<string> {
  return upsertTask(video, "pending").task_id;
}

export async function startDownload(taskId: string): Promise<void> {
  state.tasks = state.tasks.map((task) => task.task_id === taskId ? { ...task, status: "completed", progress: 100 } : task);
}

export async function getDownloadTasks(): Promise<unknown[]> {
  return clone(state.tasks);
}

export async function cancelDownloadTask(taskId: string): Promise<ApiResponse> {
  state.tasks = state.tasks.map((task) => task.task_id === taskId ? { ...task, status: "cancelled" } : task);
  return ok("Demo task cancelled.");
}

export async function removeDownloadTask(taskId: string): Promise<void> {
  state.tasks = state.tasks.filter((task) => task.task_id !== taskId);
}

export async function pauseDownload(taskId: string): Promise<ApiResponse> {
  state.tasks = state.tasks.map((task) => task.task_id === taskId ? { ...task, status: "paused" } : task);
  return ok("Demo task paused.");
}

export async function resumeDownload(taskId: string): Promise<ApiResponse> {
  state.tasks = state.tasks.map((task) => task.task_id === taskId ? { ...task, status: "completed", progress: 100 } : task);
  return ok("Demo task resumed.");
}

export async function getRecommended(cursor: number, count: number, feedType: RecommendedFeedType = "recommended"): Promise<RecommendedResponse> {
  const start = Math.max(0, cursor || 0);
  const items = demoVideos.slice(start, start + Math.max(1, count || 8));
  return { ...ok(), videos: clone(items), cursor: start + items.length, has_more: start + items.length < demoVideos.length, feed_type: feedType };
}

export async function getLikedVideos(...args: any[]): Promise<LikedVideosResponse> {
  const cursor = Number(args[0] || 0) || 0;
  const count = Number(args[1] || 20) || 20;
  const selected = demoVideos.filter((video) => state.liked.has(video.aweme_id));
  const data = (selected.length ? selected : demoVideos.slice(0, 3)).slice(cursor, cursor + count);
  return { ...ok(), data: clone(data), count: data.length, cursor: cursor + data.length, has_more: false };
}

export async function getLikedAuthors(..._args: any[]): Promise<LikedAuthorsResponse> {
  return { ...ok(), data: [clone(demoUser)], count: 1 };
}

export async function getCollectedVideos(cursor: number, count: number): Promise<CollectedVideosResponse> {
  const selected = demoVideos.filter((video) => state.collected.has(video.aweme_id));
  const data = (selected.length ? selected : demoVideos.slice(2, 5)).slice(cursor, cursor + count);
  return { ...ok(), data: clone(data), count: data.length, cursor: cursor + data.length, has_more: false };
}

export async function getCollectedMixes(_cursor = 0, _count = 20): Promise<CollectedMixesResponse> {
  const mix: CollectedMixItem = {
    mix_id: "demo_mix",
    mix_name: "Open Shell Demo 合集",
    desc: "Mock collection for public UI development.",
    cover_url: demoCover,
    author: { nickname: demoUser.nickname, sec_uid: demoUser.sec_uid, avatar_thumb: demoCover },
    statis: { collect_vv: 123, play_vv: 4567, updated_to_episode: 3 },
    create_time: now - 86400,
    update_time: now,
    mix_type: 0,
  };
  return { ...ok(), data: [mix], count: 1, cursor: 1, has_more: false };
}

export async function getMixVideos(_seriesId = "demo_mix", _cursor = 0, _count = 20): Promise<MixVideosResponse> {
  return { ...ok(), data: clone(demoVideos.slice(0, 4)), count: 4, cursor: 4, has_more: false };
}

function demoComment(index: number): CommentInfo {
  return {
    cid: `demo_comment_${index}`,
    text: `这是第 ${index} 条 Demo 评论。`,
    create_time: now - index * 300,
    user: { uid: `comment_user_${index}`, nickname: `评论用户 ${index}`, avatar_thumb: demoCover, sec_uid: `comment_sec_${index}` },
    digg_count: index * 2,
    user_digged: 0,
    reply_comment_total: 0,
    sub_comments: [],
    status: 1,
    ip_label: "Demo",
  };
}

export async function getComments(_awemeId?: string, _count = 20, _cursor = 0, _insertIds = ""): Promise<CommentsResponse> {
  return { ...ok(), comments: [demoComment(1), demoComment(2), demoComment(3)], cursor: 3, has_more: false, total: 3 };
}

export async function getCommentReplies(_awemeId?: string, _cid?: string, _count = 20, _cursor = 0): Promise<CommentsResponse> {
  return { ...ok(), comments: [demoComment(101)], cursor: 1, has_more: false, total: 1 };
}

export async function setCommentLiked(_awemeId: string, cid: string, liked: boolean, ..._args: any[]): Promise<CommentDiggResponse> {
  return { ...ok(), cid, user_digged: liked ? 1 : 0, digg_count: liked ? 1 : 0 };
}

export async function publishComment(awemeId: string, text: string, _replyId?: string, _replyToReplyId?: string): Promise<PublishCommentResponse> {
  return { ...ok("Demo comment created locally."), aweme_id: awemeId, comment: { ...demoComment(Date.now()), text } };
}

export async function getFriendOnlineStatus(..._args: any[]): Promise<FriendOnlineStatusResponse> {
  return { ...ok(), sec_user_ids: [demoUser.sec_uid], all_sec_user_ids: [demoUser.sec_uid], offset: 0, limit: 20, next_offset: 1, total_count: 1, has_more: false };
}

export async function getShareFriends(..._args: any[]): Promise<ShareFriendsResponse> {
  const friend: ShareFriend = {
    uid: "demo_friend",
    sec_uid: "demo_friend_sec",
    nickname: "Demo Friend",
    avatar_thumb: demoCover,
    avatar_medium: demoCover,
    unique_id: "demo_friend",
    follow_status: 1,
    follower_status: 1,
    conv_id: "demo_conversation",
    conv_type: 1,
    is_recent_share: true,
    share_day_count: 1,
    last_share_timestamp: now,
  };
  return { ...ok(), friends: [friend], count: 1, has_more: false };
}

export async function sendFriendMessage(_payload?: Record<string, unknown>): Promise<SendFriendMessageResponse> {
  return { ...ok("Demo private message accepted locally."), client_message_id: `demo_msg_${Date.now()}`, conversation_id: "demo_conversation", pending_ack: false };
}

export async function sendFriendVideoShare(_payload?: Record<string, unknown>): Promise<SendFriendMessageResponse> {
  return sendFriendMessage();
}

export async function sendFriendImageMessage(_payload?: Record<string, unknown>): Promise<SendFriendMessageResponse> {
  return sendFriendMessage();
}

export async function getFriendMessageHistory(..._args: any[]): Promise<FriendMessageHistoryResponse> {
  return {
    ...ok(),
    messages: [
      { conversation_id: "demo_conversation", sender_uid: "demo_friend", text: "这是 Demo 私信记录。", create_time: now - 600, message_type: 7 },
      { conversation_id: "demo_conversation", sender_uid: demoUser.uid, text: "公有壳不会发送真实消息。", create_time: now - 300, message_type: 7 },
    ],
    next_cursor: 0,
    has_more: false,
  };
}

export async function getNotices(_payload?: Record<string, unknown>): Promise<NoticesResponse> {
  return {
    ...ok(),
    notices: [
      {
        id: "demo_notice_1",
        type: 1,
        type_label: "comment",
        create_time: now - 120,
        has_read: false,
        content: "Demo 用户评论了你的作品",
        merge_count: 1,
        label_text: "评论",
        users: [{ uid: "notice_user", nickname: "Notice Demo", sec_uid: "notice_sec", avatar: demoCover }],
        aweme: { aweme_id: demoVideos[0].aweme_id, desc: demoVideos[0].desc, cover: demoCover },
        comment_text: "这个开源壳看起来不错。",
        comment: null,
      },
    ],
    count: 1,
    unread_count: 1,
    cursor: 1,
    has_more: false,
  };
}

export async function getFriendChatState(..._args: any[]): Promise<FriendChatStateResponse> {
  return { ...ok(), summaries: {}, unreadCounts: { demo_friend_sec: 1 } };
}

export async function saveFriendChatState(..._args: any[]): Promise<ApiResponse> {
  return ok("Demo chat state saved.");
}

export async function verifyCookie(): Promise<CookieStatus> {
  return {
    valid: true,
    user_name: demoUser.nickname,
    user_id: demoUser.uid,
    sec_uid: demoUser.sec_uid,
    avatar_thumb: demoCover,
    avatar_medium: demoCover,
    avatar_larger: demoCover,
    expires_at: null,
    need_login: false,
    need_verify: false,
    message: "Public shell uses a mock local account.",
  };
}

export function clearVerifyCookieCache() {}

export async function cookieBrowserLogin(_timeout?: number, _browser?: string, _cookie?: string): Promise<{ success: boolean; message: string }> {
  return { success: true, message: "Mock login enabled for this session." };
}

export async function cancelCookieBrowserLogin(): Promise<{ success: boolean; message: string }> {
  return { success: true, message: "No active mock login." };
}

export async function logoutCookie(): Promise<{ success: boolean; message: string }> {
  return { success: true, message: "Mock account kept available for demo UI." };
}

export async function getAccounts(..._args: any[]): Promise<{ success: boolean; accounts: AccountInfo[]; current_sec_uid: string }> {
  return { success: true, accounts: [clone(demoAccount)], current_sec_uid: demoAccount.sec_uid };
}

export async function refreshAccountProfile(secUid: string): Promise<{ success: boolean; message?: string; account?: AccountInfo; current_sec_uid?: string }> {
  const account = { ...demoAccount, sec_uid: secUid || demoAccount.sec_uid };
  return { success: true, message: "Demo account refreshed locally.", account, current_sec_uid: account.sec_uid };
}

export async function switchAccount(secUid: string, _cookie?: string): Promise<{ success: boolean; message: string; nickname?: string; sec_uid?: string }> {
  state.config.current_sec_uid = secUid;
  return { success: true, message: "Switched demo account.", nickname: demoAccount.nickname, sec_uid: secUid };
}

export async function deleteAccount(_secUid?: string): Promise<{ success: boolean; message: string }> {
  return { success: true, message: "Demo account cannot be deleted in public shell." };
}

export async function addAccount(_cookie?: string): Promise<{ success: boolean; message: string; nickname?: string; sec_uid?: string; avatar_thumb?: string }> {
  return { success: true, message: "Mock account already exists.", nickname: demoAccount.nickname, sec_uid: demoAccount.sec_uid, avatar_thumb: demoCover };
}

export type VerifyBrowserResponse = { success: boolean; message: string; verify_url?: string };

export async function openVerifyBrowser(targetUrl?: string): Promise<VerifyBrowserResponse> {
  return { success: true, message: "Public shell does not open a real verification browser.", verify_url: targetUrl };
}

export async function getHistory(_options?: Record<string, unknown>): Promise<HistoryItem[]> {
  if (state.history.length === 0) {
    upsertTask(demoVideos[0]);
  }
  return clone(state.history);
}

export async function listDownloadFiles(_options?: Record<string, unknown>): Promise<DownloadFilesResult> {
  const items = await getHistory();
  return { items, total: items.length, totalSize: items.reduce((sum, item) => sum + item.size, 0), latest: items[0] || null };
}

export async function listDownloadFilesPage(_options?: Record<string, unknown>): Promise<DownloadFilesResult & { page?: number; page_size?: number }> {
  return { ...(await listDownloadFiles()), page: 1, page_size: 50 };
}

export async function clearHistory(): Promise<void> {
  state.history = [];
}

export async function deleteHistory(id: string): Promise<void> {
  state.history = state.history.filter((item) => item.id !== id);
}

export async function addHistory(entry: Omit<HistoryItem, "id">): Promise<void> {
  state.history = [{ ...entry, id: `demo_history_${Date.now()}` }, ...state.history];
}

export async function openFile(_path?: string): Promise<void> {}

export async function openDownloadDirectory(_path?: string): Promise<void> {}

export async function openFileLocation(_path?: string): Promise<void> {}

export async function openExternalUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}

export async function deleteFile(path: string): Promise<void> {
  state.history = state.history.filter((item) => item.path !== path && item.file_path !== path);
}

export async function checkFilesExist(paths: string[]): Promise<boolean[]> {
  return paths.map(() => true);
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function loadRecentSearchUsersFromBackend<T>(): Promise<T[]> {
  return [];
}

export async function saveRecentSearchUsersToBackend<T>(users: T[]): Promise<T[]> {
  return users;
}

export function normalizeBrowserTask(value: unknown) {
  return value;
}

export function getDownloadPayload(video: VideoInfo) {
  return { video };
}

export type TauriUnlisten = () => void;
export type EventHandler<T> = (payload: T) => void;

export async function listenEvent<T>(event: string, handler: EventHandler<T>): Promise<TauriUnlisten> {
  const wrapped = (payload: unknown) => handler(payload as T);
  const set = listeners.get(event) || new Set<Listener>();
  set.add(wrapped);
  listeners.set(event, set);
  return () => {
    set.delete(wrapped);
  };
}
