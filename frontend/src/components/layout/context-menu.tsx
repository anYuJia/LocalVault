import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, RefreshCw, ArrowUp, Info } from "lucide-react";
import { useAlertStore } from "@/stores/app-store";

export function ContextMenu() {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [selectedText, setSelectedText] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const showAlert = useAlertStore((s) => s.showAlert);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      
      // If right-clicking inside an input, textarea, or editable element, keep the browser default menu
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        target.closest("input, textarea, [contenteditable='true']")
      ) {
        setVisible(false);
        return;
      }

      e.preventDefault();

      const selection = window.getSelection()?.toString().trim() || "";
      setSelectedText(selection);

      // Position logic: keep the menu within screen boundaries
      let x = e.clientX;
      let y = e.clientY;
      const menuWidth = 160;
      const menuHeight = 160;

      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 8;
      }

      setPosition({ x, y });
      setVisible(true);
    };

    const handleClickOutside = (e: Event) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVisible(false);
      }
    };

    window.addEventListener("contextmenu", handleContextMenu);
    window.addEventListener("click", handleClickOutside);
    window.addEventListener("scroll", handleClickOutside, true);

    return () => {
      window.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("click", handleClickOutside);
      window.removeEventListener("scroll", handleClickOutside, true);
    };
  }, []);

  const handleCopy = () => {
    if (selectedText) {
      void navigator.clipboard.writeText(selectedText);
    }
    setVisible(false);
  };

  const handleReload = () => {
    window.location.reload();
    setVisible(false);
  };

  const handleScrollTop = () => {
    // Find the scrollable main viewport and scroll it to top
    const mainScroll = document.querySelector("main div.overflow-y-auto");
    if (mainScroll) {
      mainScroll.scrollTo({ top: 0, behavior: "smooth" });
    }
    setVisible(false);
  };

  const handleAbout = () => {
    setVisible(false);
    showAlert({
      title: "better-douyin",
      variant: "info",
      description: (
        <div className="text-sm space-y-1">
          <p className="font-semibold">本地媒体工作台</p>
          <p className="text-text-muted text-xs">Version 1.0.32</p>
          <p className="text-text-muted text-xs">基于 React, TailwindCSS & pywebview 构建的优质短视频工作台。</p>
        </div>
      ),
      actionLabel: "确定",
    });
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: -4 }}
          transition={{ duration: 0.12, ease: "easeOut" }}
          style={{ top: position.y, left: position.x }}
          className="fixed z-[9999] w-40 overflow-hidden rounded-xl border border-white/[0.08] bg-surface-solid/80 p-1 shadow-lg backdrop-blur-md dark:border-white/[0.1] dark:bg-surface-solid/90"
        >
          {selectedText && (
            <>
              <button
                onClick={handleCopy}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-white/5 active:scale-98 transition-transform"
              >
                <Copy className="h-3.5 w-3.5 text-text-secondary" />
                <span>复制选中</span>
              </button>
              <div className="my-1 border-t border-white/[0.06]" />
            </>
          )}

          <button
            onClick={handleReload}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-white/5 active:scale-98 transition-transform"
          >
            <RefreshCw className="h-3.5 w-3.5 text-text-secondary" />
            <span>重新加载</span>
          </button>

          <button
            onClick={handleScrollTop}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-white/5 active:scale-98 transition-transform"
          >
            <ArrowUp className="h-3.5 w-3.5 text-text-secondary" />
            <span>返回顶部</span>
          </button>

          <div className="my-1 border-t border-white/[0.06]" />

          <button
            onClick={handleAbout}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-white/5 active:scale-98 transition-transform"
          >
            <Info className="h-3.5 w-3.5 text-text-secondary" />
            <span>关于应用</span>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
