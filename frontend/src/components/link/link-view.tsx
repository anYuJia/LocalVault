import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  FileVideo,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CompletionInput, type CompletionInputOption } from "@/components/ui/completion-input";
import { VideoCard, VIDEO_CARD_GRID_CLASS } from "@/components/search/video-card";
import { VideoDetailModal } from "@/components/modals/video-detail";
import { FullscreenPlayer } from "@/components/player/lazy-fullscreen-player";
import { useDownloads } from "@/hooks/use-downloads";
import { useAlertStore } from "@/stores/app-store";
import { useLinkStore } from "@/stores/link-store";
import { useSearchStore } from "@/stores/search-store";
import {
  clearRecentParsedLinks,
  loadRecentParsedLinks,
  removeRecentParsedLink,
  type RecentParsedLink,
} from "@/lib/recent-searches";
import { mediaProxyUrl, type UserInfo, type VideoInfo } from "@/lib/tauri";
import { videoAuthorToUserInfo } from "@/lib/video-author";
import { cn, formatNumber } from "@/lib/utils";

const HISTORY_PAGE_SIZE = 8;
const LINK_COMPLETION_LIMIT = 6;

type LinkCompletion = RecentParsedLink & CompletionInputOption;

export function LinkView() {
  const link = useLinkStore((s) => s.link);
  const parsing = useLinkStore((s) => s.parsing);
  const videos = useLinkStore((s) => s.videos);
  const user = useLinkStore((s) => s.user);
  const error = useLinkStore((s) => s.error);
  const parse = useLinkStore((s) => s.parse);
  const clear = useLinkStore((s) => s.clear);
  const showAlert = useAlertStore((s) => s.showAlert);
  const openUser = useSearchStore((s) => s.openUser);
  const { downloadVideo, downloadBatch } = useDownloads();
  const [inputValue, setInputValue] = useState(link);
  const [history, setHistory] = useState<RecentParsedLink[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [detailVideo, setDetailVideo] = useState<VideoInfo | null>(null);
  const [playerIndex, setPlayerIndex] = useState<number | null>(null);
  const [authorLoadingId, setAuthorLoadingId] = useState<string | null>(null);

  const totalHistoryPages = Math.max(1, Math.ceil(history.length / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, totalHistoryPages);
  const pagedHistory = useMemo(() => {
    const start = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
    return history.slice(start, start + HISTORY_PAGE_SIZE);
  }, [history, safeHistoryPage]);

  const syncHistory = () => {
    setHistory(loadRecentParsedLinks());
  };

  useEffect(() => {
    syncHistory();
  }, []);

  useEffect(() => {
    setInputValue(link);
  }, [link]);

  useEffect(() => {
    if (historyPage > totalHistoryPages) {
      setHistoryPage(totalHistoryPages);
    }
  }, [historyPage, totalHistoryPages]);

  const completions = useMemo<LinkCompletion[]>(() => {
    const keyword = inputValue.trim().toLowerCase();
    if (!keyword) return [];
    return history
      .filter((entry) => linkMatchesKeyword(entry, keyword))
      .slice(0, LINK_COMPLETION_LIMIT);
  }, [history, inputValue]);

  const hasResult = videos.length > 0 || Boolean(user);

  const handleParse = async (value = inputValue) => {
    const target = value.trim();
    if (!target || parsing) return;
    setInputValue(target);
    await parse(target);
    syncHistory();
  };

  const handleClearInput = () => {
    setInputValue("");
    clear();
  };

  const handleRemoveHistory = (key: string) => {
    setHistory(removeRecentParsedLink(key));
  };

  const handleClearHistory = () => {
    showAlert({
      title: "清空最近解析？",
      variant: "warning",
      description: "会删除解析链接页面中的全部历史记录，不会删除下载文件。",
      actionLabel: "全部删除",
      cancelLabel: "取消",
      onAction: () => {
        clearRecentParsedLinks();
        setHistory([]);
        setHistoryPage(1);
      },
    });
  };

  const openPlayer = (video: VideoInfo) => {
    const index = videos.findIndex((item) => item.aweme_id === video.aweme_id);
    setPlayerIndex(index >= 0 ? index : 0);
  };

  const openAuthor = async (video: VideoInfo) => {
    const userInfo = videoAuthorToUserInfo(video);
    if (!userInfo || authorLoadingId) return;
    setAuthorLoadingId(video.aweme_id);
    try {
      await openUser(userInfo);
    } finally {
      setAuthorLoadingId(null);
    }
  };

  return (
    <>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
        <section className="rounded-[20px] bg-surface-solid/78 p-5 shadow-[0_18px_52px_rgba(0,0,0,0.16),inset_0_0_0_1px_rgba(255,255,255,0.04)]">
          <div className="mb-4 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Link2 className="h-4 w-4 text-info" />
              <h3 className="text-[0.95rem] font-semibold text-text">解析链接</h3>
              {videos.length > 0 && <Badge variant="secondary">{videos.length} 个作品</Badge>}
              {user && <Badge variant="info">解析到用户</Badge>}
            </div>
            {videos.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void downloadBatch(videos, user?.nickname || "链接解析")}>
                <Download className="h-3.5 w-3.5" />
                下载全部
              </Button>
            )}
          </div>

          <div className="flex items-start gap-2">
            <CompletionInput
              autoFocus
              value={inputValue}
              onValueChange={setInputValue}
              options={completions}
              listId="parse-link-completions"
              placeholder="粘贴抖音分享文案、短链接或完整视频 URL"
              optionActiveClassName="bg-info/10"
              valueActiveClassName="bg-info/[0.07]"
              onSubmit={() => void handleParse()}
              onSelect={(entry) => void handleParse(entry.link)}
              onFocusInput={syncHistory}
              leading={({ hasValue }) => (
                <div
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white/[0.06] text-text-muted transition-[background-color,color]",
                    hasValue && "bg-info/15 text-info"
                  )}
                >
                  <Link2 className="h-4 w-4" />
                </div>
              )}
              trailing={inputValue ? (
                <button
                  type="button"
                  onClick={handleClearInput}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-text-muted transition-[background-color,color] hover:bg-surface-raised hover:text-text"
                  title="清空"
                  aria-label="清空"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
              renderOption={(entry, { active }) => (
                <>
                  <RecentLinkThumb entry={entry} className="h-9 w-9 rounded-[11px]" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[0.84rem] font-semibold text-text">{entry.title}</div>
                    <div className="truncate text-[0.68rem] text-text-muted">{entry.subtitle || entry.link}</div>
                  </div>
                  <ArrowUpRight className={cn(
                    "h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-[opacity,color,transform] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-info group-hover:opacity-100",
                    active && "translate-x-0.5 -translate-y-0.5 text-info opacity-100"
                  )} />
                </>
              )}
            />

            <Button onClick={() => void handleParse()} disabled={parsing || !inputValue.trim()} className="h-12 px-5">
              {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {parsing ? "解析中" : "解析"}
            </Button>
          </div>

          {link && (
            <div className="mt-3 truncate text-[0.72rem] text-text-muted">
              当前链接：{link}
            </div>
          )}

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded-[12px] border border-white/[0.06] bg-danger-soft px-3 py-2 text-[0.78rem] text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </section>

        {user && (
          <ParsedUserPanel user={user} onOpen={() => void openUser(user)} />
        )}

        {parsing && !hasResult ? (
          <section className="flex flex-col items-center justify-center rounded-[18px] border border-border bg-surface-solid/60 py-16 text-center">
            <Loader2 className="mb-4 h-8 w-8 animate-spin text-info" />
            <p className="text-[0.9rem] text-text-secondary">正在解析链接...</p>
            <p className="mt-1 text-[0.76rem] text-text-muted">短链会先跟随跳转，再读取作品详情。</p>
          </section>
        ) : videos.length > 0 ? (
          <section>
            <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <FileVideo className="h-4 w-4 text-accent" />
                <h3 className="text-[0.9rem] font-semibold text-text">解析结果</h3>
                <Badge variant="outline">{videos.length} 个作品</Badge>
              </div>
            </div>
            <div className={VIDEO_CARD_GRID_CLASS}>
              {videos.map((video, index) => (
                <VideoCard
                  key={video.aweme_id || `${video.desc}-${index}`}
                  video={video}
                  index={index}
                  onSelect={openPlayer}
                  onDetail={setDetailVideo}
                  onDownload={(item) => void downloadVideo(item)}
                  onAuthor={(item) => void openAuthor(item)}
                  authorLoading={authorLoadingId === video.aweme_id}
                />
              ))}
            </div>
          </section>
        ) : !error && !hasResult && (
          <section className="rounded-[18px] border border-dashed border-border bg-surface-solid/45 p-8 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[18px] bg-info/10">
              <Link2 className="h-6 w-6 text-info" />
            </div>
            <p className="text-[0.9rem] font-semibold text-text">等待链接</p>
            <p className="mx-auto mt-1 max-w-[420px] text-[0.78rem] leading-relaxed text-text-muted">
              支持分享短链、视频链接、图集和复制出来的整段分享文案。解析完成后可以播放、查看详情或下载。
            </p>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-success" />
              <h3 className="text-[0.9rem] font-semibold text-text">最近解析</h3>
              <Badge variant="outline">{history.length} 条</Badge>
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
              成功解析过的链接会显示在这里，可以再次点击解析或删除记录。
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
                {pagedHistory.map((entry) => (
                  <RecentLinkCard
                    key={entry.key}
                    entry={entry}
                    onParse={() => void handleParse(entry.link)}
                    onRemove={() => handleRemoveHistory(entry.key)}
                  />
                ))}
              </div>
              {totalHistoryPages > 1 && (
                <div className="mt-4 flex items-center justify-end gap-2 text-[0.78rem] text-text-muted">
                  <span className="tabular-nums">{safeHistoryPage} / {totalHistoryPages}</span>
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
      </div>

      <FullscreenPlayer
        key={playerIndex ?? "closed"}
        videos={videos}
        initialIndex={playerIndex ?? 0}
        open={playerIndex !== null}
        onClose={() => setPlayerIndex(null)}
        onDownload={(video) => downloadVideo(video)}
        onShowDetail={(video) => {
          setPlayerIndex(null);
          setDetailVideo(video);
        }}
        onAuthor={(video) => {
          setPlayerIndex(null);
          void openAuthor(video);
        }}
      />

      <VideoDetailModal
        video={detailVideo}
        open={Boolean(detailVideo)}
        onOpenChange={(open) => {
          if (!open) setDetailVideo(null);
        }}
        onDownload={(video) => downloadVideo(video)}
      />
    </>
  );
}

function ParsedUserPanel({ user, onOpen }: { user: UserInfo; onOpen: () => void }) {
  const avatar = user.avatar_thumb || user.avatar_medium || user.avatar_larger;
  const stats = [
    { label: "作品", value: user.aweme_count || 0 },
    { label: "关注", value: user.following_count || 0 },
    { label: "粉丝", value: user.follower_count || 0 },
    { label: "获赞", value: user.total_favorited || 0 },
  ];

  return (
    <section className="rounded-[18px] border border-border bg-surface-solid/72 p-4 shadow-[0_14px_38px_rgba(0,0,0,0.12)]">
      <div className="flex items-start gap-4">
        {avatar ? (
          <img
            src={mediaProxyUrl(avatar, "image")}
            alt={user.nickname || "用户头像"}
            className="h-14 w-14 shrink-0 rounded-full object-cover shadow-[0_8px_22px_rgba(0,0,0,0.18)]"
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-info/10 text-info">
            <UserRound className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
            <div className="truncate text-[0.95rem] font-semibold text-text">{user.nickname || "解析到用户"}</div>
          </div>
          <div className="truncate text-[0.72rem] text-text-muted">@{user.unique_id || user.sec_uid || user.uid || "unknown"}</div>
          {user.signature && (
            <p className="mt-2 line-clamp-2 text-[0.76rem] leading-relaxed text-text-secondary">{user.signature}</p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={onOpen} className="shrink-0">
          <UserRound className="h-3.5 w-3.5" />
          进入主页
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-[10px] bg-background-soft/70 px-2 py-2 text-center">
            <div className="truncate text-[0.78rem] font-semibold tabular-nums text-text">{formatNumber(stat.value)}</div>
            <div className="mt-0.5 text-[0.62rem] text-text-muted">{stat.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RecentLinkCard({
  entry,
  onParse,
  onRemove,
}: {
  entry: RecentParsedLink;
  onParse: () => void;
  onRemove: () => void;
}) {
  const timeLabel = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(entry.lastParsedAt);

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      role="button"
      tabIndex={0}
      onClick={onParse}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onParse();
        }
      }}
      className="group min-w-0 cursor-pointer rounded-[18px] border border-border bg-surface-solid/78 p-4 transition-[background-color,border-color,box-shadow,transform] hover:border-border-strong hover:bg-surface-raised hover:shadow-md active:scale-[0.99]"
    >
      <div className="mb-3 flex items-start gap-3">
        <RecentLinkThumb entry={entry} className="h-12 w-12 rounded-[14px]" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <div className="truncate text-[0.9rem] font-semibold text-text">{entry.title}</div>
            <span className="shrink-0 text-[0.68rem] text-text-muted">{timeLabel}</span>
          </div>
          <div className="truncate text-[0.72rem] text-text-muted">{entry.subtitle || entry.link}</div>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-text-muted opacity-70 transition-[background-color,color,opacity] hover:bg-danger-soft hover:text-danger group-hover:opacity-100"
          aria-label="删除解析记录"
          title="删除解析记录"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 truncate rounded-[10px] bg-background-soft/70 px-2.5 py-2 font-mono text-[0.66rem] text-text-muted">
        {entry.link}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Badge variant={entry.kind === "user" ? "info" : entry.kind === "video" ? "default" : "secondary"} size="sm">
          {formatLinkKind(entry)}
        </Badge>
        <span className="flex items-center gap-1 text-[0.7rem] font-semibold text-info">
          重新解析
          <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
    </motion.div>
  );
}

function RecentLinkThumb({ entry, className }: { entry: RecentParsedLink; className?: string }) {
  const cover = entry.cover ? mediaProxyUrl(entry.cover, "image") : "";

  if (cover) {
    return (
      <img
        src={cover}
        alt={entry.title}
        className={cn("shrink-0 object-cover shadow-[inset_0_0_0_1px_var(--image-outline)]", className)}
        loading="lazy"
      />
    );
  }

  return (
    <div className={cn("flex shrink-0 items-center justify-center bg-info/10 text-info", className)}>
      {entry.kind === "user" ? <UserRound className="h-5 w-5" /> : <Link2 className="h-5 w-5" />}
    </div>
  );
}

function linkMatchesKeyword(entry: RecentParsedLink, keyword: string): boolean {
  return [
    entry.title,
    entry.subtitle,
    entry.link,
    entry.userName,
  ].filter(Boolean).some((value) => String(value).toLowerCase().includes(keyword));
}

function formatLinkKind(entry: RecentParsedLink): string {
  if (entry.kind === "user") return "用户";
  if (entry.videoCount > 1) return `${entry.videoCount} 个作品`;
  if (entry.kind === "video") return "作品";
  if (entry.kind === "mixed") return "作品和用户";
  return "链接";
}
