import { Maximize2, Minus, X } from "lucide-react";

type PyWebViewWindowApi = {
  minimize?: () => Promise<void> | void;
  toggle_maximize?: () => Promise<void> | void;
  close?: () => Promise<void> | void;
};

type DesktopWindow = Window & {
  __TAURI_INTERNALS__?: unknown;
  pywebview?: {
    api?: PyWebViewWindowApi;
  };
};

function isMacOS() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

async function callWindowAction(action: "minimize" | "toggle_maximize" | "close") {
  if (typeof window === "undefined") return;
  const desktopWindow = window as DesktopWindow;

  if (desktopWindow.__TAURI_INTERNALS__) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const currentWindow = getCurrentWindow();
    if (action === "minimize") await currentWindow.minimize();
    if (action === "toggle_maximize") await currentWindow.toggleMaximize();
    if (action === "close") await currentWindow.close();
    return;
  }

  const pywebviewApi = desktopWindow.pywebview?.api;
  const pywebviewAction = pywebviewApi?.[action];
  if (typeof pywebviewAction === "function") {
    await pywebviewAction();
  }
}

export function WindowControls() {
  if (isMacOS()) return null;

  return (
    <div className="fixed right-0 top-0 z-[9000] flex h-9 select-none" data-no-window-drag>
      <button
        type="button"
        aria-label="最小化窗口"
        title="最小化"
        className="flex h-9 w-11 items-center justify-center text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
        onClick={() => void callWindowAction("minimize")}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        aria-label="最大化或还原窗口"
        title="最大化/还原"
        className="flex h-9 w-11 items-center justify-center text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
        onClick={() => void callWindowAction("toggle_maximize")}
      >
        <Maximize2 className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="关闭窗口"
        title="关闭"
        className="flex h-9 w-11 items-center justify-center text-text-muted transition-colors hover:bg-danger hover:text-white"
        onClick={() => void callWindowAction("close")}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
