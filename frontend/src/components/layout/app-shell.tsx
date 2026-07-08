import { Suspense, lazy, useLayoutEffect, useRef, type ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";
import { Sidebar } from "./sidebar";
import { BottomBar } from "./bottom-bar";
import { CommandPopover } from "./command-popover";
import { WindowControls, toggleWindowMaximize } from "./window-controls";
import { Hero } from "@/components/home/hero";
import { SearchView } from "@/components/search/search-view";
import { VideoGrid } from "@/components/search/video-grid";
import { UserDetail } from "@/components/search/user-detail";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useGlobalNoticeMonitor } from "@/hooks/use-global-notice-monitor";

const RecommendedFeed = lazy(() => import("@/components/recommended/feed").then((module) => ({ default: module.RecommendedFeed })));
const DownloadsView = lazy(() => import("@/components/downloads/downloads-view").then((module) => ({ default: module.DownloadsView })));
const SettingsView = lazy(() => import("@/components/settings/settings-view").then((module) => ({ default: module.SettingsView })));
const LikedView = lazy(() => import("@/components/liked/liked-view").then((module) => ({ default: module.LikedView })));
const CollectedView = lazy(() => import("@/components/collected/collected-view").then((module) => ({ default: module.CollectedView })));
const FriendsStatusView = lazy(() => import("@/components/friends/friends-status-view").then((module) => ({ default: module.FriendsStatusView })));
const NoticesView = lazy(() => import("@/components/notices/notices-view").then((module) => ({ default: module.NoticesView })));
const AutomationView = lazy(() => import("@/components/automation/automation-view").then((module) => ({ default: module.AutomationView })));

function ViewFallback({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("animate-pulse", compact ? "h-full w-full" : "min-h-[360px] rounded-[var(--radius-xl)] border border-border/50 bg-surface-solid/40")} />
  );
}

function LazyView({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  return <Suspense fallback={<ViewFallback compact={compact} />}>{children}</Suspense>;
}

export function AppShell() {
  useGlobalNoticeMonitor();
  const currentView = useAppStore((s) => s.currentView);
  const commandOpen = useAppStore((s) => s.commandOpen);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isPyWebView = typeof window !== "undefined" && Boolean((window as any).pywebview);
  const isTauri = typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
  const isWindows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || "");
  const isMacOS = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");
  const needsTopInset = (isPyWebView || isTauri) && isWindows && !isMacOS;

  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [currentView]);

  return (
    <div className={cn("relative flex h-screen w-screen overflow-hidden", needsTopInset && "shadow-[inset_0_0_0_1px_var(--color-border)]")}>
      <WindowControls />
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <main className={cn("relative flex flex-col min-w-0 flex-1", needsTopInset ? "pt-9" : "pt-4")}>
        {isPyWebView && (
          <div
            className="pywebview-drag-region absolute left-0 top-0 z-30 h-8 pointer-events-auto"
            onDoubleClick={toggleWindowMaximize}
            style={{
              right: isWindows ? 132 : 0,
              left: isMacOS ? 132 : 0,
              WebkitAppRegion: "drag",
            } as React.CSSProperties & { WebkitAppRegion: string }}
          />
        )}
        <div
          ref={scrollRef}
          className={cn(
            "relative flex-1 overflow-x-hidden rounded-t-[24px] [scrollbar-gutter:stable]",
            currentView === "friends-status" || currentView === "notices"
              ? "flex flex-col overflow-y-hidden pb-1 pt-2"
              : "overflow-y-auto pb-16 pt-2"
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {renderView(currentView)}
          </AnimatePresence>
        </div>
        {currentView !== "friends-status" && currentView !== "notices" && <BottomBar />}
      </main>

      {/* Command Popover (Raycast-style) */}
      <AnimatePresence>
        {commandOpen && <CommandPopover />}
      </AnimatePresence>
    </div>
  );
}

function renderView(view: string) {
  const variants = {
    initial: { opacity: 0, y: 6 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -6 },
  };

  const transition = {
    duration: 0.16,
    ease: "easeOut" as const,
  };

  switch (view) {
    case "home":
      return (
        <motion.div key="home" {...variants} transition={transition} className="h-full">
          <Hero />
        </motion.div>
      );
    case "search":
    case "link":
      return (
        <motion.div key="search" {...variants} transition={transition} className="p-6">
          <SearchView />
        </motion.div>
      );
    case "user":
      return (
        <motion.div key="user" {...variants} transition={transition} className="p-6">
          <UserDetail />
          <VideoGrid />
        </motion.div>
      );
    case "recommended":
      return (
        <motion.div key="recommended" {...variants} transition={transition} className="p-6">
          <LazyView>
            <RecommendedFeed />
          </LazyView>
        </motion.div>
      );
    case "downloads":
      return (
        <motion.div key="downloads" {...variants} transition={transition} className="p-6">
          <LazyView>
            <DownloadsView />
          </LazyView>
        </motion.div>
      );
    case "liked":
      return (
        <motion.div key="liked" {...variants} transition={transition} className="p-6">
          <LazyView>
            <LikedView />
          </LazyView>
        </motion.div>
      );
    case "collected":
      return (
        <motion.div key="collected" {...variants} transition={transition} className="p-6">
          <LazyView>
            <CollectedView />
          </LazyView>
        </motion.div>
      );
    case "friends-status":
      return (
        <motion.div key="friends-status" {...variants} transition={transition} className="box-border h-full min-h-0 pt-2 pb-0 px-4">
          <LazyView compact>
            <FriendsStatusView />
          </LazyView>
        </motion.div>
      );
    case "notices":
      return (
        <motion.div key="notices" {...variants} transition={transition} className="box-border h-full min-h-0 pt-2 pb-0 px-4">
          <LazyView compact>
            <NoticesView />
          </LazyView>
        </motion.div>
      );
    case "automation":
      return (
        <motion.div key="automation" {...variants} transition={transition} className="p-4">
          <LazyView>
            <AutomationView />
          </LazyView>
        </motion.div>
      );
    case "settings":
      return (
        <motion.div key="settings" {...variants} transition={transition}>
          <LazyView>
            <SettingsView />
          </LazyView>
        </motion.div>
      );
    default:
      return (
        <motion.div key="home" {...variants} transition={transition} className="h-full">
          <Hero />
        </motion.div>
      );
  }
}
