import { Suspense, lazy } from "react";
import type { FullscreenPlayerProps } from "./fullscreen-player";

const LazyFullscreenPlayer = lazy(() =>
  import("./fullscreen-player").then((module) => ({ default: module.FullscreenPlayer }))
);

export function FullscreenPlayer(props: FullscreenPlayerProps) {
  if (!props.open) return null;

  return (
    <Suspense fallback={null}>
      <LazyFullscreenPlayer {...props} />
    </Suspense>
  );
}
