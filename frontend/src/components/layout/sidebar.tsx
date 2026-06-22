import { useAppStore, useDownloadStore } from "@/stores/app-store";
import type { ViewType } from "@/types";
import { Badge } from "@/components/ui/badge";
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
import { motion } from "framer-motion";
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
  const currentView = useAppStore((s) => s.currentView);
  const setView = useAppStore((s) => s.setView);
  const cookieLoggedIn = useAppStore((s) => s.cookieLoggedIn);
  const friendUnreadCount = useAppStore((s) => s.friendUnreadCount);
  const activeCount = useDownloadStore((s) => s.activeCount);

  const handleNavClick = (item: NavItem) => {
    setView(item.id);
  };

  const isPyWebView = typeof window !== "undefined" && Boolean((window as any).pywebview);

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col bg-surface-solid/60 backdrop-blur-2xl shadow-[1px_0_0_0_var(--color-border),16px_0_40px_rgba(0,0,0,0.04)] max-lg:w-[72px]">
      {/* Brand */}
      <motion.div
        className={`flex items-center gap-3 px-5 pb-5 max-lg:justify-center max-lg:px-3 ${isPyWebView ? "pt-10" : "py-5"}`}
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
      <div className="px-3 py-3">
        <div className="flex h-[42px] items-center gap-2 rounded-[14px] bg-surface/50 px-3 text-text-muted max-lg:justify-center max-lg:px-0" title={cookieLoggedIn ? "已登录" : "需要登录 Cookie"}>
          <Circle className={cn(
            "w-2 h-2",
            cookieLoggedIn ? "fill-success text-success" : "fill-warning text-warning"
          )} />
          <span className="text-[0.72rem] font-medium max-lg:hidden">
            {cookieLoggedIn ? "已登录" : "需要登录 Cookie"}
          </span>
        </div>
      </div>
    </aside>
  );
}
