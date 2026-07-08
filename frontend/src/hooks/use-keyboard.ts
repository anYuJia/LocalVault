import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";

// ═══════════════════════════════════════════════
// Keyboard Shortcuts Hook
// ═══════════════════════════════════════════════

export function useKeyboard() {
  const setCommandOpen = useAppStore((s) => s.setCommandOpen);
  const setView = useAppStore((s) => s.setView);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const toggleBottomBar = useAppStore((s) => s.toggleBottomBar);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      // Cmd+K — Search users
      if (isMeta && e.key === "k") {
        e.preventDefault();
        setView("search");
        return;
      }

      // Cmd+L — Link input
      if (isMeta && e.key === "l") {
        e.preventDefault();
        setView("link");
        return;
      }

      // Cmd+, — Settings
      if (isMeta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }

      // Cmd+J — Toggle bottom bar
      if (isMeta && e.key === "j") {
        e.preventDefault();
        toggleBottomBar();
        return;
      }

      // Escape — Close overlays
      if (e.key === "Escape") {
        const store = useAppStore.getState();
        if (store.commandOpen) {
          setCommandOpen(false);
          return;
        }
        if (store.settingsOpen) {
          setSettingsOpen(false);
          return;
        }
      }

      // Cmd+1-5 — Quick nav
      if (isMeta && ["1", "2", "3", "4", "5"].includes(e.key)) {
        e.preventDefault();
        const views = ["home", "search", "user", "recommended", "downloads"] as const;
        const idx = parseInt(e.key) - 1;
        if (views[idx]) {
          setView(views[idx]);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setCommandOpen, setView, setSettingsOpen, toggleBottomBar]);
}
