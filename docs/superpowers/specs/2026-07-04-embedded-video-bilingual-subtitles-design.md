# Embedded Video Bilingual Subtitles Design

Date: 2026-07-04
Status: Approved

## Goal

Provide the existing LinguaFlow English-and-Chinese subtitle experience for
cross-origin YouTube embeds (including Khan Academy) and TED videos that expose
English subtitles, while showing exactly two subtitle lines and preserving all
existing learning controls.

## Scope

- YouTube players embedded through `youtube.com/embed` or
  `youtube-nocookie.com/embed`.
- Khan Academy pages that host those players in cross-origin iframes.
- TED and `embed.ted.com` players with accessible English TextTrack, WebVTT, or
  public page subtitle data.
- Existing subtitle translation, transcript, seeking, playback speed, looping,
  bookmarking, and explanation features.

Speech recognition, DRM bypass, login/paywall bypass, and protected subtitle
extraction are out of scope.

## Runtime boundaries

The top frame continues to run the complete LinguaFlow content application:
page translation, selection tools, dictionaries, and general UI. Child frames
do not run those page features.

A child frame starts a lightweight subtitle runtime only when it contains a
meaningfully sized main video. The runtime owns the adapter, subtitle controller,
player-relative overlay, transcript state, and native-caption suppression for
that frame. This keeps cross-origin video DOM access local to its own origin and
allows the overlay to follow player resizing and fullscreen transitions.

The manifest injects the content bundle into all frames and injects the YouTube
MAIN-world timed-text observer on both regular and privacy-enhanced YouTube
hosts. Runtime branching prevents duplicate full applications.

## Frame coordination

The top-frame content script receives extension commands as it does today. For
subtitle commands it also sends a narrowly scoped `window.postMessage` command
to each direct video iframe. Child runtimes accept only LinguaFlow messages from
their parent window, validate the message shape, and toggle their local subtitle
controller.

Child frames report readiness and subtitle state to the parent. The parent uses
those reports for user feedback and avoids opening a second top-frame subtitle
panel when an embedded player owns the active subtitles. Reloaded or replaced
iframes announce readiness again; stale frame state is discarded.

## YouTube embeds

`YouTubeAdapter.match` recognizes `youtube.com`, `m.youtube.com`, and
`youtube-nocookie.com`. Embedded players use the same public timed-text capture,
live caption fallback, transcript translation, and native-caption hiding as a
top-level YouTube watch page.

The child runtime is anchored to the iframe's local video rectangle. It hides
the YouTube native caption container with opacity rather than removing it, so
caption updates continue. Closing LinguaFlow restores the native caption style.

## TED subtitles

`TedAdapter` resolves subtitle sources in this order:

1. populated native `TextTrack` cues;
2. public `<track src>` WebVTT;
3. public subtitle metadata already present in the page or player configuration.

English is the preferred source track when available. A video with only an
English track is fully supported: its segments enter the existing controller and
are translated to the configured target language. Other source tracks remain
selectable where the player exposes them.

No source is guessed from inaccessible endpoints. If no accessible captions
exist, the state is `no-subtitles` and the UI explains that the video has no
accessible subtitle track.

## Display and cleanup

While LinguaFlow subtitles are active, the player-native captions are visually
hidden and the LinguaFlow overlay displays exactly two lines: original English
above translated Chinese. Translation failure keeps the English line visible and
does not pause playback.

Closing the panel, navigating away, replacing the video, unloading the frame, or
disabling subtitles removes observers and injected styles, cancels pending
translation work, and restores native captions. No third subtitle line remains.

## Security and privacy

Frame messages use a fixed source/type contract, require the expected parent or
child window relationship, and carry subtitle commands/state only. Subtitle text
is sent only to the translation provider already selected by the user. The
implementation reads only subtitle resources already available to the page.

## Testing

Automated tests cover:

- matching regular, mobile, embed, and privacy-enhanced YouTube hosts;
- classifying top frames versus video child frames;
- parent-to-child subtitle command validation and forwarding;
- child readiness/state messages and stale-frame replacement;
- an embedded YouTube fixture producing one English and one Chinese line;
- native caption hiding and restoration without removing caption DOM;
- TED native cues, public WebVTT fallback, and English-only track translation;
- cleanup after close, navigation, and frame unload;
- the absence of a third visible subtitle line.

Manual verification uses the provided Khan Academy lesson and representative TED
videos with English-only and multilingual caption sets.
