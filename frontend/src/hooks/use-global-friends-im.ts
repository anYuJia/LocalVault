import { useEffect, useRef } from "react";
import { useToastStore } from "@/components/ui/toast";
import { getAccounts, listenEvent, saveFriendChatState, sendFriendMessage, suggestAiInteraction } from "@/lib/tauri";
import {
  getAiAutoSendDelayMs,
  normalizeAiSuggestions,
  readAiAutomationConfig,
  rememberAutomationKey,
  shouldAutomateText,
  waitForAiAutoSend,
} from "@/lib/ai-automation";
import { useAppStore, useLogStore } from "@/stores/app-store";
import {
  fallbackMessageText,
  messagePreviewText,
  numberField,
  persistChatMessages,
  persistChatSummaries,
  persistUnreadCounts,
  readChatMessages,
  readChatSummaries,
  readUnreadCounts,
  stringField,
} from "@/components/friends/friends-status-utils";
import type {
  ChatMessages,
  ChatSummaries,
  JsonRecord,
  LocalChatMessage,
  UnreadCounts,
} from "@/components/friends/friends-status-types";

export const GLOBAL_FRIEND_CHAT_UPDATED_EVENT = "dy-friend-chat-updated";
export const UNKNOWN_FRIEND_KEY_PREFIX = "uid:";
const RECENT_AUTO_REPLY_TTL_MS = 5 * 60_000;

type FriendChatUpdatedDetail = {
  currentSecUid: string;
  conversationKey: string;
  senderUid: string;
  message: LocalChatMessage;
};

function unknownFriendKey(senderUid: string) {
  return `${UNKNOWN_FRIEND_KEY_PREFIX}${senderUid}`;
}

function unreadTotal(unreadCounts: UnreadCounts) {
  return Object.values(unreadCounts).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function hasExistingMessage(messages: ChatMessages, message: LocalChatMessage) {
  return Object.values(messages).some((items) =>
    items.some((item) =>
      item.id === message.id ||
      (
        Boolean(message.text) &&
        item.senderUid === message.senderUid &&
        item.text === message.text &&
        Math.abs(item.createdAt - message.createdAt) < 60_000
      )
    )
  );
}

function dispatchFriendChatUpdated(detail: FriendChatUpdatedDetail) {
  window.dispatchEvent(new CustomEvent<FriendChatUpdatedDetail>(GLOBAL_FRIEND_CHAT_UPDATED_EVENT, { detail }));
}

function booleanField(record: JsonRecord, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "yes", "out", "outgoing"].includes(normalized)) return true;
      if (["0", "false", "no", "in", "incoming"].includes(normalized)) return false;
    }
  }
  return false;
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
  const createdAt = numberField(payload, ["created_at", "createdAt"]) || Date.now();
  const serverMessageId = stringField(payload, ["server_message_id", "message_id", "id"]);
  const message: LocalChatMessage = {
    id: serverMessageId || `${conversationKey}-${createdAt}`,
    text,
    rawContent,
    createdAt,
    status: "sent",
    direction: "in",
    senderUid,
  };

  const chatMessages = readChatMessages(currentSecUid);
  if (hasExistingMessage(chatMessages, message)) {
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
  persistChatSummaries(nextSummaries, currentSecUid);
  persistUnreadCounts(nextUnreadCounts, currentSecUid);
  void saveFriendChatState({ summaries: nextSummaries, unreadCounts: nextUnreadCounts }, currentSecUid).catch(() => undefined);
  useAppStore.getState().setFriendUnreadCount(unreadTotal(nextUnreadCounts));
  dispatchFriendChatUpdated({ currentSecUid, conversationKey, senderUid, message });

  return { conversationKey, senderUid, message, nextMessages };
}

async function maybeAutoReply(
  senderUid: string,
  incoming: LocalChatMessage,
  recentMessages: LocalChatMessage[],
  repliedKeys: Set<string>,
  recentOutgoingTexts: Map<string, number>,
) {
  const key = incoming.id || `${senderUid}-${incoming.createdAt}-${incoming.text}`;
  if (!key || repliedKeys.has(key)) return;
  const logger = useLogStore.getState();

  try {
    const config = await readAiAutomationConfig();
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
    const incomingText = incoming.text || incoming.rawContent || "";
    if (!shouldAutomateText(incomingText, config, "private")) {
      logger.addLog("好友私信未触发自动回复：未命中过滤规则", "info");
      return;
    }
    if (!rememberAutomationKey(repliedKeys, key)) return;

    const displayName = `好友 ${senderUid.slice(-4)}`;
    logger.addLog(`好友私信触发自动回复：${displayName}`, "info");
    const context = recentMessages
      .slice(-8)
      .map((item) => `${item.direction === "in" ? displayName : "我"}：${item.text || item.rawContent || ""}`)
      .filter(Boolean)
      .join("\n")
      .replace(/\s+/g, " ")
      .slice(-900);
    const result = await suggestAiInteraction({
      target: "private_message",
      context,
      incoming_text: incomingText.slice(0, 360),
      author_name: displayName,
      tone: "warm",
      language: "zh-CN",
      max_suggestions: 3,
    });
    const suggestions = normalizeAiSuggestions(result);
    if (!result.actions?.send_private_message || suggestions.length === 0) {
      logger.addLog("好友私信 AI 未返回可发送回复", "warning");
      return;
    }
    await waitForAiAutoSend(getAiAutoSendDelayMs(result.auto_send_delay_ms));
    rememberRecentOutgoingText(recentOutgoingTexts, suggestions[0]);
    const sendResult = await sendFriendMessage({ toUserId: senderUid, content: suggestions[0] });
    if (!sendResult.success) {
      throw new Error(sendResult.message || "自动回复发送失败");
    }
    logger.addLog(`好友私信自动回复成功：${displayName}`, "success");
  } catch (error) {
    logger.addLog(error instanceof Error ? error.message : "好友私信自动回复失败", "warning");
  }
}

export function useGlobalFriendsIm() {
  const currentSecUidRef = useRef("");
  const currentUidRef = useRef("");
  const autoRepliedMessageIdsRef = useRef<Set<string>>(new Set());
  const recentOutgoingTextsRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    let disposed = false;
    const refreshCurrentAccount = async () => {
      try {
        const result = await getAccounts();
        if (!disposed && result.success) {
          currentSecUidRef.current = result.current_sec_uid || "";
          const currentAccount = result.accounts?.find((account) => account.sec_uid === result.current_sec_uid);
          currentUidRef.current = String(currentAccount?.uid || currentAccount?.user_id || "").trim();
          recentOutgoingTextsRef.current.clear();
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
    return () => {
      disposed = true;
      window.removeEventListener("cookie-login-status", handleCookieStatus);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenEvent<JsonRecord>("im-message", (payload) => {
      if (disposed || !payload || typeof payload !== "object") return;
      const currentSecUid = currentSecUidRef.current;
      if (!currentSecUid) {
        return;
      }
      const senderUid = stringField(payload, ["sender_uid", "senderUid"]);
      const currentUid = stringField(payload, ["current_uid", "currentUid"]);
      if (!currentUidRef.current && currentUid) {
        currentUidRef.current = currentUid;
      }
      const rawContent = stringField(payload, ["raw_content", "rawContent"]) || undefined;
      const text = stringField(payload, ["content", "text"]) || fallbackMessageText(rawContent);
      const isOutgoing =
        booleanField(payload, ["is_outgoing", "isOutgoing", "from_self", "fromSelf"]) ||
        stringField(payload, ["direction"]) === "out" ||
        Boolean(senderUid && currentUidRef.current && senderUid === currentUidRef.current) ||
        wasRecentlyAutoSent(recentOutgoingTextsRef.current, text);
      if (isOutgoing) {
        useLogStore.getState().addLog("好友私信回流已忽略：检测到自己发送的消息，已阻止自动回复循环", "info");
        return;
      }
      const result = persistIncomingMessage(currentSecUid, payload);
      if (!result) return;
      const preview = messagePreviewText(result.message) || result.message.text;
      useToastStore.getState().toast(preview ? `收到新私信：${preview}` : "收到新私信", "info", "好友私信");
      void maybeAutoReply(
        result.senderUid,
        result.message,
        result.nextMessages[result.conversationKey] || [result.message],
        autoRepliedMessageIdsRef.current,
        recentOutgoingTextsRef.current,
      );
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
