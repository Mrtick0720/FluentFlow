# LinguaFlow Live Bilingual Subtitle Overlay

Date: 2026-07-04  
Status: Approved

## Goal

Replace the large always-open subtitle learning panel with a quiet, Tracy-style bilingual overlay. Live Chinese translations must follow the current English caption promptly and must never be displayed against a different English caption.

## Confirmed experience

- The default view contains only two centered subtitle lines: Chinese above English.
- The overlay sits inside the lower portion of the video, about 8% above its bottom edge.
- Its maximum width is about 70% of the video width, while narrow videos retain safe side margins.
- The background is rounded, dark gray, and translucent (`rgba(24, 24, 24, 0.78)`), with white text and a subtle text shadow.
- Chinese is slightly larger than English.
- Learning controls are completely hidden at rest. Hovering or keyboard focus reveals a compact toolbar above the subtitle.
- The toolbar keeps the existing actions: transcript, previous, repeat, next, sentence pause, speed, bookmark, explain, and close.
- The user may still drag the overlay, but resize chrome and the permanent title/header are removed.

## Caption and translation flow

1. The YouTube adapter observes the visible native caption DOM and emits normalized caption text whenever it changes.
2. The controller immediately displays the new English text and clears the translation associated with the previous caption.
3. A short 200 ms stability window absorbs YouTube's word-by-word DOM mutations without imposing the current 600 ms delay.
4. While waiting, the Chinese line reserves its height and may show a quiet, low-opacity `翻译中…` state. Old Chinese is never retained under new English.
5. Each translation request carries a monotonically increasing token and the exact source text. A response is rendered only when both still match the current caption.
6. Duplicate normalized captions do not trigger another request. Translation cache behavior remains unchanged.
7. Failures leave the Chinese line empty for the current caption; the next stable caption retries normally. No stale fallback is shown.

For full subtitle tracks, the current cue is shown immediately. Existing look-ahead translation remains, but request/result bookkeeping must prevent overlapping look-ahead calls from assigning a translation to the wrong segment.

## Positioning and interaction

The overlay position is derived from the current video rectangle rather than a one-time viewport coordinate. It is recalculated on window resize, scroll, fullscreen changes, and relevant video layout changes. This keeps the subtitles attached to theater mode and fullscreen players.

The subtitle surface accepts pointer interaction only within its own bounds. The hidden toolbar becomes visible on `:hover` and `:focus-within`, with a short fade. Touch users reveal it by tapping the subtitle once. Toolbar interaction must not start dragging or seek the underlying video.

When captions are absent, the compact overlay may show the existing waiting/no-subtitle message. The transcript remains a separate optional panel.

## Component changes

- `SubtitleController`: shorten live stabilization, clear stale translation on source change, preserve strict request/source matching, and expose an explicit translating state.
- `YouTubeAdapter`: normalize whitespace and avoid combining stale or hidden caption windows where possible.
- `SubtitlePanel`: split the passive caption surface from the hover/focus toolbar; remove the permanent header and resize affordance.
- Content UI store: represent translating state and a video-relative anchor/rectangle rather than a fixed point if required by implementation.
- Shadow styles: add the translucent compact surface, responsive typography, hidden-toolbar transitions, and fullscreen-safe stacking.

## Error handling

- A provider error must not restore or retain the prior caption's Chinese text.
- Out-of-order responses are discarded silently.
- If the video disappears or is replaced during navigation, the controller detaches observers and clears pending timers/tokens before reattaching.
- If the player rectangle cannot be measured, the overlay falls back to a centered position near the viewport bottom.

## Verification

- Unit tests simulate rapidly growing YouTube caption text and prove only the latest stable caption can update Chinese.
- Unit tests prove a new English caption clears the previous Chinese immediately.
- Unit tests cover out-of-order responses, duplicate captions, empty gaps, detach, and translation failures.
- Component/style verification confirms controls are hidden at rest and visible on hover/focus.
- Manual Chrome checks cover normal, theater, fullscreen, resize, scroll, pause/seek, and a fast-speaking YouTube video.
- Build, type checking, unit tests, and extension end-to-end smoke tests must pass.

## Out of scope

- Fetching protected or private YouTube transcript endpoints.
- Replacing the configured translation provider.
- Redesigning the transcript side panel or unrelated page-translation UI.
