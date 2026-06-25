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
import { easeConfig } from "@/lib/utils";

export function AppShell() {
  const currentView = useAppStore((s) => s.currentView);
  const commandOpen = useAppStore((s) => s.commandOpen);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [currentView]);

  return (
    <div className="relative flex h-screen w-screen overflow-hidden">
      <WindowControls />
      {/* Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 relative">
        <div
          className="pywebview-drag-region absolute left-0 right-[132px] top-0 z-30 h-6 pointer-events-auto"
          style={{ WebkitAppRegion: "drag" } as React.CSSProperties & { WebkitAppRegion: string }}
        />
        <div ref={scrollRef} className="flex-1 overflow-x-hidden overflow-y-auto pb-16">
          <AnimatePresence initial={false} mode="wait">
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
    initial: { opacity: 0, y: 8, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -4, scale: 0.99 },
  };

  const transition = {
    duration: 0.22,
    ease: easeConfig,
    opacity: { duration: 0.15 },
  };

  switch (view) {
    case "home":
      return (
        <motion.div key="home" {...variants} transition={transition} className="h-full">
          <Hero />
        </motion.div>
      );
    case "search":
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
    case "link":
      return (
        <motion.div key="link" {...variants} transition={transition} className="p-6">
          <LinkView />
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
        <motion.div key="friends-status" {...variants} transition={transition} className="box-border h-full min-h-0 p-4">
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
