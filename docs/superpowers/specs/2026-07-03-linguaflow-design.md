# LinguaFlow — Design Document

Date: 2026-07-03
Status: Approved (derived from user-authored PRD; user directed implementation to proceed)

## 1. Product Summary

LinguaFlow is an original Chrome extension (Manifest V3) that helps Chinese speakers
learn English while browsing. It provides bilingual webpage reading, AI translation
and explanation, video subtitle learning, vocabulary/sentence notebooks, an AI chat
assistant, local reading statistics, offline caching, and a privacy-first default
posture. It does not clone any existing extension's UI, branding, source code, or
proprietary workflows; only common web UX patterns are used.

## 2. Architecture Overview

### 2.1 Process topology

```
┌────────────────────────────────────────────────────────────┐
│ Service Worker (background)                                │
│  - MessageRouter: typed request/response hub               │
│  - TranslationService  → ProviderRegistry                  │
│  - DictionaryService   → dictionaryapi.dev + AI fallback   │
│  - AIService           → OpenAI-compatible / Anthropic     │
│  - Repositories (IndexedDB): vocabulary, sentences, cache, │
│    stats, conversations                                    │
│  - SettingsStore (chrome.storage.local)                    │
│  - ContextMenus, Commands, SidePanel wiring                │
└───────────────▲───────────────────────────▲────────────────┘
                │ chrome.runtime messages   │
┌───────────────┴───────────────┐ ┌─────────┴────────────────┐
│ Content Script (per tab, IIFE)│ │ Extension pages (React)  │
│  - PageTranslator (DOM)       │ │  - Popup: quick controls │
│  - SelectionToolbar           │ │  - Options: settings     │
│  - WordPopup / SentencePopup  │ │  - Side panel: AI chat + │
│  - SubtitleController         │ │    notebooks             │
│    (VideoAdapter registry)    │ │                          │
│  - Shadow-DOM UI host         │ │                          │
└───────────────────────────────┘ └──────────────────────────┘
```

Rules:
- All network I/O and all persistent storage live in the service worker.
  Content scripts and pages communicate only via a typed message protocol
  (`src/shared/messages.ts`). API keys never reach page context.
- Content script UI is rendered inside a closed Shadow DOM host to isolate styles.
  Translated text nodes must live in the page DOM (they participate in layout), so
  they use `lf-`-prefixed classes with minimal styling from `content.css`.

### 2.2 Build system

Two Vite configs (content scripts cannot be ES modules; the service worker and
pages can):

- `vite.config.ts` — background service worker (ESM) + popup/options/sidepanel
  (React + Tailwind v4 multi-page build).
- `vite.content.config.ts` — content script as a self-contained IIFE bundle
  (`content.js` + `content.css`), `emptyOutDir: false` so it layers into `dist/`.

No third-party MV3 build plugins; `manifest.json` is static in `public/`.

### 2.3 Extensibility (ports & adapters)

- `TranslationProvider` — `google` (public endpoint, no key), `deepl`, `openai`,
  `azure`, `custom` (OpenAI-compatible endpoint). Registered in a `ProviderRegistry`;
  adding a provider = implement interface + register.
- `AIProvider` — OpenAI-compatible chat completions (covers OpenAI/custom/Ollama)
  and Anthropic Messages API; both support streaming (SSE) relayed to UIs via
  `chrome.runtime.Port`.
- `VideoAdapter` — `match/getVideo/getSubtitleTracks/getCurrentCaption/seek/
  onCaptionChanged`; adapters: `youtube`, `ted`, `bbc`, `generic` (HTML5
  `textTracks`). First matching adapter wins; generic is the fallback. Only
  publicly accessible subtitle data (native tracks, WebVTT, visible transcript/DOM
  captions) is read — no DRM/paywall/login bypass, no protected-resource scraping.
- `DictionarySource` — free dictionary API first, AI enrichment (CEFR,
  collocations) only when an AI provider is configured.

### 2.4 Storage

- `chrome.storage.local`: `UserSettings` only (single versioned document).
- IndexedDB (`linguaflow` DB, service-worker owned, Repository pattern over a
  hand-rolled promise wrapper, zero deps): `vocabulary`, `sentences`,
  `translation_cache` (TTL), `dictionary_cache` (TTL), `ai_cache` (TTL),
  `reading_sessions`, `stats`, `conversations`, `review_history`.
- Import/export: JSON (full backup) and CSV (notebooks) generated in the pages.

### 2.5 Page translation pipeline

1. Collect translatable block elements via TreeWalker (skip `script/style/pre/code/
   textarea/input/contenteditable/nav landmarks`, skip already-translated nodes via
   `data-lf-*` marks).
2. Observe with IntersectionObserver; translate viewport-first, lazily.
3. Batch segments per provider limits; check cache first; single in-flight queue
   with debounce.
4. Insert translation as a sibling block (`bilingual` mode), replace text
   (`translation-only`), or restore (`original`). `side-by-side` renders a
   two-column wrapper for wide screens. All insertions reversible.
5. MutationObserver picks up dynamically added content.

### 2.6 Privacy & security

- Defaults: no analytics, no history/URL/title/subtitle upload, no cloud sync.
  Only the text the user asks to translate is sent to the selected provider.
- Known provider endpoints in `host_permissions`; custom endpoints require runtime
  `chrome.permissions.request` on the exact origin.
- No remote code; CSP-compliant; all dynamic text inserted via `textContent`
  (never `innerHTML` with unsanitized input). API keys obfuscated at rest
  (AES-GCM with an extension-local key — documented as obfuscation, not true
  security, per platform limits).

### 2.7 Performance

Viewport-first lazy translation, request batching + de-dup, IndexedDB TTL caches,
debounced observers, streaming AI responses, minimal DOM mutation (marks +
reversible inserts), React only in extension pages and the shadow-DOM popup UI.

### 2.8 Testing

- Vitest unit tests: providers (request/response parsing with mocked fetch),
  segmentation, VTT parsing, repositories (fake-indexeddb), cache TTL, settings
  migration, message router.
- Playwright E2E scaffold: loads `dist/` unpacked, smoke-tests popup and page
  translation against a local fixture page with a mocked provider.

## 3. Folder structure

```
src/
  background/        service worker entry + router + service wiring
  content/           content script entry, page translator, popups, subtitles
  popup/             React popup page
  options/           React options page
  sidebar/           React side panel (AI chat + notebooks)
  components/        shared React components (pages)
  hooks/             shared React hooks
  services/
    translation/     TranslationProvider impls + registry
    dictionary/      dictionary sources
    subtitle/        VTT parsing, subtitle models
    video/           VideoAdapter interface + controller
    storage/         IDB wrapper + repositories
    cache/           TTL cache over IDB
    ai/              AIProvider impls + prompt library
  adapters/
    youtube/  ted/  bbc/  generic/
  utils/             segmentation, dom, debounce, csv, crypto
  types/             data models
  shared/            messages, settings schema, constants
assets/              icons (generated, original)
public/              manifest.json + static assets copied to dist
```

## 4. Data models

Defined in `src/types/models.ts`: `TranslationRecord`, `Vocabulary`, `Sentence`,
`SubtitleSegment`, `SubtitleTrack`, `Article`, `ReadingSession`, `UserSettings`,
`AIConversation`, `ReviewHistory` (full TypeScript interfaces; see source).

## 5. UI

Modern minimal aesthetic (common patterns: command-bar simplicity, soft cards,
neutral grays with a single accent). Light/dark via `prefers-color-scheme` +
manual override. Popup ≤ 360px wide; floating translation card and resizable
subtitle panel in shadow DOM; keyboard shortcuts via `chrome.commands` +
in-page hotkeys; ARIA roles/labels and focus management for popups.

## 6. Error handling

- Provider errors surface as typed `TranslationError` (rate-limit, auth, network)
  with per-paragraph retry affordance; failed segments keep original text.
- Subtitle: if no accessible track exists, show a graceful "no subtitles
  available" notice — never attempt bypass.
- Router wraps every handler; rejections serialize to `{ ok: false, error }`.

## 7. Out of scope (v0.1)

Cloud sync backend, spaced-repetition scheduler UI (data model reserved via
`ReviewHistory`), PDF/EPUB translation, Firefox port, i18n of extension chrome
(UI strings centralized for future i18n).
