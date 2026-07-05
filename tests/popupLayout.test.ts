import { describe, expect, it } from 'vitest';
import { ANCHOR_GAP, SAFE_MARGIN, computePopupPlacement } from '@/content/ui/popupLayout';

const viewport = { width: 1000, height: 800 };
// A one-line selection near the middle-left.
const anchor = { top: 300, bottom: 320, left: 100 };

describe('computePopupPlacement', () => {
  it('places a card below the selection when there is room', () => {
    const { top, left } = computePopupPlacement(anchor, { width: 380, height: 200 }, viewport, 'below');
    expect(top).toBe(anchor.bottom + ANCHOR_GAP);
    expect(left).toBe(100);
  });

  it('flips above when the card would be clipped at the bottom', () => {
    const lowAnchor = { top: 720, bottom: 740, left: 100 };
    const { top } = computePopupPlacement(lowAnchor, { width: 380, height: 300 }, viewport, 'below');
    // Below (740+8+300=1048) overflows 800 → flip above the selection.
    expect(top).toBe(lowAnchor.top - ANCHOR_GAP - 300);
  });

  it('clamps a large popup so its bottom stays on screen', () => {
    // Tall (but < viewport) popup, selection mid-screen: clamp so it fits fully.
    const { top } = computePopupPlacement(anchor, { width: 380, height: 700 }, viewport, 'below');
    expect(top).toBe(viewport.height - 700 - SAFE_MARGIN); // 92 → bottom at margin
    expect(top + 700).toBeLessThanOrEqual(viewport.height - SAFE_MARGIN);
  });

  it('pins a popup taller than the viewport to the top margin', () => {
    const { top } = computePopupPlacement(anchor, { width: 380, height: 900 }, viewport, 'below');
    expect(top).toBe(SAFE_MARGIN); // never pushes the top edge off-screen
  });

  it('never lets the left edge overflow either horizontal edge', () => {
    const rightEdge = computePopupPlacement(
      { top: 300, bottom: 320, left: 980 },
      { width: 380, height: 200 },
      viewport,
      'below',
    );
    expect(rightEdge.left).toBe(viewport.width - 380 - SAFE_MARGIN); // 612
    const leftEdge = computePopupPlacement(
      { top: 300, bottom: 320, left: -50 },
      { width: 380, height: 200 },
      viewport,
      'below',
    );
    expect(leftEdge.left).toBe(SAFE_MARGIN);
  });

  it('toolbar prefers above but flips below near the top of the viewport', () => {
    const topAnchor = { top: 10, bottom: 30, left: 100 };
    const { top } = computePopupPlacement(topAnchor, { width: 240, height: 40 }, viewport, 'above');
    // Above (10-8-40=-38) is off-screen → place below instead.
    expect(top).toBe(topAnchor.bottom + ANCHOR_GAP);
  });
});
