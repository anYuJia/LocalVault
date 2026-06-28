import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Clock3, Loader2, Search, ShieldCheck, Trash2, Users, X, Link2 } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CompletionInput, type CompletionInputOption } from "@/components/ui/completion-input";
import { useAlertStore, useAppStore } from "@/stores/app-store";
import { useSearchStore } from "@/stores/search-store";
import { LinkView } from "../link/link-view";
import {
  clearRecentSearchUsers,
  loadRecentSearches,
  loadRecentSearchUsers,
  removeRecentSearchUser,
  saveRecentSearch,
  type RecentSearch,
  type RecentSearchUser,
} from "@/lib/recent-searches";
import type { UserInfo } from "@/lib/tauri";
import { cn, formatNumber } from "@/lib/utils";
import { UserAvatar } from "./user-detail";

const HISTORY_PAGE_SIZE = 8;
const SEARCH_COMPLETION_LIMIT = 6;

interface SearchCompletion extends CompletionInputOption {
  key: string;
  label: string;
  subtitle: string;
  user?: UserInfo;
  timestamp?: number;
}

export function SearchView() {
  const query = useSearchStore((s) => s.query);
  const searching = useSearchStore((s) => s.searching);
  const users = useSearchStore((s) => s.users);
  const error = useSearchStore((s) => s.error);
  const pendingVerifySearch = useSearchStore((s) => s.pendingVerifySearch);
  const search = useSearchStore((s) => s.search);
  const resumeVerifySearch = useSearchStore((s) => s.resumeVerifySearch);
  const dismissVerifySearch = useSearchStore((s) => s.dismissVerifySearch);
  const openUser = useSearchStore((s) => s.openUser);
  const showAlert = useAlertStore((s) => s.showAlert);
  const [inputValue, setInputValue] = useState(query);
  const [history, setHistory] = useState<RecentSearchUser[]>([]);
  const [recentKeywords, setRecentKeywords] = useState<RecentSearch[]>([]);
  const [historyPage, setHistoryPage] = useState(1);

  const totalHistoryPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, totalHistoryPages);
  const pagedHistory = useMemo(() => {
    const start = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
    return history.slice(start, start + HISTORY_PAGE_SIZE);
  }, [history, safeHistoryPage]);

  const syncHistory = () => {
    setHistory(loadRecentSearchUsers());
    setRecentKeywords(loadRecentSearches());
  };

  useEffect(() => {
    syncHistory();
  }, []);

  useEffect(() => {
    if (historyPage > totalHistoryPages) {
      setHistoryPage(totalHistoryPages);
    }
  }, [historyPage, totalHistoryPages]);

  const handleSearch = async () => {
    const keyword = inputValue.trim();
    if (!keyword || searching) return;
    setRecentKeywords(saveRecentSearch(keyword));
    await search(keyword);
    syncHistory();
  };

  const handleResumeVerifySearch = async () => {
    if (!pendingVerifySearch || searching) return;
    setInputValue(pendingVerifySearch.keyword);
    setRecentKeywords(saveRecentSearch(pendingVerifySearch.keyword));
    await resumeVerifySearch();
    syncHistory();
  };

  const handleOpenUser = async (user: UserInfo) => {
    await openUser(user);
    syncHistory();
  };

  const handleRemoveHistory = (key: string) => {
    setHistory(removeRecentSearchUser(key));
  };

  const handleClearHistory = () => {
    showAlert({
      title: "清空历史搜索？",
      variant: "warning",
      description: "会删除搜索用户页面中的全部历史用户记录，但不会影响已下载文件。",
      actionLabel: "全部删除",
      cancelLabel: "取消",
      onAction: () => {
        clearRecentSearchUsers();
        setHistory([]);
        setHistoryPage(1);
      },
    });
  };

  const completions = useMemo(() => {
    const keyword = inputValue.trim().toLowerCase();
    if (!keyword) return [];

    const seen = new Set<string>();
    const userCompletions: SearchCompletion[] = history
      .filter((entry) => userMatchesKeyword(entry.user, keyword))
      .map((entry) => ({
        key: `user:${entry.key}`,
        label: entry.user.nickname || entry.user.unique_id || "未命名用户",
        subtitle: [
          entry.user.unique_id || entry.user.sec_uid || entry.user.uid || "unknown",
          entry.user.follower_count ? `${formatNumber(entry.user.follower_count)} 粉丝` : "",
        ].filter(Boolean).join(" · "),
        user: entry.user,
        timestamp: entry.lastSearchedAt,
      }));

    const keywordCompletions: SearchCompletion[] = recentKeywords
      .filter((entry) => entry.text.toLowerCase().includes(keyword))
      .map((entry) => ({
        key: `keyword:${entry.text}`,
        label: entry.text,
        subtitle: "历史搜索",
        timestamp: entry.timestamp,
      }));

    return [...userCompletions, ...keywordCompletions].filter((entry) => {
      const dedupeKey = `${entry.user ? "user" : "keyword"}:${entry.label.toLowerCase()}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    }).slice(0, SEARCH_COMPLETION_LIMIT);
  }, [history, inputValue, recentKeywords]);

  const handleCompletion = async (completion: SearchCompletion) => {
    setInputValue(completion.label);

    if (completion.user) {
      await handleOpenUser(completion.user);
      return;
    }

    setRecentKeywords(saveRecentSearch(completion.label));
    await search(completion.label);
    syncHistory();
  };

  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const currentTab = currentView === "link" ? "link" : "search";

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
      {/* Tabs Selector */}
      <div className="flex items-center gap-1.5 p-1 bg-surface-solid border border-border rounded-[12px] self-start mb-2">
        <button
          onClick={() => setView("search")}
          className={cn(
            "relative flex items-center gap-2 px-4 py-2 rounded-[8px] text-[0.8rem] font-semibold transition-all cursor-pointer",
            currentTab === "search" ? "text-accent" : "text-text-muted hover:text-text"
          )}
        >
          {currentTab === "search" && (
            <motion.div
              layoutId="search-tab-active"
              className="absolute inset-0 bg-accent/10 rounded-[8px]"
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            />
          )}
          <Users className="w-3.5 h-3.5 shrink-0 relative z-10" />
          <span className="relative z-10">搜索用户</span>
        </button>

        <button
          onClick={() => setView("link")}
          className={cn(
            "relative flex items-center gap-2 px-4 py-2 rounded-[8px] text-[0.8rem] font-semibold transition-all cursor-pointer",
            currentTab === "link" ? "text-accent" : "text-text-muted hover:text-text"
          )}
        >
          {currentTab === "link" && (
            <motion.div
              layoutId="search-tab-active"
              className="absolute inset-0 bg-accent/10 rounded-[8px]"
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
            />
          )}
          <Link2 className="w-3.5 h-3.5 shrink-0 relative z-10" />
          <span className="relative z-10">解析链接</span>
        </button>
      </div>

      {currentTab === "link" ? (
        <LinkView />
      ) : (
        <>
          <section className="rounded-[20px] bg-surface-solid/78 p-5 shadow-[0_18px_52px_rgba(0,0,0,0.16),inset_0_0_0_1px_rgba(255,255,255,0.04)]">
            <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-accent" />
                <h3 className="text-[0.95rem] font-semibold text-text">搜索用户</h3>
              </div>
              {users.length > 0 && <Badge variant="secondary">{users.length} 个候选用户</Badge>}
            </div>

            <div className="flex items-start gap-2">
              <CompletionInput
                value={inputValue}
                onValueChange={setInputValue}
                options={completions}
                listId="search-user-completions"
                placeholder="输入用户名、抖音号或 UID"
                optionActiveClassName="bg-accent/10"
                valueActiveClassName="bg-accent/[0.07]"
                onSubmit={() => void handleSearch()}
                onSelect={(completion) => void handleCompletion(completion)}
                onFocusInput={syncHistory}
                leading={({ hasValue }) => (
                  <div className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] text-text-muted transition-[background-color,color]",
                    hasValue && "bg-accent/15 text-accent"
                  )}>
                    <Search className="h-4 w-4" />
                  </div>
                )}
                renderOption={(completion, { active }) => (
                  <>
                    {completion.user ? (
                      <UserAvatar user={completion.user} className="h-9 w-9 shadow-[0_6px_18px_rgba(0,0,0,0.18)]" />
                    ) : (
                      <div className={cn(
                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-white/[0.05] text-text-muted group-hover:bg-accent/10 group-hover:text-accent",
                        active && "bg-accent/10 text-accent"
                      )}>
                        <Clock3 className="h-4 w-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.84rem] font-semibold text-text">
                        {completion.label}
                      </div>
                      <div className="truncate text-[0.68rem] text-text-muted">
                        {completion.subtitle}
                      </div>
                    </div>
                    <ArrowUpRight className={cn(
                      "h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-[opacity,color,transform] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-accent group-hover:opacity-100",
                      active && "translate-x-0.5 -translate-y-0.5 text-accent opacity-100"
                    )} />
                  </>
                )}
              />

              <Button onClick={() => void handleSearch()} disabled={searching || !inputValue.trim()} className="h-12 px-5">
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                搜索
              </Button>
            </div>

            {pendingVerifySearch && (
              <div className="mt-3 flex flex-col gap-3 rounded-[16px] bg-warning-soft px-3.5 py-3 text-warning shadow-[inset_0_0_0_1px_rgba(245,158,11,0.22)] sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-warning/15">
                    <ShieldCheck className="h-4.5 w-4.5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[0.82rem] font-semibold text-text">完成验证后继续搜索</div>
                    <div className="mt-0.5 truncate text-[0.74rem] text-text-secondary">
                      {pendingVerifySearch.message}，将继续搜索“{pendingVerifySearch.keyword}”
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                  <Button
                    size="sm"
                    variant="success-outline"
                    disabled={searching}
                    onClick={() => void handleResumeVerifySearch()}
                  >
                    {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    已完成验证
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="关闭验证提示"
                    onClick={dismissVerifySearch}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}

            {error && !pendingVerifySearch && (
              <div className="mt-3 rounded-[12px] border border-white/[0.06] bg-danger-soft px-3 py-2 text-[0.78rem] text-danger">
                {error}
              </div>
            )}
          </section>

          {users.length > 0 && (
            <section>
              <div className="mb-3 flex items-center gap-2">
                <Users className="h-4 w-4 text-info" />
                <h3 className="text-[0.9rem] font-semibold text-text">搜索结果</h3>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {users.map((user, index) => (
                  <UserSearchCard
                    key={user.sec_uid || `${user.nickname}-${index}`}
                    user={user}
                    onOpen={() => void handleOpenUser(user)}
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-success" />
                <h3 className="text-[0.9rem] font-semibold text-text">历史搜索用户</h3>
                <Badge variant="outline">{history.length} 个</Badge>
              </div>
              {history.length > 0 && (
                <Button variant="outline" size="sm" onClick={handleClearHistory}>
                  <Trash2 className="h-3.5 w-3.5" />
                  全部删除
                </Button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="rounded-[18px] border border-dashed border-border bg-surface-solid/45 p-8 text-center text-[0.82rem] text-text-muted">
                暂无历史搜索用户
              </div>
            ) : (
              <>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                  {pagedHistory.map((entry) => (
                    <UserSearchCard
                      key={entry.key}
                      user={entry.user}
                      timestamp={entry.lastSearchedAt}
                      onOpen={() => void handleOpenUser(entry.user)}
                      onRemove={() => handleRemoveHistory(entry.key)}
                    />
                  ))}
                </div>

                {totalHistoryPages > 1 && (
                  <div className="mt-4 flex items-center justify-center gap-2">
                    <Button
                      variant="outline"
                      size="icon-sm"
                      disabled={safeHistoryPage <= 1}
                      onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon-sm"
                      disabled={safeHistoryPage >= totalHistoryPages}
                      onClick={() => setHistoryPage((page) => Math.min(totalHistoryPages, page + 1))}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function userMatchesKeyword(user: UserInfo, keyword: string): boolean {
  return [
    user.nickname,
    user.unique_id,
    user.sec_uid,
    user.uid,
    user.signature,
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword));
}

function UserSearchCard({
  user,
  timestamp,
  onOpen,
  onRemove,
}: {
  user: UserInfo;
  timestamp?: number;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  const stats = [
    { label: "作品", value: user.aweme_count || 0 },
    { label: "关注", value: user.following_count || 0 },
    { label: "粉丝", value: user.follower_count || 0 },
    { label: "获赞", value: user.total_favorited || 0 },
  ];
  const timeLabel = timestamp
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(timestamp)
    : "";

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="group min-w-0 cursor-pointer rounded-[18px] border border-border bg-surface-solid/78 p-4 transition-[background-color,border-color,box-shadow,transform] hover:border-border-strong hover:bg-surface-raised hover:shadow-md active:scale-[0.99]"
    >
      <div className="mb-3 flex items-start gap-3">
        <UserAvatar user={user} className="h-12 w-12 border border-border shadow-[0_8px_22px_rgba(0,0,0,0.18)]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[0.9rem] font-semibold text-text">{user.nickname || "未命名用户"}</div>
            {timeLabel && <span className="shrink-0 text-[0.68rem] text-text-muted">{timeLabel}</span>}
          </div>
          <div className="truncate text-[0.72rem] text-text-muted">@{user.unique_id || user.sec_uid || user.uid || "unknown"}</div>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-text-muted opacity-70 transition-[background-color,color,opacity] hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
            aria-label="删除历史记录"
            title="删除历史记录"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            <div className="truncate text-[0.84rem] font-semibold tabular-nums text-text">{formatNumber(stat.value)}</div>
            <div className="mt-0.5 text-[0.65rem] text-text-muted">{stat.label}</div>
          </div>
        ))}
      </div>

      <p className="min-h-[38px] text-[0.76rem] leading-relaxed text-text-secondary line-clamp-2">
        {user.signature || "这个用户还没有填写简介"}
      </p>
    </motion.div>
  );
}
