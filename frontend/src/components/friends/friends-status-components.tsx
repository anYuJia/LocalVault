import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ElementType,
  type KeyboardEvent,
} from "react";
import { ImagePlus, Loader2, MapPin, MessageCircle, Play, Send, ShoppingBag, UserRound, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeLogo } from "@/components/common/theme-logo";
import { Textarea } from "@/components/ui/textarea";
import { mediaProxyUrl } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  MAX_SEND_IMAGE_BYTES,
  type FriendListItem,
  type FriendStatusItem,
  type LocalChatMessage,
  type PendingImageAttachment,
  type SharedMessageCard,
} from "./friends-status-types";
import {
  centerNoticeText,
  formatMessageDividerTime,
  formatMessageTime,
  friendDisplayName,
  hasFramedMessageBody,
  isSameMessageDate,
  parseSharedMessage,
  unsignedMediaUrl,
} from "./friends-status-utils";

export function Metric({
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

export function FriendRow({
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

export function ChatWorkspace({
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
