// Shared frontend/backend response contracts for the Python and Rust frontends.
// Keep this file byte-for-byte aligned in both apps until it moves into a real shared package.

export interface AccountInfo {
  sec_uid: string;
  uid?: string;
  user_id?: string;
  nickname: string;
  avatar_thumb?: string;
  cookie?: string;
  is_valid?: boolean;
}

export interface AppConfig {
  download_path: string;
  download_dir?: string;
  filename_template: string;
  max_concurrent: number;
  download_quality: string;
  download_live_photo_video: boolean;
  download_live_photo_image: boolean;
  auto_create_folder: boolean;
  folder_name_template: string;
  save_metadata: boolean;
  proxy: string | null;
  ssl_verify?: boolean;
  cookie: string;
  accounts?: AccountInfo[];
  current_sec_uid?: string;
  im_friend_sec_user_ids?: string[];
  im_friend_include_all_users?: boolean;
  im_friend_refresh_interval_seconds?: number;
  ai_interaction?: AiInteractionConfig;
  mcp?: McpConfig;
  theme: string;
  language: string;
  cookie_set?: boolean;
}

export interface McpConfig {
  enabled: boolean;
  preferred_port: number;
  allow_write_actions: boolean;
  require_confirmation: boolean;
  token?: string;
  token_set?: boolean;
  log_retention: number;
}

export interface McpStatus {
  enabled: boolean;
  running: boolean;
  port?: number | null;
  endpoint?: string | null;
  started_at?: string | null;
  last_error?: string | null;
  tool_count: number;
}

export interface McpLogEntry {
  timestamp: string;
  transport: string;
  client_name: string;
  tool_name: string;
  category: "read" | "write" | string;
  argument_summary: string;
  success: boolean;
  elapsed_ms: number;
  error_code?: string | null;
  message: string;
}

export interface McpConnectionInfo {
  endpoint?: string | null;
  im_ws_endpoint?: string | null;
  token: string;
  running: boolean;
  port?: number | null;
}

export interface AiInteractionConfig {
  enabled: boolean;
  provider: string;
  api_base: string;
  api_key?: string;
  api_key_set?: boolean;
  model: string;
  system_prompt: string;
  provider_presets?: AiProviderPreset[];
  auto_send_comments: boolean;
  auto_send_private_messages: boolean;
  auto_like: boolean;
  auto_collect: boolean;
  auto_send_delay_ms: number;
  auto_send_max_chars: number;
  auto_require_context: boolean;
  auto_monitor_notices: boolean;
  auto_monitor_friends: boolean;
  auto_monitor_comments: boolean;
  auto_monitor_feed: boolean;
  auto_match_keywords: string;
  auto_exclude_keywords: string;
  auto_private_match_keywords: string;
  auto_private_exclude_keywords: string;
  auto_comment_match_keywords: string;
  auto_comment_exclude_keywords: string;
  auto_like_match_keywords: string;
  auto_like_exclude_keywords: string;
  auto_collect_match_keywords: string;
  auto_collect_exclude_keywords: string;
  auto_min_digg_count: number;
  auto_min_comment_count: number;
  auto_min_play_count: number;
  auto_scan_interval_seconds: number;
  auto_max_actions_per_run: number;
}

export interface AiProviderPreset {
  id: string;
  label: string;
  api_base: string;
  default_model: string;
  format?: "openai_chat" | "anthropic_messages" | "gemini_generate_content" | string;
}

export interface AiInteractionSuggestPayload {
  target: "comment" | "private_message";
  context?: string;
  incoming_text?: string;
  author_name?: string;
  tone?: "friendly" | "professional" | "warm" | "playful" | "concise";
  language?: string;
  max_suggestions?: number;
  test_connection?: boolean;
}

export interface AiInteractionSuggestResponse extends ApiResponse {
  target?: "comment" | "private_message";
  source?: "model" | "fallback" | string;
  suggestions?: string[];
  draft?: string;
  actions?: {
    send_comment: boolean;
    send_private_message: boolean;
    like: boolean;
    collect: boolean;
  };
  auto_send?: boolean;
  auto_send_delay_ms?: number;
  auto_send_max_chars?: number;
  auto_require_context?: boolean;
  auto_block_reasons?: string[];
  warnings?: string[];
  generated_at?: number;
  provider_error?: string;
  connection_test?: boolean;
  provider?: string;
  model?: string;
  api_base?: string;
  provider_latency_ms?: number;
}

export interface AuthorInfo {
  uid: string;
  sec_uid: string;
  nickname: string;
  avatar_thumb: string;
  avatar_medium: string;
  signature: string;
  follower_count: number;
  following_count: number;
  aweme_count: number;
  favoriting_count: number;
  is_follow: boolean;
  follow_status: number;
  verify_status: number;
  unique_id: string;
}

export interface VideoData {
  preview_addr: string | null;
  play_addr: string;
  play_addr_candidates?: string[] | null;
  dash_addr?: string | null;
  audio_addr?: string | null;
  play_addr_h264: string | null;
  play_addr_lowbr: string | null;
  download_addr: string | null;
  cover: string;
  dynamic_cover: string;
  origin_cover: string;
  width: number;
  height: number;
  duration: number;
  duration_unit?: "seconds" | "milliseconds" | string | null;
  ratio: string;
  bit_rate?: BitRateInfo[] | null;
}

export interface BitRateInfo {
  gear_name: string;
  bit_rate: number;
  quality_type: number;
  is_h265: boolean;
  data_size: number;
  width: number;
  height: number;
  play_addr: string | null;
  play_addr_h264: string | null;
  play_addr_candidates?: string[] | null;
  play_addr_h264_candidates?: string[] | null;
}

export interface Statistics {
  play_count: number;
  digg_count: number;
  comment_count: number;
  share_count: number;
  collect_count: number;
  forward_count: number;
}

export interface VideoStatus {
  is_delete?: boolean;
  private_status?: number;
  review_status?: number;
  with_goods?: boolean;
  is_prohibited?: boolean;
}

export interface MusicInfo {
  title: string;
  author: string;
  play_url: string;
  cover: string;
  duration: number;
}

export interface VideoMediaUrl {
  type?: string;
  url: string;
  fallback_urls?: string[] | null;
}

export interface VideoInfo {
  aweme_id: string;
  desc: string;
  create_time: number;
  author: AuthorInfo;
  video: VideoData;
  statistics: Statistics;
  media_urls?: VideoMediaUrl[] | null;
  image_urls: string[] | null;
  images?: string[] | null;
  live_photo_urls?: string[] | null;
  live_photos?: string[] | null;
  has_live_photo?: boolean;
  is_liked?: boolean;
  is_collected?: boolean;
  is_image: boolean;
  media_type: string;
  raw_media_type?: string | number | null;
  status?: VideoStatus | null;
  bgm_url?: string | null;
  cover_url?: string | null;
  music: MusicInfo | null;
}

export type VideoItem = VideoInfo;

export interface UserInfo {
  uid: string;
  nickname: string;
  avatar_thumb: string;
  avatar_medium: string;
  avatar_larger: string;
  signature: string;
  follower_count: number;
  following_count: number;
  total_favorited: number;
  aweme_count: number;
  favoriting_count: number;
  is_follow: boolean;
  follow_status: number;
  sec_uid: string;
  unique_id: string;
  short_id?: string;
  verify_status: number;
}

export interface SearchResult {
  users: UserInfo[];
}

export interface ApiResponse {
  success: boolean;
  message?: string;
  need_verify?: boolean;
  need_login?: boolean;
  verify_url?: string;
}

export interface SearchUserResponse extends ApiResponse {
  type?: "single" | "multiple";
  user?: UserInfo;
  users?: UserInfo[];
}

export interface UserDetailResponse extends ApiResponse {
  user?: UserInfo;
}

export interface UserVideosResponse extends ApiResponse {
  videos?: VideoInfo[];
  has_more?: boolean;
  cursor?: number;
  total_count?: number;
}

export interface VideoDetailResponse extends ApiResponse {
  video?: VideoInfo;
}

export interface LinkParseResponse extends ApiResponse {
  type?: string;
  user?: UserInfo;
  video?: VideoInfo;
  videos?: VideoInfo[];
}

export interface VideoRelationResponse extends ApiResponse {
  aweme_id?: string;
  is_liked?: boolean;
  is_collected?: boolean;
}

export interface FollowResponse extends ApiResponse {
  user_id?: string;
  is_follow?: boolean;
  follow_status?: number;
}

export type RecommendedFeedType = "featured" | "recommended";

export interface RecommendedResponse extends ApiResponse {
  videos?: VideoInfo[];
  cursor?: number;
  has_more?: boolean;
  feed_type?: RecommendedFeedType | string;
}

export interface LikedVideosResponse extends ApiResponse {
  data?: VideoInfo[];
  count?: number;
  cursor?: number;
  has_more?: boolean;
}

export interface LikedAuthorsResponse extends ApiResponse {
  data?: UserInfo[];
  count?: number;
}

export interface CommentUser {
  uid: string;
  nickname: string;
  avatar_thumb: string;
  sec_uid: string;
}

export interface CommentInfo {
  cid: string;
  text: string;
  create_time: number;
  user: CommentUser;
  digg_count: number;
  user_digged?: number;
  reply_comment_total: number;
  sub_comments?: CommentInfo[] | null;
  reply_id?: string;
  reply_to_reply_id?: string;
  reply_to_user_id?: string;
  reply_to_user_name?: string;
  status?: number;
  ip_label?: string;
  sticker_url?: string;
}

export interface CommentsResponse extends ApiResponse {
  comments?: CommentInfo[];
  cursor?: number;
  has_more?: boolean;
  total?: number;
}

export interface CommentDiggResponse extends ApiResponse {
  aweme_id?: string;
  cid?: string;
  user_digged?: number;
  digg_count?: number;
}

export interface PublishCommentResponse extends ApiResponse {
  aweme_id?: string;
  comment?: CommentInfo;
}

export interface FriendOnlineStatusResponse extends ApiResponse {
  sec_user_ids?: string[];
  all_sec_user_ids?: string[];
  recent_interactions?: unknown;
  offset?: number;
  limit?: number;
  next_offset?: number;
  total_count?: number;
  has_more?: boolean;
  user_info?: unknown;
  active_status?: unknown;
}

export interface ShareFriend {
  uid: string;
  sec_uid: string;
  nickname: string;
  avatar_thumb: string;
  avatar_medium: string;
  unique_id?: string;
  short_id?: string;
  follow_status?: number;
  follower_status?: number;
  conv_id?: string;
  conv_type?: number;
  is_recent_share?: boolean;
  share_day_count?: number;
  last_share_timestamp?: number;
}

export interface ShareFriendsResponse extends ApiResponse {
  friends?: ShareFriend[];
  count?: number;
  has_more?: boolean;
}

export interface SendFriendMessageResponse extends ApiResponse {
  client_message_id?: string;
  message_id?: string | number;
  conversation_id?: string;
  pending_ack?: boolean;
  need_image_upload?: boolean;
  conversation?: Record<string, unknown>;
  raw?: unknown;
}

export interface FriendMessageHistoryItem {
  conversation_id?: string;
  conversation_short_id?: string | number;
  conversation_type?: string | number;
  server_message_id?: string | number;
  sender_uid?: string;
  senderUid?: string;
  content?: string;
  text?: string;
  raw_content?: string;
  rawContent?: string;
  create_time?: number;
  created_at?: number;
  message_type?: number;
}

export interface FriendMessageHistoryResponse extends ApiResponse {
  messages?: FriendMessageHistoryItem[];
  next_cursor?: number;
  has_more?: boolean;
  conversation?: unknown;
}

export interface FriendChatStateResponse extends ApiResponse {
  summaries?: Record<string, unknown>;
  unreadCounts?: Record<string, number>;
}

export interface NoticeUser {
  uid: string;
  nickname: string;
  sec_uid: string;
  avatar: string;
  unique_id?: string;
  follow_status?: number;
  follower_status?: number;
  is_verified?: boolean;
}

export interface NoticeAweme {
  aweme_id: string;
  desc: string;
  cover: string;
  aweme_type?: number;
}

export interface NoticeItem {
  id: string;
  type: number;
  type_label: string;
  create_time: number;
  has_read: boolean;
  content: string;
  merge_count: number;
  label_text: string;
  users: NoticeUser[];
  aweme: NoticeAweme | null;
  digg_type?: number | null;
  is_comment_like?: boolean;
  is_reply?: boolean;
  comment_text?: string;
  comment?: NoticeComment | null;
}

export interface NoticeComment {
  cid: string;
  root_cid: string;
  is_sub: boolean;
  text: string;
  digg_count: number;
  create_time: number;
  user: NoticeUser;
  reply_to_user?: NoticeUser | null;
  reply_to_text?: string;
}

export interface NoticesResponse extends ApiResponse {
  notices?: NoticeItem[];
  count?: number;
  unread_count?: number;
  has_more?: boolean;
  cursor?: number;
}

export interface CollectedVideosResponse extends ApiResponse {
  data?: VideoInfo[];
  count?: number;
  cursor?: number;
  has_more?: boolean;
}

export interface CollectedMixAuthor {
  nickname: string;
  sec_uid: string;
  avatar_thumb: string;
}

export interface CollectedMixStats {
  collect_vv: number;
  play_vv: number;
  updated_to_episode: number;
}

export interface CollectedMixItem {
  mix_id: string;
  mix_name: string;
  desc: string;
  cover_url: string;
  author: CollectedMixAuthor;
  statis: CollectedMixStats;
  create_time: number;
  update_time: number;
  mix_type: number;
}

export interface CollectedMixesResponse extends ApiResponse {
  data?: CollectedMixItem[];
  count?: number;
  cursor?: number;
  has_more?: boolean;
}

export interface MixVideosResponse extends ApiResponse {
  data?: VideoInfo[];
  count?: number;
  cursor?: number;
  has_more?: boolean;
}

export interface DownloadProgress {
  task_id: string;
  desc?: string;
  display_name?: string;
  progress: number;
  completed?: number;
  total?: number;
  status: string;
  error?: string;
  message?: string;
}

export interface HistoryItem {
  id: string;
  aweme_id?: string;
  filename: string;
  title?: string;
  path: string;
  file_path?: string;
  author: string;
  desc: string;
  size: number;
  file_size?: number;
  timestamp: number;
  create_time?: number;
  file_type: string;
  media_type?: string;
  cover?: string;
  author_id?: string;
}

export interface CookieStatus {
  valid: boolean;
  user_name: string | null;
  user_id: string | null;
  sec_uid?: string | null;
  avatar_thumb?: string | null;
  avatar_medium?: string | null;
  avatar_larger?: string | null;
  expires_at: number | null;
  need_login?: boolean;
  need_verify?: boolean;
  message: string;
}

export interface DownloadFilesResult {
  items: HistoryItem[];
  total: number;
  totalSize: number;
  latest: HistoryItem | null;
}
