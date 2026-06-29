import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Download,
  Music,
  Heart,
  MessageCircle,
  Share2,
  Link2,
  Copy,
  Check,
  Image as ImageIcon,
  PlayCircle,
  X,
} from "lucide-react";
import { cn, formatNumber, formatTime } from "@/lib/utils";
import { copyTextToClipboard, mediaProxyUrl, type VideoInfo } from "@/lib/tauri";
import {
  collectVideoMedia,
  getMediaProxyType,
  getVideoBgmUrl,
  getVideoCover,
  getVideoMediaLabel,
  isVideoLikeMedia,
} from "@/lib/video-media";

interface VideoDetailModalProps {
  video: VideoInfo | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDownload?: (video: VideoInfo) => void;
}

export function VideoDetailModal({ video, open, onOpenChange, onDownload }: VideoDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"cover" | "media">("cover");
  const [currentMediaIndex, setCurrentMediaIndex] = useState(0);
  const [copiedLinkType, setCopiedLinkType] = useState<string | null>(null);
  const [audioDownloading, setAudioDownloading] = useState(false);

  const musicUrl = video ? getVideoBgmUrl(video) : "";

  const downloadAudio = useCallback(async () => {
    if (!video || !musicUrl || !onDownload || audioDownloading) return;
    setAudioDownloading(true);
    try {
      await Promise.resolve(onDownload(buildAudioDownloadVideo(video, musicUrl)));
    } catch (error) {
      console.warn("Audio download failed", error);
    } finally {
      setAudioDownloading(false);
    }
  }, [audioDownloading, musicUrl, onDownload, video]);

  useEffect(() => {
    if (!video) return;
    setActiveTab("cover");
    setCurrentMediaIndex(0);
    setCopiedLinkType(null);
    setAudioDownloading(false);
  }, [video]);

  if (!video) return null;

  const mediaItems = collectVideoMedia(video);
  const currentMedia = mediaItems[currentMediaIndex] || mediaItems[0] || null;
  const coverRawUrl = getVideoCover(video);
  const coverUrl = mediaProxyUrl(coverRawUrl, "image");
  const hasMedia = mediaItems.length > 0;
  const stats = video.statistics;
  const author = video.author;
  const music = video.music;
  const mediaLabel = getVideoMediaLabel(video);

  const statItems = [
    { icon: Heart, label: "点赞", value: stats?.digg_count || 0, color: "text-accent" },
    { icon: MessageCircle, label: "评论", value: stats?.comment_count || 0, color: "text-cyan-400" },
    { icon: Share2, label: "分享", value: stats?.share_count || 0, color: "text-green-400" },
  ];

  const mediaLinks = uniqueDetailLinks([
    coverRawUrl && { label: "封面", url: coverRawUrl, type: "cover" },
    ...mediaItems.map((item, index) => ({
      label: `${mediaLabel} ${index + 1}`,
      url: item.url,
      type: `${item.type}-${index}`,
    })),
    musicUrl && { label: "BGM", url: musicUrl, type: "audio" },
  ]);
  const copyLink = (link: DetailLink) => {
    void copyTextToClipboard(link.url).then((success) => {
      if (!success) return;
      setCopiedLinkType(link.type);
      window.setTimeout(() => setCopiedLinkType((current) => (current === link.type ? null : current)), 1_200);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-0.75rem)] max-w-[880px] max-h-[calc(100vh-0.75rem)] p-0 overflow-hidden rounded-[var(--radius-xl)] border-white/[0.08] bg-background-soft">
        <div className="flex max-h-[calc(100vh-0.75rem)] min-w-0 flex-col overflow-hidden md:max-h-[85vh] md:flex-row">
          {/* Left Column: Media Preview */}
          <div className="flex min-h-[260px] min-w-0 flex-col items-center overflow-hidden border-b border-border bg-surface-solid/40 p-4 md:w-[44%] md:border-b-0 md:border-r md:p-4.5">
            {(coverUrl || hasMedia) && (
              <div className="mb-2.5 flex max-w-full flex-wrap justify-center gap-1">
                {coverUrl && (
                  <Button
                    variant={activeTab === "cover" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setActiveTab("cover")}
                    className="h-6.5 shrink-0 px-2.5 text-[0.68rem] rounded-[6px] gap-1"
                  >
                    <ImageIcon className="w-3 h-3" />
                    封面
                  </Button>
                )}
                {hasMedia && (
                  <Button
                    variant={activeTab === "media" ? "default" : "ghost"}
                    size="sm"
                    onClick={() => setActiveTab("media")}
                    className="h-6.5 shrink-0 px-2.5 text-[0.68rem] rounded-[6px] gap-1"
                  >
                    <PlayCircle className="w-3 h-3" />
                    媒体 ({mediaItems.length})
                  </Button>
                )}
              </div>
            )}

            <div className="flex w-full min-w-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-black/30 p-2 shadow-inner">
              {activeTab === "cover" && coverUrl ? (
                <img
                  src={coverUrl}
                  alt={video.desc}
                  className="max-h-[48vh] max-w-full rounded-lg object-contain md:max-h-[58vh]"
                />
              ) : currentMedia ? (
                <div className="relative flex h-full w-full min-w-0 items-center justify-center overflow-hidden">
                  {isVideoLikeMedia(currentMedia) ? (
                    <video
                      src={mediaProxyUrl(currentMedia.url, getMediaProxyType(currentMedia))}
                      poster={mediaProxyUrl(currentMedia.poster || coverRawUrl, "image")}
                      controls
                      playsInline
                      className="max-h-[48vh] max-w-full rounded-lg md:max-h-[58vh]"
                    />
                  ) : (
                    <img
                      src={mediaProxyUrl(currentMedia.url, "image")}
                      alt={`媒体 ${currentMediaIndex + 1}`}
                      className="max-h-[48vh] max-w-full rounded-lg object-contain md:max-h-[58vh]"
                    />
                  )}

                  {mediaItems.length > 1 && (
                    <div className="absolute bottom-2 left-1/2 flex max-w-[90%] -translate-x-1/2 flex-wrap justify-center gap-0.5 rounded-full bg-black/45 px-1 py-0.5 backdrop-blur-md">
                      {mediaItems.map((item, index) => (
                        <button
                          type="button"
                          key={`${item.type}-${item.url}-${index}`}
                          onClick={() => {
                            setActiveTab("media");
                            setCurrentMediaIndex(index);
                          }}
                          className="flex h-5 w-5 items-center justify-center rounded-full cursor-pointer"
                          aria-label={`切换到第 ${index + 1} 个媒体`}
                        >
                          <span
                            className={cn(
                              "h-1 rounded-full transition-[width,background-color,transform]",
                              index === currentMediaIndex ? "w-3 bg-accent" : "w-1 bg-white/40 hover:bg-white/70"
                            )}
                          />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-4 text-center text-[0.75rem] text-text-muted">
                  当前作品没有返回可预览媒体
                </div>
              )}
            </div>
          </div>

          {/* Right Column: Info & Links */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DialogHeader className="min-w-0 border-b border-border px-4 py-3.5 shrink-0">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="min-w-0 truncate text-[0.88rem] font-bold">作品详情</DialogTitle>
                <Badge variant="default" size="sm" className="shrink-0 scale-90 origin-left text-[0.62rem] py-0 px-1.5 h-4.5">{mediaLabel}</Badge>
              </div>
            </DialogHeader>

            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
              <div className="flex w-full max-w-full min-w-0 flex-col gap-3.5 overflow-hidden p-4 lg:p-5">
                {author && (
                  <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-white/[0.04] bg-white/[0.02] p-2.5">
                    <img
                      src={mediaProxyUrl(author.avatar_thumb || author.avatar_medium, "image")}
                      alt={author.nickname}
                      className="w-8.5 h-8.5 rounded-full object-cover border border-white/[0.08] shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[0.78rem] font-semibold text-text truncate">
                        {author.nickname}
                      </div>
                      <div className="text-[0.68rem] text-text-muted">
                        {formatTime(video.create_time)}
                      </div>
                    </div>
                  </div>
                )}

                <p className="text-[0.78rem] leading-relaxed text-text-secondary break-words select-text">
                  {video.desc}
                </p>

                {stats && (
                  <div className="flex items-center justify-between rounded-xl border border-white/[0.04] bg-white/[0.02] px-4 py-2">
                    {statItems.map((stat) => (
                      <div key={stat.label} className="flex items-center gap-1.5 text-[0.75rem]">
                        <stat.icon className={cn("w-3.5 h-3.5", stat.color)} />
                        <span className="font-bold text-text tabular-nums">
                          {formatNumber(stat.value)}
                        </span>
                        <span className="text-[0.68rem] text-text-muted">
                          {stat.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {mediaLinks.length > 0 && (
                  <div className="w-full max-w-full min-w-0 overflow-hidden">
                    <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-text-muted">
                      <Link2 className="w-3.5 h-3.5 shrink-0 text-accent" />
                      媒体链接
                    </div>
                    <div className="flex w-full max-w-full min-w-0 flex-col gap-1.5 overflow-hidden">
                      {mediaLinks.map((link) => (
                        <div
                          key={link.type}
                          className="group flex min-h-[36px] w-full max-w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-white/[0.04] bg-white/[0.02] px-2.5 py-1.5 transition-[border-color,background-color] hover:border-white/[0.08]"
                        >
                          <Badge variant="secondary" size="sm" className="shrink-0 scale-90 py-0.5 px-1.5 text-[0.62rem] font-semibold h-5">
                            {link.label}
                          </Badge>
                          <span
                            className="block min-w-0 basis-0 flex-1 truncate text-[0.68rem] text-text-secondary select-text"
                            title={link.url}
                          >
                            {link.url}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyLink(link)}
                            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[0.65rem] text-text-muted transition-[background-color,color] hover:bg-white/5 hover:text-accent"
                            aria-label={`复制${link.label}链接`}
                          >
                            {copiedLinkType === link.type ? (
                              <>
                                <Check className="w-3 h-3" />
                                已复制
                              </>
                            ) : (
                              <>
                                <Copy className="w-3 h-3" />
                                复制
                              </>
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {(music?.title || musicUrl) && (
                  <div className="min-w-0">
                    <div className="mb-1.5 flex min-w-0 items-center gap-1.5 text-[0.68rem] font-bold uppercase tracking-wider text-text-muted">
                      <Music className="w-3.5 h-3.5 shrink-0 text-accent" />
                      音频 / BGM
                    </div>
                    <div className="min-w-0 overflow-hidden rounded-xl border border-white/[0.04] bg-white/[0.02] p-3">
                      <div className="truncate text-[0.78rem] font-semibold text-text">
                        {music?.title || "抖音原声"}
                      </div>
                      {music?.author && (
                        <div className="truncate text-[0.68rem] text-text-muted mt-0.5">{music.author}</div>
                      )}
                      {musicUrl && (
                        <div className="mt-2.5 flex min-w-0 items-center gap-2">
                          <audio src={mediaProxyUrl(musicUrl, "audio")} controls className="h-7 min-w-0 flex-1 scale-95 origin-left" />
                          <Button variant="secondary" size="sm" onClick={() => void downloadAudio()} disabled={audioDownloading || !onDownload} className="h-7 shrink-0 text-[0.68rem] px-2.5 rounded-[6px]">
                            <Download className={cn("w-3 h-3", audioDownloading && "animate-pulse")} />
                            {audioDownloading ? "下载中" : "下载音频"}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter className="mt-0 shrink-0 border-t border-border px-4 py-2.5 flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="h-8 text-[0.72rem] rounded-lg">
                <X className="w-3.5 h-3.5" />
                关闭
              </Button>
              <Button variant="default" size="sm" onClick={() => onDownload?.(video)} className="h-8 text-[0.72rem] rounded-lg bg-accent hover:bg-accent-hover text-white">
                <Download className="w-3.5 h-3.5" />
                下载作品
              </Button>
            </DialogFooter>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type DetailLink = {
  label: string;
  url: string;
  type: string;
};

function uniqueDetailLinks(items: Array<DetailLink | false | "" | null | undefined>): DetailLink[] {
  const seen = new Set<string>();
  const result: DetailLink[] = [];

  for (const item of items) {
    if (!item || !item.url.trim()) continue;
    const key = `${item.type}::${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildAudioDownloadVideo(video: VideoInfo, audioUrl: string): VideoInfo {
  const title = video.music?.title || video.desc || video.aweme_id;
  return {
    ...video,
    desc: title ? `${title} 音频` : "背景音乐",
    media_type: "audio",
    raw_media_type: "audio",
    media_urls: [{ type: "audio", url: audioUrl }],
    video: {
      ...video.video,
      audio_addr: audioUrl,
      play_addr: "",
      play_addr_h264: null,
      play_addr_lowbr: null,
      download_addr: null,
    },
  };
}
