import type { FriendOnlineStatusResponse } from "@/lib/tauri";
import {
  CHAT_DRAFTS_KEY,
  CHAT_MESSAGES_KEY,
  CHAT_SUMMARIES_KEY,
  CHAT_UNREAD_KEY,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  LIKE_NOTICE_PATTERN,
  MAX_PERSISTED_CHAT_MESSAGES_PER_FRIEND,
  MAX_PERSISTED_RAW_CONTENT_CHARS,
  ONLINE_WINDOW_SECONDS,
  type ChatDrafts,
  type ChatMessages,
  type ChatSummaries,
  type FriendStatusItem,
  type JsonRecord,
  type LocalChatMessage,
  type SharedMessageCard,
  type UnreadCounts,
} from "./friends-status-types";

// ==================== localStorage 持久化 ====================

export function getNamespacedKey(baseKey: string, currentSecUid?: string): string {
  if (!currentSecUid) return baseKey;
  return `${baseKey}.${currentSecUid}`;
}

export function readChatDrafts(currentSecUid?: string): ChatDrafts {
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

export function readChatMessages(currentSecUid?: string): ChatMessages {
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

export function normalizeStoredChatMessage(secUid: string, message: JsonRecord): LocalChatMessage {
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

export function isLocalUnsentImagePlaceholder(message: LocalChatMessage) {
  if (message.direction !== "out" || message.status === "error") return false;
  if (message.imagePreviewUrl) return false;
  const parsed = parseJsonContent(message.rawContent || "");
  if (!parsed || Number(parsed.aweType || 0) !== 2702) return false;
  const inlinePic = stringField(parsed, ["inline_pic", "inlinePic"]);
  const hasInlineImage = Boolean(inlineImageDataUrl(inlinePic));
  const hasUploadedResource = Boolean(firstUrl(parsed.resource_url) || firstUrl(parsed.url));
  return !hasInlineImage && !hasUploadedResource;
}

export function readUnreadCounts(currentSecUid?: string): UnreadCounts {
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

export function readChatSummaries(currentSecUid?: string): ChatSummaries {
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

export function friendDisplayName(friend: FriendStatusItem | null | undefined) {
  return friend?.remarkName || friend?.nickname || "未知用户";
}

export function latestChatMessage(messages: LocalChatMessage[] | undefined) {
  if (!messages || messages.length === 0) return undefined;
  return messages.reduce<LocalChatMessage | undefined>((latest, message) => {
    if (!latest || message.createdAt > latest.createdAt) return message;
    return latest;
  }, undefined);
}

export function safeSetLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    console.warn(`localStorage 写入失败: ${key}`, error);
    return false;
  }
}

export function compactRawContent(rawContent: string | undefined, maxLength = MAX_PERSISTED_RAW_CONTENT_CHARS) {
  if (!rawContent) return undefined;
  return rawContent.length > maxLength ? undefined : rawContent;
}

export function sanitizePersistedChatMessage(message: LocalChatMessage, rawLimit = MAX_PERSISTED_RAW_CONTENT_CHARS): LocalChatMessage {
  return {
    ...message,
    rawContent: compactRawContent(message.rawContent, rawLimit),
    imagePreviewUrl: message.imagePreviewUrl?.startsWith("blob:") ? undefined : message.imagePreviewUrl,
    error: message.error ? message.error.slice(0, 300) : undefined,
  };
}

export function compactChatMessagesForStorage(
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

export function persistChatMessages(messages: ChatMessages, currentSecUid?: string) {
  const compacted = compactChatMessagesForStorage(messages);
  const key = getNamespacedKey(CHAT_MESSAGES_KEY, currentSecUid);
  if (safeSetLocalStorage(key, JSON.stringify(compacted))) return;
  const smaller = compactChatMessagesForStorage(messages, 12, 8_000);
  if (safeSetLocalStorage(key, JSON.stringify(smaller))) return;
  safeSetLocalStorage(key, "{}");
}

export function sanitizePersistedSummaries(summaries: ChatSummaries): ChatSummaries {
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

export function persistChatSummaries(summaries: ChatSummaries, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_SUMMARIES_KEY, currentSecUid);
  if (safeSetLocalStorage(key, JSON.stringify(sanitizePersistedSummaries(summaries)))) return;
  safeSetLocalStorage(key, "{}");
}

export function persistChatDrafts(drafts: ChatDrafts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_DRAFTS_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(drafts));
}

export function persistUnreadCounts(counts: UnreadCounts, currentSecUid?: string) {
  const key = getNamespacedKey(CHAT_UNREAD_KEY, currentSecUid);
  safeSetLocalStorage(key, JSON.stringify(counts));
}

export function normalizeMessageStatus(value: string): LocalChatMessage["status"] {
  return value === "pending" || value === "sent" || value === "error" ? value : "sent";
}

export function normalizeMessageDirection(value: string): LocalChatMessage["direction"] {
  return value === "in" ? "in" : "out";
}

// ==================== URL / 媒体工具 ====================

export function normalizeImUrl(value: string) {
  return value
    .trim()
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
}

export function unsignedMediaUrl(value: string) {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    return parsed.search ? `${parsed.origin}${parsed.pathname}` : "";
  } catch {
    return "";
  }
}

export function firstUrl(value: unknown): string {
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

export function inlineImageDataUrl(value: string) {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return "";
  if (normalized.startsWith("data:image/")) return normalized;
  if (normalized.startsWith("UklGR")) return `data:image/webp;base64,${normalized}`;
  if (normalized.startsWith("/9j/")) return `data:image/jpeg;base64,${normalized}`;
  if (normalized.startsWith("iVBOR")) return `data:image/png;base64,${normalized}`;
  return "";
}

export function imageMessageRawContent(imageDataUrl: string, width = 0, height = 0, fileName = "") {
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

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export function readImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = src;
  });
}

// ==================== JSON 字段访问 ====================

export function deepStringField(record: JsonRecord, keys: string[]) {
  let found = stringField(record, keys);
  if (found) return found;
  walkRecords(record, (candidate) => {
    if (found) return;
    found = stringField(candidate, keys);
  });
  return found;
}

export function deepFirstUrl(record: JsonRecord, keys: string[]) {
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

export function hasDeepField(record: JsonRecord, keys: string[]) {
  if (keys.some((key) => record[key] !== undefined && record[key] !== null)) return true;
  let found = false;
  walkRecords(record, (candidate) => {
    if (!found) {
      found = keys.some((key) => candidate[key] !== undefined && candidate[key] !== null);
    }
  });
  return found;
}

export function parseJsonContent(value: string): JsonRecord | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseNestedJsonField(record: JsonRecord, keys: string[]): JsonRecord | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const parsed = parseJsonContent(value);
    if (parsed) return parsed;
  }
  return null;
}

export function normalizeSharedItemId(value: string): string {
  if (!value) return "";
  const direct = value.trim();
  if (/^\d+$/.test(direct)) return direct;
  const numericParts = direct.split(/[_:/?&=#-]+/).filter((part) => /^\d{10,}$/.test(part));
  return numericParts[numericParts.length - 1] || "";
}

export function uniqueTextParts(parts: string[]) {
  const seen = new Set<string>();
  return parts
    .map((part) => part.trim())
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
}

export function imDynamicText(value: unknown): string {
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

// ==================== 分享卡片解析 ====================

export function parseDynamicPatchCard(root: JsonRecord): SharedMessageCard | null {
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

export function parseSharedMessage(message: LocalChatMessage): SharedMessageCard | null {
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

export function normalizeLikeNoticeText(value: string) {
  const text = value
    .replace(/\{\{\d+\}\}/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*分享的\s*$/g, "分享的内容")
    .trim();
  return text || "点赞";
}

export function centerNoticeText(message: LocalChatMessage) {
  const root = parseJsonContent(message.rawContent || "");
  const candidates = uniqueTextParts([
    message.text,
    root ? stringField(root, ["msgHint", "description", "push_detail", "text", "content"]) : "",
  ]);
  const matched = candidates.find((item) => LIKE_NOTICE_PATTERN.test(item));
  return matched ? normalizeLikeNoticeText(matched) : "";
}

export function messagePreviewText(message: LocalChatMessage | undefined) {
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

export function hasFramedMessageBody(message: LocalChatMessage) {
  return Boolean(message.imagePreviewUrl || parseSharedMessage(message));
}

export function fallbackMessageText(rawContent: string | undefined) {
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

// ==================== 通用 JSON 工具 ====================

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function walkRecords(value: unknown, visit: (record: JsonRecord) => void) {
  if (Array.isArray(value)) {
    value.forEach((item) => walkRecords(item, visit));
    return;
  }
  if (!isRecord(value)) return;
  visit(value);
  Object.values(value).forEach((item) => walkRecords(item, visit));
}

export function arrayField(value: unknown) {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value) && Array.isArray(value.data)) return value.data.filter(isRecord);
  return [];
}

export function stringField(record: JsonRecord | undefined, keys: string[]) {
  if (!record) return "";
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

export function numberField(record: JsonRecord | undefined, keys: string[]) {
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

export function extractSecUid(record: JsonRecord) {
  return stringField(record, ["sec_uid", "sec_user_id", "sec_user_id_str", "secUserId", "secUid"]);
}

export function extractAvatar(record: JsonRecord | undefined) {
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

export function extractIds(text: string) {
  const matches = text.match(/MS4w\.?LjAB[A-Za-z0-9_-]+/g) || [];
  const lines = text
    .split(/[\n,\s]+/)
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item.startsWith("MS4wLjAB") || item.startsWith("MS4w.LjAB"));
  return Array.from(new Set([...matches, ...lines]));
}

// ==================== 在线状态响应解析 ====================

export function responseNowSeconds(response: FriendOnlineStatusResponse) {
  const active = response.active_status;
  if (isRecord(active) && isRecord(active.extra)) {
    const now = numberField(active.extra, ["now"]);
    if (now > 1_000_000_000_000) return Math.floor(now / 1000);
    if (now > 0) return Math.floor(now);
  }
  return Math.floor(Date.now() / 1000);
}

// ==================== 时间格式化 ====================

export function formatLastActive(value: number) {
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

export function formatUpdateTime(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatMessageTime(value: number) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function isSameMessageDate(left: number, right: number) {
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  return leftDate.getFullYear() === rightDate.getFullYear() &&
    leftDate.getMonth() === rightDate.getMonth() &&
    leftDate.getDate() === rightDate.getDate();
}

export function formatMessageDate(value: number) {
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

export function formatMessageDividerTime(value: number, includeDate: boolean) {
  const time = formatMessageTime(value);
  const date = formatMessageDate(value);
  if (!includeDate && !date) return time;
  return date ? `${date} ${time}` : time;
}

// ==================== 响应映射 ====================

export function collectRecordsBySecUid(value: unknown) {
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

export function mapResponse(response: FriendOnlineStatusResponse): FriendStatusItem[] {
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

// 重新导出常量，方便旧调用点
export { DEFAULT_REFRESH_INTERVAL_SECONDS };
