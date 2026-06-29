import { useLayoutEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import { Sidebar } from "./sidebar";
import { BottomBar } from "./bottom-bar";
import { CommandPopover } from "./command-popover";
import { WindowControls } from "./window-controls";
import { Hero } from "@/components/home/hero";
import { SearchView } from "@/components/search/search-view";
import { VideoGrid } from "@/components/search/video-grid";
import { UserDetail } from "@/components/search/user-detail";
import { LinkView } from "@/components/link/link-view";
import { RecommendedFeed } from "@/components/recommended/feed";
import { DownloadsView } from "@/components/downloads/downloads-view";
import { SettingsView } from "@/components/settings/settings-view";
import { LikedView } from "@/components/liked/liked-view";
import { CollectedView } from "@/components/collected/collected-view";
import { FriendsStatusView } from "@/components/friends/friends-status-view";
import { AnimatePresence, motion } from "framer-motion";
import { cn, easeConfig } from "@/lib/utils";

export function AppShell() {
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
            "relative flex-1 overflow-x-hidden rounded-t-[24px]",
            currentView === "friends-status"
              ? "flex flex-col overflow-y-hidden pb-[58px] pt-2"
              : "overflow-y-auto pb-16 pt-2"
          )}
        >
          <AnimatePresence initial={false} mode="popLayout">
            {renderView(currentView)}
          </AnimatePresence>
        </div>
        <BottomBar />
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
          <RecommendedFeed />
        </motion.div>
      );
    case "downloads":
      return (
        <motion.div key="downloads" {...variants} transition={transition} className="p-6">
          <DownloadsView />
        </motion.div>
      );
    case "liked":
      return (
        <motion.div key="liked" {...variants} transition={transition} className="p-6">
          <LikedView />
        </motion.div>
      );
    case "collected":
      return (
        <motion.div key="collected" {...variants} transition={transition} className="p-6">
          <CollectedView />
        </motion.div>
      );
    case "friends-status":
      return (
        <motion.div key="friends-status" {...variants} transition={transition} className="box-border h-full min-h-0 pt-2 pb-0 px-4">
          <FriendsStatusView />
        </motion.div>
      );
    case "settings":
      return (
        <motion.div key="settings" {...variants} transition={transition}>
          <SettingsView />
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
