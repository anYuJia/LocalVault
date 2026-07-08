import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Info } from "lucide-react";
import { cn, formatDuration, formatNumber } from "@/lib/utils";
import type { VideoMediaItem } from "@/lib/video-media";
import {
  PROGRESS_PREVIEW_HEIGHT,
  PROGRESS_PREVIEW_SAMPLE_RATIOS,
  PROGRESS_PREVIEW_WIDTH,
  finiteMediaTime,
  releaseMediaElement,
} from "./player-utils";

export function TimeLabel({ currentTime, duration }: { currentTime: number; duration: number }) {
  return (
    <div className="shrink-0 text-[0.68rem] font-medium tabular-nums text-white/72">
      {formatDuration(currentTime)} / {formatDuration(duration)}
    </div>
  );
}

export function InlinePlayerButton({
  children,
  label,
  count,
  active,
  activeClassName,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  activeClassName?: string;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white transition-[background-color,transform,color,opacity] hover:scale-[1.08] hover:bg-white/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100",
          active && activeClassName
        )}
        aria-label={label}
        title={label}
      >
        {children}
      </button>
      {typeof count === "number" && (
        <span className="text-[0.78rem] font-medium tabular-nums text-white/85 drop-shadow-md">
          {formatNumber(count)}
        </span>
      )}
    </div>
  );
}

export function PlayerIconButton({
  children,
  label,
  active,
  disabled,
  onClick,
  onPointerDown,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-full bg-transparent text-white transition-[background-color,color] hover:bg-white/10 active:bg-white/15",
        active && "bg-white/10",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent active:bg-transparent"
      )}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

export function PlayerStatus({
  title,
  message,
  state = "loading",
  onRetry,
}: {
  title: string;
  message: string;
  state?: "loading" | "error";
  onRetry?: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className="absolute left-1/2 top-1/2 z-20 flex w-[min(360px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 rounded-[14px] border border-white/12 bg-black/45 px-5 py-4 text-center backdrop-blur-xl">
      <div
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full",
          state === "error" ? "bg-warning-soft text-warning" : "bg-white/10 text-white"
        )}
      >
        {state === "error" ? <Info className="h-5 w-5" /> : <span className="h-5 w-5 animate-spin rounded-full border-2 border-white/25 border-t-white" />}
      </div>
      <div className="text-[0.9rem] font-semibold">{title}</div>
      <div className="text-[0.78rem] leading-relaxed text-white/68">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 h-8 rounded-[8px] border border-white/16 bg-white/10 px-3 text-[0.78rem] text-white transition-colors hover:bg-white/18"
        >
          重试
        </button>
      )}
    </div>
  );
}

export function ProgressBar({
  duration,
  currentTime,
  progressPct,
  mediaItems,
  mediaIndex,
  previewSrc,
  onSeek,
  onSelectMedia,
}: {
  duration: number;
  currentTime: number;
  progressPct: number;
  mediaItems: VideoMediaItem[];
  mediaIndex: number;
  previewSrc?: string;
  onSeek: (time: number) => void;
  onSelectMedia: (index: number) => void;
}) {
  const pointerDraggingRef = useRef(false);
  const mouseDraggingRef = useRef(false);
  const touchDraggingRef = useRef(false);
  const [hoverPreview, setHoverPreview] = useState({
    visible: false,
    x: 0,
    width: 0,
    time: 0,
  });

  const updateHoverPreview = useCallback((target: HTMLDivElement, clientX: number, visible = true) => {
    if (!duration) {
      setHoverPreview((current) => current.visible ? { ...current, visible: false } : current);
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;

    const rawX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rawX / rect.width;

    setHoverPreview({
      visible,
      x: rawX,
      width: rect.width,
      time: ratio * duration,
    });
  }, [duration]);

  const previewX = hoverPreview.width > 0
    ? Math.min(
        Math.max(hoverPreview.x, PROGRESS_PREVIEW_WIDTH / 2),
        Math.max(PROGRESS_PREVIEW_WIDTH / 2, hoverPreview.width - PROGRESS_PREVIEW_WIDTH / 2)
      )
    : hoverPreview.x;

  const hideHoverPreview = useCallback(() => {
    if (pointerDraggingRef.current || mouseDraggingRef.current || touchDraggingRef.current) return;
    setHoverPreview((current) => current.visible ? { ...current, visible: false } : current);
  }, []);

  const seekFromClientX = useCallback((target: HTMLDivElement, clientX: number) => {
    if (!duration) return;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(ratio * duration);
  }, [duration, onSeek]);

  const handleSeekPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    pointerDraggingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateHoverPreview(event.currentTarget, event.clientX);
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      updateHoverPreview(event.currentTarget, event.clientX);
    }
    if (!pointerDraggingRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekPointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointerDraggingRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, event.clientX);
    pointerDraggingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (event.pointerType !== "touch") {
      updateHoverPreview(event.currentTarget, event.clientX);
    } else {
      hideHoverPreview();
    }
  }, [hideHoverPreview, seekFromClientX, updateHoverPreview]);

  const handleSeekClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (pointerDraggingRef.current || mouseDraggingRef.current) return;
    seekFromClientX(event.currentTarget, event.clientX);
  }, [seekFromClientX]);

  const handleSeekMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    event.stopPropagation();
    event.preventDefault();
    const target = event.currentTarget;
    mouseDraggingRef.current = true;
    updateHoverPreview(target, event.clientX);
    seekFromClientX(target, event.clientX);

    const handleMove = (moveEvent: MouseEvent) => {
      moveEvent.preventDefault();
      updateHoverPreview(target, moveEvent.clientX);
      seekFromClientX(target, moveEvent.clientX);
    };
    const handleUp = (upEvent: MouseEvent) => {
      upEvent.preventDefault();
      seekFromClientX(target, upEvent.clientX);
      mouseDraggingRef.current = false;
      updateHoverPreview(target, upEvent.clientX);
      ownerWindow.removeEventListener("mousemove", handleMove);
      ownerWindow.removeEventListener("mouseup", handleUp);
    };

    ownerWindow.addEventListener("mousemove", handleMove);
    ownerWindow.addEventListener("mouseup", handleUp);
  }, [seekFromClientX, updateHoverPreview]);

  const handleSeekTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    const ownerWindow = event.currentTarget.ownerDocument.defaultView || window;
    if (typeof ownerWindow.PointerEvent !== "undefined") return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    touchDraggingRef.current = true;
    seekFromClientX(event.currentTarget, touch.clientX);
  }, [seekFromClientX]);

  const handleSeekTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!touchDraggingRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, touch.clientX);
  }, [seekFromClientX]);

  const handleSeekTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!touchDraggingRef.current) return;
    const touch = event.changedTouches[0];
    if (!touch) return;
    event.stopPropagation();
    event.preventDefault();
    seekFromClientX(event.currentTarget, touch.clientX);
    touchDraggingRef.current = false;
  }, [seekFromClientX]);

  if (mediaItems.length > 1) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {mediaItems.map((item, index) => {
            const fill = index < mediaIndex ? 100 : index === mediaIndex ? progressPct : 0;
            return (
              <button
                key={`${item.type}-${item.url}-${index}`}
                className="relative h-1.5 min-w-[18px] flex-1 overflow-hidden rounded-full bg-white/18"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectMedia(index);
                }}
                aria-label={`切换到第 ${index + 1} 个媒体`}
              >
                <span
                  className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-gradient-to-r from-white/90 to-accent transition-transform duration-100 ease-linear"
                  style={{ transform: `scaleX(${fill / 100})` }}
                />
              </button>
            );
          })}
        </div>
        <TimeLabel currentTime={currentTime} duration={duration} />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div
        data-player-control="true"
        className="group relative flex h-6 flex-1 cursor-pointer touch-none select-none items-center"
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") {
            updateHoverPreview(event.currentTarget, event.clientX);
          }
        }}
        onPointerDown={handleSeekPointerDown}
        onPointerMove={handleSeekPointerMove}
        onPointerLeave={hideHoverPreview}
        onPointerUp={handleSeekPointerEnd}
        onPointerCancel={handleSeekPointerEnd}
        onClick={handleSeekClick}
        onMouseDown={handleSeekMouseDown}
        onTouchStart={handleSeekTouchStart}
        onTouchMove={handleSeekTouchMove}
        onTouchEnd={handleSeekTouchEnd}
        onTouchCancel={handleSeekTouchEnd}
      >
        <div
          className={cn(
            "absolute left-0 right-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full transition-[height,background-color] duration-150",
            hoverPreview.visible ? "h-1.5 bg-white/28" : "h-[2px] bg-white/10"
          )}
        >
          <div
            className={cn(
              "absolute inset-y-0 left-0 w-full origin-left rounded-full transition-[background-color,transform] duration-100 ease-linear",
              hoverPreview.visible ? "bg-accent" : "bg-accent/80"
            )}
            style={{ transform: `scaleX(${progressPct / 100})` }}
          />
        </div>
        <div
          className={cn(
            "absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full bg-white shadow-md transition-opacity",
            hoverPreview.visible ? "opacity-100" : "opacity-0"
          )}
          style={{ left: `calc(${progressPct}% - 6px)` }}
        />
        {duration > 0 && previewSrc && (
          <div
            className={cn(
              "pointer-events-none absolute bottom-full z-50 mb-3 transition-[opacity,transform] duration-150",
              hoverPreview.visible ? "opacity-100" : "opacity-0"
            )}
            style={{
              left: hoverPreview.visible ? previewX : 0,
              transform: `translateX(-50%) translateY(${hoverPreview.visible ? "0" : "6px"})`,
            }}
          >
            <div
              className="relative overflow-hidden rounded-[8px] border border-white/14 bg-black/90 shadow-[0_14px_36px_rgba(0,0,0,0.42)]"
              style={{
                width: PROGRESS_PREVIEW_WIDTH,
                height: PROGRESS_PREVIEW_HEIGHT,
              }}
            >
              <ProgressFramePreview
                src={previewSrc || ""}
                time={hoverPreview.time}
                duration={duration}
                visible={hoverPreview.visible}
              />
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/78 to-transparent px-2 pb-1.5 pt-5">
                <span className="rounded-full bg-black/72 px-2 py-0.5 text-[0.68rem] font-bold tabular-nums text-white shadow-[0_8px_18px_rgba(0,0,0,0.28)]">
                  {formatDuration(hoverPreview.time)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
      <TimeLabel currentTime={currentTime} duration={duration} />
    </div>
  );
}

function ProgressFramePreview({
  src,
  time,
  duration,
  visible,
}: {
  src: string;
  time: number;
  duration: number;
  visible: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const latestTimeRef = useRef(time);
  const latestVisibleRef = useRef(visible);
  const thumbnailCacheRef = useRef<Array<{ time: number; dataUrl: string }>>([]);
  const pendingSeekFrameRef = useRef<number | null>(null);
  const pendingDrawFrameRef = useRef<number | null>(null);
  const sampleTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const samplingCancelledRef = useRef(false);
  const lastExactTimeRef = useRef(-1);
  const [fallbackFrame, setFallbackFrame] = useState<string>("");
  const [frameReady, setFrameReady] = useState(false);

  useEffect(() => {
    latestTimeRef.current = time;
  }, [time]);

  useEffect(() => {
    latestVisibleRef.current = visible;
  }, [visible]);

  const nearestFallbackFrame = useCallback((targetTime: number) => {
    let best = "";
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const cached of thumbnailCacheRef.current) {
      const distance = Math.abs(cached.time - targetTime);
      if (distance < bestDistance) {
        best = cached.dataUrl;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  const drawPreviewFrame = useCallback(() => {
    const node = videoRef.current;
    const canvas = canvasRef.current;
    if (!node || !canvas || !node.videoWidth || !node.videoHeight || node.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return false;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvasWidth = Math.round(PROGRESS_PREVIEW_WIDTH * dpr);
    const canvasHeight = Math.round(PROGRESS_PREVIEW_HEIGHT * dpr);
    if (canvas.width !== canvasWidth) canvas.width = canvasWidth;
    if (canvas.height !== canvasHeight) canvas.height = canvasHeight;

    const sourceAspect = node.videoWidth / node.videoHeight;
    const targetAspect = canvasWidth / canvasHeight;
    let sourceX = 0;
    let sourceY = 0;
    let sourceWidth = node.videoWidth;
    let sourceHeight = node.videoHeight;

    if (sourceAspect > targetAspect) {
      sourceWidth = node.videoHeight * targetAspect;
      sourceX = (node.videoWidth - sourceWidth) / 2;
    } else {
      sourceHeight = node.videoWidth / targetAspect;
      sourceY = (node.videoHeight - sourceHeight) / 2;
    }

    try {
      const context = canvas.getContext("2d");
      if (!context) return false;
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      context.drawImage(
        node,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        canvasWidth,
        canvasHeight
      );
      setFrameReady(true);
      lastExactTimeRef.current = node.currentTime;
      return true;
    } catch {
      return false;
    }
  }, []);

  const capturePreviewDataUrl = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !drawPreviewFrame()) return "";
    try {
      return canvas.toDataURL("image/jpeg", 0.72);
    } catch {
      return "";
    }
  }, [drawPreviewFrame]);

  const requestPreviewDraw = useCallback(() => {
    if (pendingDrawFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingDrawFrameRef.current);
    }
    pendingDrawFrameRef.current = window.requestAnimationFrame(() => {
      pendingDrawFrameRef.current = null;
      drawPreviewFrame();
    });
  }, [drawPreviewFrame]);

  const seekPreview = useCallback((targetTime: number) => {
    const node = videoRef.current;
    if (!node || !src) return;
    const fallback = nearestFallbackFrame(targetTime);
    if (fallback) {
      setFallbackFrame(fallback);
      if (Math.abs(lastExactTimeRef.current - targetTime) > 0.35) {
        setFrameReady(false);
      }
    }
    if (node.readyState < HTMLMediaElement.HAVE_METADATA) {
      try {
        node.load();
      } catch {
        // Loading the preview node is opportunistic.
      }
      return;
    }

    const duration = finiteMediaTime(node.duration);
    const safeTime = duration > 0
      ? Math.min(Math.max(0, targetTime), Math.max(0, duration - 0.05))
      : Math.max(0, targetTime);
    try {
      if (Math.abs(node.currentTime - safeTime) > 0.15) {
        node.currentTime = safeTime;
        return;
      }
      requestPreviewDraw();
    } catch {
      // Preview seeking is best-effort; the main player owns actual playback.
    }
  }, [nearestFallbackFrame, requestPreviewDraw, src]);

  useEffect(() => {
    if (pendingSeekFrameRef.current !== null) {
      window.cancelAnimationFrame(pendingSeekFrameRef.current);
    }
    pendingSeekFrameRef.current = window.requestAnimationFrame(() => {
      pendingSeekFrameRef.current = null;
      seekPreview(latestTimeRef.current);
    });
    return () => {
      if (pendingSeekFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingSeekFrameRef.current);
        pendingSeekFrameRef.current = null;
      }
    };
  }, [seekPreview, time]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node || !src) return;

    setFrameReady(false);
    setFallbackFrame("");
    thumbnailCacheRef.current = [];
    samplingCancelledRef.current = false;
    let playFallbackTimer: ReturnType<typeof window.setTimeout> | null = null;

    const handleLoadedMetadata = () => seekPreview(latestTimeRef.current);
    const triggerMutedDecode = () => {
      if (drawPreviewFrame()) return;
      const playResult = node.play();
      if (playResult && typeof playResult.then === "function") {
        playResult
          .then(() => {
            node.pause();
            requestPreviewDraw();
          })
          .catch(() => {
            requestPreviewDraw();
          });
      }
    };

    node.muted = true;
    node.playsInline = true;

    node.addEventListener("loadedmetadata", handleLoadedMetadata);
    node.addEventListener("loadeddata", requestPreviewDraw);
    node.addEventListener("canplay", requestPreviewDraw);
    node.addEventListener("seeked", requestPreviewDraw);
    node.addEventListener("timeupdate", requestPreviewDraw);

    if (node.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seekPreview(latestTimeRef.current);
    } else {
      try {
        node.load();
      } catch {
        // Loading the preview node is opportunistic.
      }
    }

    playFallbackTimer = window.setTimeout(triggerMutedDecode, 180);

    return () => {
      samplingCancelledRef.current = true;
      if (playFallbackTimer !== null) {
        window.clearTimeout(playFallbackTimer);
      }
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
      if (pendingDrawFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingDrawFrameRef.current);
        pendingDrawFrameRef.current = null;
      }
      node.removeEventListener("loadedmetadata", handleLoadedMetadata);
      node.removeEventListener("loadeddata", requestPreviewDraw);
      node.removeEventListener("canplay", requestPreviewDraw);
      node.removeEventListener("seeked", requestPreviewDraw);
      node.removeEventListener("timeupdate", requestPreviewDraw);
      releaseMediaElement(node);
    };
  }, [drawPreviewFrame, requestPreviewDraw, seekPreview, src]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node || !src || duration <= 0) return;
    if (thumbnailCacheRef.current.length > 0) return;

    samplingCancelledRef.current = false;
    const sampleTimes = PROGRESS_PREVIEW_SAMPLE_RATIOS
      .map((ratio) => Math.min(Math.max(0.05, duration * ratio), Math.max(0.05, duration - 0.08)));
    let index = 0;

    const runNextSample = () => {
      if (samplingCancelledRef.current || latestVisibleRef.current || index >= sampleTimes.length) {
        return;
      }
      if (node.readyState < HTMLMediaElement.HAVE_METADATA) {
        sampleTimerRef.current = window.setTimeout(runNextSample, 180);
        return;
      }

      const sampleTime = sampleTimes[index];
      index += 1;

      const handleSeeked = () => {
        node.removeEventListener("seeked", handleSeeked);
        if (!samplingCancelledRef.current && !latestVisibleRef.current) {
          const dataUrl = capturePreviewDataUrl();
          if (dataUrl) {
            thumbnailCacheRef.current.push({ time: sampleTime, dataUrl });
          }
        }
        sampleTimerRef.current = window.setTimeout(runNextSample, 160);
      };

      try {
        node.addEventListener("seeked", handleSeeked, { once: true });
        node.currentTime = sampleTime;
      } catch {
        node.removeEventListener("seeked", handleSeeked);
        sampleTimerRef.current = window.setTimeout(runNextSample, 160);
      }
    };

    sampleTimerRef.current = window.setTimeout(runNextSample, 260);
    return () => {
      if (sampleTimerRef.current !== null) {
        window.clearTimeout(sampleTimerRef.current);
        sampleTimerRef.current = null;
      }
    };
  }, [capturePreviewDataUrl, duration, src]);

  if (!src) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/[0.04] text-[0.72rem] font-medium text-white/55">
        暂无预览
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative h-full w-full bg-black transition-opacity duration-100",
        visible ? "opacity-100" : "opacity-0"
      )}
    >
      <canvas
        ref={canvasRef}
        className={cn("relative z-10 h-full w-full transition-opacity duration-75", frameReady ? "opacity-100" : "opacity-0")}
      />
      {fallbackFrame && (
        <img
          src={fallbackFrame}
          alt=""
          aria-hidden="true"
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-75",
            frameReady ? "opacity-0" : "opacity-100"
          )}
          draggable={false}
        />
      )}
      {!frameReady && !fallbackFrame && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/[0.04] text-[0.72rem] font-medium text-white/55">
          正在预览
        </div>
      )}
      <video
        ref={videoRef}
        src={src}
        preload="auto"
        muted
        playsInline
        crossOrigin="anonymous"
        aria-hidden="true"
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
    </div>
  );
}
