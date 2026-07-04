import { describe, expect, it } from 'vitest';
import { getSubtitleOverlayGeometry } from '@/content/ui/subtitleLayout';

describe('getSubtitleOverlayGeometry', () => {
  it('anchors at the video center line, eight percent above the bottom, capped near video width', () => {
    expect(
      getSubtitleOverlayGeometry(
        { left: 100, top: 50, width: 1000, height: 600 },
        { width: 1400, height: 900 },
      ),
    ).toEqual({ centerX: 600, top: 522, maxWidth: 940 });
  });

  it('keeps the growth limit inside narrow viewports', () => {
    expect(
      getSubtitleOverlayGeometry(
        { left: -20, top: 20, width: 360, height: 240 },
        { width: 320, height: 640 },
      ),
    ).toEqual({ centerX: 160, top: 161, maxWidth: 296 });
  });

  it('uses a viewport-bottom fallback when the video cannot be measured', () => {
    expect(getSubtitleOverlayGeometry(null, { width: 1000, height: 700 })).toEqual({
      centerX: 500,
      top: 592,
      maxWidth: 940,
    });
  });

  it('never exceeds the absolute cap on huge screens', () => {
    const g = getSubtitleOverlayGeometry(
      { left: 0, top: 0, width: 2600, height: 1400 },
      { width: 2600, height: 1500 },
    );
    expect(g.maxWidth).toBe(1280);
    expect(g.centerX).toBe(1300);
  });
});
