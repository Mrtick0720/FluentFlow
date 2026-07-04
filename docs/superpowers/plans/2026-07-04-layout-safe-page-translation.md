# Layout-Safe Page Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate compact interface and hero content in place while automatically restoring English whenever the rendered Chinese introduces overflow or overlap.

**Architecture:** Keep DOM classification and geometry comparison in `src/utils/dom.ts`; `PageTranslator` takes a before snapshot, applies a translation, takes an after snapshot, and reverts unsafe results. Geometry decisions are represented as plain data so they can be unit tested without a browser DOM.

**Tech Stack:** TypeScript, Chrome MV3 content scripts, Vitest, Vite

---

## File map

- Modify `src/utils/dom.ts`: classify compact/hero content and expose layout snapshot/comparison helpers.
- Modify `src/content/pageTranslator.ts`: use the snapshot guard around each translation.
- Create `tests/domLayout.test.ts`: unit-test pure layout safety decisions.
- Modify `e2e/extension.spec.ts`: extend the fixture and assertions for hero replacement (verification only; do not launch it in this task).

### Task 1: Pure layout-safety model

**Files:**
- Create: `tests/domLayout.test.ts`
- Modify: `src/utils/dom.ts`

- [ ] **Step 1: Write failing unit tests**

Add tests using plain snapshots:

```ts
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
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- tests/domLayout.test.ts`

Expected: FAIL because `LayoutSnapshot` and `introducesUnsafeLayout` do not exist.

- [ ] **Step 3: Add the minimal snapshot comparison**

Add to `src/utils/dom.ts`:

```ts
export interface LayoutSnapshot {
  selfOverflow: boolean;
  clippingOverflow: boolean[];
  siblingOverlaps: boolean[];
}

function newlyTrue(before: boolean[], after: boolean[]): boolean {
  return after.some((value, index) => value && !before[index]);
}

export function introducesUnsafeLayout(before: LayoutSnapshot, after: LayoutSnapshot): boolean {
  return (
    (after.selfOverflow && !before.selfOverflow) ||
    newlyTrue(before.clippingOverflow, after.clippingOverflow) ||
    newlyTrue(before.siblingOverlaps, after.siblingOverlaps)
  );
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm test -- tests/domLayout.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dom.ts tests/domLayout.test.ts
git commit -m "test: define unsafe translation layout rules"
```

### Task 2: DOM snapshots and broader in-place classification

**Files:**
- Modify: `src/utils/dom.ts`
- Modify: `tests/domLayout.test.ts`

- [ ] **Step 1: Add failing pure rectangle tests**

Add cases proving touching edges do not overlap and intersecting boxes do:

```ts
import { rectanglesOverlap } from '@/utils/dom';

it('uses a tolerance when detecting overlap', () => {
  const a = { left: 0, top: 0, right: 100, bottom: 20 };
  expect(rectanglesOverlap(a, { left: 100, top: 0, right: 200, bottom: 20 })).toBe(false);
  expect(rectanglesOverlap(a, { left: 90, top: 0, right: 200, bottom: 20 })).toBe(true);
});
```

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `npm test -- tests/domLayout.test.ts`

Expected: FAIL because `rectanglesOverlap` does not exist.

- [ ] **Step 3: Implement geometry and snapshot collection**

Add `rectanglesOverlap`, collect visible previous/next siblings, and export:

```ts
export function captureLayoutSnapshot(el: HTMLElement): LayoutSnapshot {
  const siblings = nearbyVisibleSiblings(el);
  const rect = el.getBoundingClientRect();
  return {
    selfOverflow: overflows(el),
    clippingOverflow: clippingAncestors(el).map(overflows),
    siblingOverlaps: siblings.map((sibling) =>
      rectanglesOverlap(rect, sibling.getBoundingClientRect()),
    ),
  };
}
```

Use a two-pixel tolerance and ignore zero-sized, hidden, or non-rendered siblings.
Update `shouldReplaceInPlace` so it returns true for hero/banner/carousel regions,
dense lists/cards, and positioned ancestors, while ordinary article paragraphs
continue returning false.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npm test -- tests/domLayout.test.ts && npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/dom.ts tests/domLayout.test.ts
git commit -m "feat: measure translated element overlap"
```

### Task 3: Integrate guarded translation and verify

**Files:**
- Modify: `src/content/pageTranslator.ts`
- Modify: `e2e/extension.spec.ts`

- [ ] **Step 1: Extend the fixture contract**

Add a hero element to `FIXTURE_HTML` and an assertion that it receives
`lf-replaced`, while `#body` retains visible original and translated spans.

- [ ] **Step 2: Replace the clipping-only guard**

In `PageTranslator.flush`, capture the same tracked elements before insertion and
after insertion, then reject with the pure comparator:

```ts
const layout = createLayoutGuard(el);
this.applyTranslation(el, translation);
if (introducesUnsafeLayout(layout.before, layout.after())) {
  this.revertTranslation(el);
} else {
  applied++;
}
```

`createLayoutGuard` must retain the exact clipping ancestors and siblings selected
before mutation so array positions remain comparable after insertion.

- [ ] **Step 3: Run non-browser verification**

Run: `npm test && npm run typecheck && npm run build`

Expected: all unit tests pass, typecheck reports no errors, and both Vite builds succeed.

- [ ] **Step 4: Review the diff for scope and reversibility**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only the four planned implementation/test files are modified.

- [ ] **Step 5: Commit**

```bash
git add src/content/pageTranslator.ts src/utils/dom.ts tests/domLayout.test.ts e2e/extension.spec.ts
git commit -m "feat: translate compact page content safely"
```

The user performs final browser validation against NBA.com.
