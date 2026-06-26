import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore, useDownloadStore } from "@/stores/app-store";
import type { ViewType } from "@/types";
import { Badge } from "@/components/ui/badge";
import { getAccounts, switchAccount, initClient, type AccountInfo } from "@/lib/tauri";
import { useToast } from "@/components/ui/toast";
import {
  Home,
  Search,
  UserRound,
  Link2,
  Sparkles,
  FolderOpen,
  Heart,
  Settings,
  Star,
  Circle,
  Users,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";

interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "search", label: "搜索用户", icon: Search },
  { id: "user", label: "用户主页", icon: UserRound },
  { id: "link", label: "解析链接", icon: Link2 },
  { id: "recommended", label: "推荐视频", icon: Sparkles },
  { id: "downloads", label: "我的下载", icon: FolderOpen },
  { id: "liked", label: "点赞视频", icon: Heart },
  { id: "collected", label: "收藏视频", icon: Star },
  { id: "friends-status", label: "好友", icon: Users },
  { id: "settings", label: "设置", icon: Settings },
];

const containerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.04, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: { type: "spring" as const, stiffness: 400, damping: 28 } },
};

export function Sidebar() {
  const toast = useToast();
  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const friendUnreadCount = useAppStore((s) => s.friendUnreadCount);
  const activeCount = useDownloadStore((s) => s.activeCount);
  const [activeAccount, setActiveAccount] = useState<AccountInfo | null>(null);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [showUserPopover, setShowUserPopover] = useState(false);
  const hoverTimerRef = useRef<any>(null);

  const fetchActiveAccount = useCallback(async () => {
    try {
      const res = await getAccounts();
      if (res.success) {
        setAccounts(res.accounts || []);
        if (res.current_sec_uid) {
          const activeAcc = res.accounts?.find((a) => a.sec_uid === res.current_sec_uid);
          setActiveAccount(activeAcc || null);
          useAppStore.getState().setCookieLoggedIn(Boolean(activeAcc), activeAcc?.nickname, activeAcc?.sec_uid);
        } else {
          setActiveAccount(null);
          useAppStore.getState().setCookieLoggedIn(false);
        }
      } else {
        setActiveAccount(null);
        setAccounts([]);
        useAppStore.getState().setCookieLoggedIn(false);
      }
    } catch (e) {
      console.error("加载边栏头像失败", e);
    }
  }, []);

  useEffect(() => {
    void fetchActiveAccount();
  }, [currentView, cookieLoggedIn, fetchActiveAccount]);

  const handleMouseEnter = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowUserPopover(true);
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
    }
    hoverTimerRef.current = setTimeout(() => {
      setShowUserPopover(false);
    }, 200);
  };

  const handleNavClick = (item: NavItem) => {
    setView(item.id);
  };

  const isPyWebView = typeof window !== "undefined" && Boolean((window as any).pywebview);
  const isMacOS = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
  const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
  const brandTopPadding = isPyWebView && isWindows ? "pt-10" : "py-5";

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-surface-solid/60 backdrop-blur-2xl shadow-[1px_0_0_0_var(--color-border),16px_0_40px_rgba(0,0,0,0.04)] max-lg:w-[72px]">
      <motion.div
        className={`pywebview-drag-region flex items-center gap-3 px-5 pb-5 max-lg:justify-center max-lg:px-3 ${brandTopPadding}`}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties & { WebkitAppRegion: string }}
        initial={false}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
      >
        <div className="w-10 h-10 rounded-[14px] overflow-hidden flex items-center justify-center">
          <img src="/animated_icon.svg" alt="better-douyin" className="w-10 h-10" />
        </div>
        <div className="flex min-w-0 flex-col max-lg:hidden">
          <span className="text-[0.9rem] font-[780] tracking-tight text-text truncate">
            better-douyin
          </span>
          <span className="text-[0.7rem] font-semibold text-text-muted tracking-wide">
            本地媒体工作台
          </span>
        </div>
      </motion.div>

      {/* Navigation */}
      <motion.nav
        className="flex-1 flex flex-col gap-1 px-3 overflow-y-auto max-lg:items-center"
        variants={containerVariants}
        initial={false}
        animate="show"
      >
        <div className="px-2 mb-2 text-[0.68rem] font-bold uppercase tracking-[0.08em] text-text-muted max-lg:hidden">
          导航
        </div>

        {navItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;

          return (
            <motion.button
              key={item.label}
              variants={itemVariants}
              onClick={() => handleNavClick(item)}
              title={item.label}
              aria-label={item.label}
              className={cn(
                "group relative flex h-[42px] w-full items-center gap-3 rounded-[14px] px-3 text-left transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-spring)] cursor-pointer max-lg:w-[44px] max-lg:justify-center max-lg:px-0",
                isActive
                  ? "bg-accent-soft text-accent shadow-[0_8px_24px_rgba(254,44,85,0.10)]"
                  : "text-text-muted hover:text-text hover:bg-surface-raised"
              )}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.98 }}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              <span className="truncate text-[0.8125rem] font-semibold max-lg:hidden">{item.label}</span>

              {item.id === "downloads" && activeCount > 0 && (
                <Badge variant="default" size="sm" className="ml-auto max-lg:absolute max-lg:-right-1 max-lg:-top-1 max-lg:ml-0">
                  {activeCount}
                </Badge>
              )}
              {item.id === "friends-status" && friendUnreadCount > 0 && (
                <Badge variant="default" size="sm" className="ml-auto max-lg:absolute max-lg:-right-1 max-lg:-top-1 max-lg:ml-0">
                  {friendUnreadCount > 99 ? "99+" : friendUnreadCount}
                </Badge>
              )}
            </motion.button>
          );
        })}
      </motion.nav>

      {/* Status — pinned to bottom */}
      <div
        className="relative px-3 py-3"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <AnimatePresence>
          {showUserPopover && (
            <motion.div
              initial={{ opacity: 0, y: 10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-[calc(100%-4px)] left-3 w-[220px] max-lg:left-[76px] max-lg:bottom-3 z-50 bg-background/95 backdrop-blur shadow-[0_10px_30px_rgba(0,0,0,0.15)] border border-border/80 rounded-xl p-2 flex flex-col gap-1 overflow-hidden pointer-events-auto"
            >
              <div className="px-2 py-1 text-[10px] font-bold text-text-muted border-b border-border/10 mb-1">
                切换账号
              </div>
              {accounts.length === 0 ? (
                <div className="text-[11px] text-text-muted text-center py-2">
                  无其他账号
                </div>
              ) : (
                <div className="max-h-[200px] overflow-y-auto flex flex-col gap-0.5">
                  {accounts.map((acc) => {
                    const isActive = activeAccount?.sec_uid === acc.sec_uid;
                    const isValid = acc.is_valid !== false; // if undefined or true, it's valid
                    return (
                      <button
                        key={acc.sec_uid}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (isActive) return;
                          try {
                            const res = await switchAccount(acc.sec_uid);
                            if (res.success) {
                              toast.success(`已切换为: ${res.nickname}`, "切换成功");
                              useAppStore.getState().setCookieLoggedIn(true, res.nickname, acc.sec_uid);
                              await initClient().catch(() => {});
                              await fetchActiveAccount();
                            } else {
                              toast.error(res.message, "切换失败");
                            }
                          } catch (err) {
                            toast.error(err instanceof Error ? err.message : "切换失败", "错误");
                          }
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors cursor-pointer",
                          isActive
                            ? "bg-accent-soft text-accent"
                            : "hover:bg-surface-raised text-text"
                        )}
                      >
                        {/* Avatar */}
                        <div className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center border border-border shrink-0">
                          {acc.avatar_thumb ? (
                            <img src={acc.avatar_thumb} alt={acc.nickname} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-accent-soft text-accent text-[9px] font-bold flex items-center justify-center">
                              {acc.nickname.slice(0, 1).toUpperCase()}
                            </div>
                          )}
                        </div>
                        {/* Name & Validity */}
                        <div className="flex-1 flex items-center justify-between min-w-0">
                          <span className="text-[11px] font-semibold truncate">
                            {acc.nickname}
                          </span>
                          {!isValid && (
                            <span className="text-[9px] font-semibold px-1 py-0.5 rounded bg-danger-soft text-danger shrink-0 scale-90 origin-right">
                              无效
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={() => setView("settings")}
          className="flex h-[48px] w-full items-center gap-3 rounded-[14px] hover:bg-surface-raised active:scale-95 px-3 transition-[background-color,transform] cursor-pointer max-lg:justify-center max-lg:px-0"
          title={cookieLoggedIn && activeAccount ? `当前账号: ${activeAccount.nickname} (点击进入设置)` : "需要登录 Cookie"}
        >
          {cookieLoggedIn && activeAccount ? (
            <>
              <div className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center border border-accent/20 shrink-0">
                {activeAccount.avatar_thumb ? (
                  <img src={activeAccount.avatar_thumb} alt={activeAccount.nickname} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-accent-soft text-accent text-[0.62rem] font-bold flex items-center justify-center">
                    {activeAccount.nickname.slice(0, 1).toUpperCase()}
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-col items-start max-lg:hidden">
                <span className="text-[0.72rem] font-semibold text-text truncate w-full">
                  {activeAccount.nickname}
                </span>
                <span className="text-[0.62rem] font-medium text-success">
                  已登录
                </span>
              </div>
            </>
          ) : (
            <>
              <Circle className={cn(
                "w-2.5 h-2.5 ml-1 shrink-0",
                cookieLoggedIn ? "fill-success text-success" : "fill-warning text-warning"
              )} />
              <span className="text-[0.72rem] font-medium text-text-muted max-lg:hidden">
                {cookieLoggedIn ? "已登录" : "需要登录 Cookie"}
              </span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
