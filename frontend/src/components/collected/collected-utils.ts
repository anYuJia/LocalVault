import type { CollectedMixItem, VideoInfo } from "@/lib/tauri";
import { VIDEO_CARD_GRID_CLASS } from "@/components/search/video-card";

export type CollectedTab = "videos" | "mixes";

export const PAGE_SIZE = 20;
export const ORIGINAL_VIDEO_GRID_CLASS = VIDEO_CARD_GRID_CLASS;

export function uniqueVideos(existing: VideoInfo[], incoming: VideoInfo[]) {
  const seen = new Set(existing.map((video) => video.aweme_id));
  const next = [...existing];
  for (const video of incoming) {
    if (!video?.aweme_id || seen.has(video.aweme_id)) continue;
    seen.add(video.aweme_id);
    next.push(video);
  }
  return next;
}

export function uniqueMixes(existing: CollectedMixItem[], incoming: CollectedMixItem[]) {
  const seen = new Set(existing.map((mix) => mix.mix_id));
  const next = [...existing];
  for (const mix of incoming) {
    if (!mix?.mix_id || seen.has(mix.mix_id)) continue;
    seen.add(mix.mix_id);
    next.push(mix);
  }
  return next;
}
