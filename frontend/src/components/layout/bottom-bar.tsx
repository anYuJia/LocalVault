import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useDownloadStore, useLogStore } from "@/stores/app-store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { DownloadTaskCardById } from "@/components/downloads/task-card";
import { ChevronUp, Trash2, ArrowDown, FolderOpen } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDownloads } from "@/hooks/use-downloads";

export function BottomBar() {
  const expanded = useAppStore((s) => s.bottomBarExpanded);
  const setExpanded = useAppStore((s) => s.setBottomBarExpanded);
  const toggleExpanded = useAppStore((s) => s.toggleBottomBar);
  const activeCount = useDownloadStore((s) => s.activeCount);
  const taskIds = useDownloadStore((s) => s.taskIds);
  const logs = useLogStore((s) => s.logs);
  const clearLogs = useLogStore((s) => s.clearLogs);
  const [activeTab, setActiveTab] = useState("progress");
  const logsViewportRef = useRef<HTMLDivElement>(null);
  const {
    cancelDownload,
    pauseTask,
    resumeTask,
    removeTask,
    openDownloadsDirectory,
    openTaskLocation,
  } = useDownloads();

  const visibleLogs = useMemo(() => logs.slice(-300), [logs]);
  const hiddenLogCount = Math.max(0, logs.length - visibleLogs.length);
  const hasActiveTasks = activeCount > 0;
  const toggleLabel = expanded ? "收起下载面板" : "展开下载面板";
  const scrollLogsToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = logsViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setExpanded(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [expanded, setExpanded]);

  useEffect(() => {
    if (!expanded || activeTab !== "logs") return;
    scrollLogsToBottom("auto");
  }, [activeTab, expanded, logs.length, scrollLogsToBottom]);

  return (
    <motion.div
      ref={containerRef}
      className="absolute bottom-4 right-4 z-40 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/96 shadow-[0_12px_40px_rgba(0,0,0,0.14)] backdrop-blur-xl"
      animate={{
        height: expanded ? 360 : 42,
        width: expanded ? "min(620px, calc(100vw - 32px))" : 246,
      }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
    >
      {/* Header */}
      <div
        className="flex h-[42px] cursor-pointer select-none items-center justify-between gap-3 border-b border-border/10 px-3"
        onClick={toggleExpanded}
      >
        <div className="min-w-0 flex-1 text-[0.72rem] font-medium text-text-muted">
          {hasActiveTasks ? `${activeCount} 个下载任务` : ""}
        </div>
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Tabs
            value={activeTab}
            onValueChange={(val) => {
              setActiveTab(val);
              if (!expanded) {
                setExpanded(true);
              }
            }}
          >
            <TabsList>
              <TabsTrigger value="progress">
                进度
                {hasActiveTasks && (
                  <Badge variant="secondary" size="sm" className="ml-1.5 shrink-0 px-1 min-w-[16px] h-4 text-[10px]">
                    {activeCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="logs">日志</TabsTrigger>
            </TabsList>
          </Tabs>

          <button
            onClick={(event) => {
              event.stopPropagation();
              void openDownloadsDirectory();
            }}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-muted transition-[background-color,color,transform] duration-[var(--duration-fast)] hover:bg-surface-raised hover:text-text active:scale-[0.96]"
            title="打开下载目录"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>

          <motion.button
            type="button"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            title={toggleLabel}
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded();
            }}
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] text-text-muted transition-[background-color,color,transform] duration-[var(--duration-fast)] hover:bg-surface-raised hover:text-text active:scale-[0.96]"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
          >
            <ChevronUp className="w-4 h-4" />
          </motion.button>
        </div>
      </div>

      {/* Body — uses the SAME tab state */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 overflow-hidden px-3 pb-3"
          >
            {/* Progress Panel */}
            {activeTab === "progress" && (
              <ScrollArea className="h-full">
                {taskIds.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-[0.8125rem] text-text-muted">
                    暂无下载任务
                  </div>
                ) : (
                  <div className="flex flex-col gap-2 py-2">
                    <AnimatePresence initial={false}>
                      {taskIds.map((taskId) => (
                        <DownloadTaskCardById
                          key={taskId}
                          taskId={taskId}
                          onCancel={cancelDownload}
                          onPause={pauseTask}
                          onResume={resumeTask}
                          onOpen={openTaskLocation}
                          onRemove={removeTask}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </ScrollArea>
            )}

            {/* Logs Panel */}
            {activeTab === "logs" && (
              <>
                <div className="flex items-center gap-1 mb-1">
                  <button
                    type="button"
                    aria-label="清空日志"
                    title="清空日志"
                    onClick={clearLogs}
                    className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-raised transition-[background-color,color,transform,opacity] cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => scrollLogsToBottom()}
                    className="w-6 h-6 rounded flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-raised transition-[background-color,color,transform,opacity] cursor-pointer"
                    title="滚动到底部"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </div>
                <ScrollArea className="h-[calc(100%-28px)]" viewportRef={logsViewportRef}>
                  <div className="font-mono text-[11px] leading-relaxed text-text-secondary">
                    {hiddenLogCount > 0 && (
                      <div className="py-0.5 text-text-muted">
                        已折叠较早的 {hiddenLogCount} 条日志
                      </div>
                    )}
                    {visibleLogs.map((log) => (
                      <div
                        key={log.id}
                        className={cn(
                          "flex min-w-0 items-start gap-2 py-0.5",
                          log.type === "success" && "text-success",
                          log.type === "error" && "text-danger",
                          log.type === "warning" && "text-warning"
                        )}
                      >
                        <span className="shrink-0 whitespace-nowrap text-text-muted">
                          [{new Date(log.timestamp).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}]
                        </span>
                        <span className="min-w-0 break-words">{log.message}</span>
                      </div>
                    ))}
                    {logs.length === 0 && (
                      <div className="text-text-muted">等待操作...</div>
                    )}
                  </div>
                </ScrollArea>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
