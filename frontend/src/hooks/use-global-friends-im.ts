import { useEffect, useRef } from "react";
import { useToastStore } from "@/components/ui/toast";
import {
  getAccounts,
  getFriendMessageHistory,
  getImConnectionStatus,
  listenEvent,
  saveFriendChatState,
  sendFriendMessage,
  suggestAiInteraction,
} from "@/lib/tauri";
import {
  getAiAutoSendDelayMs,
  normalizeAiSuggestions,
  readAiAutomationConfig,
  rememberAutomationKey,
  shouldAutomateText,
  waitForAiAutoSend,
} from "@/lib/ai-automation";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { autoReturnSharedMedia, isSharedWorkPayload } from "@/lib/auto-return-shared-media";
import {
  fallbackMessageText,
  buildPrivateMessageAiContext,
  messagePreviewText,
  numberField,
  persistChatMessages,
  persistChatSessions,
  persistChatSummaries,
  persistUnreadCounts,
  readChatMessages,
  readChatSessions,
  readChatSummaries,
  readUnreadCounts,
  stringField,
  refreshChatSession,
} from "@/components/friends/friends-status-utils";
import type {
  ChatMessages,
  ChatSession,
  ChatSummaries,
  JsonRecord,
  LocalChatMessage,
  UnreadCounts,
} from "@/components/friends/friends-status-types";

export const GLOBAL_FRIEND_CHAT_UPDATED_EVENT = "dy-friend-chat-updated";
export const FRIEND_UID_NAME_CACHE_KEY = "dy.friend.uidNameCache";
export const UNKNOWN_FRIEND_KEY_PREFIX = "uid:";
const RECENT_AUTO_REPLY_TTL_MS = 5 * 60_000;
const IM_ACCOUNT_READY_EVENT = "dy-im-account-ready";
const MAX_PENDING_IM_EVENTS = 64;
const IM_RECONCILE_SAFETY_WINDOW_MS = 45_000;
const MAX_IM_RECONCILE_PAGES = 16;
const IM_RECONCILE_RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000, 30_000];
const IM_WATCHDOG_INITIAL_DELAY_MS = 12_000;
const IM_WATCHDOG_INTERVAL_MS = 75_000;
const IM_WATCHDOG_CONNECTION_STABLE_MS = 8_000;
const IM_WATCHDOG_SAFETY_WINDOW_MS = 45_000;
const MAX_IM_WATCHDOG_PAGES = 3;
// A Frontier light-sync packet can carry no renderable MessageBody at all.
// Keep a bounded identity baseline for the authenticated history fallback so
// only records that appeared after startup can enter unread/Toast handling.
const IM_HISTORY_BASELINE_PAGES = 3;
const MAX_IM_HISTORY_IDENTITIES = 4_096;
const IM_SYNC_HINT_DEBOUNCE_MS = 220;
const MAX_IM_SYNC_HINT_PAGES = 3;
// A 203 `messages_per_user_init` packet can be both a first-connect sync and
// a short reconnect catch-up. It is allowed to return shared media only when
// the server supplied a genuinely fresh timestamp; AI text replies stay
// live-event-only so old history can never receive a surprise reply.
const RECOVERY_SHARE_AUTOMATION_WINDOW_MS = 2 * 60_000;
const RECOVERY_SERVER_TIME_FUTURE_SKEW_MS = 60_000;

type MessageDirection = {
  /** Whether the transport explicitly supplied an incoming/outgoing marker. */
  explicit: boolean;
  outgoing: boolean;
};

type FriendChatUpdatedDetail = {
  currentSecUid: string;
  conversationKey: string;
  senderUid: string;
  message: LocalChatMessage;
};

type PendingIncomingPayload = {
  payload: JsonRecord;
  accountEpoch: number;
  receivedAt: number;
  source: "live" | "initial_sync" | "history" | "watchdog" | "hint";
};

type ProcessIncomingOptions = {
  /** Non-live records are persisted and surfaced but require extra guards before side effects. */
  source: "live" | "initial_sync" | "history" | "watchdog" | "hint";
  accountEpoch: number;
  /** A watchdog record must be newer than this trusted server-time boundary. */
  recoveryCutoff?: number;
};

function unknownFriendKey(senderUid: string) {
  return `${UNKNOWN_FRIEND_KEY_PREFIX}${senderUid}`;
}

function friendNameCacheKey(currentSecUid: string) {
  return currentSecUid ? `${FRIEND_UID_NAME_CACHE_KEY}.${currentSecUid}` : FRIEND_UID_NAME_CACHE_KEY;
}

function readFriendDisplayName(currentSecUid: string, senderUid: string) {
  try {
    const cached = JSON.parse(localStorage.getItem(friendNameCacheKey(currentSecUid)) || "{}");
    if (!cached || typeof cached !== "object") return "好友";
    const name = String((cached as Record<string, unknown>)[senderUid] || "").trim();
    return name || "好友";
  } catch {
    return "好友";
  }
}

function unreadTotal(unreadCounts: UnreadCounts) {
  return Object.values(unreadCounts).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

/**
 * Local chat message IDs must be scoped to a conversation. Rich sharing cards
 * can legitimately use `index_in_conversation` when a server message ID is
 * absent; that index is not globally unique across different friends.
 */
export function buildIncomingMessageStorageId(
  conversationNamespace: string,
  serverMessageId: string,
  createdAt: number,
) {
  const namespace = conversationNamespace.trim() || "unknown-conversation";
  const stableId = serverMessageId.trim();
  return stableId
    ? `${namespace}:message:${stableId}`
    : `${namespace}:received:${createdAt}`;
}

function incomingConversationNamespace(payload: JsonRecord, fallbackConversationKey: string) {
  const conversationId = stringField(payload, ["conversation_id", "conversationId"]).trim();
  if (conversationId) return `conversation:${conversationId}`;
  const conversationShortId = stringField(payload, ["conversation_short_id", "conversationShortId"]).trim();
  if (conversationShortId) return `conversation-short:${conversationShortId}`;
  return fallbackConversationKey;
}

/**
 * `index_in_conversation` is the stable fallback supplied by richer IM cards
 * when their normal server message ID is absent. It is only unique within a
 * conversation, hence every caller combines it with the namespace above.
 */
function incomingStableMessageId(payload: JsonRecord) {
  const candidates = [
    stringField(payload, ["server_message_id", "serverMessageId"]),
    stringField(payload, ["index_in_conversation", "indexInConversation"]),
    stringField(payload, ["message_id", "messageId", "id"]),
    stringField(payload, ["client_message_id", "clientMessageId"]),
  ];
  return candidates.find((value) => {
    const normalized = value.trim();
    return Boolean(normalized && normalized !== "0");
  })?.trim() || "";
}

/**
 * History can occasionally lack every transport ID. This fallback is only
 * retained in memory to compare two adjacent history pulls; it deliberately
 * includes the conversation and sender so equal card text in separate chats
 * cannot mask a new sharing card.
 */
function incomingHistoryIdentity(payload: JsonRecord) {
  const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
  const fallbackConversationKey = senderUid ? unknownFriendKey(senderUid) : "unknown-conversation";
  const namespace = incomingConversationNamespace(payload, fallbackConversationKey);
  const stableId = incomingStableMessageId(payload);
  if (stableId) return buildIncomingMessageStorageId(namespace, stableId, 0);
  const rawCreatedAt = numberField(payload, [
    "server_created_at",
    "serverCreatedAt",
    "created_at",
    "createdAt",
    "create_time",
    "createTime",
  ]);
  const createdAt = normalizeTimestampMillis(rawCreatedAt);
  const content = stringField(payload, ["raw_content", "rawContent", "content", "text"])
    .trim()
    .slice(0, 1_024);
  return `${namespace}:history:${senderUid}:${createdAt}:${content}`;
}

function rememberHistoryIdentity(identities: Set<string>, identity: string) {
  if (!identity) return;
  identities.add(identity);
  while (identities.size > MAX_IM_HISTORY_IDENTITIES) {
    const oldest = identities.values().next().value as string | undefined;
    if (oldest === undefined) break;
    identities.delete(oldest);
  }
}

function hasExistingMessage(
  messages: ChatMessages,
  conversationKey: string,
  message: LocalChatMessage,
  hasStableServerMessageId: boolean,
  legacyServerMessageId: string,
) {
  return (messages[conversationKey] || []).some((item) =>
    item.id === message.id ||
    // Keep a one-time compatibility path for messages persisted by older
    // builds, which stored the bare server/index ID. It is intentionally
    // limited to this conversation so another friend's index cannot hide a
    // fresh share card.
    (hasStableServerMessageId && Boolean(legacyServerMessageId) && item.id === legacyServerMessageId) ||
    (
      !hasStableServerMessageId &&
      Boolean(message.text) &&
      item.senderUid === message.senderUid &&
      item.text === message.text &&
      Math.abs(item.createdAt - message.createdAt) < 60_000
    )
  );
}

function dispatchFriendChatUpdated(detail: FriendChatUpdatedDetail) {
  window.dispatchEvent(new CustomEvent<FriendChatUpdatedDetail>(GLOBAL_FRIEND_CHAT_UPDATED_EVENT, { detail }));
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "out", "outgoing"].includes(normalized)) return true;
    if (["0", "false", "no", "in", "incoming"].includes(normalized)) return false;
  }
  return undefined;
}

function normalizeTimestampMillis(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 10_000_000_000 ? value * 1000 : value;
}

function isInitialSyncPayload(payload: JsonRecord) {
  if (booleanValue(payload.is_initial_sync ?? payload.isInitialSync) === true) return true;
  return stringField(payload, ["source", "event_source", "eventSource"]).trim().toLowerCase() === "initial_sync";
}

function trustedServerTimestampMs(payload: JsonRecord) {
  // `created_at` intentionally cannot be used for recovery decisions: an
  // adapter can fill it with local receipt time. Only the explicit pair is
  // safe for a background catch-up side effect.
  if (booleanValue(payload.has_server_created_at ?? payload.hasServerCreatedAt) !== true) return 0;
  return normalizeTimestampMillis(numberField(payload, ["server_created_at", "serverCreatedAt"]));
}

function hasTrustedRecentServerTimestamp(payload: JsonRecord, cutoff: number, now = Date.now()) {
  const createdAt = trustedServerTimestampMs(payload);
  return createdAt > 0
    && createdAt >= cutoff
    && createdAt <= now + RECOVERY_SERVER_TIME_FUTURE_SKEW_MS;
}

function isFreshRecoveryShare(payload: JsonRecord, now = Date.now()) {
  return hasTrustedRecentServerTimestamp(
    payload,
    Math.max(0, now - RECOVERY_SHARE_AUTOMATION_WINDOW_MS),
    now,
  );
}

function resolveMessageDirection(payload: JsonRecord, currentUid: string): MessageDirection {
  const direction = stringField(payload, ["direction"]).trim().toLowerCase();
  if (["out", "outgoing"].includes(direction)) return { explicit: true, outgoing: true };
  if (["in", "incoming"].includes(direction)) return { explicit: true, outgoing: false };

  for (const key of ["is_outgoing", "isOutgoing", "from_self", "fromSelf"]) {
    const resolved = booleanValue(payload[key]);
    if (resolved !== undefined) return { explicit: true, outgoing: resolved };
  }

  const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
  if (senderUid && currentUid) {
    // This is sufficient to suppress a self echo, but it is not an explicit
    // incoming marker and must not make reconciled history automatable.
    return { explicit: false, outgoing: senderUid === currentUid };
  }
  return { explicit: false, outgoing: false };
}

function normalizedOutgoingText(text: string) {
  return String(text || "").trim().replace(/\s+/g, " ").slice(0, 500);
}

function pruneRecentOutgoingText(recentOutgoingTexts: Map<string, number>, now = Date.now()) {
  for (const [key, expiresAt] of recentOutgoingTexts) {
    if (expiresAt <= now) recentOutgoingTexts.delete(key);
  }
}

function rememberRecentOutgoingText(recentOutgoingTexts: Map<string, number>, text: string) {
  const key = normalizedOutgoingText(text);
  if (!key) return;
  pruneRecentOutgoingText(recentOutgoingTexts);
  recentOutgoingTexts.set(key, Date.now() + RECENT_AUTO_REPLY_TTL_MS);
}

function wasRecentlyAutoSent(recentOutgoingTexts: Map<string, number>, text: string) {
  const key = normalizedOutgoingText(text);
  if (!key) return false;
  pruneRecentOutgoingText(recentOutgoingTexts);
  return recentOutgoingTexts.has(key);
}

function persistIncomingMessage(currentSecUid: string, payload: JsonRecord) {
  const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
  const rawContent = stringField(payload, ["raw_content", "rawContent"]) || undefined;
  const text = stringField(payload, ["content", "text"]) || fallbackMessageText(rawContent);
  if (!senderUid || !text) return null;

  const conversationKey = unknownFriendKey(senderUid);
  // The listener keeps `created_at` as local receipt time. Prefer a
  // explicitly trustworthy server time for ordering batched 203 records,
  // otherwise retain the receipt/history timestamp as a safe fallback.
  const hasServerCreatedAt = booleanValue(payload.has_server_created_at ?? payload.hasServerCreatedAt) === true;
  const rawServerCreatedAt = hasServerCreatedAt
    ? numberField(payload, ["server_created_at", "serverCreatedAt"])
    : 0;
  const rawCreatedAt = rawServerCreatedAt || numberField(payload, ["created_at", "createdAt", "create_time", "createTime"]);
  const createdAt = rawCreatedAt > 0 && rawCreatedAt < 10_000_000_000
    ? rawCreatedAt * 1000
    : rawCreatedAt || Date.now();
  const serverMessageId = incomingStableMessageId(payload);
  const messageNamespace = incomingConversationNamespace(payload, conversationKey);
  const message: LocalChatMessage = {
    id: buildIncomingMessageStorageId(messageNamespace, serverMessageId, createdAt),
    text,
    rawContent,
    createdAt,
    status: "sent",
    direction: "in",
    senderUid,
  };

  const chatMessages = readChatMessages(currentSecUid);
  // Share cards use compact repeated labels such as "[分享作品]". When the
  // transport supplied a server ID, it is authoritative: do not treat a
  // second share in the same minute as a duplicate just because its label
  // matches the first one.
  if (hasExistingMessage(chatMessages, conversationKey, message, Boolean(serverMessageId), serverMessageId)) {
    return null;
  }

  const nextMessages: ChatMessages = {
    ...chatMessages,
    [conversationKey]: [...(chatMessages[conversationKey] || []), message].sort((a, b) => a.createdAt - b.createdAt),
  };
  const chatSummaries: ChatSummaries = readChatSummaries(currentSecUid);
  const currentSummary = chatSummaries[conversationKey];
  const nextSummaries: ChatSummaries = {
    ...chatSummaries,
    [conversationKey]: {
      latestMessage: message,
      latestMessageAt: Math.max(message.createdAt, currentSummary?.latestMessageAt || 0),
      unreadCount: (currentSummary?.unreadCount || 0) + 1,
    },
  };
  const unreadCounts: UnreadCounts = readUnreadCounts(currentSecUid);
  const nextUnreadCounts: UnreadCounts = {
    ...unreadCounts,
    [conversationKey]: (unreadCounts[conversationKey] || 0) + 1,
  };

  persistChatMessages(nextMessages, currentSecUid);
  const chatSessions = readChatSessions(currentSecUid);
  const displayName = readFriendDisplayName(currentSecUid, senderUid);
  const session = refreshChatSession(chatSessions[conversationKey], nextMessages[conversationKey] || [], displayName);
  persistChatSessions({ ...chatSessions, [conversationKey]: session }, currentSecUid);
  persistChatSummaries(nextSummaries, currentSecUid);
  persistUnreadCounts(nextUnreadCounts, currentSecUid);
  void saveFriendChatState({ summaries: nextSummaries, unreadCounts: nextUnreadCounts }, currentSecUid).catch(() => undefined);
  useAppStore.getState().setFriendUnreadCount(unreadTotal(nextUnreadCounts));
  dispatchFriendChatUpdated({ currentSecUid, conversationKey, senderUid, message });

  return { conversationKey, senderUid, message, nextMessages, session };
}

async function maybeAutoReply(
  senderUid: string,
  displayName: string,
  incoming: LocalChatMessage,
  recentMessages: LocalChatMessage[],
  session: ChatSession | undefined,
  repliedKeys: Set<string>,
  recentOutgoingTexts: Map<string, number>,
  isCurrentAccount: () => boolean,
) {
  const key = incoming.id || `${senderUid}-${incoming.createdAt}-${incoming.text}`;
  if (!isCurrentAccount() || !key || repliedKeys.has(key)) return;
  const logger = useLogStore.getState();
  const incomingText = incoming.text || incoming.rawContent || "";

  try {
    const config = await readAiAutomationConfig();
    if (!isCurrentAccount()) return;
    if (!config?.enabled) {
      logger.addLog("好友私信已收到，自动回复未执行：自动监控总开关未开启", "info");
      return;
    }
    if (!config.auto_monitor_friends) {
      logger.addLog("好友私信已收到，自动回复未执行：好友私信监控未开启", "info");
      return;
    }
    if (!config.auto_send_private_messages) {
      logger.addLog("好友私信已收到，自动回复未执行：发送私信动作未开启", "info");
      return;
    }
    if (!shouldAutomateText(incomingText, config, "private")) {
      logger.addLog(`好友私信未触发自动回复：未命中过滤规则 · 收到：${incomingText.slice(0, 80)}`, "info");
      return;
    }
    if (!rememberAutomationKey(repliedKeys, key)) return;

    logger.addLog(`好友私信触发自动回复：${displayName} · 收到：${incomingText.slice(0, 80)}`, "info");
    const context = buildPrivateMessageAiContext(session, recentMessages, displayName);
    const result = await suggestAiInteraction({
      target: "private_message",
      context,
      incoming_text: incomingText.slice(0, 360),
      author_name: displayName,
      tone: "warm",
      language: "zh-CN",
      max_suggestions: 3,
    });
    if (!isCurrentAccount()) return;
    const suggestions = normalizeAiSuggestions(result);
    if (!result.actions?.send_private_message || suggestions.length === 0) {
      logger.addLog("好友私信 AI 未返回可发送回复", "warning");
      return;
    }
    await waitForAiAutoSend(getAiAutoSendDelayMs(result.auto_send_delay_ms));
    if (!isCurrentAccount()) return;
    rememberRecentOutgoingText(recentOutgoingTexts, suggestions[0]);
    const sendResult = await sendFriendMessage({ toUserId: senderUid, content: suggestions[0] });
    if (!isCurrentAccount()) return;
    if (!sendResult.success) {
      throw new Error(sendResult.message || "自动回复发送失败");
    }
    logger.addLog(`好友私信自动回复成功：${displayName} · 发送：${suggestions[0].slice(0, 100)}`, "success");
  } catch (error) {
    logger.addLog(error instanceof Error ? error.message : "好友私信自动回复失败", "warning");
  }
}

async function maybeAutoReturnShare(
  senderUid: string,
  incoming: LocalChatMessage,
  handledKeys: Set<string>,
  isCurrentAccount: () => boolean,
) {
  const key = `share:${incoming.id || `${senderUid}-${incoming.createdAt}`}`;
  if (!isCurrentAccount() || !rememberAutomationKey(handledKeys, key)) return;
  const logger = useLogStore.getState();
  try {
    const config = await readAiAutomationConfig();
    if (!isCurrentAccount()) return;
    if (!config?.enabled || !config.auto_monitor_friends || !config.auto_return_shared_media) return;
    const result = await autoReturnSharedMedia(senderUid, incoming.rawContent || incoming.text, config, {
      shouldContinue: isCurrentAccount,
    });
    if (!isCurrentAccount()) return;
    if (!result.handled) return;
    logger.addLog(result.sent > 0 ? `好友分享内容已自动回传：${result.sent} 个媒体` : `好友分享内容未回传：${result.skipped}`, result.sent > 0 ? "success" : "info");
  } catch (error) {
    logger.addLog(error instanceof Error ? `好友分享内容回传失败：${error.message}` : "好友分享内容回传失败", "warning");
  }
}

export function useGlobalFriendsIm() {
  const currentSecUidRef = useRef("");
  const currentUidRef = useRef("");
  const accountEpochRef = useRef(0);
  const accountLookupGenerationRef = useRef(0);
  const autoRepliedMessageIdsRef = useRef<Set<string>>(new Set());
  const autoReturnedSharedMessageIdsRef = useRef<Set<string>>(new Set());
  const recentOutgoingTextsRef = useRef<Map<string, number>>(new Map());
  const pendingIncomingPayloadsRef = useRef<PendingIncomingPayload[]>([]);
  const pendingIncomingOverflowAtRef = useRef(0);
  const lastImStatusUpdatedAtRef = useRef(0);
  const imDisconnectedAtRef = useRef(0);
  const imReconcileInFlightRef = useRef(false);
  const reconcileRetryCountRef = useRef(0);
  const reconcileRetryTimerRef = useRef<number | undefined>(undefined);
  const imConnectedSinceRef = useRef(0);
  const imWatchdogInFlightEpochRef = useRef<number | null>(null);
  const imWatchdogLastPollAtRef = useRef(0);
  const imWatchdogTimerRef = useRef<number | undefined>(undefined);
  // The baseline is intentionally separate from rendered chat storage: its
  // sole job is to tell a recovery pull which history rows pre-date this
  // renderer session. That lets a content-free WS sync hint surface a new
  // sharing card without replaying cold-start history as unread notifications.
  const imHistoryBaselineEpochRef = useRef(-1);
  const imHistoryBaselineReadyRef = useRef(false);
  const imHistoryBaselineInFlightEpochRef = useRef<number | null>(null);
  const imHistorySeenIdentitiesRef = useRef<Set<string>>(new Set());
  const imSyncHintPendingEpochRef = useRef<number | null>(null);
  const imSyncHintInFlightEpochRef = useRef<number | null>(null);
  const imSyncHintTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    let unlistenCookieStatus: (() => void) | undefined;
    const refreshCurrentAccount = async () => {
      const requestGeneration = ++accountLookupGenerationRef.current;
      try {
        const result = await getAccounts();
        if (!disposed && requestGeneration === accountLookupGenerationRef.current && result.success) {
          const nextSecUid = result.current_sec_uid || "";
          const previousSecUid = currentSecUidRef.current;
          const accountChanged = previousSecUid !== nextSecUid;
          if (accountChanged) {
            // A sync hint can arrive before the first account lookup has
            // resolved. It belongs to the listener being initialized, so
            // carry it into that first known account only; never cross a
            // real account switch with it.
            const carryBootstrapSyncHint = !previousSecUid && imSyncHintPendingEpochRef.current !== null;
            accountEpochRef.current += 1;
            // Events queued for a known previous account must never be
            // flushed into this account's local chat namespace.
            if (previousSecUid) pendingIncomingPayloadsRef.current = [];
            if (previousSecUid) pendingIncomingOverflowAtRef.current = 0;
            // Listener status belongs to the desktop client being replaced.
            // Await the new listener's snapshot/event instead of reconciling
            // old-account history into the newly selected namespace.
            imDisconnectedAtRef.current = 0;
            lastImStatusUpdatedAtRef.current = 0;
            imConnectedSinceRef.current = 0;
            imWatchdogLastPollAtRef.current = 0;
            imWatchdogInFlightEpochRef.current = null;
            if (imWatchdogTimerRef.current !== undefined) {
              window.clearTimeout(imWatchdogTimerRef.current);
              imWatchdogTimerRef.current = undefined;
            }
            if (imSyncHintTimerRef.current !== undefined) {
              window.clearTimeout(imSyncHintTimerRef.current);
              imSyncHintTimerRef.current = undefined;
            }
            imHistoryBaselineEpochRef.current = -1;
            imHistoryBaselineReadyRef.current = false;
            imHistoryBaselineInFlightEpochRef.current = null;
            imHistorySeenIdentitiesRef.current.clear();
            imSyncHintInFlightEpochRef.current = null;
            imSyncHintPendingEpochRef.current = carryBootstrapSyncHint
              ? accountEpochRef.current
              : null;
            autoRepliedMessageIdsRef.current.clear();
            autoReturnedSharedMessageIdsRef.current.clear();
            recentOutgoingTextsRef.current.clear();
          }
          currentSecUidRef.current = nextSecUid;
          const currentAccount = result.accounts?.find((account) => account.sec_uid === nextSecUid);
          currentUidRef.current = String(currentAccount?.uid || currentAccount?.user_id || "").trim();
          // The listener can beat this async account lookup on a cold launch.
          // Wake the event handler so it can replay anything safely queued
          // during that short initialization window.
          window.dispatchEvent(new CustomEvent(IM_ACCOUNT_READY_EVENT, {
            detail: { accountEpoch: accountEpochRef.current, accountChanged },
          }));
        }
      } catch {
        // Keep the existing namespace if account lookup temporarily fails.
      }
    };
    void refreshCurrentAccount();
    const handleCookieStatus = () => {
      void refreshCurrentAccount();
    };
    window.addEventListener("cookie-login-status", handleCookieStatus);
    void listenEvent("cookie-login-status", handleCookieStatus).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlistenCookieStatus = cleanup;
    });
    return () => {
      disposed = true;
      window.removeEventListener("cookie-login-status", handleCookieStatus);
      unlistenCookieStatus?.();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let unlistenSyncHint: (() => void) | undefined;
    // Do not let the silent baseline itself start the listener before its
    // non-replayable sync-hint subscription exists. Otherwise a cold start
    // can lose the one hint that describes a rich sharing card.
    let imSyncHintListenerReady = false;
    const isAccountActive = (accountEpoch: number, currentSecUid: string) =>
      !disposed &&
      accountEpochRef.current === accountEpoch &&
      currentSecUidRef.current === currentSecUid &&
      Boolean(currentSecUid);

    const queuePendingPayload = (
      payload: JsonRecord,
      accountEpoch: number,
      source: ProcessIncomingOptions["source"],
    ) => {
      const pending = pendingIncomingPayloadsRef.current;
      const pendingIdentity = incomingHistoryIdentity(payload);
      if (pendingIdentity && pending.some((item) => {
        const itemIdentity = incomingHistoryIdentity(item.payload);
        return itemIdentity === pendingIdentity;
      })) return;
      pending.push({ payload, accountEpoch, receivedAt: Date.now(), source });
      if (pending.length > MAX_PENDING_IM_EVENTS) {
        const removed = pending.splice(0, pending.length - MAX_PENDING_IM_EVENTS);
        const oldestRemoved = removed[0]?.receivedAt || Date.now();
        pendingIncomingOverflowAtRef.current = pendingIncomingOverflowAtRef.current
          ? Math.min(pendingIncomingOverflowAtRef.current, oldestRemoved)
          : oldestRemoved;
      }
    };

    const processIncomingPayload = (payload: JsonRecord, options: ProcessIncomingOptions) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const currentSecUid = currentSecUidRef.current;
      if (!currentSecUid) {
        queuePendingPayload(payload, options.accountEpoch, options.source);
        return;
      }
      if (!isAccountActive(options.accountEpoch, currentSecUid)) return;
      if (
        options.source === "watchdog"
        && !hasTrustedRecentServerTimestamp(payload, options.recoveryCutoff || 0)
      ) {
        // Do not let the periodic safety net turn a cold-start history page
        // into new unread messages or notifications. Live WS events and the
        // explicit reconnect reconciliation retain their separate paths.
        return;
      }
      const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
      const currentUid = stringField(payload, ["current_uid", "currentUid"]);
      if (!currentUidRef.current && currentUid) {
        currentUidRef.current = currentUid;
      }
      const rawContent = stringField(payload, ["raw_content", "rawContent"]) || undefined;
      const text = stringField(payload, ["content", "text"]) || fallbackMessageText(rawContent);
      const messageDirection = resolveMessageDirection(payload, currentUidRef.current);
      const isOutgoing =
        messageDirection.outgoing ||
        wasRecentlyAutoSent(recentOutgoingTextsRef.current, text);
      // Preserve every successfully observed transport identity while the
      // silent baseline is still being built. A subsequent sync hint then
      // cannot rediscover an ordinary live message as a new history row.
      rememberHistoryIdentity(imHistorySeenIdentitiesRef.current, incomingHistoryIdentity(payload));
      if (isOutgoing) {
        // A history/watchdog page repeatedly contains our own recent sends.
        // Suppress those silently; the explicit live echo remains visible so
        // users can verify that the loop guard is working.
        if (options.source === "live") {
          useLogStore.getState().addLog("好友私信回流已忽略：检测到自己发送的消息，已阻止自动回复循环", "info");
        }
        return;
      }
      const result = persistIncomingMessage(currentSecUid, payload);
      if (!result) return;
      const preview = messagePreviewText(result.message) || result.message.text;
      const displayName = readFriendDisplayName(currentSecUid, result.senderUid);
      useToastStore.getState().toast(preview ? `收到新私信：${preview}` : "收到新私信", "info", "好友私信");
      // History and 203 batches can contain records the listener did not see
      // in real time. They belong in local unread state, but an AI text reply
      // must only be caused by the ordinary live notification path.
      const canAutoReply = options.source === "live";
      // A freshly-created shared-work record is safe to catch up after a
      // short reconnect/watchdog pull, but never trust a client-side fallback
      // timestamp. Text AI remains live-event-only.
      // `persistIncomingMessage` above also makes a previously handled card
      // a no-op after a renderer restart.
      const canAutoReturnShare = canAutoReply
        || options.source === "hint"
        || (
          (options.source === "initial_sync" || options.source === "history" || options.source === "watchdog")
          && isFreshRecoveryShare(payload)
        );
      const active = () => isAccountActive(options.accountEpoch, currentSecUid);
      if (isSharedWorkPayload(result.message.rawContent || result.message.text)) {
        if (canAutoReturnShare) {
          useLogStore.getState().addLog("好友分享作品已进入自动下载回传流程，已跳过 AI 自动回复", "info");
          void maybeAutoReturnShare(result.senderUid, result.message, autoReturnedSharedMessageIdsRef.current, active);
        } else if (options.source !== "live") {
          useLogStore.getState().addLog("好友分享内容已同步到未读，因消息较早或缺少服务端时间未自动回传", "info");
        }
        return;
      }
      if (!canAutoReply) return;
      void maybeAutoReply(
        result.senderUid,
        displayName,
        result.message,
        result.nextMessages[result.conversationKey] || [result.message],
        result.session,
        autoRepliedMessageIdsRef.current,
        recentOutgoingTextsRef.current,
        active,
      );
    };

    const flushPendingIncomingPayloads = () => {
      if (disposed || !currentSecUidRef.current) return;
      const pending = pendingIncomingPayloadsRef.current.splice(0);
      const accountEpoch = accountEpochRef.current;
      for (const item of pending) {
        // A value of zero is the small cold-start window before the account
        // lookup completed. Any non-zero epoch must match exactly.
        if (item.accountEpoch && item.accountEpoch !== accountEpoch) continue;
        processIncomingPayload(item.payload, { source: item.source, accountEpoch });
      }
    };

    const scheduleReconcileRetry = () => {
      if (disposed || reconcileRetryTimerRef.current !== undefined || !imDisconnectedAtRef.current) return;
      const index = Math.min(reconcileRetryCountRef.current, IM_RECONCILE_RETRY_DELAYS_MS.length - 1);
      const delay = IM_RECONCILE_RETRY_DELAYS_MS[index];
      reconcileRetryCountRef.current += 1;
      reconcileRetryTimerRef.current = window.setTimeout(() => {
        reconcileRetryTimerRef.current = undefined;
        void reconcileRecentMessages(accountEpochRef.current);
      }, delay);
    };

    const reconcileRecentMessages = async (requestedEpoch = accountEpochRef.current) => {
      const disconnectedAt = imDisconnectedAtRef.current;
      if (disposed || !disconnectedAt || imReconcileInFlightRef.current || requestedEpoch !== accountEpochRef.current) return;
      if (!currentSecUidRef.current) return;
      const currentSecUid = currentSecUidRef.current;
      imReconcileInFlightRef.current = true;
      let reconciled = false;
      try {
        // The backend detects a half-open socket after a 25s ping + 10s
        // Pong deadline. Include that window before the recorded disconnect
        // rather than creating a blind spot between the last live event and
        // the reconnection history pull.
        const cutoff = Math.max(0, disconnectedAt - IM_RECONCILE_SAFETY_WINDOW_MS);
        let cursor = 0;
        let coveredBreakpoint = false;
        const seenCursors = new Set<number>();
        for (let page = 0; page < MAX_IM_RECONCILE_PAGES; page += 1) {
          if (!isAccountActive(requestedEpoch, currentSecUid)) return;
          const result = await getFriendMessageHistory({ cursor });
          if (!isAccountActive(requestedEpoch, currentSecUid)) return;
          if (!result.success) throw new Error(result.message || "获取断线期间私信失败");
          const messages = Array.isArray(result.messages) ? result.messages : [];
          let oldestTimestamp = Number.POSITIVE_INFINITY;
          let foundTrustedTimestamp = false;
          for (const item of messages) {
            const payload = item as unknown as JsonRecord;
            const serverCreatedAt = trustedServerTimestampMs(payload);
            if (serverCreatedAt > 0) {
              foundTrustedTimestamp = true;
              oldestTimestamp = Math.min(oldestTimestamp, serverCreatedAt);
            }
            if (hasTrustedRecentServerTimestamp(payload, cutoff)) {
              processIncomingPayload(payload, {
                source: "history",
                accountEpoch: requestedEpoch,
                recoveryCutoff: cutoff,
              });
            }
          }
          const nextCursor = Number(result.next_cursor || 0) || 0;
          const hasMore = result.has_more === true || nextCursor > 0;
          // A legacy adapter without an explicit server timestamp is not
          // safe to replay into unread state. Treat that page as covered
          // rather than retrying forever and turning old history into toasts.
          if (oldestTimestamp <= cutoff || messages.length === 0 || !hasMore || !foundTrustedTimestamp) {
            coveredBreakpoint = true;
            break;
          }
          if (!nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        reconciled = coveredBreakpoint;
      } catch {
        // Keep the breakpoint. A bounded exponential retry is preferable to
        // declaring success after a transient history endpoint failure.
      } finally {
        if (reconciled && imDisconnectedAtRef.current === disconnectedAt && isAccountActive(requestedEpoch, currentSecUid)) {
          imDisconnectedAtRef.current = 0;
          reconcileRetryCountRef.current = 0;
        } else if (!disposed && imDisconnectedAtRef.current === disconnectedAt) {
          scheduleReconcileRetry();
        }
        imReconcileInFlightRef.current = false;
      }
    };

    const clearImWatchdogTimer = () => {
      if (imWatchdogTimerRef.current === undefined) return;
      window.clearTimeout(imWatchdogTimerRef.current);
      imWatchdogTimerRef.current = undefined;
    };

    const isWatchdogConnectionActive = (requestedEpoch: number, currentSecUid: string) =>
      isAccountActive(requestedEpoch, currentSecUid) && imConnectedSinceRef.current > 0;

    const scheduleImWatchdog = (requestedEpoch = accountEpochRef.current) => {
      if (disposed || imWatchdogTimerRef.current !== undefined || requestedEpoch !== accountEpochRef.current) return;
      const currentSecUid = currentSecUidRef.current;
      const connectedSince = imConnectedSinceRef.current;
      if (!currentSecUid || !connectedSince || !isWatchdogConnectionActive(requestedEpoch, currentSecUid)) return;
      const connectedFor = Math.max(0, Date.now() - connectedSince);
      const delay = imWatchdogLastPollAtRef.current > 0
        ? IM_WATCHDOG_INTERVAL_MS
        : Math.max(IM_WATCHDOG_INITIAL_DELAY_MS, IM_WATCHDOG_CONNECTION_STABLE_MS - connectedFor);
      imWatchdogTimerRef.current = window.setTimeout(() => {
        imWatchdogTimerRef.current = undefined;
        void runImHistoryWatchdog(requestedEpoch);
      }, delay);
    };

    const runImHistoryWatchdog = async (requestedEpoch = accountEpochRef.current) => {
      const currentSecUid = currentSecUidRef.current;
      const connectedSince = imConnectedSinceRef.current;
      if (!currentSecUid || !connectedSince || !isWatchdogConnectionActive(requestedEpoch, currentSecUid)) return;
      if (Date.now() - connectedSince < IM_WATCHDOG_CONNECTION_STABLE_MS) {
        scheduleImWatchdog(requestedEpoch);
        return;
      }
      if (imWatchdogInFlightEpochRef.current === requestedEpoch) {
        scheduleImWatchdog(requestedEpoch);
        return;
      }

      // The first pull deliberately starts around the observed connection
      // time, not at an arbitrary historic cursor. Subsequent pulls overlap
      // their previous poll slightly so a late history page cannot create a
      // gap, while locally persisted server IDs collapse the overlap.
      const cutoff = Math.max(
        0,
        (imWatchdogLastPollAtRef.current || connectedSince) - IM_WATCHDOG_SAFETY_WINDOW_MS,
      );
      imWatchdogInFlightEpochRef.current = requestedEpoch;
      let completed = false;
      try {
        let cursor = 0;
        const seenCursors = new Set<number>();
        for (let page = 0; page < MAX_IM_WATCHDOG_PAGES; page += 1) {
          if (!isWatchdogConnectionActive(requestedEpoch, currentSecUid)) return;
          const result = await getFriendMessageHistory({ cursor });
          if (!isWatchdogConnectionActive(requestedEpoch, currentSecUid)) return;
          if (!result.success) throw new Error(result.message || "获取 IM 安全补偿消息失败");
          completed = true;
          const messages = Array.isArray(result.messages) ? result.messages : [];
          let oldestTimestamp = Number.POSITIVE_INFINITY;
          let foundTrustedTimestamp = false;
          for (const item of messages) {
            const payload = item as unknown as JsonRecord;
            const serverCreatedAt = trustedServerTimestampMs(payload);
            if (serverCreatedAt > 0) {
              foundTrustedTimestamp = true;
              oldestTimestamp = Math.min(oldestTimestamp, serverCreatedAt);
            }
            if (hasTrustedRecentServerTimestamp(payload, cutoff)) {
              processIncomingPayload(payload, {
                source: "watchdog",
                accountEpoch: requestedEpoch,
                recoveryCutoff: cutoff,
              });
            }
          }
          const nextCursor = Number(result.next_cursor || 0) || 0;
          const hasMore = result.has_more === true || nextCursor > 0;
          if (oldestTimestamp <= cutoff || messages.length === 0 || !hasMore || !foundTrustedTimestamp) break;
          if (!nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } catch {
        // This is deliberately a quiet safety net. The live listener remains
        // authoritative, and a failed watchdog must not spam automation logs.
      } finally {
        if (imWatchdogInFlightEpochRef.current === requestedEpoch) {
          imWatchdogInFlightEpochRef.current = null;
          if (completed && isWatchdogConnectionActive(requestedEpoch, currentSecUid)) {
            imWatchdogLastPollAtRef.current = Date.now();
          }
        }
        if (isWatchdogConnectionActive(requestedEpoch, currentSecUid)) {
          scheduleImWatchdog(requestedEpoch);
        }
      }
    };

    /**
     * Build a silent snapshot of the recent global history. The Frontier
     * sync route deliberately does not include a message body for some rich
     * shares, so the later hint can only know "something changed". Capturing
     * identities here is what prevents that recovery pull from replaying old
     * history into unread counts and notifications on startup.
     */
    const establishImHistoryBaseline = async (requestedEpoch = accountEpochRef.current) => {
      const currentSecUid = currentSecUidRef.current;
      if (!isAccountActive(requestedEpoch, currentSecUid)) return false;
      if (
        imHistoryBaselineReadyRef.current
        && imHistoryBaselineEpochRef.current === requestedEpoch
      ) return true;
      if (imHistoryBaselineInFlightEpochRef.current === requestedEpoch) return false;

      imHistoryBaselineInFlightEpochRef.current = requestedEpoch;
      const captured = new Set<string>();
      // Live messages can race this initial pull. Preserve anything already
      // observed by the renderer when committing the completed snapshot.
      for (const identity of imHistorySeenIdentitiesRef.current) {
        rememberHistoryIdentity(captured, identity);
      }
      let completed = false;
      try {
        let cursor = 0;
        const seenCursors = new Set<number>();
        for (let page = 0; page < IM_HISTORY_BASELINE_PAGES; page += 1) {
          if (!isAccountActive(requestedEpoch, currentSecUid)) return false;
          const result = await getFriendMessageHistory({ cursor });
          if (!isAccountActive(requestedEpoch, currentSecUid)) return false;
          if (!result.success) throw new Error(result.message || "获取 IM 历史基线失败");
          const messages = Array.isArray(result.messages) ? result.messages : [];
          for (const item of messages) {
            rememberHistoryIdentity(captured, incomingHistoryIdentity(item as unknown as JsonRecord));
          }
          const nextCursor = Number(result.next_cursor || 0) || 0;
          const hasMore = result.has_more === true || nextCursor > 0;
          if (messages.length === 0 || !hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
        completed = true;
      } catch {
        // No UI side effect is safe without a complete initial snapshot. A
        // future status transition or sync hint will attempt it again.
      } finally {
        if (imHistoryBaselineInFlightEpochRef.current === requestedEpoch) {
          imHistoryBaselineInFlightEpochRef.current = null;
        }
      }

      if (!completed || !isAccountActive(requestedEpoch, currentSecUid)) return false;
      const merged = new Set<string>();
      for (const identity of imHistorySeenIdentitiesRef.current) {
        rememberHistoryIdentity(merged, identity);
      }
      for (const identity of captured) {
        rememberHistoryIdentity(merged, identity);
      }
      imHistorySeenIdentitiesRef.current = merged;
      imHistoryBaselineEpochRef.current = requestedEpoch;
      imHistoryBaselineReadyRef.current = true;
      if (imSyncHintPendingEpochRef.current === requestedEpoch) {
        scheduleImSyncHint(requestedEpoch);
      }
      return true;
    };

    const clearImSyncHintTimer = () => {
      if (imSyncHintTimerRef.current === undefined) return;
      window.clearTimeout(imSyncHintTimerRef.current);
      imSyncHintTimerRef.current = undefined;
    };

    /**
     * A hint carries no conversation or message ID by design. Coalesce a
     * burst of them, fetch the latest global history, then feed only records
     * absent from the silent baseline through `processIncomingPayload`.
     */
    const runImSyncHintHistory = async (requestedEpoch = accountEpochRef.current) => {
      const currentSecUid = currentSecUidRef.current;
      if (!isAccountActive(requestedEpoch, currentSecUid)) return;
      if (
        !imHistoryBaselineReadyRef.current
        || imHistoryBaselineEpochRef.current !== requestedEpoch
      ) {
        void establishImHistoryBaseline(requestedEpoch);
        return;
      }
      if (imSyncHintInFlightEpochRef.current === requestedEpoch) return;

      // Consume the hint that caused this run. If another arrives while the
      // request is in flight it re-populates this ref and schedules one final
      // coalesced pass after the current history page completes.
      if (imSyncHintPendingEpochRef.current === requestedEpoch) {
        imSyncHintPendingEpochRef.current = null;
      }
      imSyncHintInFlightEpochRef.current = requestedEpoch;
      try {
        let cursor = 0;
        const seenCursors = new Set<number>();
        for (let page = 0; page < MAX_IM_SYNC_HINT_PAGES; page += 1) {
          if (!isAccountActive(requestedEpoch, currentSecUid)) return;
          const result = await getFriendMessageHistory({ cursor });
          if (!isAccountActive(requestedEpoch, currentSecUid)) return;
          if (!result.success) throw new Error(result.message || "获取 IM 同步消息失败");
          const messages = Array.isArray(result.messages) ? result.messages : [];
          let pageAlreadyKnown = false;
          for (const item of messages) {
            const payload = item as unknown as JsonRecord;
            const identity = incomingHistoryIdentity(payload);
            if (imHistorySeenIdentitiesRef.current.has(identity)) {
              pageAlreadyKnown = true;
              continue;
            }
            // Mark before side effects so an overlapping hint cannot launch a
            // second download/reply while this item is being persisted.
            rememberHistoryIdentity(imHistorySeenIdentitiesRef.current, identity);
            processIncomingPayload(payload, {
              source: "hint",
              accountEpoch: requestedEpoch,
            });
          }
          const nextCursor = Number(result.next_cursor || 0) || 0;
          const hasMore = result.has_more === true || nextCursor > 0;
          // Recent-user history is ordered newest first. Once a page reaches
          // the startup baseline, older pages cannot add a newly hinted card.
          if (messages.length === 0 || pageAlreadyKnown || !hasMore || !nextCursor || seenCursors.has(nextCursor)) break;
          seenCursors.add(nextCursor);
          cursor = nextCursor;
        }
      } catch {
        // The next sync hint can retry this quiet recovery path. Do not show
        // an error Toast for an internal safety net.
      } finally {
        if (imSyncHintInFlightEpochRef.current === requestedEpoch) {
          imSyncHintInFlightEpochRef.current = null;
        }
        if (
          imSyncHintPendingEpochRef.current === requestedEpoch
          && isAccountActive(requestedEpoch, currentSecUid)
        ) {
          scheduleImSyncHint(requestedEpoch);
        }
      }
    };

    const scheduleImSyncHint = (requestedEpoch = accountEpochRef.current) => {
      if (disposed || requestedEpoch !== accountEpochRef.current) return;
      imSyncHintPendingEpochRef.current = requestedEpoch;
      const currentSecUid = currentSecUidRef.current;
      if (!isAccountActive(requestedEpoch, currentSecUid)) return;
      if (
        !imHistoryBaselineReadyRef.current
        || imHistoryBaselineEpochRef.current !== requestedEpoch
      ) {
        void establishImHistoryBaseline(requestedEpoch);
        return;
      }
      if (imSyncHintTimerRef.current !== undefined || imSyncHintInFlightEpochRef.current === requestedEpoch) return;
      imSyncHintTimerRef.current = window.setTimeout(() => {
        imSyncHintTimerRef.current = undefined;
        void runImSyncHintHistory(requestedEpoch);
      }, IM_SYNC_HINT_DEBOUNCE_MS);
    };

    const markReconciliationRequired = (at: number) => {
      const safeAt = at > 0 ? at : Date.now();
      imDisconnectedAtRef.current = imDisconnectedAtRef.current
        ? Math.min(imDisconnectedAtRef.current, safeAt)
        : safeAt;
    };
    const handleAccountReady = () => {
      flushPendingIncomingPayloads();
      if (imSyncHintListenerReady) void establishImHistoryBaseline(accountEpochRef.current);
      if (pendingIncomingOverflowAtRef.current) {
        markReconciliationRequired(pendingIncomingOverflowAtRef.current);
        pendingIncomingOverflowAtRef.current = 0;
      }
      if (imDisconnectedAtRef.current) void reconcileRecentMessages(accountEpochRef.current);
      scheduleImWatchdog(accountEpochRef.current);
    };
    const handleImStatus = (payload: JsonRecord) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const connected = booleanValue(payload.connected) === true;
      const updatedAt = numberField(payload, ["updated_at", "updatedAt"]) || Date.now();
      if (updatedAt < lastImStatusUpdatedAtRef.current) return;
      lastImStatusUpdatedAtRef.current = updatedAt;
      if (!connected) {
        // The listener emits an initial “connecting” status before its first
        // successful socket. That is not a dropped-message interval. Only a
        // transition from an established connection requires reconciliation.
        if (imConnectedSinceRef.current) {
          markReconciliationRequired(updatedAt);
          imConnectedSinceRef.current = 0;
          clearImWatchdogTimer();
        }
        return;
      }
      if (!imConnectedSinceRef.current) {
        // Use local observation time rather than a possibly stale snapshot
        // timestamp: a freshly mounted renderer must never replay hours of
        // history merely because the socket was already connected.
        imConnectedSinceRef.current = Date.now();
        imWatchdogLastPollAtRef.current = 0;
      }
      if (imSyncHintListenerReady) void establishImHistoryBaseline(accountEpochRef.current);
      const shouldReconcile = imDisconnectedAtRef.current > 0;
      if (shouldReconcile) void reconcileRecentMessages(accountEpochRef.current);
      scheduleImWatchdog(accountEpochRef.current);
    };
    window.addEventListener(IM_ACCOUNT_READY_EVENT, handleAccountReady);
    // Covers the case where getAccounts resolved before this listener effect
    // had been registered.
    handleAccountReady();
    void listenEvent<JsonRecord>("im-message", (payload) => {
      processIncomingPayload(payload, {
        source: isInitialSyncPayload(payload) ? "initial_sync" : "live",
        accountEpoch: accountEpochRef.current,
      });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    void listenEvent<JsonRecord>("im-sync-hint", () => {
      // This signal intentionally has no message payload. Its presence means
      // the WS frontier may have advanced, so retrieve the authenticated
      // history after the silent startup baseline is ready.
      scheduleImSyncHint(accountEpochRef.current);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else {
        unlistenSyncHint = cleanup;
        imSyncHintListenerReady = true;
        void establishImHistoryBaseline(accountEpochRef.current);
      }
    });
    void listenEvent<JsonRecord>("im-status", handleImStatus).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlistenStatus = cleanup;
      // Events are not replayed when a renderer subscribes late. Read the
      // backend snapshot only after registering the listener, so a status
      // transition cannot slip between the two operations.
      void getImConnectionStatus()
        .then((snapshot) => {
          if (!disposed && snapshot?.success) handleImStatus(snapshot as unknown as JsonRecord);
        })
        .catch(() => undefined);
    });
    return () => {
      disposed = true;
      if (reconcileRetryTimerRef.current !== undefined) {
        window.clearTimeout(reconcileRetryTimerRef.current);
        reconcileRetryTimerRef.current = undefined;
      }
      clearImWatchdogTimer();
      clearImSyncHintTimer();
      window.removeEventListener(IM_ACCOUNT_READY_EVENT, handleAccountReady);
      unlisten?.();
      unlistenStatus?.();
      unlistenSyncHint?.();
    };
  }, []);
}
