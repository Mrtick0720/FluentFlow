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
  /** Horizontal anchor: the bar is centered here and sizes to its content. */
  centerX: number;
  top: number;
  /** The bar may grow up to this width before the text wraps. */
  maxWidth: number;
}

export function getSubtitleOverlayGeometry(
  video: VideoRect | null,
  viewport: ViewportSize,
): SubtitleOverlayGeometry {
  const viewportWidth = Math.max(0, viewport.width);
  const safeWidth = Math.max(240, viewportWidth - 24);
  const maxWidth = Math.min(video ? video.width * 0.94 : viewportWidth * 0.94, 1280, safeWidth);
  const centerX = video ? video.left + video.width / 2 : viewportWidth / 2;
  const top = video
    ? video.top + video.height - 80 - video.height * 0.08
    : viewport.height - 108;

  return {
    centerX: Math.round(centerX),
    top: Math.max(8, Math.round(top)),
    maxWidth: Math.round(maxWidth),
  };
}
