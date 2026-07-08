import { useState, useEffect, useCallback } from "react";
import { useAppStore, useDownloadStore } from "@/stores/app-store";
import type { ViewType } from "@/types";
import { Badge } from "@/components/ui/badge";
import { getAccounts, mediaProxyUrl, switchAccount, deleteAccount, type AccountInfo } from "@/lib/tauri";
import { ThemeLogo } from "@/components/common/theme-logo";
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
  Bell,
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { toggleWindowMaximize } from "./window-controls";

interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ElementType;
}

const navItems: NavItem[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "search", label: "搜索", icon: Search },
  { id: "user", label: "用户主页", icon: UserRound },
  { id: "recommended", label: "推荐视频", icon: Sparkles },
  { id: "downloads", label: "我的下载", icon: FolderOpen },
  { id: "liked", label: "点赞视频", icon: Heart },
  { id: "collected", label: "收藏视频", icon: Star },
  { id: "notices", label: "通知", icon: Bell },
  { id: "friends-status", label: "好友", icon: Users },
  { id: "automation", label: "监控", icon: Activity },
  { id: "settings", label: "设置", icon: Settings },
];

const SIDEBAR_COLLAPSED_KEY = "bd_sidebar_collapsed";
const SIDEBAR_COLLAPSED_WIDTH = 72;
const SIDEBAR_EXPANDED_WIDTH = 200;

function readSidebarCollapsed() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
}

function SidebarHint({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-[60] -translate-y-1/2 translate-x-0 whitespace-nowrap rounded-[10px] border border-black/[0.08] bg-white px-3 py-1.5 text-[0.75rem] font-semibold leading-none text-[#1f2937] opacity-0 shadow-[0_8px_20px_rgba(15,23,42,0.14)] transition-[opacity,transform] duration-150 ease-out group-hover:translate-x-1 group-hover:opacity-100 dark:border-white/[0.10] dark:bg-white dark:text-[#1f2937]">
      {children}
    </span>
  );
}

function AccountAvatar({ account, className }: { account: AccountInfo; className: string }) {
  const avatarSrc = account.avatar_thumb ? mediaProxyUrl(account.avatar_thumb, "image") : "";
  const initial = (account.nickname || account.sec_uid || "?").slice(0, 1).toUpperCase();
  return (
    <div className={cn("relative overflow-hidden rounded-full bg-white/5 text-text-muted", className)}>
      {avatarSrc ? (
        <img
          src={avatarSrc}
          alt={account.nickname}
          className="absolute inset-0 h-full w-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      <div className="flex h-full w-full items-center justify-center text-[0.62rem] font-bold">
        {initial ? initial : <UserRound className="h-4 w-4" />}
      </div>
    </div>
  );
}

export function Sidebar() {
  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const friendUnreadCount = useAppStore((s) => s.friendUnreadCount);
  const noticeUnreadCount = useAppStore((s) => s.noticeUnreadCount);
  const activeCount = useDownloadStore((s) => s.activeCount);
  const [activeAccount, setActiveAccount] = useState<AccountInfo | null>(null);
  const [allAccounts, setAllAccounts] = useState<AccountInfo[]>([]);
  const [currentSecUid, setCurrentSecUid] = useState("");
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [showPopover, setShowPopover] = useState(false);

  const fetchActiveAccount = useCallback(async () => {
    try {
      const res = await getAccounts();
      if (res.success) {
        setAllAccounts(res.accounts || []);
        setCurrentSecUid(res.current_sec_uid || "");
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
        useAppStore.getState().setCookieLoggedIn(false);
      }
    } catch (e) {
      console.error("加载边栏头像失败", e);
    }
  }, []);

  const handleSwitchAccount = async (secUid: string) => {
    try {
      const res = await switchAccount(secUid);
      if (res.success) {
        await fetchActiveAccount();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleLogout = async (secUid: string) => {
    try {
      const res = await deleteAccount(secUid);
      if (res.success) {
        await fetchActiveAccount();
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    void fetchActiveAccount();
  }, [currentView, cookieLoggedIn, fetchActiveAccount]);

  const handleNavClick = (item: NavItem) => {
    setView(item.id);
  };

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  const isPyWebView = typeof window !== "undefined" && Boolean((window as any).pywebview);
  const isMacOS = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
  const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
  const brandTopPadding = isPyWebView && isWindows ? "pt-10" : "pt-7 pb-5";

  return (
    <motion.aside
      className="relative z-20 flex h-full shrink-0 flex-col overflow-visible bg-surface-solid/60 backdrop-blur-2xl shadow-[1px_0_0_0_var(--color-border),16px_0_40px_rgba(0,0,0,0.04)]"
      initial={false}
      animate={{ width: collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
    >
      <div
        className={cn(
          "pywebview-drag-region flex items-center gap-3 pb-5",
          collapsed ? "justify-center px-3" : "px-4",
          brandTopPadding
        )}
        onDoubleClick={toggleWindowMaximize}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties & { WebkitAppRegion: string }}
      >
        {collapsed ? (
          <button
            type="button"
            aria-label="展开侧边栏"
            title="展开侧边栏"
            onClick={toggleCollapsed}
            className="group relative flex h-10 w-10 items-center justify-center overflow-visible rounded-[14px] transition-transform active:scale-95"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties & { WebkitAppRegion: string }}
          >
            <ThemeLogo label="better-douyin" className="w-10 h-10" />
            <SidebarHint>展开侧边栏</SidebarHint>
          </button>
        ) : (
          <div className="relative flex h-10 w-10 items-center justify-center overflow-visible rounded-[14px]">
            <ThemeLogo label="better-douyin" className="w-10 h-10" />
          </div>
        )}
        <div
          className={cn(
            "flex min-w-0 flex-col overflow-hidden transition-opacity duration-100",
            collapsed ? "w-0 opacity-0" : "flex-1 opacity-100"
          )}
        >
          <span className="truncate text-[0.9rem] font-[780] tracking-tight text-text">
            better-douyin
          </span>
          <span className="whitespace-nowrap text-[0.7rem] font-semibold text-text-muted tracking-wide">
            本地媒体工作台
          </span>
        </div>
      </div>

      {/* Navigation */}
      <nav
        className={cn(
          "flex-1 flex flex-col gap-1 overflow-visible px-[14px]",
          collapsed && "items-center"
        )}
      >
        <div className={cn("mb-2 flex h-8 shrink-0 items-center", collapsed ? "justify-center" : "justify-between px-[3px]")}>
          {collapsed ? (
            <button
              type="button"
              aria-label="展开侧边栏"
              title="展开侧边栏"
              onClick={toggleCollapsed}
              className="flex h-8 w-8 items-center justify-center rounded-[9px] text-text-muted transition-[background-color,color,transform] hover:bg-surface-raised hover:text-text active:scale-95"
            >
              <PanelLeftOpen className="h-4 w-4" />
            </button>
          ) : (
            <>
              <span className="text-[0.68rem] font-bold uppercase tracking-[0.08em] text-text-muted">
                导航
              </span>
              <button
                type="button"
                aria-label="收起侧边栏"
                title="收起侧边栏"
                onClick={toggleCollapsed}
                className="flex h-7 w-7 items-center justify-center rounded-[9px] text-text-muted transition-[background-color,color,transform] hover:bg-surface-raised hover:text-text active:scale-95"
              >
                <PanelLeftClose className="h-4 w-4" />
              </button>
            </>
          )}
        </div>

        {navItems.map((item) => {
          const isActive = currentView === item.id;
          const Icon = item.icon;

          return (
            <button
              key={item.label}
              onClick={() => handleNavClick(item)}
              title={item.label}
              aria-label={item.label}
              className={cn(
                "group relative flex h-[42px] items-center rounded-[14px] text-left transition-[background-color,color,box-shadow,transform] duration-[var(--duration-fast)] ease-[var(--ease-spring)] cursor-pointer",
                collapsed ? "w-[44px] justify-center px-0" : "w-full gap-3 px-[13px]",
                isActive
                  ? "bg-accent-soft text-accent shadow-[0_8px_24px_rgba(254,44,85,0.10)]"
                  : "text-text-muted hover:text-text hover:bg-surface-raised"
              )}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              {collapsed && <SidebarHint>{item.label}</SidebarHint>}
              <span
                className={cn(
                  "min-w-0 truncate text-[0.8125rem] font-semibold transition-opacity duration-100",
                  collapsed ? "w-0 opacity-0" : "flex-1 opacity-100"
                )}
              >
                {item.label}
              </span>

              {item.id === "downloads" && activeCount > 0 && (
                <Badge variant="default" size="sm" className={cn(collapsed ? "absolute -right-1 -top-1" : "ml-auto")}>
                  {activeCount}
                </Badge>
              )}
              {item.id === "friends-status" && friendUnreadCount > 0 && (
                <Badge variant="default" size="sm" className={cn(collapsed ? "absolute -right-1 -top-1" : "ml-auto")}>
                  {friendUnreadCount > 99 ? "99+" : friendUnreadCount}
                </Badge>
              )}
              {item.id === "notices" && noticeUnreadCount > 0 && (
                <Badge variant="default" size="sm" className={cn(collapsed ? "absolute -right-1 -top-1" : "ml-auto")}>
                  {noticeUnreadCount > 99 ? "99+" : noticeUnreadCount}
                </Badge>
              )}
            </button>
          );
        })}
      </nav>

      {/* Status — pinned to bottom */}
      <div 
        onMouseEnter={() => setShowPopover(true)}
        onMouseLeave={() => setShowPopover(false)}
        className={cn("relative px-[14px] py-3", collapsed && "flex justify-center")}
      >
        <AnimatePresence>
          {showPopover && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className={cn(
                "absolute bottom-[calc(100%-4px)] left-[14px] z-50 rounded-2xl border border-white/[0.08] bg-surface-solid/95 p-3.5 shadow-[0_12px_36px_rgba(0,0,0,0.3)] backdrop-blur-xl text-left flex flex-col gap-3",
                collapsed ? "w-[220px]" : "w-[172px]"
              )}
            >
              {cookieLoggedIn && activeAccount ? (
                <div className="flex items-center gap-2.5 pb-2.5 border-b border-white/[0.06]">
                  <AccountAvatar account={activeAccount} className="h-9 w-9 shrink-0 border border-accent/20" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.78rem] font-bold text-text truncate">{activeAccount.nickname}</div>
                    <div className="text-[0.62rem] text-success font-semibold flex items-center gap-1">
                      <span className="w-1 h-1 rounded-full bg-success animate-pulse" /> 已登录
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2.5 pb-2.5 border-b border-white/[0.06]">
                  <div className="w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
                    <UserRound className="w-4 h-4 text-text-muted" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[0.78rem] font-bold text-text-muted">未登录</div>
                    <div className="text-[0.62rem] text-text-muted">需要登录 Cookie</div>
                  </div>
                </div>
              )}

              {allAccounts.length > 1 && (
                <div className="flex flex-col gap-1 max-h-[120px] overflow-y-auto pr-1">
                  <span className="text-[0.58rem] font-bold text-text-muted uppercase tracking-wider mb-1">切换账号</span>
                  {allAccounts.map((acc) => {
                    if (acc.sec_uid === currentSecUid) return null;
                    return (
                      <button
                        key={acc.sec_uid}
                        onClick={() => handleSwitchAccount(acc.sec_uid)}
                        className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/5 text-left transition-colors cursor-pointer"
                      >
                        <AccountAvatar account={acc} className="h-6 w-6 shrink-0" />
                        <span className="text-[0.7rem] font-semibold text-text truncate flex-1">{acc.nickname}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-col gap-0.5">
                <button
                  onClick={() => { setView("settings"); setShowPopover(false); }}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-white/5 text-[0.7rem] font-semibold text-text transition-colors cursor-pointer"
                >
                  <Settings className="w-3.5 h-3.5 text-text-muted" />
                  <span>账号与设置</span>
                </button>
                {cookieLoggedIn && activeAccount && (
                  <button
                    onClick={() => { handleLogout(activeAccount.sec_uid); setShowPopover(false); }}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-red-500/10 hover:text-red-400 text-[0.7rem] font-semibold text-red-400/80 transition-colors cursor-pointer"
                  >
                    <UserRound className="w-3.5 h-3.5" />
                    <span>退出当前账号</span>
                  </button>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={() => setView("settings")}
          className={cn(
            "group relative flex h-[48px] items-center rounded-[14px] hover:bg-surface-raised active:scale-95 transition-[background-color,transform] cursor-pointer",
            collapsed ? "w-[44px] justify-center px-0" : "w-full gap-3 px-[13px]"
          )}
          title={cookieLoggedIn && activeAccount ? `当前账号: ${activeAccount.nickname} (点击进入设置)` : "需要登录 Cookie"}
        >
          {cookieLoggedIn && activeAccount ? (
            <>
              <div className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center border border-accent/20 shrink-0">
                <AccountAvatar account={activeAccount} className="h-full w-full" />
              </div>
              {collapsed && <SidebarHint>{activeAccount.nickname}</SidebarHint>}
              <div
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden transition-opacity duration-100",
                  collapsed ? "w-0 opacity-0" : "flex-1 opacity-100"
                )}
              >
                <span className="text-[0.72rem] font-semibold text-text truncate max-w-[100px]">
                  {activeAccount.nickname}
                </span>
                <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" title="已登录" />
              </div>
            </>
          ) : (
            <>
              <div className="w-7 h-7 rounded-full overflow-hidden flex items-center justify-center border border-white/10 bg-white/5 shrink-0">
                <UserRound className="w-4 h-4 text-text-muted" />
              </div>
              {collapsed && <SidebarHint>需要登录 Cookie</SidebarHint>}
              <div
                className={cn(
                  "flex min-w-0 items-center gap-1.5 overflow-hidden transition-opacity duration-100",
                  collapsed ? "w-0 opacity-0" : "flex-1 opacity-100"
                )}
              >
                <span className="text-[0.72rem] font-medium text-text-muted truncate max-w-[100px]">
                  未登录
                </span>
                <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" title="未登录" />
              </div>
            </>
          )}
        </button>
      </div>
    </motion.aside>
  );
}
