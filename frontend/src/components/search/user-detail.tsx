import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  Copy,
  Download,
  Loader2,
  Search,
  Sparkles,
  User,
  UserCheck,
  UserPlus,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore, useDownloadStore, useLogStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import { useToastStore } from "@/components/ui/toast";
import { downloadUserVideos, mediaProxyUrl, setUserFollowed, type UserInfo } from "@/lib/tauri";
import { formatNumber } from "@/lib/utils";

export function UserDetail() {
  const query = useSearchStore((s) => s.query);
  const searching = useSearchStore((s) => s.searching);
  const loadingUser = useSearchStore((s) => s.loadingUser);
  const currentUser = useSearchStore((s) => s.currentUser);
  const users = useSearchStore((s) => s.users);
  const error = useSearchStore((s) => s.error);
  const openUser = useSearchStore((s) => s.openUser);
  const loadVideos = useSearchStore((s) => s.loadVideos);
  const setView = useAppStore((s) => s.setView);
  const addLog = useLogStore((s) => s.addLog);
  const updateTask = useDownloadStore((s) => s.updateTask);
  const [downloadingAll, setDownloadingAll] = useState(false);

  const handleDownloadAll = async () => {
    if (!currentUser || downloadingAll) return;
    setDownloadingAll(true);

    try {
      const result = await downloadUserVideos(
        currentUser.sec_uid,
        currentUser.nickname,
        currentUser.aweme_count || 0
      );
      if (!result.success) {
        addLog(result.message || "批量下载启动失败", "error");
        return;
      }
      if (result.task_id) {
        const totalVideos = result.total_videos ?? currentUser.aweme_count ?? 0;
        updateTask({
          id: result.task_id,
          filename: `${result.nickname || currentUser.nickname || "用户"} 全部作品`,
          progress: 0,
          status: "downloading",
          isBatch: true,
          mediaCount: totalVideos,
          fileTotal: totalVideos,
          fileIndex: 0,
          startTime: Date.now(),
          speed: 0,
        });
      }
      addLog(result.message || `开始下载 ${currentUser.nickname} 的作品`, "success");
    } catch (error) {
      addLog(error instanceof Error ? error.message : "批量下载启动失败", "error");
    } finally {
      setDownloadingAll(false);
    }
  };

  if (searching && !currentUser && users.length === 0) {
    return (
      <motion.div
        initial={false}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-[18px] border border-border bg-surface-solid/80 p-8 mb-5"
      >
        <div className="flex items-center gap-3 text-text">
          <div className="w-11 h-11 rounded-[14px] bg-accent/10 flex items-center justify-center">
            <Loader2 className="w-5 h-5 text-accent animate-spin" />
          </div>
          <div>
            <div className="text-[0.92rem] font-semibold">正在搜索用户</div>
            <div className="text-[0.78rem] text-text-muted mt-0.5">
              {query ? `关键词：${query}` : "正在提交搜索请求..."}
            </div>
          </div>
        </div>
      </motion.div>
    );
  }

  if (currentUser) {
    return (
      <div className="mb-5">
        <UserDetailCard
          user={currentUser}
          busy={loadingUser || downloadingAll}
          onDownloadAll={handleDownloadAll}
          onViewVideos={loadVideos}
        />

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-[14px] border border-white/[0.06] bg-danger-soft px-4 py-3 text-[0.78rem] text-danger">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  if (users.length > 0) {
    return (
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-info" />
          <h3 className="text-[0.92rem] font-semibold text-text">搜索结果</h3>
          <span className="text-[0.74rem] text-text-muted">{users.length} 个候选用户</span>
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
          {users.map((user, index) => (
            <motion.div
              key={user.sec_uid || `${user.nickname}-${index}`}
              onClick={() => void openUser(user)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void openUser(user);
                }
              }}
              role="button"
              tabIndex={0}
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              className="group rounded-[18px] border border-border bg-surface-solid/80 p-4 text-left hover:border-border-strong hover:shadow-md active:scale-[0.99] transition-[transform,box-shadow,border-color,background-color] cursor-pointer"
            >
              <div className="flex items-center gap-3 mb-3">
                <UserAvatar
                  user={user}
                  className="w-12 h-12 border border-white/10 shadow-[0_8px_24px_rgba(0,0,0,0.24)]"
                />
                <div className="min-w-0">
                  <div className="text-[0.88rem] font-semibold text-text truncate">
                    {user.nickname}
                  </div>
                  <div className="text-[0.72rem] text-text-muted truncate">
                    @{user.unique_id || user.sec_uid}
                  </div>
                </div>
              </div>

              <div className="mt-3 mb-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
                {[
                  { label: "作品", value: user.aweme_count || 0 },
                  { label: "关注", value: user.following_count || 0 },
                  { label: "粉丝", value: user.follower_count || 0 },
                  { label: "获赞", value: user.total_favorited || 0 },
                ].map((stat) => (
                  <div key={stat.label} className="min-w-0">
                    <div className="truncate text-[0.84rem] font-semibold text-text tabular-nums">
                      {formatNumber(stat.value)}
                    </div>
                    <div className="mt-0.5 text-[0.65rem] text-text-muted">{stat.label}</div>
                  </div>
                ))}
              </div>

              <p className="text-[0.75rem] text-text-secondary line-clamp-2 leading-relaxed min-h-[38px]">
                {user.signature || "这个用户还没有填写简介"}
              </p>

              <div className="mt-3">
                <Button variant="info-outline" size="sm" className="w-full pointer-events-none">
                  选择这个用户
                </Button>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-5 rounded-[18px] border border-white/[0.06] bg-danger-soft p-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-[12px] bg-danger/10 flex items-center justify-center shrink-0">
            <AlertCircle className="w-4.5 h-4.5 text-danger" />
          </div>
          <div>
            <div className="text-[0.88rem] font-semibold text-danger">搜索失败</div>
            <div className="text-[0.78rem] text-text-secondary mt-1">{error}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      className="mb-5 rounded-[18px] border border-border bg-surface-solid/70 p-7"
    >
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-[16px] bg-accent/10 flex items-center justify-center shrink-0">
          {query ? (
            <Sparkles className="w-5 h-5 text-accent" />
          ) : (
            <Search className="w-5 h-5 text-accent" />
          )}
        </div>
        <div>
          <div className="text-[0.92rem] font-semibold text-text">
            还没有选择用户
          </div>
          <div className="text-[0.78rem] text-text-muted mt-1 leading-relaxed">
            请先在搜索用户页面选择一个用户，或从视频卡片进入作者主页。
          </div>
          <Button variant="default" size="sm" className="mt-4" onClick={() => setView("search")}>
            去搜索用户
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

interface UserDetailCardProps {
  user: UserInfo;
  busy?: boolean;
  onDownloadAll?: () => void;
  onViewVideos?: () => void;
}

export function UserDetailCard({ user, busy, onDownloadAll, onViewVideos }: UserDetailCardProps) {
  const addLog = useLogStore((s) => s.addLog);
  const toast = useToastStore.getState().toast;
  // follow_status: 0=未关注, 1=已关注(单向), 2=互相关注
  const [followStatus, setFollowStatus] = useState<number>(user.follow_status || (user.is_follow ? 1 : 0));
  const [followLoading, setFollowLoading] = useState(false);

  // Sync local state when user prop changes (e.g. switching users)
  useEffect(() => {
    setFollowStatus(user.follow_status || (user.is_follow ? 1 : 0));
  }, [user.uid, user.sec_uid, user.is_follow, user.follow_status]);

  const stats = [
    { label: "作品", value: user.aweme_count || 0 },
    { label: "粉丝", value: user.follower_count || 0 },
    { label: "关注", value: user.following_count || 0 },
    { label: "获赞", value: user.total_favorited || 0 },
  ];
  const displayUid = user.unique_id || user.short_id || user.sec_uid || user.uid || "";

  const copyDisplayUid = async () => {
    if (!displayUid) return;
    try {
      await navigator.clipboard.writeText(displayUid);
      toast("已复制抖音号", "success");
    } catch {
      addLog("复制抖音号失败", "error");
    }
  };

  const handleFollow = async () => {
    if (!user.uid || followLoading) return;
    const wasFollowing = followStatus > 0;
    const prevStatus = followStatus;
    const nextFollow = !wasFollowing;
    setFollowLoading(true);
    // Optimistic update
    setFollowStatus(nextFollow ? 1 : 0);
    try {
      const result = await setUserFollowed(user.uid, nextFollow);
      if (!result.success) {
        // Revert on failure
        setFollowStatus(prevStatus);
        addLog(result.message || "关注失败", "error");
        toast(result.message || "关注失败", "error");
        return;
      }
      // Use follow_status from API response (1=following, 2=mutual, 0=not following)
      const newStatus = nextFollow
        ? (result.follow_status ?? (prevStatus === 2 ? 2 : 1))
        : 0;
      setFollowStatus(newStatus);
      // Update store so the state persists across navigation
      const current = useSearchStore.getState().currentUser;
      if (current && (current.uid === user.uid || current.sec_uid === user.sec_uid)) {
        useSearchStore.setState({
          currentUser: {
            ...current,
            is_follow: nextFollow,
            follow_status: newStatus,
          },
        });
      }
      addLog(result.message || (nextFollow ? "关注成功" : "已取消关注"), "success");
    } catch (error) {
      setFollowStatus(prevStatus);
      const msg = error instanceof Error ? error.message : "关注失败";
      addLog(msg, "error");
      toast(msg, "error");
    } finally {
      setFollowLoading(false);
    }
  };

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 350, damping: 28 }}
      className="relative overflow-hidden rounded-[18px] border border-border bg-surface-solid/85 p-5 text-text shadow-[var(--shadow-md)]"
    >
      <div className="flex items-center gap-4 flex-wrap">
        <UserAvatar
          user={user}
          className="w-[76px] h-[76px] border-[3px] border-border-strong bg-background shadow-[0_10px_28px_rgba(0,0,0,0.22)]"
        />

        <div className="min-w-0 flex-1 sm:min-w-[220px]">
          <h3 className="text-[1.2rem] font-[780] tracking-tight text-text mb-1.5">
            {user.nickname}
          </h3>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-border bg-background-soft/70 pl-2.5 pr-1.5 py-1 text-[0.72rem] font-mono text-text-secondary">
              <span className="truncate">@{displayUid}</span>
              {displayUid && (
                <button
                  type="button"
                  onClick={() => void copyDisplayUid()}
                  title={`复制抖音号: ${displayUid}`}
                  className="shrink-0 rounded-full p-0.5 text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                >
                  <Copy className="w-3 h-3" />
                </button>
              )}
            </span>
            {user.uid && (
              <Button
                variant={followStatus > 0 ? "outline" : "default"}
                size="sm"
                disabled={followLoading || busy}
                onClick={handleFollow}
                className="h-7 gap-1.5 rounded-full px-3 text-[0.72rem] font-semibold"
              >
                {followLoading ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : followStatus === 2 ? (
                  <Users className="w-3.5 h-3.5" />
                ) : followStatus === 1 ? (
                  <UserCheck className="w-3.5 h-3.5" />
                ) : (
                  <UserPlus className="w-3.5 h-3.5" />
                )}
                {followStatus === 2 ? "互相关注" : followStatus === 1 ? "已关注" : "关注"}
              </Button>
            )}
          </div>
          {user.signature && (
            <p className="text-[0.8rem] text-text-secondary mt-2 line-clamp-2 leading-relaxed">
              {user.signature}
            </p>
          )}
        </div>

        <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:flex sm:items-center sm:gap-0">
          {stats.map((stat, index) => (
            <div key={stat.label} className="relative flex items-baseline justify-center gap-1.5 rounded-[12px] border border-border bg-background-soft/70 px-3 py-2 sm:border-0 sm:bg-transparent sm:px-4 sm:py-1">
              <span className="text-[1.15rem] font-[780] tracking-tight text-text tabular-nums">
                {formatNumber(stat.value)}
              </span>
              <span className="text-[0.75rem] font-medium text-text-muted">
                {stat.label}
              </span>
              {index < stats.length - 1 && (
                <div className="absolute right-0 top-[20%] bottom-[20%] hidden w-px bg-gradient-to-b from-transparent via-border to-transparent sm:block" />
              )}
            </div>
          ))}
        </div>
      </div>


    </motion.div>
  );
}

export function UserAvatar({ user, className }: { user: UserInfo; className?: string }) {
  const avatarCandidates = useMemo(() => {
    const rawUrls = [
      user.avatar_larger,
      user.avatar_medium,
      user.avatar_thumb,
    ].filter((url): url is string => Boolean(url && url.trim()));
    const uniqueRawUrls = Array.from(new Set(rawUrls));
    return [
      ...uniqueRawUrls,
      ...uniqueRawUrls.map((url) => mediaProxyUrl(url, "image")),
    ].filter(Boolean);
  }, [user.avatar_larger, user.avatar_medium, user.avatar_thumb]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const avatarUrl = avatarCandidates[sourceIndex] || "";
  const fallbackText = (user.nickname || user.unique_id || "?").trim().slice(0, 1).toUpperCase();

  useEffect(() => {
    setSourceIndex(0);
  }, [avatarCandidates]);

  return (
    <div
      className={`relative rounded-full overflow-hidden bg-gradient-to-br from-accent/18 to-info/14 flex items-center justify-center text-text shrink-0 ${className || ""}`}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={user.nickname}
          onError={() => setSourceIndex((index) => index + 1)}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="flex flex-col items-center justify-center gap-0.5">
          {fallbackText && fallbackText !== "?" ? (
            <span className="text-[1rem] font-bold leading-none">{fallbackText}</span>
          ) : (
            <User className="w-5 h-5 text-text-muted" />
          )}
        </div>
      )}
    </div>
  );
}
