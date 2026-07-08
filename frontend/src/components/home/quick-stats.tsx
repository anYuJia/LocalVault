import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ArrowUpRight, Clock, Download, HardDrive, Video } from "lucide-react";
import {
  getHistory,
  listDownloadFilesPage,
  openDownloadDirectory,
  openFileLocation,
  type HistoryItem,
} from "@/lib/tauri";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { formatBytes } from "@/lib/utils";

interface Stat {
  icon: React.ElementType;
  label: string;
  value: string;
  color: string;
  action: "downloads" | "directory" | "latest";
  hint: string;
}

export function QuickStats() {
  const setView = useAppStore((s) => s.setView);
  const addLog = useLogStore((s) => s.addLog);
  const [latestItem, setLatestItem] = useState<HistoryItem | null>(null);
  const [stats, setStats] = useState<Stat[]>([
    { icon: Video, label: "已下载", value: "—", color: "text-accent", action: "downloads", hint: "查看任务" },
    { icon: HardDrive, label: "占用空间", value: "—", color: "text-info", action: "directory", hint: "打开目录" },
    { icon: Download, label: "今日下载", value: "—", color: "text-purple-400", action: "downloads", hint: "查看今日" },
    { icon: Clock, label: "最近记录", value: "暂无", color: "text-success", action: "latest", hint: "定位文件" },
  ]);

  useEffect(() => {
    let disposed = false;

    const loadStats = async () => {
      const [filesResult, historyResult] = await Promise.allSettled([
        listDownloadFilesPage({ offset: 0, limit: 1 }),
        getHistory(),
      ]);
      if (disposed) return;

      const filesPage = filesResult.status === "fulfilled" ? filesResult.value : null;
      const history = historyResult.status === "fulfilled" ? historyResult.value : [];
      const latest = filesPage?.latest || history[0] || null;
      const total = filesPage?.total || 0;
      const totalSize = filesPage?.totalSize || 0;

      if (filesResult.status === "rejected") {
        addLog("读取下载目录失败，首页统计已回退到历史记录", "warning");
      }

      if (total === 0) {
          setLatestItem(null);
          setStats([
            { icon: Video, label: "已下载", value: "0 个", color: "text-accent", action: "downloads", hint: "查看任务" },
            { icon: HardDrive, label: "占用空间", value: "0 B", color: "text-info", action: "directory", hint: "打开目录" },
            { icon: Download, label: "今日下载", value: "0 个", color: "text-purple-400", action: "downloads", hint: "查看今日" },
            { icon: Clock, label: "最近记录", value: "暂无", color: "text-success", action: "latest", hint: "查看任务" },
          ]);
          return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayTs = today.getTime() / 1000;
        const todayCount = history.filter((i) => i.timestamp >= todayTs).length;
        setLatestItem(latest);

        setStats([
          { icon: Video, label: "已下载", value: `${total} 个`, color: "text-accent", action: "downloads", hint: "查看任务" },
          { icon: HardDrive, label: "占用空间", value: formatBytes(totalSize), color: "text-info", action: "directory", hint: "打开目录" },
          { icon: Download, label: "今日下载", value: `${todayCount} 个`, color: "text-purple-400", action: "downloads", hint: "查看今日" },
          { icon: Clock, label: "最近记录", value: latest?.filename?.slice(0, 10) || "暂无", color: "text-success", action: "latest", hint: "定位文件" },
        ]);
    };

    void loadStats();
    return () => {
      disposed = true;
    };
  }, [addLog]);

  const handleStatClick = async (stat: Stat) => {
    if (stat.action === "downloads") {
      setView("downloads");
      return;
    }

    if (stat.action === "directory") {
      try {
        await openDownloadDirectory();
      } catch (error) {
        addLog(error instanceof Error ? error.message : "打开下载目录失败", "error");
      }
      return;
    }

    if (latestItem?.path) {
      try {
        await openFileLocation(latestItem.path);
        return;
      } catch (error) {
        addLog(error instanceof Error ? error.message : "打开最近文件失败", "error");
      }
    }
    setView("downloads");
  };

  return (
    <motion.div
      initial={false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.2, 0, 0, 1] }}
      className="w-full grid grid-cols-2 gap-2 sm:grid-cols-4"
    >
      {stats.map((s) => (
        <button
          key={s.label}
          onClick={() => void handleStatClick(s)}
          className="group relative flex min-h-[88px] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-[var(--radius-lg)] bg-surface-solid/45 px-2.5 py-3.5 text-center shadow-[inset_0_0_0_1px_var(--color-border),0_10px_28px_rgba(0,0,0,0.06)] transition-[background-color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-spring)] hover:bg-surface-raised hover:shadow-[inset_0_0_0_1px_var(--color-border-strong),0_16px_34px_rgba(0,0,0,0.10)] active:scale-[0.96] cursor-pointer"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-[11px] bg-surface-raised shadow-[inset_0_0_0_1px_var(--color-border)] transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)] group-hover:-translate-y-0.5">
            <s.icon className={`w-4 h-4 ${s.color} opacity-80`} />
          </span>
          <span className="max-w-full truncate text-[0.82rem] font-bold text-text tabular-nums">{s.value}</span>
          <span className="text-[0.6rem] text-text-muted">{s.label}</span>
          <span className="absolute right-2 top-2 flex items-center gap-0.5 rounded-full bg-background/40 px-1.5 py-0.5 text-[0.56rem] text-text-muted opacity-0 shadow-[inset_0_0_0_1px_var(--color-border)] transition-[opacity,transform] duration-[var(--duration-fast)] group-hover:translate-x-0 group-hover:opacity-100">
            {s.hint}
            <ArrowUpRight className="w-2.5 h-2.5" />
          </span>
        </button>
      ))}
    </motion.div>
  );
}
