import { describe, expect, it } from 'vitest';
import { getSubtitleOverlayGeometry } from '@/content/ui/subtitleLayout';

describe('getSubtitleOverlayGeometry', () => {
  it('centers a 70%-wide overlay eight percent above the video bottom', () => {
    expect(
      getSubtitleOverlayGeometry(
        { left: 100, top: 50, width: 1000, height: 600 },
        { width: 1400, height: 900 },
      ),
    ).toEqual({ left: 250, top: 522, width: 700 });
  });

  it('keeps the overlay inside narrow viewports', () => {
    expect(
      getSubtitleOverlayGeometry(
        { left: -20, top: 20, width: 360, height: 240 },
        { width: 320, height: 640 },
      ),
    ).toEqual({ left: 34, top: 161, width: 252 });
  });

  it('uses a viewport-bottom fallback when the video cannot be measured', () => {
    expect(getSubtitleOverlayGeometry(null, { width: 1000, height: 700 })).toEqual({
      left: 150,
      top: 592,
      width: 700,
    });
  });
});
