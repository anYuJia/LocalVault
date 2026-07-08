import { useState, useRef, useEffect, useCallback } from "react";
import { useAppStore, useLogStore } from "@/stores/app-store";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Link2,
  Clock,
  ArrowUpRight,
  X,
  Sparkles,
  ArrowRight,
  Globe,
  Video,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  loadRecentSearches,
  saveRecentSearch,
  removeRecentSearch,
  clearRecentSearches,
  type RecentSearch,
} from "@/lib/recent-searches";
import { useSearchStore } from "@/stores/search-store";
import { useLinkStore } from "@/stores/link-store";

const exampleLinks = [
  "https://v.douyin.com/iRNBho6/",
  "https://www.douyin.com/video/734...",
];

const contentVariants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

const contentTransition = {
  duration: 0.15,
  ease: "easeOut" as const,
};

const iconSwitchTransition = {
  duration: 0.15,
  ease: "easeOut" as const,
};

export function CommandPopover() {
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setView = useAppStore((s) => s.setView);
  const commandMode = useAppStore((s) => s.commandMode);
  const addLog = useLogStore((s) => s.addLog);
  const [value, setValue] = useState("");
  const [recents, setRecents] = useState<RecentSearch[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRecents(loadRecentSearches());
    const timer = setTimeout(() => inputRef.current?.focus(), 80);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [setCommandOpen]);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;

    if (commandMode === "search") {
      setRecents(saveRecentSearch(trimmed));
      void useSearchStore.getState().search(trimmed);
    } else {
      void useLinkStore.getState().parse(trimmed);
      addLog("开始解析链接", "info");
    }

    setCommandOpen(false);
  }, [value, commandMode, addLog, setCommandOpen]);

  const handleRecentClick = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setRecents(saveRecentSearch(trimmed));
    void useSearchStore.getState().search(trimmed);
    setCommandOpen(false);
  };

  const handleRemoveRecent = (text: string) => {
    setRecents(removeRecentSearch(text));
  };

  const handleClearAll = () => {
    clearRecentSearches();
    setRecents([]);
  };

  const handleExampleClick = (text: string) => {
    setValue(text);
    inputRef.current?.focus();
  };

  const isSearch = commandMode === "search";
  const Icon = isSearch ? Search : Link2;

  return (
    <>
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[1080] bg-black/40 backdrop-blur-md"
        onClick={() => setCommandOpen(false)}
      />

      {/* Command Panel — centered on screen */}
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.16, ease: "easeOut" }}
        className={cn(
          "fixed z-[1090] flex flex-col overflow-hidden",
          "inset-0 m-auto w-fit h-fit",
          "w-[640px] max-w-[calc(100vw-48px)]",
          "rounded-[var(--radius-xl)]",
          "bg-surface-solid/80 backdrop-blur-3xl",
          "shadow-[0_44px_110px_rgba(0,0,0,0.42),0_0_0_1px_var(--color-border)]"
        )}
      >
        {/* Header with mode tabs */}
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <div className="flex items-center gap-1 p-1 rounded-[12px] bg-white/[0.04]">
            {(
              [
                { mode: "search" as const, icon: Search, label: "搜索用户" },
                { mode: "link" as const, icon: Link2, label: "解析链接" },
              ] as const
            ).map(({ mode, icon: TabIcon, label }) => (
              <button
                key={mode}
                onClick={() => {
                  if (mode === "search") {
                    setView("search");
                    setCommandOpen(false);
                    return;
                  }
                  setView("link");
                  setCommandOpen(false);
                }}
                className={cn(
                  "relative flex items-center gap-2 px-3.5 py-2 rounded-[10px] text-[0.78rem] font-semibold cursor-pointer transition-[color,background-color,box-shadow] duration-200",
                  commandMode === mode
                    ? "text-text"
                    : "text-text-muted hover:text-text-secondary"
                )}
              >
                {commandMode === mode && (
                  <motion.div
                    layoutId="command-tab-bg"
                    className="absolute inset-0 rounded-[10px] bg-accent/[0.12] shadow-[0_0_12px_rgba(254,44,85,0.08)]"
                    transition={{
                      duration: 0.16,
                      ease: "easeOut" as const,
                    }}
                  />
                )}
                <TabIcon className="relative w-3.5 h-3.5" />
                <span className="relative">{label}</span>
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setCommandOpen(false)}
              className="w-7 h-7 rounded-[8px] flex items-center justify-center text-text-muted hover:text-text hover:bg-surface-raised cursor-pointer transition-[background-color,color]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Input area */}
        <div className="px-5 pb-4">
          <div
            className={cn(
              "relative flex items-center gap-4 px-5 h-[64px] rounded-[16px] transition-[background-color,box-shadow] duration-200",
              value
                ? "bg-accent/[0.07] shadow-[0_0_50px_rgba(254,44,85,0.1),0_8px_32px_rgba(0,0,0,0.2)]"
                : "bg-white/[0.04] shadow-[0_4px_20px_rgba(0,0,0,0.1)] focus-within:bg-white/[0.07] focus-within:shadow-[0_0_40px_rgba(254,44,85,0.05),0_8px_40px_rgba(0,0,0,0.2)]"
            )}
          >
            <div
              className={cn(
                "w-9 h-9 rounded-[10px] flex items-center justify-center shrink-0 transition-[background-color,box-shadow] duration-200",
                value
                  ? "bg-accent/15 shadow-[0_0_12px_rgba(254,44,85,0.15)]"
                  : "bg-white/[0.06]"
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={commandMode}
                  initial={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
                  animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
                  exit={{ opacity: 0, scale: 0.25, filter: "blur(4px)" }}
                  transition={iconSwitchTransition}
                  className="flex items-center justify-center"
                >
                  <Icon
                    className={cn(
                      "w-[18px] h-[18px] transition-colors duration-200",
                      value ? "text-accent" : "text-text-muted"
                    )}
                  />
                </motion.div>
              </AnimatePresence>
            </div>

            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              placeholder={
                isSearch
                  ? "输入用户名或抖音号..."
                  : "粘贴抖音分享链接..."
              }
              className="flex-1 bg-transparent text-[1rem] text-text placeholder:text-text-muted/60 font-medium tracking-tight command-input"
            />

            {value ? (
              <motion.button
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                onClick={handleSubmit}
                className="flex items-center gap-1.5 px-4 h-9 rounded-[10px] bg-accent text-white text-[0.82rem] font-bold cursor-pointer hover:bg-accent-hover active:scale-[0.96] transition-[background-color,scale,box-shadow] shrink-0 shadow-[0_4px_16px_rgba(254,44,85,0.35)]"
              >
                {isSearch ? "搜索" : "解析"}
                <ArrowRight className="w-4 h-4" />
              </motion.button>
            ) : (
              <div className="flex items-center gap-1 shrink-0 text-text-muted">
                <kbd className="inline-flex items-center justify-center h-6 px-1.5 text-[0.6rem] font-mono rounded-[5px] bg-white/[0.06] text-text-muted/60">
                  esc
                </kbd>
              </div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/[0.06] mx-5" />

        {/* Content Area */}
        <div className="h-[min(280px,calc(100vh-220px))] min-h-[180px] overflow-y-auto px-5 py-4">
          <AnimatePresence mode="wait" initial={false}>
            {/* Search mode: recent searches */}
            {isSearch && !value && (
              <motion.div
                key="search-empty"
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={contentTransition}
              >
                {recents.length > 0 ? (
                  <div className="mb-4">
                    <div className="flex items-center justify-between px-1 mb-2.5">
                      <div className="flex items-center gap-2">
                        <Clock className="w-3.5 h-3.5 text-text-muted" />
                        <span className="text-[0.7rem] font-bold text-text-muted uppercase tracking-[0.08em]">
                          最近搜索
                        </span>
                      </div>
                      <button
                        onClick={handleClearAll}
                        className="flex items-center gap-1 text-[0.65rem] text-text-muted hover:text-danger cursor-pointer transition-colors"
                      >
                        <Trash2 className="w-3 h-3" />
                        清除
                      </button>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {recents.map((item) => (
                        <div
                          key={item.text}
                          className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-left hover:bg-surface-raised group/item transition-colors"
                        >
                          <button
                            onClick={() => handleRecentClick(item.text)}
                            className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"
                          >
                            <div className="w-8 h-8 rounded-[10px] bg-white/[0.05] flex items-center justify-center group-hover/item:bg-accent/[0.08] transition-colors">
                              <Search className="w-3.5 h-3.5 text-text-muted group-hover/item:text-accent transition-colors" />
                            </div>
                            <span className="text-[0.85rem] font-medium text-text-secondary group-hover/item:text-text transition-colors truncate">
                              {item.text}
                            </span>
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveRecent(item.text);
                            }}
                            className="w-6 h-6 rounded-[6px] flex items-center justify-center text-text-muted opacity-0 group-hover/item:opacity-100 hover:text-danger hover:bg-danger/10 cursor-pointer transition-[opacity,background-color,color] shrink-0"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center py-6 mb-3">
                    <div className="w-12 h-12 rounded-[14px] bg-white/[0.04] flex items-center justify-center mb-3">
                      <Search className="w-6 h-6 text-text-muted/50" />
                    </div>
                    <p className="text-[0.85rem] font-medium text-text-secondary mb-1">
                      暂无搜索记录
                    </p>
                    <p className="text-[0.75rem] text-text-muted">
                      搜索过的用户会显示在这里
                    </p>
                  </div>
                )}

                {/* Tips */}
                <div className="flex items-center gap-2 px-3 py-2.5 rounded-[10px] bg-white/[0.03]">
                  <Sparkles className="w-3.5 h-3.5 text-info shrink-0" />
                  <span className="text-[0.72rem] text-text-muted">
                    支持搜索抖音昵称、抖音号、UID
                  </span>
                </div>
              </motion.div>
            )}

            {/* Link mode: empty state */}
            {!isSearch && !value && (
              <motion.div
                key="link-empty"
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={contentTransition}
              >
                <div className="flex flex-col items-center py-4 mb-4">
                  <div className="w-14 h-14 rounded-[16px] bg-gradient-to-br from-info/15 to-info/5 flex items-center justify-center mb-4 shadow-[0_0_20px_rgba(124,92,252,0.1)]">
                    <Globe className="w-7 h-7 text-info" />
                  </div>
                  <p className="text-[0.92rem] font-semibold text-text mb-1">
                    粘贴链接开始解析
                  </p>
                  <p className="text-[0.78rem] text-text-muted text-center max-w-[280px]">
                    支持抖音分享链接、短链接和完整视频 URL
                  </p>
                </div>

                <div className="mb-3">
                  <div className="flex items-center gap-2 px-1 mb-2.5">
                    <Video className="w-3.5 h-3.5 text-text-muted" />
                    <span className="text-[0.7rem] font-bold text-text-muted uppercase tracking-[0.08em]">
                      示例链接
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {exampleLinks.map((link) => (
                      <button
                        key={link}
                        onClick={() => handleExampleClick(link)}
                        className="flex items-center gap-3 w-full px-3 py-2.5 rounded-[12px] text-left hover:bg-surface-raised cursor-pointer transition-colors group"
                      >
                        <div className="w-8 h-8 rounded-[10px] bg-white/[0.05] flex items-center justify-center group-hover:bg-info/[0.08] transition-colors">
                          <Link2 className="w-3.5 h-3.5 text-text-muted group-hover:text-info transition-colors" />
                        </div>
                        <span className="text-[0.78rem] text-text-muted font-mono truncate group-hover:text-text-secondary transition-colors">
                          {link}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-2 px-3 py-2.5 rounded-[10px] bg-white/[0.03]">
                  <Sparkles className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                  <span className="text-[0.72rem] text-text-muted">
                    也可以直接从抖音 App 复制分享链接
                  </span>
                </div>
              </motion.div>
            )}

            {/* Input active: action preview */}
            {value && (
              <motion.div
                key="action"
                variants={contentVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={contentTransition}
              >
                <button
                  onClick={handleSubmit}
                  className="flex items-center gap-4 w-full px-4 py-4 rounded-[14px] text-left bg-accent/[0.07] hover:bg-accent/[0.11] cursor-pointer transition-colors group"
                >
                  <div className="w-11 h-11 rounded-[12px] bg-accent/12 flex items-center justify-center shrink-0">
                    <Icon className="w-5 h-5 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.9rem] font-semibold text-text truncate">
                      {value}
                    </div>
                    <div className="text-[0.75rem] text-text-muted mt-0.5">
                      {isSearch ? "搜索此用户" : "解析此链接"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <kbd className="inline-flex items-center justify-center h-6 px-2 text-[0.65rem] font-mono rounded-[6px] bg-white/[0.06] text-text-muted/70">
                      Enter
                    </kbd>
                  </div>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer keyboard hints */}
        <div className="flex items-center justify-between px-5 py-3 bg-white/[0.02]">
          <div className="flex items-center gap-3 text-text-muted">
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex items-center justify-center min-w-[22px] h-[20px] px-1.5 text-[0.6rem] font-mono rounded-[5px] bg-white/[0.06] text-text-muted/70">
                ↵
              </kbd>
              <span className="text-[0.65rem]">执行</span>
            </span>
            <span className="flex items-center gap-1.5">
              <kbd className="inline-flex items-center justify-center min-w-[28px] h-[20px] px-1.5 text-[0.6rem] font-mono rounded-[5px] bg-white/[0.06] text-text-muted/70">
                esc
              </kbd>
              <span className="text-[0.65rem]">关闭</span>
            </span>
          </div>
          <span className="text-[0.62rem] text-text-muted/60">
            better-douyin
          </span>
        </div>
      </motion.div>
    </>
  );
}
