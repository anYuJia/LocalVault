import { useEffect, useRef } from "react";
import { Loader2, Users, Wifi, WifiOff } from "lucide-react";
import type { FriendListItem, FriendStatusItem } from "./friends-status-types";
import { FriendRow, Metric } from "./friends-status-components";

interface FriendListPanelProps {
  friends: FriendStatusItem[];
  friendItems: FriendListItem[];
  selectedFriendId: string;
  onlineCount: number;
  offlineCount: number;
  isInitialLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  idsLength: number;
  selectFriend: (friend: FriendStatusItem) => void;
  openFriendProfile: (friend: FriendStatusItem) => Promise<void>;
  onLoadMore: () => void;
}

export function FriendListPanel({ friends, friendItems, selectedFriendId, onlineCount, offlineCount, isInitialLoading, isLoadingMore, hasMore, idsLength, selectFriend, openFriendProfile, onLoadMore }: FriendListPanelProps) {
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const triggerIndex = Math.max(0, friendItems.length - 10);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) onLoadMore();
      },
      { root: target.closest("[data-friend-scroll]"), rootMargin: "160px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [friendItems.length, hasMore, onLoadMore]);

  return (
    <section className="flex min-h-0 flex-col rounded-[var(--radius-lg)] border border-border bg-surface-solid/70 p-3 shadow-[var(--shadow-sm)]">
      <div className="mb-3 flex items-center justify-between shrink-0 px-0.5">
        <span className="text-[0.76rem] font-bold text-text-secondary tracking-wide">联系人列表</span>
        <div className="flex gap-1.5">
          <span className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-border bg-surface-solid px-2 py-0.5 text-[0.66rem] font-medium text-text-muted">
            全部 {friends.length || idsLength}
          </span>
          <span className="flex items-center gap-1 rounded-[var(--radius-sm)] border border-success/20 bg-success-soft px-2 py-0.5 text-[0.66rem] font-medium text-success">
            在线 {onlineCount}
          </span>
        </div>
      </div>
      {isInitialLoading ? (
        <div className="flex min-h-[280px] items-center justify-center text-[0.82rem] text-text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />正在查询</div>
      ) : friendItems.length === 0 ? (
        <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-[16px] border border-border bg-surface"><Users className="h-5 w-5 text-text-muted" /></div>
          <p className="text-[0.86rem] text-text-secondary">等待查询</p>
          <p className="mt-1 text-[0.75rem] text-text-muted">点刷新自动获取；若没有返回列表，可展开备用输入缓存一次</p>
        </div>
      ) : (
        <div data-friend-scroll className="grid min-h-0 flex-1 content-start gap-1.5 overflow-y-auto pr-1">
          {friendItems.map((friend, index) => (
            <div key={friend.secUid} ref={hasMore && index === triggerIndex ? loadMoreRef : undefined}>
              <FriendRow friend={friend} selected={friend.secUid === selectedFriendId} onSelect={selectFriend} onOpenProfile={openFriendProfile} />
            </div>
          ))}
          {isLoadingMore && (
            <div className="flex items-center justify-center py-2 text-[0.72rem] text-text-muted">
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              正在加载更多联系人
            </div>
          )}
        </div>
      )}
    </section>
  );
}
