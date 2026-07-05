import type { AnchorRect } from './store';

/** Keep popups this far from every viewport edge. */
export const SAFE_MARGIN = 8;
/** Gap between the anchored selection and the popup. */
export const ANCHOR_GAP = 8;

export interface Size {
  width: number;
  height: number;
}
export interface Viewport {
  width: number;
  height: number;
}

/**
 * Place a popup relative to its selection so the whole thing stays on screen.
 * Order: the preferred side (below for cards, so they clear a site's usually
 * above-selection menu), then the other side when there isn't room, then a
 * viewport clamp. Horizontally the left edge is clamped so it never overflows.
 * Pure and deterministic — the hook feeds it measured sizes; tests feed fixtures.
 */
export function computePopupPlacement(
  anchor: AnchorRect,
  size: Size,
  viewport: Viewport,
  prefer: 'above' | 'below',
  margin = SAFE_MARGIN,
  gap = ANCHOR_GAP,
): { left: number; top: number } {
  const left = Math.max(margin, Math.min(anchor.left, viewport.width - size.width - margin));

  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - margin;
  const fitsAbove = above >= margin;

  let top: number;
  if (prefer === 'below') top = fitsBelow ? below : fitsAbove ? above : below;
  else top = fitsAbove ? above : fitsBelow ? below : above;

  // Final safety clamp: keep the top edge on screen; a popup taller than the
  // viewport pins to the top margin rather than pushing its top off-screen.
  top = Math.max(margin, Math.min(top, Math.max(margin, viewport.height - size.height - margin)));
  return { left, top };
}
