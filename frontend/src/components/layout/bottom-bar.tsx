import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, useDownloadStore, useLogStore } from "@/stores/app-store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { TaskCard } from "@/components/downloads/task-card";
import { Download, ChevronUp, Trash2, ArrowDown, FolderOpen } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { useDownloads } from "@/hooks/use-downloads";

export function BottomBar() {
  const expanded = useAppStore((s) => s.bottomBarExpanded);
  const setExpanded = useAppStore((s) => s.setBottomBarExpanded);
  const toggleExpanded = useAppStore((s) => s.toggleBottomBar);
  const activeCount = useDownloadStore((s) => s.activeCount);
  const tasks = useDownloadStore((s) => s.tasks);
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

  const tasksList = Object.values(tasks);
  const visibleLogs = useMemo(() => logs.slice(-300), [logs]);
  const hiddenLogCount = Math.max(0, logs.length - visibleLogs.length);
  const hasActiveTasks = activeCount > 0;
  const activeProgress =
    activeCount > 0
      ? tasksList
          .filter((task) => task.status === "downloading" || task.status === "pending" || task.status === "paused")
          .reduce((sum, task) => sum + (task.progress || 0), 0) / activeCount
      : 0;
  const scrollLogsToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const viewport = logsViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (!expanded || activeTab !== "logs") return;
    scrollLogsToBottom("auto");
  }, [activeTab, expanded, logs.length, scrollLogsToBottom]);

  return (
    <motion.div
      className="absolute bottom-4 right-4 z-40 bg-background/95 backdrop-blur shadow-[0_8px_30px_rgba(0,0,0,0.12)] border border-border/80 rounded-xl flex flex-col overflow-hidden"
      animate={{
        height: expanded ? 320 : 42,
        width: expanded ? 400 : 230,
      }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-end h-[42px] px-3 cursor-pointer select-none gap-2 border-b border-border/10"
        onClick={toggleExpanded}
      >
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
            className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-raised transition-[background-color,color,transform] duration-[var(--duration-fast)] cursor-pointer"
            title="打开下载目录"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>

          <motion.button
            onClick={(event) => {
              event.stopPropagation();
              toggleExpanded();
            }}
            className="w-7 h-7 rounded-[var(--radius-sm)] flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-raised transition-[background-color,color,transform] duration-[var(--duration-fast)] cursor-pointer"
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
            className="px-3 pb-2 flex-1 overflow-hidden"
          >
            {/* Progress Panel */}
            {activeTab === "progress" && (
              <ScrollArea className="h-full">
                {tasksList.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-[0.8125rem] text-text-muted">
                    暂无下载任务
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5 py-1">
                    <AnimatePresence initial={false}>
                      {tasksList.map((task) => (
                        <TaskCard
                          key={task.id}
                          task={task}
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
                          "py-0.5",
                          log.type === "success" && "text-success",
                          log.type === "error" && "text-danger",
                          log.type === "warning" && "text-warning"
                        )}
                      >
                        <span className="text-text-muted mr-2">
                          [{new Date(log.timestamp).toLocaleTimeString()}]
                        </span>
                        {log.message}
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
