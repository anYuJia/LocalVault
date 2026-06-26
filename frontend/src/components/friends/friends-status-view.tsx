import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Loader2, RefreshCw, Users, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FullscreenPlayer } from "@/components/player/fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import {
  getAccounts,
  getConfig,
  getFriendChatState,
  getFriendMessageHistory,
  getFriendOnlineStatus,
  getUserDetail,
  getVideoDetail,
  listenEvent,
  saveConfig,
  saveFriendChatState,
  sendFriendImageMessage,
  sendFriendMessage,
  verifyCookie,
  type FriendOnlineStatusResponse,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import type { FriendMessageHistoryItem, UserInfo, VideoInfo } from "@/lib/contracts";
import {
  COOKIE_REQUIRED_PATTERN,
  CURRENT_USER_AVATAR_KEY,
  DEFAULT_REFRESH_INTERVAL_SECONDS,
  MAX_SEND_IMAGE_BYTES,
  MIN_BACKGROUND_REFRESH_INTERVAL_MS,
  STORAGE_KEY,
  type ChatDrafts,
  type ChatMessages,
  type ChatSummaries,
  type FriendListItem,
  type FriendStatusItem,
  type HistoryPageState,
  type ImConnectionStatus,
  type JsonRecord,
  type LocalChatMessage,
  type SharedMessageCard,
  type UnreadCounts,
} from "./friends-status-types";
import {
  extractIds,
  fallbackMessageText,
  formatUpdateTime,
  imageMessageRawContent,
  isRecord,
  latestChatMessage,
  mapResponse,
  messagePreviewText,
  normalizeMessageDirection,
  normalizeMessageStatus,
  numberField,
  persistChatDrafts,
  persistChatMessages,
  persistChatSummaries,
  persistUnreadCounts,
  readChatDrafts,
  readChatMessages,
  readChatSummaries,
  readUnreadCounts,
  readFileAsDataUrl,
  readImageSize,
  stringField,
} from "./friends-status-utils";
import { ChatWorkspace, FriendRow, Metric } from "./friends-status-components";

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

