import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type ElementType, type KeyboardEvent } from "react";
import { Activity, ImagePlus, Loader2, MapPin, MessageCircle, Play, RefreshCw, Send, ShoppingBag, UserRound, Users, Wifi, WifiOff, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeLogo } from "@/components/common/theme-logo";
import { Textarea } from "@/components/ui/textarea";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import { getAccounts, getConfig, getFriendChatState, getFriendMessageHistory, getFriendOnlineStatus, getUserDetail, getVideoDetail, listenEvent, mediaProxyUrl, saveConfig, saveFriendChatState, sendFriendImageMessage, sendFriendMessage, verifyCookie, type FriendOnlineStatusResponse } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import type { FriendMessageHistoryItem, UserInfo, VideoInfo } from "@/lib/contracts";

interface FriendStatusItem {
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
}

type JsonRecord = Record<string, unknown>;

const STORAGE_KEY = "douyin.friendStatus.secUserIds";
const CHAT_DRAFTS_KEY = "douyin.friendStatus.chatDrafts";
const CHAT_MESSAGES_KEY = "douyin.friendStatus.chatMessages";
const CHAT_UNREAD_KEY = "douyin.friendStatus.unreadCounts";
const CHAT_SUMMARIES_KEY = "douyin.friendStatus.chatSummaries";
const CURRENT_USER_AVATAR_KEY = "douyin.friendStatus.currentUserAvatar";
const ONLINE_WINDOW_SECONDS = 60;
const DEFAULT_REFRESH_INTERVAL_SECONDS = 30;
const MIN_BACKGROUND_REFRESH_INTERVAL_MS = 12_000;
const COOKIE_REQUIRED_PATTERN = /请先设置\s*Cookie/i;
const MAX_SEND_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PERSISTED_CHAT_MESSAGES_PER_FRIEND = 40;
const MAX_PERSISTED_RAW_CONTENT_CHARS = 30_000;
const LIKE_NOTICE_PATTERN = /(?:你)?(?:赞了|点赞了|点赞)/;

type ChatDrafts = Record<string, string>;
type HistoryPageState = Record<string, {
  loaded: boolean;
  loading: boolean;
  nextCursor: number;
  hasMore: boolean;
  error: string;
}>;
interface LocalChatMessage {
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
type ChatMessages = Record<string, LocalChatMessage[]>;
type UnreadCounts = Record<string, number>;
type ChatSummaries = Record<string, {
  latestMessage?: LocalChatMessage;
  latestMessageAt: number;
  unreadCount: number;
}>;
type ImConnectionStatus = {
  connected: boolean;
  message: string;
  updatedAt: number;
};
type PendingImageAttachment = {
  id: string;
  file: File;
  previewUrl: string;
};

interface FriendListItem extends FriendStatusItem {
  latestMessage?: LocalChatMessage;
  latestMessageAt: number;
  previewText: string;
  unreadCount: number;
}

function getNamespacedKey(baseKey: string, currentSecUid?: string): string {
  if (!currentSecUid) return baseKey;
  return `${baseKey}.${currentSecUid}`;
}

function readChatDrafts(currentSecUid?: string): ChatDrafts {
  try {
    const key = getNamespacedKey(CHAT_DRAFTS_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return isRecord(parsed) ? Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string"),
    ) as ChatDrafts : {};
  } catch {
    return {};
  }
}

function readChatMessages(currentSecUid?: string): ChatMessages {
  try {
    const key = getNamespacedKey(CHAT_MESSAGES_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: ChatMessages = {};
    for (const [secUid, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const messages: LocalChatMessage[] = value
        .filter(isRecord)
        .map((message) => normalizeStoredChatMessage(secUid, message))
        .filter((message) => {
          if (!message.text || message.createdAt <= 0) return false;
          if (message.text.trim().startsWith('{') && message.text.includes("command_type")) {
            return false;
          }
          return true;
        });
      if (messages.length > 0) {
        result[secUid] = messages;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function normalizeStoredChatMessage(secUid: string, message: JsonRecord): LocalChatMessage {
  const item: LocalChatMessage = {
    id: stringField(message, ["id"]) || `${secUid}-${numberField(message, ["createdAt"])}-${Math.random()}`,
    text: stringField(message, ["text"]),
    rawContent: stringField(message, ["rawContent", "raw_content"]) || undefined,
    imagePreviewUrl: stringField(message, ["imagePreviewUrl"]).startsWith("blob:") ? undefined : stringField(message, ["imagePreviewUrl"]) || undefined,
    createdAt: numberField(message, ["createdAt"]),
    status: normalizeMessageStatus(stringField(message, ["status"])),
    direction: normalizeMessageDirection(stringField(message, ["direction"])),
    senderUid: stringField(message, ["senderUid", "sender_uid"]),
    error: stringField(message, ["error"]) || undefined,
  };
  if (isLocalUnsentImagePlaceholder(item)) {
    return {
      ...item,
      status: "error",
      error: item.error || "图片未发送：缺少抖音上传凭证",
    };
  }
  return item;
}

function isLocalUnsentImagePlaceholder(message: LocalChatMessage) {
  if (message.direction !== "out" || message.status === "error") return false;
  if (message.imagePreviewUrl) return false;
  const parsed = parseJsonContent(message.rawContent || "");
  if (!parsed || Number(parsed.aweType || 0) !== 2702) return false;
  const inlinePic = stringField(parsed, ["inline_pic", "inlinePic"]);
  const hasInlineImage = Boolean(inlineImageDataUrl(inlinePic));
  const hasUploadedResource = Boolean(firstUrl(parsed.resource_url) || firstUrl(parsed.url));
  return !hasInlineImage && !hasUploadedResource;
}

function readUnreadCounts(currentSecUid?: string): UnreadCounts {
  try {
    const key = getNamespacedKey(CHAT_UNREAD_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: UnreadCounts = {};
    for (const [keyVal, value] of Object.entries(parsed)) {
      const count = Math.max(0, Number(value) || 0);
      if (count > 0) result[keyVal] = count;
    }
    return result;
  } catch {
    return {};
  }
}

function readChatSummaries(currentSecUid?: string): ChatSummaries {
  try {
    const key = getNamespacedKey(CHAT_SUMMARIES_KEY, currentSecUid);
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    if (!isRecord(parsed)) return {};
    const result: ChatSummaries = {};
    for (const [secUid, value] of Object.entries(parsed)) {
      if (!isRecord(value)) continue;
      const latestRaw = isRecord(value.latestMessage) ? value.latestMessage : undefined;
      const latestMessage = latestRaw ? {
        id: stringField(latestRaw, ["id"]) || `${secUid}-${numberField(latestRaw, ["createdAt"])}`,
        text: stringField(latestRaw, ["text"]),
        rawContent: stringField(latestRaw, ["rawContent", "raw_content"]) || undefined,
        imagePreviewUrl: stringField(latestRaw, ["imagePreviewUrl"]).startsWith("blob:") ? undefined : stringField(latestRaw, ["imagePreviewUrl"]) || undefined,
        createdAt: numberField(latestRaw, ["createdAt"]),
        status: normalizeMessageStatus(stringField(latestRaw, ["status"])),
        direction: normalizeMessageDirection(stringField(latestRaw, ["direction"])),
        senderUid: stringField(latestRaw, ["senderUid", "sender_uid"]),
        error: stringField(latestRaw, ["error"]) || undefined,
      } : undefined;
      const latestMessageAt = Math.max(
        numberField(value, ["latestMessageAt"]),
        latestMessage?.createdAt || 0,
      );
      const unreadCount = Math.max(0, numberField(value, ["unreadCount"]));
      if (latestMessageAt > 0 || unreadCount > 0) {
        result[secUid] = {
          latestMessage: latestMessage?.text ? latestMessage : undefined,
          latestMessageAt,
          unreadCount,
        };
      }
    }
    return result;
  } catch {
    return {};
  }
}

function friendDisplayName(friend: FriendStatusItem | null | undefined) {
  return friend?.remarkName || friend?.nickname || "未知用户";
}

function latestChatMessage(messages: LocalChatMessage[] | undefined) {
  if (!messages || messages.length === 0) return undefined;
  return messages.reduce<LocalChatMessage | undefined>((latest, message) => {
    if (!latest || message.createdAt > latest.createdAt) return message;
    return latest;
  }, undefined);
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`localStorage 写入失败: ${key}`, error);
    return false;
  }
}

function compactRawContent(rawContent: string | undefined, maxLength = MAX_PERSISTED_RAW_CONTENT_CHARS) {
  if (!rawContent) return undefined;
  return rawContent.length > maxLength ? undefined : rawContent;
}

function sanitizePersistedChatMessage(message: LocalChatMessage, rawLimit = MAX_PERSISTED_RAW_CONTENT_CHARS): LocalChatMessage {
  return {
    ...message,
    rawContent: compactRawContent(message.rawContent, rawLimit),
    imagePreviewUrl: message.imagePreviewUrl?.startsWith("blob:") ? undefined : message.imagePreviewUrl,
    error: message.error ? message.error.slice(0, 300) : undefined,
  };
}

function compactChatMessagesForStorage(
  messages: ChatMessages,
  perFriendLimit = MAX_PERSISTED_CHAT_MESSAGES_PER_FRIEND,
  rawLimit = MAX_PERSISTED_RAW_CONTENT_CHARS,
) {
  const compacted: ChatMessages = {};
  for (const [secUid, items] of Object.entries(messages)) {
    const kept = [...items]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-perFriendLimit)
      .map((message) => sanitizePersistedChatMessage(message, rawLimit));
    if (kept.length > 0) compacted[secUid] = kept;
  }
  return compacted;
}

function persistChatMessages(messages: ChatMessages, currentSecUid?: string) {
  const compacted = compactChatMessagesForStorage(messages);
  const key = getNamespacedKey(CHAT_MESSAGES_KEY, currentSecUid);
  if (safeSetLocalStorage(key, JSON.stringify(compacted))) return;
  const smaller = compactChatMessagesForStorage(messages, 12, 8_000);
  if (safeSetLocalStorage(key, JSON.stringify(smaller))) return;
  safeSetLocalStorage(key, "{}");
}

function sanitizePersistedSummaries(summaries: ChatSummaries): ChatSummaries {
  return Object.fromEntries(
    Object.entries(summaries).map(([secUid, summary]) => [
      secUid,
      {
        ...summary,
        latestMessage: summary.latestMessage
          ? sanitizePersistedChatMessage(summary.latestMessage, 8_000)
          : undefined,
      },
    ]),
  ) as ChatSummaries;
}

function persistChatSummaries(summaries: ChatSummaries, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_SUMMARIES_KEY, currentSecUid);
  if (safeSetLocalStorage(key, JSON.stringify(sanitizePersistedSummaries(summaries)))) return;
  safeSetLocalStorage(key, "{}");
}

function persistChatDrafts(drafts: ChatDrafts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_DRAFTS_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(drafts));
}

function persistUnreadCounts(counts: UnreadCounts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_UNREAD_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(counts));
}

function normalizeMessageStatus(value: string): LocalChatMessage["status"] {
  return value === "pending" || value === "sent" || value === "error" ? value : "sent";
}

function normalizeMessageDirection(value: string): LocalChatMessage["direction"] {
  return value === "in" ? "in" : "out";
}

interface SharedMessageCard {
  kind: "video" | "comment" | "image" | "share" | "location" | "product";
  title: string;
  subtitle: string;
  coverUrl: string;
  skey?: string;
  avatarUrl: string;
  authorName: string;
  itemId: string;
}

function normalizeImUrl(value: string) {
  return value
    .trim()
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
}

function unsignedMediaUrl(value: string) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.search ? `${parsed.origin}${parsed.pathname}` : "";
  } catch {
    return "";
  }
}

function firstUrl(value: unknown): string {
  if (typeof value === "string") {
    const normalized = normalizeImUrl(value);
    if (/^https?:\/\//.test(normalized)) return normalized;
  }
  if (!isRecord(value)) return "";
  for (const key of ["large_url_list", "origin_url_list", "medium_url_list", "url_list", "thumb_url_list"]) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    const url = list.find((item) => typeof item === "string" && /^https?:\/\//.test(normalizeImUrl(item)));
    if (typeof url === "string") return normalizeImUrl(url);
  }
  for (const key of ["url", "src", "download_url", "uri", "content"]) {
    const url = value[key];
    if (typeof url === "string") {
      const normalized = normalizeImUrl(url);
      if (/^https?:\/\//.test(normalized)) return normalized;
    }
  }
  const list = value.url_list;
  if (!Array.isArray(list)) return "";
  const url = list.find((item) => typeof item === "string" && /^https?:\/\//.test(normalizeImUrl(item)));
  return typeof url === "string" ? normalizeImUrl(url) : "";
}

function inlineImageDataUrl(value: string) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return "";
  if (normalized.startsWith("data:image/")) return normalized;
  if (normalized.startsWith("UklGR")) return `data:image/webp;base64,${normalized}`;
  if (normalized.startsWith("/9j/")) return `data:image/jpeg;base64,${normalized}`;
  if (normalized.startsWith("iVBOR")) return `data:image/png;base64,${normalized}`;
  return "";
}

function imageMessageRawContent(imageDataUrl: string, width = 0, height = 0, fileName = "") {
  return JSON.stringify({
    aweType: 2702,
    inline_pic: imageDataUrl,
    cover_width: width,
    cover_height: height,
    width,
    height,
    file_name: fileName,
    msgHint: "",
    ref_msg_info: { comment: "" },
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = src;
  });
}

function deepStringField(record: JsonRecord, keys: string[]) {
  let found = stringField(record, keys);
  if (found) return found;
  walkRecords(record, (candidate) => {
    if (found) return;
    found = stringField(candidate, keys);
  });
  return found;
}

function deepFirstUrl(record: JsonRecord, keys: string[]) {
  let found = "";
  for (const key of keys) {
    found = firstUrl(record[key]);
    if (found) return found;
  }
  walkRecords(record, (candidate) => {
    if (found) return;
    for (const key of keys) {
      found = firstUrl(candidate[key]);
      if (found) return;
    }
  });
  return found;
}

function hasDeepField(record: JsonRecord, keys: string[]) {
  if (keys.some((key) => record[key] !== undefined && record[key] !== null)) return true;
  let found = false;
  walkRecords(record, (candidate) => {
    if (!found) {
      found = keys.some((key) => candidate[key] !== undefined && candidate[key] !== null);
    }
  });
  return found;
}

function parseJsonContent(value: string): JsonRecord | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseNestedJsonField(record: JsonRecord, keys: string[]): JsonRecord | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const parsed = parseJsonContent(value);
    if (parsed) return parsed;
  }
  return null;
}

function normalizeSharedItemId(value: string): string {
  if (!value) return "";
  const direct = value.trim();
  if (/^\d+$/.test(direct)) return direct;
  const numericParts = direct.split(/[_:/?&=#-]+/).filter((part) => /^\d{10,}$/.test(part));
  return numericParts[numericParts.length - 1] || "";
}

function uniqueTextParts(parts: string[]) {
  const seen = new Set<string>();
  return parts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}

function imDynamicText(value: unknown): string {
  const parts: string[] = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!isRecord(item)) return;
    const type = stringField(item, ["type"]);
    if (type === "im-image" || type === "im-icon") return;
    const normal = stringField(item, ["content@normal"]);
    if (normal) parts.push(normal);
    const text = stringField(item, ["text"]);
    if (text) parts.push(text);
    const content = item.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      if (trimmed && !/^https?:\/\//.test(trimmed)) parts.push(trimmed);
      return;
    }
    visit(content);
  };
  visit(value);
  return uniqueTextParts(parts).join(" · ");
}

function parseDynamicPatchCard(root: JsonRecord): SharedMessageCard | null {
  const directPatch = isRecord(root.im_dynamic_patch)
    ? root.im_dynamic_patch
    : isRecord(root.imDynamicPatch)
      ? root.imDynamicPatch
      : undefined;
  const patch = directPatch || (stringField(root, ["card_key", "cardKey", "card_type", "cardType", "raw_data", "rawData"]) ? root : undefined);
  if (!patch) return null;
  const rawValue = patch.raw_data ?? patch.rawData;
  const rawData = typeof rawValue === "string"
    ? parseJsonContent(rawValue)
    : isRecord(rawValue)
      ? rawValue
      : null;
  const cardKey = stringField(patch, ["card_key", "cardKey"]);
  const cardType = stringField(patch, ["card_type", "cardType"]);
  const hint = stringField(root, ["push_detail", "description", "msgHint"]);
  const signal = `${cardKey} ${cardType} ${hint}`.toLowerCase();
  const aweType = Number(root.aweType || root.awe_type || 0);
  const isLocation = aweType === 110147 || /poi|shop|地点/.test(signal);
  const isProduct = aweType === 11052 || /product|goods|group|商品/.test(signal);
  if (!rawData && !isLocation && !isProduct) return null;
  const titleFromHint = hint.replace(/^分享(?:地点|商品)\s*[:：]\s*/, "");
  const title = imDynamicText(rawData?.content_top) || titleFromHint;
  const detailParts = uniqueTextParts([
    imDynamicText(rawData?.content_content_top),
    imDynamicText(rawData?.content_bottom_left),
    imDynamicText(rawData?.content_content),
    imDynamicText(rawData?.content_bottom_right),
  ]).filter((part) => part !== title);
  const kind: SharedMessageCard["kind"] = isLocation ? "location" : isProduct ? "product" : "share";
  const subtitlePrefix = kind === "location" ? "分享地点" : kind === "product" ? "分享商品" : "分享卡片";
  const top = isRecord(rawData?.top) ? rawData.top : undefined;
  const coverUrl =
    firstUrl(top?.content) ||
    firstUrl(rawData?.top) ||
    deepFirstUrl(rawData || {}, ["cover_url", "content_cover", "image", "url"]);
  if (!title && !coverUrl && detailParts.length === 0) return null;
  return {
    kind,
    title: title || titleFromHint || subtitlePrefix,
    subtitle: uniqueTextParts([subtitlePrefix, ...detailParts]).join(" · "),
    coverUrl,
    avatarUrl: "",
    authorName: "",
    itemId: "",
  };
}

function parseSharedMessage(message: LocalChatMessage): SharedMessageCard | null {
  const root = parseJsonContent(message.rawContent || message.text);
  if (!root) return null;
  const nested = parseNestedJsonField(root, ["share_content", "shareContent", "content", "text"]);
  const parsed = nested || root;
  const dynamicCard = parseDynamicPatchCard(parsed) || (nested ? parseDynamicPatchCard(root) : null);
  if (dynamicCard) return dynamicCard;
  const inlineImageUrl = inlineImageDataUrl(deepStringField(parsed, ["inline_pic", "inlinePic"]));
  const resourceImageUrl = deepFirstUrl(parsed, ["resource_url"]);
  const resource = isRecord(parsed.resource_url) ? parsed.resource_url : undefined;
  const imageSkey = stringField(resource, ["skey"]) || deepStringField(parsed, ["skey"]);
  const isImageContent = Number(parsed.aweType || parsed.awe_type || 0) === 2702 || Boolean(resourceImageUrl || inlineImageUrl);
  const itemId = normalizeSharedItemId(
    deepStringField(parsed, ["itemId", "item_id", "awemeId", "aweme_id"]) ||
    deepStringField(parsed, ["share_id"]),
  );
  const commentText = deepStringField(parsed, [
    "comment_content",
    "comment_text",
    "reply_content",
    "reply_text",
    "origin_comment_content",
    "origin_comment_text",
  ]);
  const title = commentText || deepStringField(parsed, [
    "content_title",
    "content_name",
    "aweme_title",
    "item_title",
    "title",
    "desc",
    "text",
  ]);
  const hasCommentSignal = hasDeepField(parsed, [
    "comment_id",
    "cid",
    "comment_content",
    "comment_text",
    "comment_info",
    "reply_id",
    "reply_content",
    "reply_text",
    "origin_comment_content",
    "origin_comment_text",
  ]);
  const hasShareSignal = Boolean(
    itemId ||
      hasCommentSignal ||
      isImageContent ||
      deepStringField(parsed, ["content_title", "content_name", "aweme_title", "item_title"]) ||
      deepFirstUrl(parsed, ["cover_url", "content_cover", "aweme_cover", "item_cover", "video_cover", "origin_cover", "url"]),
  );
  if (!hasShareSignal) return null;
  const coverUrl =
    deepFirstUrl(parsed, ["cover_url", "content_cover", "aweme_cover", "item_cover", "video_cover", "origin_cover"]) ||
    resourceImageUrl ||
    deepFirstUrl(parsed, ["url"]) ||
    deepFirstUrl(parsed, ["content_thumb", "thumb_url"]) ||
    inlineImageUrl;
  const kind: SharedMessageCard["kind"] = isImageContent ? "image" : hasCommentSignal ? "comment" : itemId ? "video" : coverUrl ? "image" : "share";
  const avatarUrl = deepFirstUrl(parsed, ["content_thumb", "author_avatar", "avatar_thumb", "user_avatar"]);
  const authorName = deepStringField(parsed, [
    "author_name",
    "authorName",
    "nickname",
    "nick_name",
    "user_name",
    "share_user_name",
    "content_author_name",
  ]);
  if (!title && !coverUrl) return null;
  return {
    kind,
    title: title || (kind === "comment" ? "分享了一条评论" : kind === "image" ? "图片" : "分享了一条内容"),
    subtitle: kind === "comment" ? "分享评论" : kind === "video" ? "分享视频" : kind === "image" ? "图片" : "分享内容",
    coverUrl,
    skey: kind === "image" ? imageSkey : undefined,
    avatarUrl,
    authorName,
    itemId,
  };
}

function normalizeLikeNoticeText(value: string) {
  const text = value
    .replace(/\{\{\d+\}\}/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*分享的\s*$/g, "分享的内容")
    .trim();
  return text || "点赞";
}

function centerNoticeText(message: LocalChatMessage) {
  const root = parseJsonContent(message.rawContent || "");
  const candidates = uniqueTextParts([
    message.text,
    root ? stringField(root, ["msgHint", "description", "push_detail", "text", "content"]) : "",
  ]);
  const matched = candidates.find((item) => LIKE_NOTICE_PATTERN.test(item));
  return matched ? normalizeLikeNoticeText(matched) : "";
}

function messagePreviewText(message: LocalChatMessage | undefined) {
  if (!message) return "";
  const notice = centerNoticeText(message);
  if (notice) {
    const root = parseJsonContent(message.rawContent || "");
    const candidates = uniqueTextParts([
      message.text,
      root ? stringField(root, ["msgHint", "description", "push_detail", "text", "content"]) : "",
    ]);
    const matched = candidates.find((item) => LIKE_NOTICE_PATTERN.test(item));
    if (matched) {
      return `[点赞] ${notice}`;
    }
    return notice;
  }
  if (message.imagePreviewUrl) return "[图片]";
  const shared = parseSharedMessage(message);
  if (shared?.kind === "image") return "[图片]";
  if (shared) return `[${shared.subtitle}] ${shared.title}`;
  return message.text;
}

function hasFramedMessageBody(message: LocalChatMessage) {
  return Boolean(message.imagePreviewUrl || parseSharedMessage(message));
}

function fallbackMessageText(rawContent: string | undefined) {
  if (!rawContent) return "";
  const shared = parseSharedMessage({
    id: "",
    text: "",
    rawContent,
    createdAt: 0,
    status: "sent",
    direction: "out",
  });
  return shared?.kind === "image" ? "[图片]" : "[分享内容]";
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function walkRecords(value: unknown, visit: (record: JsonRecord) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkRecords(item, visit));
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  Object.values(value).forEach((item) => walkRecords(item, visit));
}

function arrayField(value: unknown) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.data)) return value.data.filter(isRecord);
  return [];
}

function stringField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return 0;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function extractSecUid(record: JsonRecord) {
  return stringField(record, ["sec_uid", "sec_user_id", "sec_user_id_str", "secUserId", "secUid"]);
}

function extractAvatar(record: JsonRecord | undefined) {
  const direct = stringField(record, ["avatar_thumb", "avatar_small", "avatar_medium", "avatar", "avatar_url"]);
  if (direct) return direct;
  if (!record) return "";
  for (const key of ["avatar_thumb", "avatar_small", "avatar_medium", "avatar_larger"]) {
    const value = record[key];
    if (isRecord(value) && Array.isArray(value.url_list)) {
      const first = value.url_list.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") return first;
    }
  }
  return "";
}

function extractIds(text: string) {
  const matches = text.match(/MS4w\.?LjAB[A-Za-z0-9_-]+/g) || [];
  const lines = text
    .split(/[\n,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.startsWith("MS4wLjAB") || item.startsWith("MS4w.LjAB"));
  return Array.from(new Set([...matches, ...lines]));
}

function responseNowSeconds(response: FriendOnlineStatusResponse) {
  const active = response.active_status;
  if (isRecord(active) && isRecord(active.extra)) {
    const now = numberField(active.extra, ["now"]);
    if (now > 1_000_000_000_000) return Math.floor(now / 1000);
    if (now > 0) return Math.floor(now);
  }
  return Math.floor(Date.now() / 1000);
}

function formatLastActive(value: number) {
  if (!value) return "未显示";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatUpdateTime(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMessageTime(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isSameMessageDate(left: number, right: number) {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate();
}

function formatMessageDate(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameMessageDate(value, today.getTime())) return "";
  if (isSameMessageDate(value, yesterday.getTime())) return "昨天";
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  if (date.getFullYear() === today.getFullYear()) return monthDay;
  return `${date.getFullYear()}年${monthDay}`;
}

function formatMessageDividerTime(value: number, includeDate: boolean) {
  const time = formatMessageTime(value);
  const date = formatMessageDate(value);
  if (!includeDate && !date) return time;
  return date ? `${date} ${time}` : time;
}

function collectRecordsBySecUid(value: unknown) {
  const map = new Map<string, JsonRecord>();
  const direct = arrayField(value);
  if (direct.length > 0) {
    direct.forEach((record) => {
      const secUid = extractSecUid(record);
      if (secUid) map.set(secUid, record);
    });
    return map;
  }

  walkRecords(value, (record) => {
    const secUid = extractSecUid(record);
    if (secUid) map.set(secUid, record);
  });
  return map;
}

function mapResponse(response: FriendOnlineStatusResponse): FriendStatusItem[] {
  const nowSeconds = responseNowSeconds(response);
  const users = collectRecordsBySecUid(response.user_info);
  const statuses = collectRecordsBySecUid(response.active_status);
  const ids = Array.from(new Set([...statuses.keys(), ...users.keys(), ...(response.sec_user_ids || [])]));

  return ids
    .map((secUid) => {
      const user = users.get(secUid);
      const status = statuses.get(secUid);
      const lastActiveTime = numberField(status, ["last_active_time", "active_time", "last_seen"]);
      const online =
        lastActiveTime > 0 &&
        nowSeconds - lastActiveTime >= 0 &&
        nowSeconds - lastActiveTime <= ONLINE_WINDOW_SECONDS;

      return {
        secUid,
        uid: stringField(user, ["uid", "user_id", "id", "uid_str", "short_id"]),
        nickname: stringField(user, ["nickname", "nick_name", "display_name", "unique_id"]),
        remarkName: stringField(user, ["remark_name"]),
        avatar: extractAvatar(user),
        signature: stringField(user, ["signature", "desc"]),
        online,
        statusText: online ? "在线" : lastActiveTime > 0 ? "最近活跃" : "未显示",
        lastActive: formatLastActive(lastActiveTime),
        lastActiveTime,
      };
    })
    .sort((a, b) => {
      if (!a.lastActiveTime && !b.lastActiveTime) return 0;
      if (!a.lastActiveTime) return 1;
      if (!b.lastActiveTime) return -1;
      return b.lastActiveTime - a.lastActiveTime;
    });
}

export function FriendsStatusView() {
  const setView = useAppStore((state) => state.setView);
  const setFriendUnreadCount = useAppStore((state) => state.setFriendUnreadCount);
  const openUser = useSearchStore((state) => state.openUser);
  const { downloadVideo } = useDownloads();
  const [input, setInput] = useState(() => localStorage.getItem(STORAGE_KEY) || "");
  const [currentSecUid, setCurrentSecUid] = useState<string>("");
  const [chatDrafts, setChatDrafts] = useState<ChatDrafts>(() => readChatDrafts());
  const [chatMessages, setChatMessages] = useState<ChatMessages>(() => readChatMessages());
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>(() => readUnreadCounts());
  const [chatSummaries, setChatSummaries] = useState<ChatSummaries>(() => readChatSummaries());
  const [selectedFriendId, setSelectedFriendId] = useState("");
  const [historyState, setHistoryState] = useState<HistoryPageState>({});
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [savedCount, setSavedCount] = useState(0);
  const [includeAllUsers, setIncludeAllUsers] = useState(false);
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_INTERVAL_SECONDS);
  const [currentUserAvatar, setCurrentUserAvatar] = useState(() => localStorage.getItem(CURRENT_USER_AVATAR_KEY) || "");
  const [imStatus, setImStatus] = useState<ImConnectionStatus>({
    connected: false,
    message: "接收通道未连接",
    updatedAt: 0,
  });
  const [showManualInput, setShowManualInput] = useState(false);
  const [loading, setLoading] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [sharedPlayerVideos, setSharedPlayerVideos] = useState<VideoInfo[]>([]);
  const [sharedPlayerOpen, setSharedPlayerOpen] = useState(false);
  const [sharedPlayerLoadingId, setSharedPlayerLoadingId] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(0);
  const [error, setError] = useState("");
  const [response, setResponse] = useState<FriendOnlineStatusResponse | null>(null);
  const savedIdsRef = useRef<string[]>([]);
  const idsRef = useRef<string[]>([]);
  const queryInFlightRef = useRef(false);
  const pendingBackgroundQueryRef = useRef(false);
  const lastQueryStartedAtRef = useRef(0);
  const pendingBackgroundTimerRef = useRef<number | null>(null);
  const cookieRetryTimerRef = useRef<number | null>(null);
  const avatarRetryTimerRef = useRef<number | null>(null);
  const initialInputRef = useRef(input);
  const chatStateLoadedRef = useRef(false);
  const selectedFriendIdRef = useRef(selectedFriendId);
  const currentSecUidRef = useRef(currentSecUid);

  useEffect(() => {
    currentSecUidRef.current = currentSecUid;
  }, [currentSecUid]);

  useEffect(() => {
    selectedFriendIdRef.current = selectedFriendId;
  }, [selectedFriendId]);

  useEffect(() => {
    let active = true;
    getAccounts().then((res) => {
      if (active && res.success && res.current_sec_uid) {
        const uid = res.current_sec_uid;
        setCurrentSecUid(uid);
        setChatDrafts(readChatDrafts(uid));
        setChatMessages(readChatMessages(uid));
        setUnreadCounts(readUnreadCounts(uid));
        setChatSummaries(readChatSummaries(uid));
      }
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  const ids = useMemo(() => extractIds(input), [input]);
  const friends = useMemo(() => {
    if (!response?.success) return [];
    const rawFriends = mapResponse(response);
    if (!currentSecUid) return rawFriends;
    return rawFriends.filter((f) => f.secUid !== currentSecUid);
  }, [response, currentSecUid]);
  const friendItems = useMemo<FriendListItem[]>(() => friends
    .map((friend) => {
      const latestMessage = latestChatMessage(chatMessages[friend.secUid]);
      const persistedSummary = chatSummaries[friend.secUid];
      const displayMessage = latestMessage && latestMessage.createdAt >= (persistedSummary?.latestMessageAt || 0)
        ? latestMessage
        : persistedSummary?.latestMessage;
      const displayText = messagePreviewText(displayMessage || latestMessage);
      const previewText = latestMessage
        ? `${displayMessage?.direction === "out" ? "我：" : ""}${displayText || latestMessage.text}`
        : displayMessage
          ? `${displayMessage.direction === "out" ? "我：" : ""}${displayText}`
          : friend.signature || friend.secUid;
      return {
        ...friend,
        latestMessage: displayMessage,
        latestMessageAt: Math.max(latestMessage?.createdAt || 0, persistedSummary?.latestMessageAt || 0),
        previewText,
        unreadCount: Math.max(unreadCounts[friend.secUid] || 0, persistedSummary?.unreadCount || 0),
      };
    })
    .sort((a, b) => {
      if (a.latestMessageAt || b.latestMessageAt) {
        return b.latestMessageAt - a.latestMessageAt;
      }
      if (a.lastActiveTime || b.lastActiveTime) {
        return b.lastActiveTime - a.lastActiveTime;
      }
      return 0;
    }), [chatMessages, chatSummaries, friends, unreadCounts]);
  const selectedFriend = useMemo(
    () => friendItems.find((friend) => friend.secUid === selectedFriendId) || null,
    [friendItems, selectedFriendId],
  );
  const selectedMessages = selectedFriend ? chatMessages[selectedFriend.secUid] || [] : [];
  const selectedHistory = selectedFriend ? historyState[selectedFriend.secUid] : undefined;
  const onlineCount = friends.filter((friend) => friend.online).length;
  const offlineCount = friends.filter((friend) => !friend.online).length;
  const isInitialLoading = loading && friends.length === 0;

  const openFriendProfile = useCallback(
    async (friend: FriendStatusItem) => {
      const user: UserInfo = {
        uid: friend.uid,
        nickname: friend.remarkName || friend.nickname || "未知用户",
        avatar_thumb: friend.avatar,
        avatar_medium: friend.avatar,
        avatar_larger: friend.avatar,
        signature: friend.signature,
        follower_count: 0,
        following_count: 0,
        total_favorited: 0,
        aweme_count: 0,
        favoriting_count: 0,
        is_follow: false,
        follow_status: 0,
        sec_uid: friend.secUid,
        unique_id: "",
        verify_status: 0,
      };
      setView("user");
      await openUser(user, { loadVideos: true });
    },
    [openUser, setView],
  );

  const openSharedVideo = useCallback(async (card: SharedMessageCard) => {
    if (!card.itemId || sharedPlayerLoadingId) return;
    setSharedPlayerLoadingId(card.itemId);
    setError("");
    try {
      const result = await getVideoDetail(card.itemId);
      if (!result.success || !result.video) {
        throw new Error(result.message || "无法加载分享视频");
      }
      setSharedPlayerVideos([result.video]);
      setSharedPlayerOpen(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法加载分享视频");
    } finally {
      setSharedPlayerLoadingId("");
    }
  }, [sharedPlayerLoadingId]);

  useEffect(() => {
    let cancelled = false;
    void getFriendChatState()
      .then((result) => {
        if (cancelled) return;
        chatStateLoadedRef.current = true;
        const summaries = isRecord(result.summaries) ? result.summaries : {};
        const unread = isRecord(result.unreadCounts) ? result.unreadCounts : {};
        const nextSummaries = readChatSummaries(currentSecUidRef.current);
        let messagesMerged = false;
        
        setChatMessages((currentChatMessages) => {
          const nextChatMessages = { ...currentChatMessages };
          for (const [secUid, value] of Object.entries(summaries)) {
            if (!isRecord(value)) continue;
            const latestRaw = isRecord(value.latestMessage) ? value.latestMessage : undefined;
            const latestMessage = latestRaw ? {
              id: stringField(latestRaw, ["id"]) || `${secUid}-${numberField(latestRaw, ["createdAt"])}`,
              text: stringField(latestRaw, ["text"]),
              rawContent: stringField(latestRaw, ["rawContent", "raw_content"]) || undefined,
              imagePreviewUrl: stringField(latestRaw, ["imagePreviewUrl"]).startsWith("blob:") ? undefined : stringField(latestRaw, ["imagePreviewUrl"]) || undefined,
              createdAt: numberField(latestRaw, ["createdAt"]),
              status: normalizeMessageStatus(stringField(latestRaw, ["status"])),
              direction: normalizeMessageDirection(stringField(latestRaw, ["direction"])),
              senderUid: stringField(latestRaw, ["senderUid", "sender_uid"]),
              error: stringField(latestRaw, ["error"]) || undefined,
            } : undefined;

            if (latestMessage && latestMessage.text) {
              const currentList = nextChatMessages[secUid] || [];
              if (!currentList.some((existing) => 
                existing.id === latestMessage.id || 
                (existing.text === latestMessage.text && Math.abs(existing.createdAt - latestMessage.createdAt) < 60000)
              )) {
                nextChatMessages[secUid] = [...currentList, latestMessage].sort((a, b) => a.createdAt - b.createdAt);
                messagesMerged = true;
              }
            }

            const latestMessageAt = Math.max(numberField(value, ["latestMessageAt"]), latestMessage?.createdAt || 0);
            const unreadCount = Math.max(0, numberField(value, ["unreadCount"]));
            const current = nextSummaries[secUid];
            if (latestMessageAt >= (current?.latestMessageAt || 0)) {
              nextSummaries[secUid] = {
                latestMessage: latestMessage?.text ? latestMessage : current?.latestMessage,
                latestMessageAt,
                unreadCount: Math.max(unreadCount, current?.unreadCount || 0),
              };
            }
          }
          if (messagesMerged) {
            persistChatMessages(nextChatMessages, currentSecUidRef.current);
          }
          return nextChatMessages;
        });

        for (const [secUid, value] of Object.entries(unread)) {
          const count = Math.max(0, Number(value) || 0);
          if (!count) continue;
          nextSummaries[secUid] = {
            latestMessage: nextSummaries[secUid]?.latestMessage,
            latestMessageAt: nextSummaries[secUid]?.latestMessageAt || 0,
            unreadCount: secUid === selectedFriendIdRef.current ? 0 : Math.max(count, nextSummaries[secUid]?.unreadCount || 0),
          };
        }
        persistChatSummaries(nextSummaries, currentSecUidRef.current);
        setChatSummaries(nextSummaries);
        setUnreadCounts((current) => {
          const next = { ...current };
          for (const [secUid, summary] of Object.entries(nextSummaries)) {
            if (summary.unreadCount > 0 && secUid !== selectedFriendIdRef.current) {
              next[secUid] = Math.max(next[secUid] || 0, summary.unreadCount);
            } else if (secUid === selectedFriendIdRef.current) {
              delete next[secUid];
            }
          }
          persistUnreadCounts(next, currentSecUidRef.current);
          return next;
        });
      })
      .catch(() => {
        chatStateLoadedRef.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [currentSecUid]);

  useEffect(() => {
    setChatSummaries((current) => {
      let changed = false;
      const next: ChatSummaries = { ...current };
      for (const [secUid, messages] of Object.entries(chatMessages)) {
        const latestMessage = latestChatMessage(messages);
        if (!latestMessage) continue;
        const unreadCount = unreadCounts[secUid] || 0;
        const currentSummary = next[secUid];
        if (
          latestMessage.createdAt >= (currentSummary?.latestMessageAt || 0) ||
          unreadCount !== (currentSummary?.unreadCount || 0)
        ) {
          next[secUid] = {
            latestMessage,
            latestMessageAt: Math.max(latestMessage.createdAt, currentSummary?.latestMessageAt || 0),
            unreadCount,
          };
          changed = true;
        }
      }
      for (const [secUid, count] of Object.entries(unreadCounts)) {
        if ((next[secUid]?.unreadCount || 0) === count) continue;
        next[secUid] = {
          latestMessage: next[secUid]?.latestMessage,
          latestMessageAt: next[secUid]?.latestMessageAt || 0,
          unreadCount: count,
        };
        changed = true;
      }
      if (!changed) return current;
      persistChatSummaries(next, currentSecUidRef.current);
      return next;
    });
  }, [chatMessages, unreadCounts]);

  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    setFriendUnreadCount(total);
  }, [setFriendUnreadCount, unreadCounts]);

  useEffect(() => {
    if (!chatStateLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveFriendChatState({
        summaries: chatSummaries,
        unreadCounts,
      }, currentSecUidRef.current).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [chatSummaries, unreadCounts]);

  const updateDraft = useCallback((secUid: string, value: string) => {
    setChatDrafts((current) => {
      const next = { ...current };
      if (value) {
        next[secUid] = value;
      } else {
        delete next[secUid];
      }
      persistChatDrafts(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const patchMessage = useCallback((secUid: string, messageId: string, patch: Partial<LocalChatMessage>) => {
    setChatMessages((current) => {
      const next = {
        ...current,
        [secUid]: (current[secUid] || []).map((message) =>
          message.id === messageId ? { ...message, ...patch } : message,
        ),
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const clearUnread = useCallback((secUid: string) => {
    setUnreadCounts((current) => {
      const next = { ...current };
      delete next[secUid];
      persistUnreadCounts(next, currentSecUidRef.current);
      return next;
    });
    setChatSummaries((current) => {
      const summary = current[secUid];
      if (!summary || summary.unreadCount === 0) return current;
      const next = {
        ...current,
        [secUid]: {
          ...summary,
          unreadCount: 0,
        },
      };
      persistChatSummaries(next, currentSecUidRef.current);
      return next;
    });
  }, []);

  const sendLocalMessage = useCallback(async (friend: FriendStatusItem, value: string) => {
    const text = value.trim();
    if (!text) return;
    const message: LocalChatMessage = {
      id: `${friend.secUid}-${Date.now()}`,
      text,
      rawContent: undefined,
      createdAt: Date.now(),
      status: "pending",
      direction: "out",
    };
    setChatMessages((current) => {
      const next = {
        ...current,
        [friend.secUid]: [...(current[friend.secUid] || []), message],
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });
    updateDraft(friend.secUid, "");

    if (!friend.uid) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: "缺少好友数字 uid，无法发送",
      });
      return;
    }

    try {
      const result = await sendFriendMessage({ toUserId: friend.uid, content: text });
      if (!result.success) {
        throw new Error(result.message || "发送失败");
      }
      patchMessage(friend.secUid, message.id, { status: "sent", error: "" });
    } catch (caught) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: caught instanceof Error ? caught.message : "发送失败",
      });
    }
  }, [patchMessage, updateDraft]);

  const sendLocalImageMessage = useCallback(async (friend: FriendStatusItem, file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件");
      return;
    }
    if (file.size > MAX_SEND_IMAGE_BYTES) {
      setError("图片不能超过 8MB");
      return;
    }
    if (!friend.uid) {
      setError("缺少好友数字 uid，无法发送图片");
      return;
    }
    setError("");
    const imageDataUrl = await readFileAsDataUrl(file);
    if (!imageDataUrl) {
      setError("读取图片失败");
      return;
    }
    const size = await readImageSize(imageDataUrl);
    const message: LocalChatMessage = {
      id: `${friend.secUid}-${Date.now()}`,
      text: "[图片]",
      rawContent: imageMessageRawContent("", size.width, size.height, file.name),
      imagePreviewUrl: URL.createObjectURL(file),
      createdAt: Date.now(),
      status: "pending",
      direction: "out",
    };
    setChatMessages((current) => {
      const next = {
        ...current,
        [friend.secUid]: [...(current[friend.secUid] || []), message],
      };
      persistChatMessages(next, currentSecUidRef.current);
      return next;
    });

    try {
      const result = await sendFriendImageMessage({
        toUserId: friend.uid,
        imageDataUrl,
        width: size.width,
        height: size.height,
        fileName: file.name,
        mimeType: file.type,
      });
      if (!result.success) {
        throw new Error(result.message || "发送图片失败");
      }
      patchMessage(friend.secUid, message.id, { status: "sent", error: "" });
    } catch (caught) {
      patchMessage(friend.secUid, message.id, {
        status: "error",
        error: caught instanceof Error ? caught.message : "发送图片失败",
      });
    }
  }, [patchMessage]);

  const selectFriend = useCallback((friend: FriendStatusItem) => {
    setSelectedFriendId(friend.secUid);
    clearUnread(friend.secUid);
  }, [clearUnread]);

  const mergeHistoryMessages = useCallback((items: FriendMessageHistoryItem[], fallbackFriend?: FriendStatusItem | null) => {
    if (!items.length) return 0;
    let mergedCount = 0;
    setChatMessages((current) => {
      const next: ChatMessages = { ...current };
      for (const item of items) {
        const conversationId = stringField(item as JsonRecord, ["conversation_id", "conversationId"]);
        const senderUid = stringField(item as JsonRecord, ["sender_uid", "senderUid"]);
        const rawContent = stringField(item as JsonRecord, ["raw_content", "rawContent"]) || undefined;
        const text = stringField(item as JsonRecord, ["content", "text"]) || fallbackMessageText(rawContent);
        const messageId = stringField(item as JsonRecord, ["server_message_id", "message_id", "id"]);
        if (!text) continue;
        if (text.trim().startsWith('{') && text.includes("command_type")) {
          continue;
        }
        const friend = fallbackFriend || friends.find((candidate) =>
          (senderUid && candidate.uid === senderUid) ||
          (candidate.uid && conversationId.includes(candidate.uid))
        );
        if (!friend) continue;
        const rawCreatedAt = numberField(item as JsonRecord, ["created_at", "createdAt", "create_time", "createTime"]);
        const createdAt = rawCreatedAt > 0 && rawCreatedAt < 10_000_000_000
          ? rawCreatedAt * 1000
          : rawCreatedAt || Date.now();
        const message: LocalChatMessage = {
          id: messageId || `${friend.secUid}-${createdAt}`,
          text,
          rawContent,
          createdAt,
          status: "sent",
          direction: senderUid && senderUid === friend.uid ? "in" : "out",
          senderUid,
        };
        const currentMessages = next[friend.secUid] || [];
        if (currentMessages.some((existing) => existing.id === message.id)) continue;
        next[friend.secUid] = [...currentMessages, message].sort((a, b) => a.createdAt - b.createdAt);
        mergedCount += 1;
      }
      if (mergedCount > 0) {
        persistChatMessages(next, currentSecUidRef.current);
        return next;
      }
      return current;
    });
    return mergedCount;
  }, [friends]);

  const loadHistoryMessages = useCallback(async (friend: FriendStatusItem, cursor = 0) => {
    const current = historyState[friend.secUid];
    if (current?.loading) return;
    if (cursor > 0 && current?.hasMore === false) return;
    const currentMessages = chatMessages[friend.secUid] || [];
    setHistoryState((state) => ({
      ...state,
      [friend.secUid]: {
        loaded: Boolean(state[friend.secUid]?.loaded),
        loading: true,
        nextCursor: state[friend.secUid]?.nextCursor || 0,
        hasMore: state[friend.secUid]?.hasMore ?? true,
        error: "",
      },
    }));
    try {
      const result = await getFriendMessageHistory({ cursor, toUserId: friend.uid });
      if (!result.success) {
        throw new Error(result.message || "获取历史消息失败");
      }
      const messages = Array.isArray(result.messages) ? result.messages : [];
      mergeHistoryMessages(messages, friend);
      const nextCursor = Number(result.next_cursor || 0) || 0;
      setHistoryState((state) => ({
        ...state,
        [friend.secUid]: {
          loaded: true,
          loading: false,
          nextCursor,
          hasMore: Boolean(nextCursor && messages.length > 0),
          error: "",
        },
      }));
    } catch (caught) {
      setHistoryState((state) => ({
        ...state,
        [friend.secUid]: {
          loaded: cursor === 0 ? true : Boolean(state[friend.secUid]?.loaded),
          loading: false,
          nextCursor: state[friend.secUid]?.nextCursor || 0,
          hasMore: false,
          error: cursor === 0 && currentMessages.length === 0
            ? caught instanceof Error ? caught.message : "获取历史消息失败"
            : "",
        },
      }));
    }
  }, [chatMessages, historyState, mergeHistoryMessages]);

  useEffect(() => {
    if (!selectedFriend || !selectedFriend.uid) return;
    const current = historyState[selectedFriend.secUid];
    if (current?.loaded || current?.loading) return;
    void loadHistoryMessages(selectedFriend, 0);
  }, [historyState, loadHistoryMessages, selectedFriend]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<Record<string, unknown>>("im-status", (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      setImStatus({
        connected: Boolean(payload.connected),
        message: stringField(payload, ["message"]) || (payload.connected ? "私信接收已连接" : "私信接收未连接"),
        updatedAt: numberField(payload, ["updated_at", "updatedAt"]) || Date.now(),
      });
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<Record<string, unknown>>("im-message", (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
      const rawContent = stringField(payload, ["raw_content", "rawContent"]) || undefined;
      const text = stringField(payload, ["content", "text"]) || fallbackMessageText(rawContent);
      const serverMessageId = stringField(payload, ["server_message_id", "message_id", "id"]);
      if (!senderUid || !text) return;
      const friend = friends.find((item) => item.uid === senderUid);
      if (!friend) return;
      const message: LocalChatMessage = {
        id: serverMessageId || `${friend.secUid}-${Date.now()}`,
        text,
        rawContent,
        createdAt: numberField(payload, ["created_at", "createdAt"]) || Date.now(),
        status: "sent",
        direction: "in",
        senderUid,
      };
      setChatMessages((current) => {
        const currentMessages = current[friend.secUid] || [];
        if (currentMessages.some((item) => item.id === message.id)) return current;
        const next = {
          ...current,
          [friend.secUid]: [...currentMessages, message],
        };
        persistChatMessages(next, currentSecUidRef.current);
        return next;
      });
      if (friend.secUid !== selectedFriendId) {
        setUnreadCounts((current) => {
          const next = {
            ...current,
            [friend.secUid]: (current[friend.secUid] || 0) + 1,
          };
          persistUnreadCounts(next, currentSecUidRef.current);
          return next;
        });
      }
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [friends, selectedFriendId, currentSecUid]);

  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  useEffect(() => {
    savedIdsRef.current = savedIds;
  }, [savedIds]);

  useEffect(() => {
    if (friends.length === 0) {
      setSelectedFriendId("");
      return;
    }
    if (selectedFriendId && !friends.some((friend) => friend.secUid === selectedFriendId)) {
      setSelectedFriendId("");
    }
  }, [friends, selectedFriendId]);

  useEffect(() => {
    if (selectedFriend) {
      clearUnread(selectedFriend.secUid);
    }
  }, [clearUnread, selectedFriend]);

  const query = useCallback(async (overrideIds?: string[], options?: { background?: boolean; retryCookie?: boolean }) => {
    const background = Boolean(options?.background);
    if (background && Date.now() - lastQueryStartedAtRef.current < MIN_BACKGROUND_REFRESH_INTERVAL_MS) {
      return;
    }
    if (queryInFlightRef.current) {
      if (background) pendingBackgroundQueryRef.current = true;
      return;
    }
    const retryCookie = options?.retryCookie !== false;
    const baseIds = overrideIds ?? savedIdsRef.current;
    const queryIds = Array.from(new Set([...baseIds, ...idsRef.current]));
    queryInFlightRef.current = true;
    lastQueryStartedAtRef.current = Date.now();
    if (!background) {
      setError("");
      setLoading(true);
    } else {
      setBackgroundRefreshing(true);
    }
    try {
      localStorage.setItem(STORAGE_KEY, queryIds.join("\n"));
      const result = await getFriendOnlineStatus(queryIds);
      const hasUsableData = Boolean(
        result.success ||
        (Array.isArray(result.sec_user_ids) && result.sec_user_ids.length > 0) ||
        mapResponse(result).length > 0,
      );
      if (hasUsableData) {
        setResponse(result);
        setLastUpdatedAt(Date.now());
        setError("");
      }
      if (hasUsableData && Array.isArray(result.sec_user_ids)) {
        setSavedIds(result.sec_user_ids);
        setSavedCount(result.sec_user_ids.length);
        setInput(result.sec_user_ids.join("\n"));
        localStorage.setItem(STORAGE_KEY, result.sec_user_ids.join("\n"));
      }
      if (!hasUsableData && !background) {
        const message = result.message || "获取好友在线状态失败";
        if (retryCookie && COOKIE_REQUIRED_PATTERN.test(message)) {
          const config = await getConfig().catch(() => null);
          if (config?.cookie_set) {
            setError("");
            if (cookieRetryTimerRef.current !== null) {
              window.clearTimeout(cookieRetryTimerRef.current);
            }
            cookieRetryTimerRef.current = window.setTimeout(() => {
              cookieRetryTimerRef.current = null;
              void query(queryIds, { background, retryCookie: false });
            }, 700);
          } else {
            setError(message);
          }
        } else {
          setError(message);
        }
      }
    } catch (caught) {
      if (!background) {
        const message = caught instanceof Error ? caught.message : "获取好友在线状态失败";
        if (retryCookie && COOKIE_REQUIRED_PATTERN.test(message)) {
          const config = await getConfig().catch(() => null);
          if (config?.cookie_set) {
            setError("");
            if (cookieRetryTimerRef.current !== null) {
              window.clearTimeout(cookieRetryTimerRef.current);
            }
            cookieRetryTimerRef.current = window.setTimeout(() => {
              cookieRetryTimerRef.current = null;
              void query(queryIds, { background, retryCookie: false });
            }, 700);
          } else {
            setError(message);
          }
        } else {
          setError(message);
        }
      }
    } finally {
      queryInFlightRef.current = false;
      if (background) {
        setBackgroundRefreshing(false);
      } else {
        setLoading(false);
      }
      if (pendingBackgroundQueryRef.current) {
        pendingBackgroundQueryRef.current = false;
        if (pendingBackgroundTimerRef.current !== null) {
          window.clearTimeout(pendingBackgroundTimerRef.current);
        }
        pendingBackgroundTimerRef.current = window.setTimeout(() => {
          pendingBackgroundTimerRef.current = null;
          void query(undefined, { background: true });
        }, MIN_BACKGROUND_REFRESH_INTERVAL_MS);
      }
    }
  }, []);

  useEffect(() => () => {
    if (cookieRetryTimerRef.current !== null) {
      window.clearTimeout(cookieRetryTimerRef.current);
    }
    if (avatarRetryTimerRef.current !== null) {
      window.clearTimeout(avatarRetryTimerRef.current);
    }
    if (pendingBackgroundTimerRef.current !== null) {
      window.clearTimeout(pendingBackgroundTimerRef.current);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    void getConfig()
      .then((config) => {
        if (disposed) return;
        const savedIds = Array.isArray(config.im_friend_sec_user_ids)
          ? config.im_friend_sec_user_ids.filter(Boolean)
          : [];
        setSavedIds(savedIds);
        setSavedCount(savedIds.length);
        const nextInterval = Number(config.im_friend_refresh_interval_seconds) || DEFAULT_REFRESH_INTERVAL_SECONDS;
        setIncludeAllUsers(Boolean(config.im_friend_include_all_users));
        setRefreshIntervalSeconds(Math.max(0, nextInterval));
        if (!initialInputRef.current.trim() && savedIds.length > 0) {
          setInput(savedIds.join("\n"));
        }
        void query(savedIds);
      })
      .catch(() => {
        if (!disposed) void query([]);
      });
    return () => {
      disposed = true;
    };
  }, [query]);

  useEffect(() => {
    let disposed = false;
    let unlistenCookieLogin: (() => void) | null = null;
    const saveAvatar = (avatar: string) => {
      if (!avatar) return;
      setCurrentUserAvatar(avatar);
      localStorage.setItem(CURRENT_USER_AVATAR_KEY, avatar);
    };
    const retry = (attempt: number) => {
      if (disposed || attempt >= 8) return;
      if (avatarRetryTimerRef.current !== null) {
        window.clearTimeout(avatarRetryTimerRef.current);
      }
      avatarRetryTimerRef.current = window.setTimeout(() => {
        avatarRetryTimerRef.current = null;
        void loadAvatar(attempt + 1);
      }, 700 + attempt * 700);
    };
    const loadAvatar = async (attempt = 0) => {
      try {
        const config = await getConfig().catch(() => null);
        if (disposed || !config?.cookie_set) return;
        const status = await verifyCookie();
        if (disposed) return;
        if (!status.valid) {
          retry(attempt);
          return;
        }
        const directAvatar = status.avatar_thumb || status.avatar_medium || status.avatar_larger || "";
        if (directAvatar) {
          saveAvatar(directAvatar);
          return;
        }
        const secUid = status.sec_uid || (status.user_id?.startsWith("MS4") ? status.user_id : "");
        if (!secUid) {
          retry(attempt);
          return;
        }
        const detail = await getUserDetail(secUid).catch(() => null);
        if (disposed || !detail?.success || !detail.user) return;
        const detailAvatar = detail.user.avatar_thumb || detail.user.avatar_medium || detail.user.avatar_larger || "";
        if (detailAvatar) {
          saveAvatar(detailAvatar);
        } else {
          retry(attempt);
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "";
        if (COOKIE_REQUIRED_PATTERN.test(message) || attempt < 8) retry(attempt);
      }
    };
    void loadAvatar();
    void listenEvent<{ event?: string; cookie_set?: boolean }>("cookie-login-status", (payload) => {
      if (payload?.cookie_set || payload?.event === "success") {
        void loadAvatar();
      }
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      unlistenCookieLogin = unlisten;
    });
    return () => {
      disposed = true;
      unlistenCookieLogin?.();
      if (avatarRetryTimerRef.current !== null) {
        window.clearTimeout(avatarRetryTimerRef.current);
      }
    };
  }, []);

  const toggleIncludeAllUsers = async () => {
    const nextValue = !includeAllUsers;
    const previousValue = includeAllUsers;
    setIncludeAllUsers(nextValue);
    setError("");
    try {
      const result = await saveConfig({ im_friend_include_all_users: nextValue });
      if (!result.success) {
        throw new Error(result.message || "保存好友范围设置失败");
      }
      void query([], { background: friends.length > 0 });
    } catch (caught) {
      setIncludeAllUsers(previousValue);
      setError(caught instanceof Error ? caught.message : "保存好友范围设置失败");
    }
  };

  useEffect(() => {
    if (refreshIntervalSeconds <= 0) return;
    const timer = window.setInterval(() => {
      void query(undefined, { background: true });
    }, Math.max(1, refreshIntervalSeconds) * 1000);
    return () => window.clearInterval(timer);
  }, [query, refreshIntervalSeconds]);

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[1320px] flex-col gap-3 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="h-4 w-4 text-accent" />
          <h3 className="text-[0.95rem] font-semibold text-text">好友</h3>
          <span className="truncate text-[0.72rem] text-text-muted">
            {savedCount > 0 ? `已保存 ${savedCount}` : `${friends.length || ids.length} 个好友`}
            {backgroundRefreshing
              ? " · 正在更新"
              : lastUpdatedAt
                ? ` · 上次更新于 ${formatUpdateTime(lastUpdatedAt)}`
                : ""}
          </span>
          <span
            className={cn(
              "flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[0.68rem]",
              imStatus.connected
                ? "border-success/25 bg-success-soft text-success"
                : "border-border bg-surface-solid text-text-muted",
            )}
            title={imStatus.updatedAt ? `${imStatus.message} · ${formatUpdateTime(imStatus.updatedAt)}` : imStatus.message}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                imStatus.connected ? "bg-success" : "bg-text-muted",
              )}
            />
            {imStatus.connected ? "接收已连接" : "接收未连接"}
          </span>
        </div>
        <div className="relative flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowManualInput((value) => !value)}
            className="h-9"
          >
            备用 ID
            <Badge variant="secondary" size="sm">{ids.length}</Badge>
          </Button>
          {showManualInput && (
            <div className="absolute right-0 top-11 z-30 w-[min(420px,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-border bg-background p-3 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[0.76rem] font-semibold text-text-secondary">备用 ID 输入</span>
                <button
                  type="button"
                  onClick={() => setShowManualInput(false)}
                  className="text-[0.72rem] text-text-muted hover:text-text"
                >
                  收起
                </button>
              </div>
              <Textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="MS4w... 每行一个，或粘贴 curl 参数"
                className="min-h-[136px] resize-none bg-surface-solid"
                spellCheck={false}
              />
            </div>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={includeAllUsers}
            onClick={() => void toggleIncludeAllUsers()}
            disabled={loading}
            className={cn(
              "flex h-9 items-center gap-2 rounded-[var(--radius-sm)] border px-3 text-[0.76rem] transition",
              includeAllUsers
                ? "border-accent/35 bg-accent-soft text-accent"
                : "border-border bg-surface-solid text-text-muted hover:text-text",
              loading && "cursor-not-allowed opacity-60",
            )}
          >
            <span
              className={cn(
                "relative h-4 w-7 rounded-full transition",
                includeAllUsers ? "bg-accent" : "bg-border-strong",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition",
                  includeAllUsers ? "left-3.5" : "left-0.5",
                )}
              />
            </span>
            {includeAllUsers ? "全部用户" : "仅互关"}
          </button>
          <Button size="sm" onClick={() => void query()} disabled={loading} className="h-9">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新状态
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-[var(--radius-sm)] border border-white/[0.06] bg-danger-soft px-3 py-2 text-[0.78rem] text-danger">
          {error}
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[380px_minmax(0,1fr)] xl:grid-cols-[420px_minmax(0,1fr)]">
      <section className="flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-border bg-surface-solid/70 p-3 shadow-[var(--shadow-sm)]">
        <div className="mb-3 grid shrink-0 grid-cols-3 gap-1.5">
          <Metric label="总数" value={friends.length || ids.length} icon={Users} />
          <Metric label="在线" value={onlineCount} icon={Wifi} tone="success" />
          <Metric label="未在线" value={offlineCount} icon={WifiOff} tone="muted" />
        </div>

        {isInitialLoading ? (
          <div className="flex min-h-[280px] items-center justify-center text-[0.82rem] text-text-muted">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在查询
          </div>
        ) : friendItems.length === 0 ? (
          <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[16px] border border-border bg-surface">
              <Users className="h-5 w-5 text-text-muted" />
            </div>
            <p className="text-[0.86rem] text-text-secondary">等待查询</p>
            <p className="mt-1 text-[0.75rem] text-text-muted">点刷新自动获取；若没有返回列表，可展开备用输入缓存一次</p>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto pr-1">
            {friendItems.map((friend) => (
              <FriendRow
                key={friend.secUid}
                friend={friend}
                selected={friend.secUid === selectedFriendId}
                onSelect={selectFriend}
                onOpenProfile={openFriendProfile}
              />
            ))}
          </div>
        )}
      </section>

      <ChatWorkspace
        friend={selectedFriend}
        draft={selectedFriend ? chatDrafts[selectedFriend.secUid] || "" : ""}
        messages={selectedMessages}
        historyError={selectedHistory?.error || ""}
        historyLoading={Boolean(selectedHistory?.loading)}
        canLoadOlder={Boolean(selectedFriend && selectedHistory?.nextCursor && selectedHistory.hasMore !== false)}
        currentUserAvatar={currentUserAvatar}
        onDraftChange={updateDraft}
        onSendMessage={sendLocalMessage}
        onSendImage={sendLocalImageMessage}
        onLoadOlder={() => selectedFriend && selectedHistory?.nextCursor ? loadHistoryMessages(selectedFriend, selectedHistory.nextCursor) : Promise.resolve()}
        onOpenProfile={openFriendProfile}
        onOpenSharedVideo={openSharedVideo}
        sharedPlayerLoadingId={sharedPlayerLoadingId}
      />
      </div>
      <FullscreenPlayer
        videos={sharedPlayerVideos}
        initialIndex={0}
        open={sharedPlayerOpen}
        onClose={() => setSharedPlayerOpen(false)}
        onDownload={(video) => downloadVideo(video)}
      />
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: number;
  icon: ElementType;
  tone?: "default" | "success" | "muted";
}) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-border bg-surface px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[0.68rem] text-text-muted">
        <Icon
          className={cn(
            "h-3.5 w-3.5",
            tone === "success" && "text-success",
            tone === "muted" && "text-text-muted"
          )}
        />
        {label}
      </div>
      <div className="mt-0.5 text-[1rem] font-bold tabular-nums text-text">{value}</div>
    </div>
  );
}

function FriendRow({
  friend,
  selected,
  onSelect,
  onOpenProfile,
}: {
  friend: FriendListItem;
  selected: boolean;
  onSelect: (friend: FriendListItem) => void;
  onOpenProfile: (friend: FriendListItem) => Promise<void>;
}) {
  const rightLabel = friend.latestMessageAt ? formatMessageTime(friend.latestMessageAt) : friend.lastActive;
  return (
    <button
      type="button"
      onClick={() => onSelect(friend)}
      className={cn(
        "grid grid-cols-[34px_1fr_auto] items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-2 text-left transition-[background-color,border-color,box-shadow,transform]",
        selected
          ? "border-accent/35 bg-accent-soft shadow-[inset_0_0_0_1px_rgba(254,44,85,0.04)]"
          : "border-border bg-surface hover:border-border-strong hover:bg-surface-raised",
      )}
    >
      <span
        role="button"
        tabIndex={0}
        aria-label="打开主页"
        onClick={(event) => {
          event.stopPropagation();
          void onOpenProfile(friend);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          void onOpenProfile(friend);
        }}
        className="relative h-8 w-8 overflow-hidden rounded-full bg-surface-raised outline-none ring-accent/35 transition hover:ring-2 focus-visible:ring-2"
      >
        {friend.avatar ? (
          <img src={friend.avatar} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[0.75rem] font-bold text-text-muted">
            {(friend.remarkName || friend.nickname).slice(0, 1) || "友"}
          </div>
        )}
        <span
          className={cn(
            "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface",
            friend.online ? "bg-success" : "bg-text-muted"
          )}
        />
      </span>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[0.8rem] font-semibold text-text">
            {friend.remarkName || friend.nickname || "未知用户"}
          </span>
          <Badge variant={friend.online ? "success" : "secondary"} size="sm">
            {friend.statusText}
          </Badge>
        </div>
        <div className="mt-0.5 truncate text-[0.68rem] text-text-muted">
          {friend.previewText}
        </div>
      </div>

      <div className="flex min-w-[44px] flex-col items-end gap-1 text-right">
        <span className="text-[0.68rem] text-text-muted">{rightLabel}</span>
        {friend.unreadCount > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[0.6rem] font-bold leading-none text-white">
            {friend.unreadCount > 99 ? "99+" : friend.unreadCount}
          </span>
        )}
      </div>
    </button>
  );
}

function ChatWorkspace({
  friend,
  draft,
  messages,
  historyError,
  historyLoading,
  canLoadOlder,
  currentUserAvatar,
  onDraftChange,
  onSendMessage,
  onSendImage,
  onLoadOlder,
  onOpenProfile,
  onOpenSharedVideo,
  sharedPlayerLoadingId,
}: {
  friend: FriendStatusItem | null;
  draft: string;
  messages: LocalChatMessage[];
  historyError: string;
  historyLoading: boolean;
  canLoadOlder: boolean;
  currentUserAvatar: string;
  onDraftChange: (secUid: string, value: string) => void;
  onSendMessage: (friend: FriendStatusItem, value: string) => Promise<void>;
  onSendImage: (friend: FriendStatusItem, file: File) => Promise<void>;
  onLoadOlder: () => Promise<void>;
  onOpenProfile: (friend: FriendStatusItem) => Promise<void>;
  onOpenSharedVideo: (card: SharedMessageCard) => Promise<void>;
  sharedPlayerLoadingId: string;
}) {
  const displayName = friendDisplayName(friend);
  const [pendingImages, setPendingImages] = useState<PendingImageAttachment[]>([]);
  const pendingImagesRef = useRef<PendingImageAttachment[]>([]);
  const hasDraft = Boolean(draft.trim());
  const hasPendingImages = pendingImages.length > 0;
  const canSend = Boolean(friend && (hasDraft || hasPendingImages));
  const textSending = messages.some((message) => message.status === "pending" && !message.imagePreviewUrl);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const preserveScrollOffsetRef = useRef<number | null>(null);
  const preserveScrollUntilRef = useRef(0);
  const olderLoadArmedRef = useRef(false);
  const ignoreScrollUntilRef = useRef(0);
  const pinBottomUntilRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const latestMessageId = messages.length > 0 ? messages[messages.length - 1].id : "";
  const oldestMessageId = messages.length > 0 ? messages[0].id : "";

  const markProgrammaticScroll = useCallback(() => {
    ignoreScrollUntilRef.current = Date.now() + 280;
  }, []);

  const scrollToBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    pinBottomUntilRef.current = Date.now() + 2600;
    markProgrammaticScroll();
    scroller.scrollTop = scroller.scrollHeight;
    bottomAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [markProgrammaticScroll]);

  const isNearBottom = useCallback(() => {
    const scroller = scrollRef.current;
    if (!scroller) return true;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 96;
  }, []);

  const restorePreservedScroll = useCallback(() => {
    const scroller = scrollRef.current;
    const offset = preserveScrollOffsetRef.current;
    if (!scroller || offset === null) return false;
    markProgrammaticScroll();
    scroller.scrollTop = Math.max(0, scroller.scrollHeight - offset);
    return true;
  }, [markProgrammaticScroll]);

  const scheduleScrollToBottom = useCallback(() => {
    pinBottomUntilRef.current = Date.now() + 2600;
    let disposed = false;
    const timers: number[] = [];
    const frames: number[] = [];
    const run = () => {
      if (!disposed) scrollToBottom();
    };
    frames.push(window.requestAnimationFrame(run));
    frames.push(window.requestAnimationFrame(() => {
      frames.push(window.requestAnimationFrame(run));
    }));
    for (const delay of [60, 180, 420]) {
      timers.push(window.setTimeout(run, delay));
    }
    return () => {
      disposed = true;
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [scrollToBottom]);

  useEffect(() => {
    return scheduleScrollToBottom();
  }, [friend?.secUid, latestMessageId, scheduleScrollToBottom]);

  useEffect(() => {
    if (preserveScrollOffsetRef.current === null) return;
    preserveScrollUntilRef.current = Date.now() + 1600;
    const frames: number[] = [];
    const timers: number[] = [];
    const restore = () => {
      restorePreservedScroll();
    };
    frames.push(window.requestAnimationFrame(restore));
    frames.push(window.requestAnimationFrame(() => {
      frames.push(window.requestAnimationFrame(restore));
    }));
    for (const delay of [80, 240, 520]) {
      timers.push(window.setTimeout(restore, delay));
    }
    timers.push(window.setTimeout(() => {
      preserveScrollOffsetRef.current = null;
    }, 1700));
    return () => {
      frames.forEach((frame) => window.cancelAnimationFrame(frame));
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [oldestMessageId, restorePreservedScroll]);

  useEffect(() => {
    olderLoadArmedRef.current = false;
    preserveScrollOffsetRef.current = null;
    preserveScrollUntilRef.current = 0;
    pinBottomUntilRef.current = Date.now() + 2600;
    userScrollIntentUntilRef.current = 0;
  }, [friend?.secUid]);

  const handleMediaSettled = useCallback(() => {
    if (preserveScrollOffsetRef.current !== null && Date.now() < preserveScrollUntilRef.current) {
      restorePreservedScroll();
      return;
    }
    if (Date.now() < pinBottomUntilRef.current || isNearBottom()) {
      scheduleScrollToBottom();
    }
  }, [isNearBottom, restorePreservedScroll, scheduleScrollToBottom]);

  useEffect(() => {
    setPendingImages((current) => {
      current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
  }, [friend?.secUid]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(() => () => {
    pendingImagesRef.current.forEach((item) => URL.revokeObjectURL(item.previewUrl));
  }, []);

  const handleSendMessage = () => {
    if (!friend || !canSend) return;
    const imagesToSend = pendingImages;
    setPendingImages([]);
    if (hasDraft) {
      void onSendMessage(friend, draft);
    }
    for (const image of imagesToSend) {
      void onSendImage(friend, image.file);
      URL.revokeObjectURL(image.previewUrl);
    }
  };
  const handlePickImage = () => {
    if (!friend) return;
    imageInputRef.current?.click();
  };
  const addPendingImageFiles = useCallback((files: File[]) => {
    if (!friend || files.length === 0) return;
    const nextImages = files
      .filter((file) => file.type.startsWith("image/") && file.size <= MAX_SEND_IMAGE_BYTES)
      .map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
        file,
        previewUrl: URL.createObjectURL(file),
      }));
    if (nextImages.length === 0) return;
    setPendingImages((current) => {
      const merged = [...current, ...nextImages];
      const kept = merged.slice(0, 9);
      merged.slice(9).forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return kept;
    });
  }, [friend]);
  const handleImageInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    addPendingImageFiles(files);
  };
  const handleDraftPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(event.clipboardData?.items || []);
    const imageFiles = items
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    addPendingImageFiles(imageFiles);
  };
  const removePendingImage = (id: string) => {
    setPendingImages((current) => {
      const target = current.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
  };
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 900;
  }, []);

  const handleMessageScroll = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = scrollTop;
    if (Date.now() < ignoreScrollUntilRef.current) return;
    if (scrollTop < previousScrollTop - 4) {
      pinBottomUntilRef.current = 0;
    }
    if (!friend || historyLoading || !canLoadOlder) return;
    if (Date.now() > userScrollIntentUntilRef.current) return;
    if (scroller.scrollHeight <= scroller.clientHeight + 4) return;
    if (scroller.scrollTop > 140) {
      olderLoadArmedRef.current = true;
      return;
    }
    if (scroller.scrollTop > 72) return;
    if (!olderLoadArmedRef.current) return;
    if (scrollTop >= previousScrollTop - 4) return;
    olderLoadArmedRef.current = false;
    preserveScrollOffsetRef.current = scroller.scrollHeight - scroller.scrollTop;
    preserveScrollUntilRef.current = Date.now() + 1600;
    void onLoadOlder();
  };
  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    handleSendMessage();
  };

  return (
    <section className="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-[var(--radius-lg)] border border-border bg-surface-solid/70 shadow-[var(--shadow-sm)]">
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            disabled={!friend}
            onClick={() => friend && void onOpenProfile(friend)}
            className="relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-raised outline-none ring-accent/35 transition hover:ring-2 focus-visible:ring-2 disabled:pointer-events-none disabled:hover:ring-0"
          >
            {friend?.avatar ? (
              <img src={friend.avatar} alt="" className="h-full w-full object-cover" />
            ) : (
              <UserRound className="h-4 w-4 text-text-muted" />
            )}
            {friend && (
              <span
                className={cn(
                  "absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-surface",
                  friend.online ? "bg-success" : "bg-text-muted",
                )}
              />
            )}
          </button>
          <div className="min-w-0">
            <p className="truncate text-[0.86rem] font-semibold text-text">
              {friend ? displayName : "选择好友"}
            </p>
            <p className="truncate text-[0.7rem] text-text-muted">
              {friend ? `${friend.statusText} · ${friend.lastActive}` : "左侧列表会同步好友在线状态"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={friend?.online ? "success" : "secondary"} size="sm">
            {friend?.online ? "在线" : "离线"}
          </Badge>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {historyError && (
          <div className="border-b border-white/[0.06] bg-danger-soft px-4 py-2 text-[0.72rem] text-danger">
            {historyError}
          </div>
        )}
        <div
          ref={scrollRef}
          onPointerDown={markUserScrollIntent}
          onTouchStart={markUserScrollIntent}
          onWheel={markUserScrollIntent}
          onScroll={handleMessageScroll}
          className="flex-1 overflow-y-auto px-4 py-4"
        >
          {friend ? (
            <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
              {historyLoading && messages.length > 0 && (
                <div className="mx-auto flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-[0.68rem] text-text-muted">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  加载中
                </div>
              )}
              {messages.map((message, index) => {
                const prevMessage = index > 0 ? messages[index - 1] : null;
                const showDate = !prevMessage || !isSameMessageDate(message.createdAt, prevMessage.createdAt);
                const showTime = showDate || !prevMessage || (message.createdAt - prevMessage.createdAt) > 10 * 60 * 1000;
                const centerNotice = centerNoticeText(message);
                const framedBody = hasFramedMessageBody(message);
                return (
                  <Fragment key={message.id}>
                    {showTime && (
                      <div className="mx-auto my-1 text-[0.68rem] text-text-muted select-none">
                        {formatMessageDividerTime(message.createdAt, showDate)}
                      </div>
                    )}
                    {centerNotice ? (
                      <div className="mx-auto max-w-[78%] rounded-full bg-surface-raised px-3 py-1 text-center text-[0.68rem] leading-relaxed text-text-muted">
                        {centerNotice}
                      </div>
                    ) : (
                    <div
                      className={cn(
                        "flex max-w-[88%] items-start gap-2",
                        message.direction === "in" ? "mr-auto flex-row" : "ml-auto flex-row-reverse",
                      )}
                    >
                      <MessageAvatar
                        friend={friend}
                        direction={message.direction || "out"}
                        currentUserAvatar={currentUserAvatar}
                        onOpenProfile={onOpenProfile}
                      />
                      <div className={cn("flex min-w-0 flex-col", message.direction === "in" ? "items-start" : "items-end")}>
                        <div className="peer/bubble relative">
                          {message.direction !== "in" && message.status === "pending" && message.imagePreviewUrl && (
                            <div className="absolute right-full top-1/2 mr-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface-solid text-text-muted shadow-[0_8px_18px_rgba(15,23,42,0.12)]">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            </div>
                          )}
                          <div
                            className={cn(
                              "min-w-0",
                              framedBody
                                ? ""
                                : "rounded-[16px] shadow-[0_10px_20px_rgba(15,23,42,0.08)]",
                              !framedBody && (
                                message.direction === "in"
                                  ? "rounded-tl-[6px] border border-border bg-surface text-text"
                                  : "rounded-tr-[6px] bg-accent text-white shadow-[0_10px_20px_rgba(254,44,85,0.16)]"
                              ),
                            )}
                          >
                          <MessageBody
                            message={message}
                            onOpenSharedVideo={onOpenSharedVideo}
                            sharedPlayerLoadingId={sharedPlayerLoadingId}
                            onMediaSettled={handleMediaSettled}
                          />
                          </div>
                        </div>
                        <div
                          className={cn(
                            "mt-1 min-h-4 text-[0.62rem] transition-opacity",
                            message.status === "error"
                              ? "visible max-w-[18rem] text-danger opacity-100"
                              : "invisible text-text-muted opacity-0 peer-hover/bubble:visible peer-hover/bubble:opacity-100",
                          )}
                        >
                          {message.status === "error"
                            ? message.error || "发送失败"
                            : formatMessageTime(message.createdAt)}
                        </div>
                      </div>
                    </div>
                    )}
                  </Fragment>
                );
              })}
              <div ref={bottomAnchorRef} aria-hidden="true" className="h-px w-full" />
              {hasDraft && (
                <div className="ml-auto max-w-[82%] rounded-[16px] rounded-tr-[6px] border border-accent/25 bg-accent-soft px-3 py-2 text-accent">
                  <p className="whitespace-pre-wrap break-words text-[0.76rem] leading-relaxed">{draft}</p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full min-h-[280px] flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-16 w-16 items-center justify-center overflow-hidden rounded-[18px] border border-border bg-surface">
                <ThemeLogo className="h-14 w-14 object-contain opacity-90" />
              </div>
              <p className="text-[0.88rem] font-semibold text-text">未选择会话</p>
              <p className="mt-1 max-w-sm text-[0.74rem] leading-relaxed text-text-muted">
                左侧选择好友后再加载聊天内容。
              </p>
            </div>
          )}
        </div>

        <div className="border-t border-border bg-surface/40 p-3">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleImageInputChange}
            />
            {pendingImages.length > 0 && (
              <div className="col-span-3 mb-1 flex max-h-28 gap-2 overflow-x-auto rounded-[14px] border border-border bg-surface-solid p-2">
                {pendingImages.map((image) => (
                  <div
                    key={image.id}
                    className="relative h-20 w-20 shrink-0 overflow-hidden rounded-[12px] border border-border bg-surface-raised"
                  >
                    <img src={image.previewUrl} alt="" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removePendingImage(image.id)}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/70"
                      aria-label="移除图片"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={!friend}
              onClick={handlePickImage}
              className="h-10 w-10 px-0"
              title="发送图片"
            >
              <ImagePlus className="h-3.5 w-3.5" />
            </Button>
            <Textarea
              value={draft}
              onChange={(event) => friend && onDraftChange(friend.secUid, event.target.value)}
              onKeyDown={handleDraftKeyDown}
              onPaste={handleDraftPaste}
              disabled={!friend}
              placeholder={friend ? `给 ${displayName} 写点内容...` : "选择好友后输入"}
              className="h-10 min-h-10 resize-none bg-surface-solid py-2 leading-5"
            />
            <Button disabled={!canSend || textSending} onClick={handleSendMessage} className="h-10 px-4">
              {textSending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              发送
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function MessageBody({
  message,
  onOpenSharedVideo,
  sharedPlayerLoadingId,
  onMediaSettled,
}: {
  message: LocalChatMessage;
  onOpenSharedVideo: (card: SharedMessageCard) => Promise<void>;
  sharedPlayerLoadingId: string;
  onMediaSettled: () => void;
}) {
  if (message.imagePreviewUrl) {
    return <ImageMessageView src={message.imagePreviewUrl} onSettled={onMediaSettled} />;
  }
  const shared = parseSharedMessage(message);
  if (shared) {
    if (shared.kind === "image") {
      return <ImageMessageView src={shared.coverUrl} skey={shared.skey} onSettled={onMediaSettled} />;
    }
    return (
      <SharedMessageCardView
        card={shared}
        outgoing={message.direction !== "in"}
        loading={Boolean(shared.itemId && sharedPlayerLoadingId === shared.itemId)}
        onOpenSharedVideo={onOpenSharedVideo}
      />
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words px-3 py-2 text-[0.76rem] leading-relaxed">
      {message.text}
    </p>
  );
}

function ImageMessageView({ src, skey, onSettled }: { src: string; skey?: string; onSettled?: () => void }) {
  if (!src) return null;
  const displaySrc = /^https?:\/\//.test(src) ? mediaProxyUrl(src, "image", { skey }) : src;
  return (
    <button
      type="button"
      onClick={() => window.open(displaySrc, "_blank", "noopener,noreferrer")}
      className="block max-w-[min(12rem,52vw)] overflow-hidden rounded-[14px] bg-surface-raised outline-none ring-accent/35 transition hover:ring-2 focus-visible:ring-2"
      title="打开图片"
    >
      <img
        src={displaySrc}
        alt=""
        onLoad={onSettled}
        onError={onSettled}
        className="block max-h-48 w-auto max-w-full object-contain"
      />
    </button>
  );
}

function SharedMessageCardView({
  card,
  outgoing,
  loading,
  onOpenSharedVideo,
}: {
  card: SharedMessageCard;
  outgoing: boolean;
  loading: boolean;
  onOpenSharedVideo: (card: SharedMessageCard) => Promise<void>;
}) {
  const compact = !card.coverUrl;
  const clickable = card.kind === "video" ? Boolean(card.itemId) : false;
  const unsignedCoverUrl = unsignedMediaUrl(card.coverUrl);
  const [useUnsignedCover, setUseUnsignedCover] = useState(false);
  const coverSrc = card.coverUrl ? mediaProxyUrl(useUnsignedCover && unsignedCoverUrl ? unsignedCoverUrl : card.coverUrl, "image") : "";
  const avatarSrc = card.avatarUrl ? mediaProxyUrl(card.avatarUrl, "image") : "";
  const [coverFailed, setCoverFailed] = useState(false);
  useEffect(() => {
    setUseUnsignedCover(false);
    setCoverFailed(false);
  }, [card.coverUrl]);
  const handleCoverError = () => {
    if (!useUnsignedCover && unsignedCoverUrl) {
      setUseUnsignedCover(true);
      return;
    }
    setCoverFailed(true);
  };
  const showCover = Boolean(coverSrc && !coverFailed);
  const fallbackIcon = card.kind === "location"
    ? <MapPin className="h-4 w-4 text-text-muted" />
    : card.kind === "product"
      ? <ShoppingBag className="h-4 w-4 text-text-muted" />
      : <MessageCircle className="h-4 w-4 text-text-muted" />;
  const fallbackCover = (
    <div className={cn(
      "flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center",
      card.kind === "product"
        ? "bg-[linear-gradient(135deg,rgba(254,44,85,0.12),rgba(255,255,255,0.96)_46%,rgba(245,158,11,0.14))]"
        : card.kind === "location"
          ? "bg-[linear-gradient(135deg,rgba(20,184,166,0.14),rgba(255,255,255,0.96)_46%,rgba(59,130,246,0.12))]"
          : "bg-surface-raised",
    )}>
      <div className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-white/85 shadow-[0_8px_18px_rgba(15,23,42,0.08)]">
        {fallbackIcon}
      </div>
      <div className="line-clamp-2 max-w-full text-[0.62rem] font-semibold leading-snug text-text-muted">
        {card.kind === "product" ? "商品" : card.kind === "location" ? "地点" : "分享"}
      </div>
    </div>
  );
  if (card.kind === "video" && card.coverUrl) {
    const videoContent = (
      <div className="group relative w-[min(10.6rem,42vw)] overflow-hidden rounded-[12px] bg-black text-left shadow-[0_10px_24px_rgba(0,0,0,0.22)] sm:w-[11.6rem]">
        <div className="relative w-full aspect-[9/16] max-h-[16.6rem] min-h-[12rem]">
          {showCover ? (
            <img
              src={coverSrc}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
              onError={handleCoverError}
            />
          ) : (
            <div className="absolute inset-0">{fallbackCover}</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/82 via-black/24 to-black/5" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-black/42 text-white shadow-[0_6px_12px_rgba(0,0,0,0.22)] backdrop-blur transition-transform duration-300 group-hover:scale-110">
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 p-2.5 text-white">
            <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
              {avatarSrc ? (
                <img
                  src={avatarSrc}
                  alt=""
                  className="h-5 w-5 shrink-0 rounded-full border border-white/70 object-cover shadow-[0_3px_8px_rgba(0,0,0,0.25)]"
                />
              ) : (
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/15">
                  <UserRound className="h-2.5 w-2.5 text-white/85" />
                </div>
              )}
              <div className="min-w-0">
                <div className="truncate text-[0.65rem] font-semibold">
                  {card.authorName || "抖音作者"}
                </div>
                <div className="text-[0.55rem] text-white/68">{card.subtitle}</div>
              </div>
            </div>
            <div className="line-clamp-3 break-words text-[0.7rem] font-semibold leading-snug text-white">
              {card.title}
            </div>
          </div>
          {loading && (
            <div className="absolute inset-0 bg-black/18" />
          )}
        </div>
      </div>
    );
    if (!clickable) return videoContent;
    return (
      <button
        type="button"
        disabled={loading}
        onClick={() => void onOpenSharedVideo(card)}
        className="block cursor-pointer rounded-[16px] outline-none ring-accent/35 transition hover:ring-2 focus-visible:ring-2 disabled:cursor-wait"
        title="打开播放器"
      >
        {videoContent}
      </button>
    );
  }
  const content = (
    <div className={cn(
      compact
        ? "grid w-[min(16rem,62vw)] grid-cols-[44px_minmax(0,1fr)] overflow-hidden rounded-[14px] text-left"
        : "grid w-[min(18rem,68vw)] grid-cols-[112px_minmax(0,1fr)] overflow-hidden rounded-[14px] text-left sm:w-[20rem] sm:grid-cols-[132px_minmax(0,1fr)]",
      "border border-border bg-surface-raised text-text shadow-[0_10px_20px_rgba(15,23,42,0.08)]",
    )}>
      <div className={cn("relative overflow-hidden bg-black/10", compact ? "h-full min-h-[72px]" : "h-[112px] sm:h-[132px]")}>
        {showCover ? (
          <img
            src={coverSrc}
            alt=""
            loading="lazy"
            onError={handleCoverError}
            className="h-full w-full object-cover outline outline-1 outline-black/10"
          />
        ) : (
          fallbackCover
        )}
        {avatarSrc && (
          <img
            src={avatarSrc}
            alt=""
            className="absolute bottom-1.5 right-1.5 h-5 w-5 rounded-full border border-white/80 object-cover"
          />
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/35">
            <Loader2 className="h-4 w-4 animate-spin text-white" />
          </div>
        )}
      </div>
      <div className={cn("flex min-w-0 flex-col justify-between gap-2", compact ? "p-2.5" : "p-3")}>
        <div className="min-w-0">
          <div className="line-clamp-2 text-[0.66rem] font-medium leading-snug text-text-muted">
            {card.subtitle}
          </div>
          <div className={cn(
            "mt-1 break-words font-semibold leading-snug",
            compact ? "line-clamp-3 text-[0.74rem]" : "line-clamp-2 text-[0.78rem]",
          )}>
            {card.title}
          </div>
        </div>
        {card.itemId && (
          <div className="truncate text-[0.6rem] tabular-nums text-text-muted">
            {card.itemId}
          </div>
        )}
      </div>
    </div>
  );
  if (!clickable) return content;
  return (
    <button
      type="button"
      disabled={loading}
      onClick={() => void onOpenSharedVideo(card)}
      className="block cursor-pointer rounded-[14px] outline-none ring-accent/35 transition hover:ring-2 focus-visible:ring-2 disabled:cursor-wait"
      title="打开播放器"
    >
      {content}
    </button>
  );
}

function MessageAvatar({
  friend,
  direction,
  currentUserAvatar,
  onOpenProfile,
}: {
  friend: FriendStatusItem;
  direction: "in" | "out";
  currentUserAvatar: string;
  onOpenProfile: (friend: FriendStatusItem) => Promise<void>;
}) {
  const isIncoming = direction === "in";
  const avatar = isIncoming ? friend.avatar : currentUserAvatar;
  const avatarSrc = avatar ? mediaProxyUrl(avatar, "image") : "";
  const className = cn(
    "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border outline-none ring-accent/35 transition",
    isIncoming
      ? "border-border bg-surface-raised hover:ring-2 focus-visible:ring-2"
      : "border-accent/20 bg-accent-soft text-accent",
  );
  const content = avatarSrc ? (
    <img src={avatarSrc} alt="" className="h-full w-full object-cover" />
  ) : (
    <UserRound className="h-3.5 w-3.5" />
  );
  if (isIncoming) {
    return (
      <button type="button" aria-label="打开主页" onClick={() => void onOpenProfile(friend)} className={className}>
        {content}
      </button>
    );
  }
  return (
    <div className={className}>
      {content}
    </div>
  );
}
