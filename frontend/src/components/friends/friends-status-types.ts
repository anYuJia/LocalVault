export interface FriendStatusItem {
  secUid: string;
  uid: string;
  nickname: string;
  remarkName: string;
  avatar: string;
  signature: string;
  online: boolean;
  statusText: string;
  lastActive: string;
  lastActiveTime: number;
  serverLatestMessageAt?: number;
}

export type JsonRecord = Record<string, unknown>;

export const STORAGE_KEY = "douyin.friendStatus.secUserIds";
export const CHAT_DRAFTS_KEY = "douyin.friendStatus.chatDrafts";
export const CHAT_MESSAGES_KEY = "douyin.friendStatus.chatMessages";
export const CHAT_UNREAD_KEY = "douyin.friendStatus.unreadCounts";
export const CHAT_SUMMARIES_KEY = "douyin.friendStatus.chatSummaries";
export const CURRENT_USER_AVATAR_KEY = "douyin.friendStatus.currentUserAvatar";
export const ONLINE_WINDOW_SECONDS = 60;
export const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;
export const MIN_BACKGROUND_REFRESH_INTERVAL_MS = 12_000;
export const COOKIE_REQUIRED_PATTERN = /请先设置\s*Cookie/i;
export const MAX_SEND_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_PERSISTED_CHAT_MESSAGES_PER_FRIEND = 40;
export const MAX_PERSISTED_RAW_CONTENT_CHARS = 30_000;
export const LIKE_NOTICE_PATTERN = /(?:你)?(?:赞了|点赞了|点赞)/;

export type ChatDrafts = Record<string, string>;
export type HistoryPageState = Record<string, {
  loaded: boolean;
  loading: boolean;
  nextCursor: number;
  hasMore: boolean;
  error: string;
}>;
export interface LocalChatMessage {
  id: string;
  text: string;
  rawContent?: string;
  imagePreviewUrl?: string;
  createdAt: number;
  status: "pending" | "sent" | "error";
  direction?: "in" | "out";
  senderUid?: string;
  error?: string;
}
export type ChatMessages = Record<string, LocalChatMessage[]>;
export type UnreadCounts = Record<string, number>;
export type ChatSummaries = Record<string, {
  latestMessage?: LocalChatMessage;
  latestMessageAt: number;
  unreadCount: number;
}>;
export type ImConnectionStatus = {
  connected: boolean;
  message: string;
  updatedAt: number;
};
export type PendingImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

export interface FriendListItem extends FriendStatusItem {
  latestMessage?: LocalChatMessage;
  latestMessageAt: number;
  previewText: string;
  unreadCount: number;
}

export interface SharedMessageCard {
  kind: "video" | "comment" | "image" | "share" | "location" | "product";
  title: string;
  subtitle: string;
  coverUrl: string;
  skey?: string;
  avatarUrl: string;
  authorName: string;
  itemId: string;
}
