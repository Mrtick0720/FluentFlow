# Embedded Video Bilingual Subtitles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LinguaFlow bilingual subtitles work inside YouTube embeds such as Khan Academy and on TED videos with accessible English captions, while never showing a third native-caption line.

**Architecture:** Inject the content bundle in every frame, retain the full application in the top frame, and start a subtitle-only runtime in child frames that contain a main video. Parent and child frames exchange a small validated message protocol; site adapters continue to feed the existing `SubtitleController` and own native-caption hiding/restoration.

**Tech Stack:** Chrome Manifest V3, TypeScript, React, DOM `postMessage`, TextTrack/WebVTT, Vitest, Playwright

---

## File map

- Create `src/content/frameBridge.ts`: pure frame message types, validation, and parent/child helpers.
- Create `src/content/subtitleRuntime.ts`: shared subtitle-only runtime used by top-level and embedded players.
- Modify `src/content/index.ts`: branch top-frame/full-app and child-frame/subtitle-only startup; relay commands.
- Modify `public/manifest.json`: inject in all frames and support YouTube privacy-enhanced embeds.
- Modify `src/adapters/youtube/index.ts`: match `youtube-nocookie.com`.
- Modify `src/adapters/ted/index.ts`: explicit English-track preference and public subtitle fallback.
- Modify `src/adapters/generic/index.ts`: expose protected track-loading helpers needed by TED.
- Modify `public/pagehook.js`: no logic change; run it on both YouTube host families through the manifest.
- Create `tests/frameBridge.test.ts`: message validation and routing tests.
- Modify `tests/subtitle.test.ts`: YouTube host matching and TED English-only behavior.
- Modify `e2e/extension.spec.ts`: embedded-frame two-line/no-third-line contract.

### Task 1: Frame message contract

**Files:**
- Create: `src/content/frameBridge.ts`
- Create: `tests/frameBridge.test.ts`

- [ ] **Step 1: Write failing protocol tests**

```ts
import { describe, expect, it } from 'vitest';
import { isFrameMessage, makeFrameCommand, makeFrameState } from '@/content/frameBridge';

describe('subtitle frame messages', () => {
  it('accepts only the fixed LinguaFlow command contract', () => {
    expect(isFrameMessage(makeFrameCommand('toggle'))).toBe(true);
    expect(isFrameMessage({ source: 'other', type: 'subtitle-command', command: 'toggle' })).toBe(false);
    expect(isFrameMessage({ source: 'linguaflow', type: 'subtitle-command', command: 'delete' })).toBe(false);
  });

  it('serializes child readiness and subtitle status', () => {
    expect(makeFrameState('ready', 'track')).toEqual({
      source: 'linguaflow', type: 'subtitle-frame-state', status: 'ready', mode: 'track',
    });
  });
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/frameBridge.test.ts`

Expected: FAIL because `@/content/frameBridge` does not exist.

- [ ] **Step 3: Implement the closed protocol**

```ts
export type SubtitleFrameCommand = 'toggle' | 'open' | 'close';
export type SubtitleFrameStatus = 'ready' | 'no-video' | 'no-subtitles' | 'closed';

export type FrameMessage =
  | { source: 'linguaflow'; type: 'subtitle-command'; command: SubtitleFrameCommand }
  | { source: 'linguaflow'; type: 'subtitle-frame-ready' }
  | { source: 'linguaflow'; type: 'subtitle-frame-state'; status: SubtitleFrameStatus; mode?: 'track' | 'live' };

export const makeFrameCommand = (command: SubtitleFrameCommand): FrameMessage =>
  ({ source: 'linguaflow', type: 'subtitle-command', command });

export const makeFrameState = (status: SubtitleFrameStatus, mode?: 'track' | 'live'): FrameMessage =>
  ({ source: 'linguaflow', type: 'subtitle-frame-state', status, ...(mode ? { mode } : {}) });

export function isFrameMessage(value: unknown): value is FrameMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.source !== 'linguaflow') return false;
  if (v.type === 'subtitle-frame-ready') return true;
  if (v.type === 'subtitle-command') return ['toggle', 'open', 'close'].includes(String(v.command));
  return v.type === 'subtitle-frame-state' && ['ready', 'no-video', 'no-subtitles', 'closed'].includes(String(v.status));
}
```

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test -- tests/frameBridge.test.ts && npm run typecheck`

Expected: tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/content/frameBridge.ts tests/frameBridge.test.ts
git commit -m "feat: define embedded subtitle frame protocol"
```

### Task 2: YouTube embed recognition and manifest injection

**Files:**
- Modify: `public/manifest.json`
- Modify: `src/adapters/youtube/index.ts`
- Modify: `tests/subtitle.test.ts`

- [ ] **Step 1: Write failing host-matching tests**

```ts
import { YouTubeAdapter } from '@/adapters/youtube';

it('matches standard and privacy-enhanced YouTube embeds', () => {
  const adapter = new YouTubeAdapter();
  expect(adapter.match('https://www.youtube.com/embed/abc')).toBe(true);
  expect(adapter.match('https://www.youtube-nocookie.com/embed/abc')).toBe(true);
  expect(adapter.match('https://example.com/embed/abc')).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/subtitle.test.ts`

Expected: FAIL for `youtube-nocookie.com`.

- [ ] **Step 3: Add host matching and all-frame injection**

Update `YouTubeAdapter.match` to accept:

```ts
return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(host);
```

Set `"all_frames": true` on the main content-script entry. Extend the MAIN-world
`pagehook.js` entry to match:

```json
[
  "https://www.youtube.com/*",
  "https://m.youtube.com/*",
  "https://www.youtube-nocookie.com/*"
]
```

- [ ] **Step 4: Verify manifest, unit tests, and build**

Run: `npm test -- tests/subtitle.test.ts && npm run typecheck && npm run build`

Expected: tests pass; built `dist/manifest.json` includes `all_frames` and the privacy-enhanced host.

- [ ] **Step 5: Commit**

```bash
git add public/manifest.json src/adapters/youtube/index.ts tests/subtitle.test.ts
git commit -m "feat: recognize YouTube embedded players"
```

### Task 3: Subtitle-only child-frame runtime

**Files:**
- Create: `src/content/subtitleRuntime.ts`
- Modify: `src/content/index.ts`
- Modify: `tests/frameBridge.test.ts`

- [ ] **Step 1: Write failing frame-routing tests**

Add tests for a pure helper:

```ts
import { shouldStartSubtitleFrame } from '@/content/frameBridge';

it('starts child runtime only for a meaningful video frame', () => {
  expect(shouldStartSubtitleFrame(false, [{ width: 800, height: 450 }])).toBe(true);
  expect(shouldStartSubtitleFrame(false, [{ width: 120, height: 80 }])).toBe(false);
  expect(shouldStartSubtitleFrame(true, [{ width: 800, height: 450 }])).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/frameBridge.test.ts`

Expected: FAIL because `shouldStartSubtitleFrame` does not exist.

- [ ] **Step 3: Implement frame classification and extract runtime**

Implement:

```ts
export function shouldStartSubtitleFrame(
  isTop: boolean,
  videos: Array<{ width: number; height: number }>,
): boolean {
  return !isTop && videos.some((v) => v.width >= 200 && v.height >= 120);
}
```

Move adapter registry, `SubtitleController`, subtitle UI state, video rectangle
tracking, native-caption cleanup, and toggle/open/close actions into
`createSubtitleRuntime({ settings, translate, mountUi, onState })`. It returns
`detect()`, `open()`, `close()`, `toggle()`, and `destroy()`.

At content entry:

```ts
if (document.contentType === 'text/html') {
  if (window.top === window) void main();
  else void startChildSubtitleRuntime();
}
```

The child listens only when `event.source === window.parent` and
`isFrameMessage(event.data)`. The top frame forwards subtitle commands with
`iframe.contentWindow?.postMessage(makeFrameCommand(command), '*')`; no subtitle
text, credentials, or provider settings cross frame boundaries.

- [ ] **Step 4: Verify focused tests and all unit tests**

Run: `npm test -- tests/frameBridge.test.ts && npm test && npm run typecheck`

Expected: all tests pass and no duplicate/unused runtime declarations remain.

- [ ] **Step 5: Commit**

```bash
git add src/content/frameBridge.ts src/content/subtitleRuntime.ts src/content/index.ts tests/frameBridge.test.ts
git commit -m "feat: run subtitles inside embedded video frames"
```

### Task 4: TED English-only subtitle fallback

**Files:**
- Modify: `src/adapters/generic/index.ts`
- Modify: `src/adapters/ted/index.ts`
- Modify: `tests/subtitle.test.ts`

- [ ] **Step 1: Write failing track-selection tests**

```ts
import { preferEnglishTracks } from '@/adapters/ted';

it('puts an English-only track first without requiring a translated track', () => {
  const tracks = [
    { id: 'en', label: 'English', language: 'en', kind: 'subtitles' as const, segments: [] },
  ];
  expect(preferEnglishTracks(tracks).map((t) => t.id)).toEqual(['en']);
});

it('prefers English when several TED tracks are available', () => {
  const tracks = [
    { id: 'fr', label: 'Français', language: 'fr', kind: 'subtitles' as const, segments: [] },
    { id: 'en', label: 'English', language: 'en-US', kind: 'subtitles' as const, segments: [] },
  ];
  expect(preferEnglishTracks(tracks).map((t) => t.id)).toEqual(['en', 'fr']);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- tests/subtitle.test.ts`

Expected: FAIL because `preferEnglishTracks` does not exist.

- [ ] **Step 3: Implement TED ordering and public fallback**

```ts
export function preferEnglishTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  return [...tracks].sort((a, b) => Number(/^en(?:-|$)/i.test(b.language)) - Number(/^en(?:-|$)/i.test(a.language)));
}
```

Make the generic `<track src>` loader `protected`, then let `TedAdapter` call
`super.getSubtitleTracks()`, order populated tracks with `preferEnglishTracks`,
and parse only subtitle URLs already exposed by `<track>` or TED's public player
configuration. Normalize results to `SubtitleTrack`; return `[]` when no public
source is available.

- [ ] **Step 4: Verify tests and build**

Run: `npm test -- tests/subtitle.test.ts && npm test && npm run typecheck && npm run build`

Expected: all unit tests pass, typecheck is clean, and both Vite builds succeed.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/generic/index.ts src/adapters/ted/index.ts tests/subtitle.test.ts
git commit -m "feat: support TED English-only subtitles"
```

### Task 5: End-to-end two-line contract and final verification

**Files:**
- Modify: `e2e/extension.spec.ts`
- Modify: `src/content/ui/shadow.css` only if the fixture exposes a third visible line

- [ ] **Step 1: Add an embedded-player regression fixture**

Create a local outer page with a same-test-server iframe representing an embed.
The inner frame contains a video, one English caption source, and a native caption
element. Toggle subtitles from the outer tab and assert:

```ts
await expect(frame.locator('.lf-sub-original')).toHaveText('English caption');
await expect(frame.locator('.lf-sub-translation')).toHaveText('中文字幕');
await expect(frame.locator('.native-caption')).toHaveCSS('opacity', '0');
await expect(frame.locator('.lf-sub-original, .lf-sub-translation')).toHaveCount(2);
```

- [ ] **Step 2: Run and verify the regression test**

Run: `npm run build && npx playwright test e2e/extension.spec.ts --grep "embedded subtitles"`

Expected: PASS. If the environment cannot launch extension Chromium, record the
environment error and perform the remaining non-browser verification; do not
weaken assertions.

- [ ] **Step 3: Run complete verification**

Run: `npm test && npm run typecheck && npm run build && git diff --check`

Expected: all unit tests pass, typecheck and build exit 0, and no whitespace errors.

- [ ] **Step 4: Manually verify the supplied sites**

Reload the unpacked extension, then verify:

- Khan Academy lesson: opening LinguaFlow subtitles inside the embedded
  `youtube-nocookie.com` player shows English + Chinese and hides YouTube native CC.
- TED English-only video: English + Chinese appear and native captions are hidden.
- Closing LinguaFlow restores each player's native captions.

- [ ] **Step 5: Commit**

```bash
git add e2e/extension.spec.ts src/content/ui/shadow.css
git commit -m "test: cover embedded bilingual subtitles"
```
