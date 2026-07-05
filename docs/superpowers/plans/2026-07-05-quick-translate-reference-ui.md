# Quick Translate Reference UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match the supplied dark Quick Translate reference while preserving existing translation behavior and leaving the footer styling unchanged.

**Architecture:** Keep all state and event logic in the existing `QuickTranslate` component. Reshape only the modal's main-area markup so the panes form a true two-column grid with an overlaid swap button, then replace the dedicated quick-translate CSS with fixed dark, viewport-responsive styling.

**Tech Stack:** React, TypeScript, Shadow DOM CSS, Vitest raw-source regression tests, Vite

---

## File map

- Modify `src/content/ui/App.tsx`: remove the dedicated drag-bar element and wrap the two panes in a main-area layer while preserving controls and footer.
- Modify `src/content/ui/shadow.css`: implement the approved fixed-dark reference layout and responsive constraints.
- Create `tests/quickTranslate.test.ts`: enforce structure, fixed palette, geometry, accessibility, and unchanged footer wiring.

### Task 1: Lock the approved structure with tests

**Files:**
- Create: `tests/quickTranslate.test.ts`
- Modify: `src/content/ui/App.tsx`

- [ ] **Step 1: Write failing source-contract tests**

```ts
import { describe, expect, it } from 'vitest';
import appSource from '../src/content/ui/App.tsx?raw';

describe('Quick Translate reference UI', () => {
  it('uses a two-pane main layer without the old drag bar', () => {
    expect(appSource).toContain('className="lf-qt-main"');
    expect(appSource).toContain('className="lf-qt-cols"');
    expect(appSource).not.toContain('className="lf-qt-dragbar"');
  });

  it('preserves dialog and control semantics', () => {
    expect(appSource).toContain('role="dialog"');
    expect(appSource).toContain('aria-label="输入语言"');
    expect(appSource).toContain('aria-label="输出语言"');
    expect(appSource).toContain('aria-label="交换语言"');
    expect(appSource).toContain('aria-label="清空"');
  });

  it('keeps footer structure and actions unchanged', () => {
    expect(appSource).toContain('className="lf-qt-footer"');
    expect(appSource).toContain('className="lf-muted lf-qt-model"');
    expect(appSource).toContain('aria-label="复制译文"');
    expect(appSource).toContain('onClick={actions.closeQuickTranslate}');
  });

});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/quickTranslate.test.ts`

Expected: FAIL because `lf-qt-main` is absent and the old drag bar is present.

- [ ] **Step 3: Reshape only the modal main area**

In `QuickTranslate`, remove:

```tsx
<div className="lf-qt-dragbar">
  <GripIcon />
  <span>拖动移动</span>
</div>
```

Wrap the existing pane grid and swap button as:

```tsx
<div className="lf-qt-main">
  <div className="lf-qt-cols">
    <div className="lf-qt-col lf-qt-col-in">{/* existing input controls */}</div>
    <div className="lf-qt-col lf-qt-col-out">{/* existing output controls */}</div>
  </div>
  <button className="lf-qt-swap" onClick={swap} title="交换语言" aria-label="交换语言">
    <SwapIcon />
  </button>
</div>
```

Keep `lf-qt-footer` and everything inside it byte-for-byte equivalent. Keep the
existing root `onPointerDown`; its interactive-element guard already allows drag
from pane whitespace while excluding controls and text surfaces.

- [ ] **Step 4: Run structural tests**

Run: `npm test -- tests/quickTranslate.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/content/ui/App.tsx tests/quickTranslate.test.ts
git commit -m "refactor: reshape quick translate main area"
```

### Task 2: Implement the fixed-dark reference styling

**Files:**
- Modify: `src/content/ui/shadow.css`
- Test: `tests/quickTranslate.test.ts`

- [ ] **Step 1: Replace modal and main-area geometry**

First add failing CSS contracts to `tests/quickTranslate.test.ts`:

```ts
import { readFileSync } from 'node:fs';
const cssSource = readFileSync(new URL('../src/content/ui/shadow.css', import.meta.url), 'utf8');

it('uses fixed dark panes and viewport-safe sizing', () => {
  expect(cssSource).toMatch(/\.lf-qt\s*\{[^}]*background:\s*#171717/s);
  expect(cssSource).toMatch(/\.lf-qt-col-in\s*\{[^}]*background:\s*#262626/s);
  expect(cssSource).toMatch(/\.lf-qt-col-out\s*\{[^}]*background:\s*#181818/s);
  expect(cssSource).toContain('grid-template-columns: 1fr 1fr');
  expect(cssSource).toContain('width: min(96vw, 1400px)');
  expect(cssSource).toContain('height: min(90vh, 900px)');
});

it('overlays the swap control on the center boundary', () => {
  expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*position:\s*absolute/s);
  expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*left:\s*50%/s);
  expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
});
```

Run: `npm test -- tests/quickTranslate.test.ts`

Expected: FAIL on fixed palette, viewport sizing, and absolute swap geometry.

Then use these exact desktop contracts:

Use these exact desktop contracts:

```css
.lf-qt {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(96vw, 1400px);
  height: min(90vh, 900px);
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  background: #171717;
  color: #d6d6d6;
  border: 2px solid #353535;
  border-radius: 18px;
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.52);
  overflow: hidden;
}

.lf-qt-main { position: relative; min-height: 0; padding: 14px; }
.lf-qt-cols { display: grid; grid-template-columns: 1fr 1fr; height: 100%; }
```

- [ ] **Step 2: Style the two panes and language rows**

```css
.lf-qt-col { min-width: 0; padding: 22px 38px 24px; }
.lf-qt-col-in { background: #262626; border-radius: 16px 0 0 16px; }
.lf-qt-col-out { background: #181818; border-radius: 0 16px 16px 0; }
.lf-qt-lang {
  align-self: center;
  border: 0;
  background: transparent;
  color: #bcbcbc;
  font-size: 21px;
  margin: 0 auto 42px;
  text-align: center;
}
.lf-qt-input, .lf-qt-output {
  min-height: 0;
  max-height: none;
  font-size: clamp(22px, 2.15vw, 31px);
  line-height: 1.5;
  color: #d6d6d6;
}
```

Keep placeholder and muted text in a softer gray. Preserve textarea scrolling,
multiline output, and the input count at the pane bottom.

- [ ] **Step 3: Overlay the swap button and add narrow-screen rules**

```css
.lf-qt-swap {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 82px;
  height: 82px;
  margin: 0;
  border: 8px solid #171717;
  border-radius: 30px;
  background: #282828;
  color: #aaa;
}

@media (max-width: 720px), (max-height: 620px) {
  .lf-qt { width: calc(100vw - 16px); height: calc(100vh - 16px); }
  .lf-qt-main { padding: 8px; }
  .lf-qt-col { padding: 16px 18px; }
  .lf-qt-lang { font-size: 15px; margin-bottom: 24px; }
  .lf-qt-swap { width: 58px; height: 58px; border-width: 6px; border-radius: 20px; }
}
```

Do not modify `.lf-qt-footer`, `.lf-qt-model`, `.lf-qt-actions`, or the footer
button rules.

- [ ] **Step 4: Run complete verification**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: all tests pass, TypeScript emits no errors, both Vite builds succeed,
and there are no whitespace errors.

- [ ] **Step 5: Perform visual checks**

Reload the unpacked extension and compare Quick Translate against the supplied
reference at a desktop viewport. Then resize to a narrow viewport and confirm the
modal remains fully visible, both panes remain usable, controls retain focus, and
the footer is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/content/ui/shadow.css tests/quickTranslate.test.ts
git commit -m "feat: match quick translate dark reference UI"
```
