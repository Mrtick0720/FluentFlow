export interface VideoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface SubtitleOverlayGeometry {
  left: number;
  top: number;
  width: number;
}

export function getSubtitleOverlayGeometry(
  video: VideoRect | null,
  viewport: ViewportSize,
): SubtitleOverlayGeometry {
  const viewportWidth = Math.max(0, viewport.width);
  const safeWidth = Math.max(240, viewportWidth - 24);
  const width = Math.min(video ? video.width * 0.7 : viewportWidth * 0.7, 760, safeWidth);
  const centerX = video ? video.left + video.width / 2 : viewportWidth / 2;
  const left = Math.max(12, Math.min(centerX - width / 2, viewportWidth - width - 12));
  const top = video
    ? video.top + video.height - 80 - video.height * 0.08
    : viewport.height - 108;

  return {
    left: Math.round(left),
    top: Math.max(8, Math.round(top)),
    width: Math.round(width),
  };
}
