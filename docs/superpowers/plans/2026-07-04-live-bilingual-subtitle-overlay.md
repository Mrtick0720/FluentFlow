# Live Bilingual Subtitle Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LinguaFlow show timely, correctly paired Chinese/English captions in a compact Tracy-style overlay whose learning controls appear only on hover or focus.

**Architecture:** Keep caption acquisition in adapters and translation sequencing in `SubtitleController`. Add explicit `translating` state and strict source/token checks, normalize YouTube DOM captions at the adapter boundary, and render the same controller state through a passive video-relative subtitle surface plus a hidden interaction toolbar.

**Tech Stack:** TypeScript, React 18, Chrome Manifest V3 content scripts, Shadow DOM CSS, Vitest, Playwright

---

## File map

- Modify `src/services/video/controller.ts`: live-caption stabilization, stale-result rejection, translating state, cleanup.
- Modify `src/adapters/youtube/index.ts`: select visible caption windows and normalize emitted text.
- Modify `src/content/ui/store.ts`: store a measured video rectangle instead of a one-time anchor point.
- Modify `src/content/index.ts`: keep the rectangle synchronized with player layout changes.
- Modify `src/content/ui/App.tsx`: compact caption surface and hover/focus/touch toolbar.
- Modify `src/content/ui/shadow.css`: translucent overlay, responsive type, hidden controls, drag affordance.
- Modify `tests/subtitle.test.ts`: controller race, timing, cleanup, and adapter normalization regressions.
- Modify `e2e/extension.spec.ts`: structural assertions for the compact subtitle overlay where the fixture permits.

### Task 1: Lock down live-caption correctness

**Files:**
- Modify: `tests/subtitle.test.ts`
- Modify: `src/services/video/controller.ts`

- [ ] **Step 1: Add a controllable video adapter and deferred translation helpers**

Add test helpers that expose a caption callback, a minimal event-capable fake video, and deferred translation promises. Construct `SubtitleController` with `vi.useFakeTimers()` and collect every emitted state.

```ts
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function liveHarness(translate: (texts: string[]) => Promise<string[]>) {
  let emit: (caption: CaptionState | null) => void = () => {};
  const video = Object.assign(new EventTarget(), {
    currentTime: 0, playbackRate: 1, paused: false,
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    getBoundingClientRect() { return null; },
  }) as unknown as HTMLVideoElement;
  const adapter: VideoAdapter = {
    id: 'live-test', match: () => true, getVideo: () => video,
    getSubtitleTracks: async () => [], getCurrentCaption: () => null,
    seek: () => {}, onCaptionChanged: (cb) => { emit = cb; return () => {}; },
  };
  const states: SubtitleViewState[] = [];
  const controller = new SubtitleController(new VideoAdapterRegistry().register(adapter), {
    translate, onState: (state) => states.push({ ...state }),
  });
  return { controller, emit, states };
}
```

- [ ] **Step 2: Write failing tests for immediate clearing and the 200 ms stability window**

Assert that changing from `First sentence` with a resolved Chinese translation to `Second sentence` emits `original: 'Second sentence'`, `translation: ''`, and `translating: true` immediately. Advance 199 ms and expect no second request; advance one more millisecond and expect it.

- [ ] **Step 3: Write failing tests for stale responses, duplicates, failures, and detach**

Resolve an older request after a newer caption is active and assert it never changes the visible Chinese. Emit normalized duplicate text and assert it makes no extra request. Reject a current request and assert the translation stays empty and `translating` becomes false. Detach before a timer/request resolves and assert no ready state is emitted afterward.

- [ ] **Step 4: Run the focused tests and verify failure**

Run: `npm test -- --run tests/subtitle.test.ts`

Expected: FAIL because `SubtitleViewState` has no `translating` field, the debounce is 600 ms, and new captions retain the previous translation.

- [ ] **Step 5: Implement the minimal controller state machine**

Add `translating: boolean` to `SubtitleViewState` and all initial/reset paths. Set `{ original: text, translation: '', translating: true }` for every new non-empty live source. Change the stability delay to 200 ms. Increment the request token when the source changes, capture both token and source, and apply success/failure only when both still match. On success set the returned translation and `translating: false`; on current-request failure set `translating: false` without restoring old text. Clear timers and invalidate tokens in `detach()`.

- [ ] **Step 6: Run the focused tests and verify pass**

Run: `npm test -- --run tests/subtitle.test.ts`

Expected: PASS for parsing, registry, and all new live-caption tests.

- [ ] **Step 7: Commit the controller fix**

```bash
git add tests/subtitle.test.ts src/services/video/controller.ts
git commit -m "fix: keep live subtitle translations in sync"
```

### Task 2: Normalize visible YouTube captions

**Files:**
- Modify: `src/adapters/youtube/index.ts`
- Modify: `tests/subtitle.test.ts`

- [ ] **Step 1: Write failing adapter tests**

Test exported pure helpers with candidate arrays containing repeated whitespace, a hidden stale window, and a visible current window. Assert selection returns only visible text normalized with `text.replace(/\s+/g, ' ').trim()`. This keeps unit tests compatible with the repository's Node test environment; DOM wiring is covered by the extension E2E test.

- [ ] **Step 2: Run the adapter tests and verify failure**

Run: `npm test -- --run tests/subtitle.test.ts -t "YouTubeAdapter"`

Expected: FAIL because the adapter currently joins every `.ytp-caption-segment`, including segments from non-visible windows.

- [ ] **Step 3: Implement visible-window extraction**

Add focused helpers in `src/adapters/youtube/index.ts`:

```ts
export const normalizeCaptionText = (text: string) => text.replace(/\s+/g, ' ').trim();

export function chooseCaptionText(candidates: Array<{ text: string; visible: boolean }>): string {
  const visible = candidates.filter((item) => item.visible).map((item) => normalizeCaptionText(item.text)).filter(Boolean);
  return visible.join(' ');
}

function isVisibleCaptionWindow(element: Element): boolean {
  const node = element as HTMLElement;
  const style = getComputedStyle(node);
  return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}
```

Read segments from visible `.caption-window` elements first, falling back to all current segments only when no window wrapper exists. Compare normalized text inside the mutation observer.

- [ ] **Step 4: Run the complete subtitle test file**

Run: `npm test -- --run tests/subtitle.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit adapter normalization**

```bash
git add tests/subtitle.test.ts src/adapters/youtube/index.ts
git commit -m "fix: read only current YouTube caption text"
```

### Task 3: Keep the overlay attached to the video

**Files:**
- Modify: `src/content/ui/store.ts`
- Modify: `src/content/index.ts`
- Modify: `src/content/ui/App.tsx`

- [ ] **Step 1: Replace point anchoring with a video rectangle**

Change `subtitleAnchor` to `subtitleVideoRect: { left: number; top: number; width: number; height: number } | null` in `UIState` and initial state. In `toggleSubtitlePanel`, measure `subtitleController.getVideoRect()` and store the four serializable values.

- [ ] **Step 2: Add bounded layout synchronization**

While subtitles are visible, update the stored rectangle from `getVideoRect()` through one `requestAnimationFrame`-throttled callback listening to `resize`, capturing `scroll`, and `fullscreenchange`. Attach a `ResizeObserver` to the video when available. Return one cleanup function and invoke it when closing/detaching the panel.

- [ ] **Step 3: Derive overlay geometry from the rectangle**

In `SubtitlePanel`, compute a centered position with `width: Math.min(rect.width * 0.7, 760)`, safe horizontal margins, and a baseline approximately 8% above `rect.bottom`. Preserve a dragged position until close, and use centered viewport-bottom fallback geometry when there is no rectangle.

- [ ] **Step 4: Verify types before styling**

Run: `npm run typecheck`

Expected: PASS with no stale `subtitleAnchor` references.

- [ ] **Step 5: Commit video-relative positioning**

```bash
git add src/content/ui/store.ts src/content/index.ts src/content/ui/App.tsx
git commit -m "feat: anchor subtitles to the active video"
```

### Task 4: Build the compact Tracy-style surface

**Files:**
- Modify: `src/content/ui/App.tsx`
- Modify: `src/content/ui/shadow.css`

- [ ] **Step 1: Restructure `SubtitlePanel` markup**

Remove the permanent title header and resize behavior. Render `.lf-subtitle-toolbar` before `.lf-subtitle-surface`. Keep Chinese first, English second. When `s.translating` is true render `翻译中…` in a reserved `.lf-subtitle-translation.lf-pending` line. Put transcript, previous, repeat, next, A-B, sentence pause, speed, bookmark, explain, and close in the toolbar. Stop pointer propagation on interactive controls so toolbar use cannot initiate dragging.

- [ ] **Step 2: Add touch reveal state and accessible focus behavior**

Add local `controlsPinned` state toggled by tapping the passive surface. Apply `.lf-controls-pinned` to the panel. Keep every control keyboard-focusable; `:focus-within` must reveal the toolbar without requiring a mouse.

- [ ] **Step 3: Replace panel CSS with compact overlay CSS**

Use these core values:

```css
.lf-subtitle-panel { position: fixed; display: flex; flex-direction: column; align-items: center; min-width: 240px; max-width: calc(100vw - 24px); }
.lf-subtitle-surface { width: fit-content; max-width: 100%; padding: 10px 18px 11px; border-radius: 14px; background: rgba(24,24,24,.78); backdrop-filter: blur(8px); color: #fff; text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,.8); }
.lf-subtitle-toolbar { opacity: 0; visibility: hidden; transform: translateY(6px); pointer-events: none; transition: opacity .15s ease, transform .15s ease, visibility .15s; }
.lf-subtitle-panel:hover .lf-subtitle-toolbar,
.lf-subtitle-panel:focus-within .lf-subtitle-toolbar,
.lf-subtitle-panel.lf-controls-pinned .lf-subtitle-toolbar { opacity: 1; visibility: visible; transform: none; pointer-events: auto; }
.lf-subtitle-translation { font-size: clamp(18px, 2.1vw, 30px); line-height: 1.3; }
.lf-subtitle-original { margin-top: 3px; font-size: clamp(15px, 1.7vw, 25px); line-height: 1.3; }
.lf-pending { opacity: .42; }
```

Add `@media (hover: none)` handling, `prefers-reduced-motion`, and high-contrast focus rings. Do not inherit light/dark card background variables for the caption surface.

- [ ] **Step 4: Build and inspect generated content assets**

Run: `npm run build`

Expected: both Vite builds finish successfully and `dist/content.js` plus `dist/content.css` are generated.

- [ ] **Step 5: Commit the visual redesign**

```bash
git add src/content/ui/App.tsx src/content/ui/shadow.css
git commit -m "feat: add compact bilingual subtitle overlay"
```

### Task 5: End-to-end regression verification

**Files:**
- Modify: `e2e/extension.spec.ts`
- Modify: `README.md` only if its subtitle description contradicts the new behavior

- [ ] **Step 1: Add stable E2E structure checks**

Extend the extension fixture to activate subtitles on a local HTML5 video with cues. Assert `.lf-subtitle-surface` exists, `.lf-subtitle-toolbar` has `opacity: 0` at rest, hovering the panel makes it visible, and the rendered translation line changes without retaining the prior cue's text.

- [ ] **Step 2: Run all automated checks**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: every command exits 0. If Chromium is unavailable, record the exact Playwright installation/runtime error and complete the unit, type, and build checks rather than claiming E2E passed.

- [ ] **Step 3: Perform Chrome manual verification**

Load `dist/` unpacked, open the supplied YouTube/CNBC video, enable native CC, then LinguaFlow CC. Verify normal, theater, and fullscreen modes; resize and scroll; seek rapidly; pause/resume; hover and keyboard focus; confirm every English change immediately removes the prior Chinese and only the matching Chinese appears.

- [ ] **Step 4: Review the final diff for scope and artifacts**

Run: `git diff --check HEAD~4..HEAD && git status --short`

Expected: no whitespace errors, no generated `dist/` files accidentally staged unless already tracked, and only subtitle-related source/tests/docs changed.

- [ ] **Step 5: Commit verification coverage**

```bash
git add e2e/extension.spec.ts README.md
git commit -m "test: cover compact subtitle overlay"
```
