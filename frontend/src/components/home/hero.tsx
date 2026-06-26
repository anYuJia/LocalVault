import { useAppStore } from "@/stores/app-store";
import { motion } from "framer-motion";
import {
  Search,
  Link2,
  Sparkles,
  Heart,
  ArrowUpRight,
  Command,
} from "lucide-react";
import type { ViewType } from "@/types";
import { cn } from "@/lib/utils";
import { ThemeLogo } from "@/components/common/theme-logo";
import { AmbientBackground } from "./ambient-background";
import { QuickStats } from "./quick-stats";

interface Shortcut {
  icon: React.ElementType;
  label: string;
  desc: string;
  gradient: string;
  iconColor: string;
  glowColor: string;
  view?: ViewType;
  kbd?: string;
}

const shortcuts: Shortcut[] = [
  {
    icon: Search,
    label: "搜索用户",
    desc: "通过用户名或抖音号查找创作者",
    gradient: "from-accent/20 via-accent/5 to-transparent",
    iconColor: "text-accent",
    glowColor: "shadow-[0_0_20px_rgba(254,44,85,0.15)]",
    view: "search",
    kbd: "⌘K",
  },
  {
    icon: Link2,
    label: "解析链接",
    desc: "解析分享链接，一键下载视频",
    gradient: "from-info/20 via-info/5 to-transparent",
    iconColor: "text-info",
    glowColor: "shadow-[0_0_20px_rgba(124,92,252,0.15)]",
    view: "link",
    kbd: "⌘L",
  },
  {
    icon: Sparkles,
    label: "推荐视频",
    desc: "浏览抖音推荐流内容",
    gradient: "from-purple-500/20 via-purple-500/5 to-transparent",
    iconColor: "text-purple-400",
    glowColor: "shadow-[0_0_20px_rgba(168,85,247,0.15)]",
    view: "recommended",
  },
  {
    icon: Heart,
    label: "收藏视频",
    desc: "查看账号收藏的视频内容",
    gradient: "from-rose-500/20 via-rose-500/5 to-transparent",
    iconColor: "text-rose-400",
    glowColor: "shadow-[0_0_20px_rgba(244,63,94,0.15)]",
    view: "collected",
    kbd: "⌘4",
  },
];

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 320, damping: 26 },
  },
};

export function Hero() {
  const setView = useAppStore((s) => s.setView);

  const handleShortcut = (s: Shortcut) => {
    if (s.view) {
      setView(s.view);
    }
  };

  return (
    <div className="relative flex min-h-full min-w-0 items-center justify-center px-4 py-6 sm:px-8 sm:py-8">
      <AmbientBackground />

      <motion.div
        className="relative z-10 flex w-[min(720px,calc(100vw-104px))] max-w-full min-w-0 flex-col items-center"
        variants={container}
        initial={false}
        animate="show"
      >
        {/* Status pill */}
        <motion.div variants={item} className="mb-4 sm:mb-5">
          <span className="inline-flex h-7 items-center gap-2 rounded-full bg-success/8 px-3.5 text-[0.68rem] font-semibold text-success shadow-[inset_0_0_0_1px_rgba(0,214,143,0.18)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            就绪
          </span>
        </motion.div>

        {/* Title */}
        <motion.div variants={item} className="mb-2 flex max-w-full min-w-0 items-center gap-2 max-lg:flex-col max-lg:gap-1">
          <div className="h-9 w-9 overflow-visible rounded-[14px] bg-transparent drop-shadow-[0_10px_24px_rgba(0,0,0,0.14)]">
            <ThemeLogo label="better-douyin" className="h-full w-full object-contain" />
          </div>
          <h1 className="min-w-0 truncate text-center text-[1.18rem] font-[750] tracking-[-0.02em] text-text sm:text-[1.35rem] max-lg:text-[1.08rem]">
            better-douyin
          </h1>
        </motion.div>

        {/* Subtitle */}
        <motion.p
          variants={item}
          className="mb-5 max-w-[360px] text-center text-[0.8rem] leading-relaxed text-text-muted sm:mb-7 sm:text-[0.82rem]"
        >
          搜索用户、粘贴链接、浏览推荐
          <br />
          <span className="text-text-secondary">一站式视频解析与下载</span>
        </motion.p>

        {/* Shortcut grid */}
        <motion.div
          variants={container}
          className="grid w-full min-w-0 grid-cols-1 gap-3 sm:grid-cols-2"
        >
          {shortcuts.map((s) => (
            <motion.button
              key={s.label}
              variants={item}
              onClick={() => handleShortcut(s)}
              className={cn(
                "group relative flex min-h-[106px] min-w-0 flex-col gap-2.5 overflow-hidden rounded-[var(--radius-lg)] p-3 text-left cursor-pointer sm:min-h-[128px] sm:gap-3 sm:p-4",
                "bg-surface-solid/70 shadow-[var(--shadow-sm)]",
                "ring-1 ring-border/60",
                "hover:bg-surface-raised hover:ring-border-strong hover:shadow-md",
                "transition-[transform,box-shadow,border-color,background-color] duration-[var(--duration-base)] ease-[var(--ease-spring)]"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.97 }}
            >
              {/* Gradient accent strip at top */}
              <div
                className={cn(
                  "absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r opacity-0 transition-opacity duration-300 group-hover:opacity-100",
                  s.gradient.replace("/20", "/60").replace("to-transparent", "via-transparent to-transparent")
                )}
              />

              {/* Background gradient glow on hover */}
              <div
                className={cn(
                  "absolute -right-10 -top-14 h-28 w-28 rounded-full bg-gradient-to-br opacity-0 blur-2xl transition-opacity duration-500 group-hover:opacity-70",
                  s.gradient
                )}
              />

              {/* Icon + kbd row */}
              <div className="relative flex items-center justify-between w-full">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-[12px]",
                    "bg-gradient-to-br",
                    s.gradient,
                    "border border-border/60 group-hover:border-border-strong",
                    "transition-[transform,border-color,background-color] duration-300"
                  )}
                >
                  <s.icon
                    className={cn(
                      "h-5 w-5 transition-transform duration-300 group-hover:scale-110",
                      s.iconColor
                    )}
                  />
                </div>
                {s.kbd && (
                  <kbd className="text-[0.58rem] font-mono px-1.5 py-0.5 rounded-[6px] bg-surface border border-border text-text-muted opacity-60 group-hover:opacity-100 transition-opacity">
                    {s.kbd}
                  </kbd>
                )}
              </div>

              {/* Text */}
              <div className="relative">
                <div className="flex items-center gap-1.5">
                  <span className="text-[0.9rem] font-semibold text-text">
                    {s.label}
                  </span>
                  <ArrowUpRight className="w-3.5 h-3.5 text-text-muted opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-[opacity,transform] duration-300" />
                </div>
                <div className="mt-0.5 text-[0.72rem] leading-snug text-text-muted">
                  {s.desc}
                </div>
              </div>
            </motion.button>
          ))}
        </motion.div>

        {/* Quick Stats */}
        <div className="mt-5 w-full">
          <QuickStats />
        </div>

        {/* Keyboard hint */}
        <motion.div
          variants={item}
          className="mt-5 hidden items-center gap-1.5 text-text-muted sm:flex"
        >
          <kbd className="text-[0.58rem] font-mono px-1.5 py-0.5 rounded bg-surface border border-border">
            <Command className="w-2.5 h-2.5 inline" />
          </kbd>
          <span className="text-[0.65rem]">+</span>
          <kbd className="text-[0.58rem] font-mono px-1.5 py-0.5 rounded bg-surface border border-border">
            K
          </kbd>
          <span className="text-[0.65rem] ml-1">打开搜索用户</span>
        </motion.div>
      </motion.div>
    </div>
  );
}
