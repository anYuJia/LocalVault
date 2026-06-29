import { useMemo, useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Calendar, Video, Image, Headphones, HardDrive, FolderOpen, FileText } from "lucide-react";
import { formatBytes } from "@/lib/utils";
import { openFileLocation, checkFilesExist, type HistoryItem } from "@/lib/tauri";

interface DownloadRecordsModalProps {
  isOpen: boolean;
  onClose: () => void;
  historyItems: HistoryItem[];
}

interface DownloadRecordBatch {
  id: string;
  author: string;
  authorId: string;
  timestamp: number;
  items: HistoryItem[];
  mediaCounts: { video: number; image: number; audio: number; media: number };
  totalSize: number;
}

export function DownloadRecordsModal({ isOpen, onClose, historyItems }: DownloadRecordsModalProps) {
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [existMap, setExistMap] = useState<Record<string, boolean>>({});

  // Group history items into batches (downloads in same 30 mins window for same author count as 1 batch)
  const batches = useMemo(() => {
    const sorted = [...historyItems].sort((a, b) => b.timestamp - a.timestamp);
    const result: DownloadRecordBatch[] = [];

    const getMediaKind = (item: HistoryItem): "video" | "image" | "audio" | "media" => {
      const path = item.path || item.file_path || "";
      const ext = path.split(".").pop()?.toLowerCase() || "";
      if (["mp4", "mov", "m4v", "webm", "mkv"].includes(ext)) return "video";
      if (["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(ext)) return "image";
      if (["mp3", "wav", "m4a", "flac", "ogg"].includes(ext)) return "audio";
      return "media";
    };

    for (const item of sorted) {
      const itemAuthor = item.author || "解析下载";
      const itemAuthorId = item.author_id || "";
      const timeThreshold = 1800; // 30 minutes (handles interruption/resume)

      const matched = result.find((b) => {
        const sameAuthor = b.author === itemAuthor && b.authorId === itemAuthorId;
        const closeTime = Math.abs(b.timestamp - item.timestamp) <= timeThreshold;
        return sameAuthor && closeTime;
      });

      const kind = getMediaKind(item);
      const size = Number(item.size || item.file_size || 0);

      if (matched) {
        matched.items.push(item);
        matched.totalSize += size;
        matched.mediaCounts[kind] += 1;
      } else {
        const counts = { video: 0, image: 0, audio: 0, media: 0 };
        counts[kind] = 1;

        result.push({
          id: `${item.timestamp}_${itemAuthor}_${result.length}`,
          author: itemAuthor,
          authorId: itemAuthorId,
          timestamp: item.timestamp,
          items: [item],
          mediaCounts: counts,
          totalSize: size,
        });
      }
    }

    return result;
  }, [historyItems]);

  // Check file existence status when modal opens or history items change
  useEffect(() => {
    if (!isOpen || historyItems.length === 0) return;

    const paths = historyItems.map((item) => item.path || item.file_path || "").filter(Boolean);
    if (paths.length === 0) return;

    const checkAll = async () => {
      try {
        const exists = await checkFilesExist(paths);
        const newMap: Record<string, boolean> = {};
        paths.forEach((path, idx) => {
          newMap[path] = exists[idx];
        });
        setExistMap(newMap);
      } catch (e) {
        console.error("检查文件是否存在失败", e);
      }
    };
    checkAll();
  }, [isOpen, historyItems]);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const handleLocateFile = async (path: string) => {
    if (!path) return;
    try {
      await openFileLocation(path);
    } catch (e) {
      console.error("定位文件失败", e);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />

          {/* Modal Content */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 15 }}
            className="relative z-10 flex h-[min(640px,calc(100vh-64px))] w-[min(540px,calc(100vw-32px))] flex-col rounded-2xl border border-white/[0.08] bg-surface-solid/90 p-5 shadow-2xl backdrop-blur-xl"
          >
            {/* Header */}
            <div className="flex items-center justify-between pb-3 border-b border-white/[0.06]">
              <div className="flex items-center gap-2">
                <span className="text-[1rem] font-bold text-text">批量下载记录</span>
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.68rem] font-semibold text-accent">
                  共 {batches.length} 次下载
                </span>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 text-text-muted hover:bg-white/5 hover:text-text transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto mt-4 pr-1 space-y-3 scrollbar-thin">
              {batches.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-center py-10">
                  <FileText className="w-10 h-10 text-text-muted/40 mb-3" />
                  <p className="text-[0.8rem] text-text-muted">暂无下载记录</p>
                </div>
              ) : (
                batches.map((batch) => {
                  const isExpanded = expandedBatchId === batch.id;

                  return (
                    <div
                      key={batch.id}
                      className="rounded-xl border border-white/[0.04] bg-white/[0.01] hover:bg-white/[0.02] transition-colors overflow-hidden"
                    >
                      {/* Batch Row */}
                      <div
                        onClick={() => setExpandedBatchId(isExpanded ? null : batch.id)}
                        className="flex items-center justify-between gap-4 p-3.5 cursor-pointer select-none"
                      >
                        <div className="flex-1 min-w-0 space-y-1.5">
                          {/* Author and Date */}
                          <div className="flex items-center gap-2">
                            <span className="text-[0.82rem] font-bold text-text truncate">
                              @{batch.author}
                            </span>
                            <span className="text-[0.62rem] text-text-muted flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              {formatDate(batch.timestamp)}
                            </span>
                          </div>

                          {/* Stats Row */}
                          <div className="flex items-center gap-3 text-[0.68rem] text-text-muted flex-wrap">
                            {batch.mediaCounts.video > 0 && (
                              <span className="flex items-center gap-1 text-info font-medium">
                                <Video className="w-3 h-3" />
                                视频 {batch.mediaCounts.video}
                              </span>
                            )}
                            {batch.mediaCounts.image > 0 && (
                              <span className="flex items-center gap-1 text-accent font-medium">
                                <Image className="w-3 h-3" />
                                图片 {batch.mediaCounts.image}
                              </span>
                            )}
                            {batch.mediaCounts.audio > 0 && (
                              <span className="flex items-center gap-1 text-purple-400 font-medium">
                                <Headphones className="w-3 h-3" />
                                音频 {batch.mediaCounts.audio}
                              </span>
                            )}
                            <span className="flex items-center gap-1 font-semibold text-text-secondary">
                              <HardDrive className="w-3 h-3" />
                              {formatBytes(batch.totalSize)}
                            </span>
                          </div>
                        </div>

                        {/* Expand Trigger Indicator */}
                        <div className="text-[0.68rem] font-bold text-accent/80 hover:text-accent select-none shrink-0">
                          {isExpanded ? "收起" : `展开 (${batch.items.length})`}
                        </div>
                      </div>

                      {/* Expanded Details */}
                      {isExpanded && (
                        <div className="border-t border-white/[0.04] bg-black/10 px-3.5 py-2.5 space-y-1.5">
                          <span className="text-[0.58rem] font-bold text-text-muted uppercase tracking-wider block mb-1">
                            包含文件 ({batch.items.length})
                          </span>
                          {batch.items.map((item, idx) => {
                            const path = item.path || item.file_path || "";
                            const fileExists = path ? existMap[path] !== false : false;

                            return (
                              <div
                                key={`${item.aweme_id || idx}_${path}`}
                                className="flex items-center justify-between gap-3 text-[0.7rem] hover:bg-white/5 p-1.5 rounded-lg transition-colors group"
                              >
                                <div className="flex items-center gap-2 truncate flex-1">
                                  <span
                                    className={`truncate transition-colors ${
                                      fileExists
                                        ? "text-text-secondary group-hover:text-text"
                                        : "text-text-muted/50 line-through"
                                    }`}
                                  >
                                    {item.filename || item.title || "未命名"}
                                  </span>
                                  {!fileExists && (
                                    <span className="shrink-0 text-[0.58rem] font-semibold px-1 rounded bg-danger/10 text-danger border border-danger/25 scale-90">
                                      已删除
                                    </span>
                                  )}
                                </div>
                                {path && fileExists && (
                                  <button
                                    onClick={() => handleLocateFile(path)}
                                    className="shrink-0 flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 hover:bg-accent/15 hover:text-accent text-[0.62rem] text-text-muted font-bold transition-colors cursor-pointer"
                                  >
                                    <FolderOpen className="w-3 h-3" />
                                    定位
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
