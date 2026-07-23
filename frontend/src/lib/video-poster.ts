function waitForMediaEvent(target: HTMLMediaElement, event: "loadeddata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("读取视频封面超时"));
    }, 15_000);
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("无法读取视频封面"));
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      target.removeEventListener(event, onSuccess);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(event, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

/** Extract one JPEG still image for Douyin's required native-video check picture. */
export async function createVideoPosterDataUrl(videoBlob: Blob): Promise<string> {
  const objectUrl = URL.createObjectURL(videoBlob);
  const video = document.createElement("video");
  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = objectUrl;
    await waitForMediaEvent(video, "loadeddata");
    if (!video.videoWidth || !video.videoHeight) throw new Error("视频没有可用画面");
    if (Number.isFinite(video.duration) && video.duration > 0.1) {
      video.currentTime = Math.min(0.1, video.duration / 2);
      await waitForMediaEvent(video, "seeked");
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法生成视频封面");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}
