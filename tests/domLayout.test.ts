import { describe, expect, it } from 'vitest';
import { introducesUnsafeLayout, rectanglesOverlap, type LayoutSnapshot } from '@/utils/dom';

const safe: LayoutSnapshot = {
  selfOverflow: false,
  clippingOverflow: [false],
  siblingOverlaps: [false, false],
};

describe('introducesUnsafeLayout', () => {
  it('rejects newly introduced self or ancestor overflow', () => {
    expect(introducesUnsafeLayout(safe, { ...safe, selfOverflow: true })).toBe(true);
    expect(introducesUnsafeLayout(safe, { ...safe, clippingOverflow: [true] })).toBe(true);
  });

  it('rejects only newly introduced sibling overlap', () => {
    expect(introducesUnsafeLayout(safe, { ...safe, siblingOverlaps: [false, true] })).toBe(true);
    const existing = { ...safe, siblingOverlaps: [true] };
    expect(introducesUnsafeLayout(existing, existing)).toBe(false);
  });
});

describe('rectanglesOverlap', () => {
  it('uses a tolerance when detecting overlap', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 20 };
    expect(rectanglesOverlap(a, { left: 100, top: 0, right: 200, bottom: 20 })).toBe(false);
    expect(rectanglesOverlap(a, { left: 90, top: 0, right: 200, bottom: 20 })).toBe(true);
  });
});
