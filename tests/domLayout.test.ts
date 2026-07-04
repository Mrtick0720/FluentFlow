import { describe, expect, it } from 'vitest';
import { introducesUnsafeLayout, type LayoutSnapshot } from '@/utils/dom';

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
