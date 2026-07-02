import { mediaProxyUrl, type VideoInfo } from "@/lib/tauri";
import { collectVideoMedia, getMediaProxyType, isVideoLikeMedia } from "@/lib/video-media";

const PREWARM_INTENT_RANGE = "bytes=0-1048575";
const PREWARM_PLAYBACK_RANGE = "bytes=0-4194303";
const PREWARM_HEADER = "X-Douyin-Prewarm";
const MAX_PREWARMED = 48;
const MAX_CONCURRENT_PREWARMS = 2;
const DEFAULT_INTENT_DELAY_MS = 140;

type PrewarmMode = "intent" | "playback";

interface PrewarmOptions {
  mode?: PrewarmMode;
  delayMs?: number;
}

interface PendingPrewarm {
  key: string;
  url: string;
  range: string;
  controller: AbortController;
  timer?: number;
}

const prewarmedKeys = new Set<string>();
const pendingPrewarms: PendingPrewarm[] = [];
const activePrewarms = new Map<string, AbortController>();

export function prewarmVideoForPlayback(
  video: VideoInfo | null | undefined,
  options: PrewarmOptions = {}
) {
  const media = collectVideoMedia(video)[0];
  if (!media || !isVideoLikeMedia(media)) return;

  const url = mediaProxyUrl(media.url, getMediaProxyType(media));
  if (!url) return;

  const mode = options.mode ?? "intent";
  if (mode === "playback") cancelVideoPrewarm(video, "intent");

  const range = mode === "playback" ? PREWARM_PLAYBACK_RANGE : PREWARM_INTENT_RANGE;
  const key = `${mode}:${url}`;
  if (prewarmedKeys.has(key) || pendingPrewarms.some((item) => item.key === key) || activePrewarms.has(key)) return;

  const controller = new AbortController();
  const pending: PendingPrewarm = { key, url, range, controller };
  prewarmedKeys.add(key);
  trimPrewarmedKeys();

  const delayMs = mode === "intent" ? options.delayMs ?? DEFAULT_INTENT_DELAY_MS : options.delayMs ?? 0;
  if (delayMs > 0) {
    pending.timer = window.setTimeout(() => {
      pending.timer = undefined;
      enqueuePrewarm(pending);
    }, delayMs);
    pendingPrewarms.push(pending);
    return;
  }

  enqueuePrewarm(pending);
}

export function cancelVideoPrewarm(video: VideoInfo | null | undefined, mode: PrewarmMode = "intent") {
  const media = collectVideoMedia(video)[0];
  if (!media || !isVideoLikeMedia(media)) return;

  const url = mediaProxyUrl(media.url, getMediaProxyType(media));
  const key = `${mode}:${url}`;
  const active = activePrewarms.get(key);
  if (active) {
    active.abort();
    activePrewarms.delete(key);
    prewarmedKeys.delete(key);
  }

  const pendingIndex = pendingPrewarms.findIndex((item) => item.key === key);
  if (pendingIndex >= 0) {
    const [pending] = pendingPrewarms.splice(pendingIndex, 1);
    if (pending.timer) window.clearTimeout(pending.timer);
    pending.controller.abort();
    prewarmedKeys.delete(key);
  }
}

function enqueuePrewarm(pending: PendingPrewarm) {
  if (pending.controller.signal.aborted) return;
  if (!pendingPrewarms.includes(pending)) pendingPrewarms.push(pending);
  drainPrewarmQueue();
}

function drainPrewarmQueue() {
  while (activePrewarms.size < MAX_CONCURRENT_PREWARMS && pendingPrewarms.length > 0) {
    const pending = pendingPrewarms.shift();
    if (!pending || pending.timer || pending.controller.signal.aborted) continue;

    activePrewarms.set(pending.key, pending.controller);
    void fetch(pending.url, {
      headers: { Range: pending.range, [PREWARM_HEADER]: "1" },
      cache: "force-cache",
      signal: pending.controller.signal,
    })
      .then((response) => {
        if (!response.ok && response.status !== 206) throw new Error(`Prewarm failed: ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (buffer.byteLength <= 0) throw new Error("Empty prewarm response");
      })
      .catch(() => {
        prewarmedKeys.delete(pending.key);
      })
      .finally(() => {
        activePrewarms.delete(pending.key);
        drainPrewarmQueue();
      });
  }
}

function trimPrewarmedKeys() {
  while (prewarmedKeys.size > MAX_PREWARMED) {
    const first = prewarmedKeys.values().next().value;
    if (!first) return;
    prewarmedKeys.delete(first);
  }
}
