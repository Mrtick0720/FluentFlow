import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import shadowCss from './ui/shadow.css?inline';
import './styles.css';
import { BbcAdapter } from '@/adapters/bbc';
import { GenericHtml5Adapter } from '@/adapters/generic';
import { TedAdapter } from '@/adapters/ted';
import { YouTubeAdapter } from '@/adapters/youtube';
import { initTimedTextCapture, onTimedTextCaptured } from '@/adapters/youtube/timedtext';
import {
  explainDifficultWordsPrompt,
  explainGrammarPrompt,
  explainWordPrompt,
  generateExamplesPrompt,
  rewritePrompt,
} from '@/services/ai/prompts';
import { VideoAdapterRegistry } from '@/services/video/adapter';
import { SubtitleController } from '@/services/video/controller';
import { sendRequest, type Response, type TabEnvelope } from '@/shared/messages';
import { shouldAutoTranslate, type ProviderSelection, type UserSettings } from '@/shared/settings';
import type { Glossary, QualitySegment } from '@/services/translation/quality';
import type { DisplayMode } from '@/types/models';
import { extractPageText, sentenceAround } from '@/utils/dom';
import { PageTranslator } from './pageTranslator';
import { injectYouTubePlayerButton } from './youtubeButton';
import { App, type UIActions } from './ui/App';
import { showToast, uiStore, type AnchorRect } from './ui/store';
import {
  isFrameMessage,
  makeFrameCommand,
  shouldStartSubtitleFrame,
  type SubtitleFrameCommand,
} from './frameBridge';
import { createSubtitleRuntime } from './subtitleRuntime';

if (document.contentType === 'text/html') {
  // Top frame runs the full app; child frames (embedded players such as
  // YouTube in Khan Academy) run only the two-line subtitle runtime.
  if (window.top === window) void main();
  else void startChildSubtitleRuntime();
}

async function main() {
  let settings: UserSettings = await sendRequest('settings.get', null).catch(() => null as never);
  if (!settings) return; // background unavailable (e.g. extension reloading)

  /* ---------- shadow-DOM UI host ---------- */

  const host = document.createElement('div');
  host.id = 'lf-host';
  host.style.all = 'initial';
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = shadowCss;
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  document.documentElement.appendChild(host);

  const isOwnEvent = (e: Event) => e.composedPath().includes(host);

  /* ---------- page translation ---------- */

  const translate = async (texts: string[]) => {
    const res = await sendRequest('translation.translate', {
      texts,
      from: settings.sourceLanguage,
      to: settings.targetLanguage,
    });
    return res.translations;
  };

  // Whole-page translation. 'fast' uses machine translation (its own fast
  // provider) so a slow LLM chosen for selection/explanations doesn't make整页
  // 翻译 crawl. 'ai' uses the LLM with context + a per-page glossary threaded
  // across batches for terminology consistency.
  let pageMode: 'fast' | 'ai' = settings.pageTranslationMode;
  let pageGlossary: Glossary = {};
  // Domain inferred by the first AI batch, reused by the rest (no re-inference).
  let pageDomain: string | undefined;

  // Resolve an OpenAI-compatible endpoint for AI 精译 from the user's config.
  const aiTranslationProvider = (): ProviderSelection => {
    const p = settings.translationProvider;
    if (p === 'openai' || p.startsWith('custom:')) return p;
    const first = settings.customEndpoints[0];
    return first ? (`custom:${first.id}` as ProviderSelection) : 'openai';
  };

  const translatePage = async (segments: QualitySegment[]) => {
    if (pageMode === 'ai') {
      const res = await sendRequest('translation.translateQuality', {
        segments,
        from: settings.sourceLanguage,
        to: settings.targetLanguage,
        provider: aiTranslationProvider(),
        domain: pageDomain,
        glossary: pageGlossary,
      });
      if (res.glossary) pageGlossary = { ...pageGlossary, ...res.glossary };
      if (!pageDomain && res.domain) pageDomain = res.domain; // lock in after batch 1
      return res.translations;
    }
    const res = await sendRequest('translation.translate', {
      texts: segments.map((s) => s.text),
      from: settings.sourceLanguage,
      to: settings.targetLanguage,
      provider: settings.pageTranslationProvider,
    });
    return res.translations;
  };

  let errorToastShown = false;
  const translator = new PageTranslator({
    translate: translatePage,
    targetLanguage: settings.targetLanguage,
    mode: settings.displayMode,
    quality: settings.pageTranslationMode === 'ai',
    style: settings.translationStyle,
    fontScale: settings.fontScale,
    onProgress: (done, total) => uiStore.set({ progress: { done, total } }),
    onError: (message) => {
      // Transient per-line failures (bad JSON / count mismatch) self-heal via
      // retry — don't nag. Only surface a likely config problem (key/URL/model)
      // once per translation run.
      if (/valid JSON|translations in response/i.test(message)) return;
      if (errorToastShown) return;
      errorToastShown = true;
      showToast(`翻译失败：${message}`);
    },
  });

  function togglePage() {
    if (translator.active) {
      translator.stop();
      uiStore.set({ pageActive: false, progress: { done: 0, total: 0 } });
    } else {
      errorToastShown = false; // re-arm the one-time error toast for this run
      translator.start();
      uiStore.set({ pageActive: true });
    }
    // Green toolbar badge while this tab is being translated.
    void sendRequest('action.setBadge', { active: translator.active }).catch(() => {});
  }

  // Translate the whole page in a chosen mode. When it's already active this
  // just toggles it off (restore). 'bilingual' keeps the original above each
  // translation; 'translation-only' replaces the original in place (Chrome-style).
  function translatePageAs(mode: DisplayMode, quality: 'fast' | 'ai' = 'fast') {
    if (!translator.active) {
      translator.setMode(mode);
      pageMode = quality;
      pageGlossary = {}; // fresh glossary + domain per translation run
      pageDomain = undefined;
      translator.setQuality(quality === 'ai');
      void sendRequest('settings.set', {
        patch: { displayMode: mode, pageTranslationMode: quality },
      }).catch(() => {});
    }
    togglePage();
  }

  /* ---------- subtitle learning ---------- */

  const adapterRegistry = new VideoAdapterRegistry()
    .register(new YouTubeAdapter())
    .register(new TedAdapter())
    .register(new BbcAdapter())
    .register(new GenericHtml5Adapter());

  let videoWatchedRecorded = false;
  const subtitleController = new SubtitleController(adapterRegistry, {
    translate,
    onState: (state) => uiStore.set({ subtitleState: state }),
    onTranscript: (segments) => uiStore.set({ transcript: segments }),
    smartTranslate: async (texts) =>
      (await sendRequest('subtitle.smartTranslate', { texts, to: settings.targetLanguage })).sentences,
  });

  // Auto-open coordination. Opening in live mode and then upgrading to the full
  // transcript flickers; on YouTube we instead wait for captions to be ready
  // and open directly in track mode.
  let autoSubtitleArmed = false; // want to auto-open on this page
  let autoSubtitleOpened = false; // already auto-opened (don't repeat)
  let subtitleUpgraded = false; // live→track upgrade already done

  function openAutoSubtitle() {
    if (!autoSubtitleArmed || autoSubtitleOpened || uiStore.get().subtitleVisible) return;
    autoSubtitleArmed = false;
    autoSubtitleOpened = true;
    void toggleSubtitlePanel();
  }

  function requestAutoSubtitle() {
    if (autoSubtitleArmed || autoSubtitleOpened || uiStore.get().subtitleVisible) return;
    autoSubtitleArmed = true;
    if (/(^|\.)youtube\.com$/.test(location.hostname)) {
      // Prefer opening once the player has fetched captions (→ track mode).
      // onTimedTextCaptured triggers openAutoSubtitle; this is the fallback.
      setTimeout(openAutoSubtitle, 5000);
    } else {
      openAutoSubtitle();
    }
  }

  function resetAutoSubtitle() {
    autoSubtitleArmed = false;
    autoSubtitleOpened = false;
    subtitleUpgraded = false;
  }

  function detectVideo(attempt = 0) {
    if (isVideoPage() && findMainVideo()) {
      uiStore.set({ videoDetected: true });
      startVideoLayoutSync(); // pin the floating buttons to the video
      // Auto-open the bilingual subtitle panel: globally, or on this site.
      const autoSubtitle =
        settings.autoSubtitleVideoSites || settings.autoSubtitleSites.includes(location.hostname);
      if (autoSubtitle) requestAutoSubtitle();
    } else if (attempt < 5) {
      setTimeout(() => detectVideo(attempt + 1), 1500);
    }
  }
  // detectVideo() is invoked after all `let` declarations below are
  // initialized (it calls startVideoLayoutSync / toggleSubtitlePanel).

  // YouTube: a native-looking button in the player control bar opens the
  // quick-action menu (translate page / subtitles / styles / learning panel).
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    injectYouTubePlayerButton((rect) => {
      const open = uiStore.get().playerMenu !== null;
      uiStore.set({ playerMenu: open ? null : { x: rect.left, y: rect.top } });
    });
    // SPA navigation: leaving a watch page tears down the video UI (so the
    // buttons/subtitle don't linger over the feed); entering one re-detects.
    window.addEventListener('yt-navigate-finish', () => {
      setTimeout(() => {
        resetAutoSubtitle();
        if (isVideoPage()) {
          detectVideo();
        } else {
          if (uiStore.get().subtitleVisible) void toggleSubtitlePanel();
          uiStore.set({ videoDetected: false, videoRect: null, playerMenu: null });
        }
      }, 300);
    });
  }

  // YouTube: once the player fetches captions (user enables CC), the page
  // hook hands us a valid full-transcript URL — upgrade live mode to the
  // complete track without the user doing anything else.
  if (/(^|\.)youtube\.com$/.test(location.hostname)) {
    initTimedTextCapture();
    onTimedTextCaptured(() => {
      // Auto-open path: captions are now ready — open directly in track mode.
      if (autoSubtitleArmed) {
        openAutoSubtitle();
        return;
      }
      // Manual early-open path: upgrade live → full transcript, at most once.
      const ui = uiStore.get();
      if (ui.subtitleVisible && ui.subtitleState?.mode === 'live' && !subtitleUpgraded) {
        subtitleUpgraded = true;
        void subtitleController.attach(location.href).then(() => {
          showToast('已获取完整字幕，切换到整片模式');
        });
      }
    });
  }

  // Feed/list pages (e.g. YouTube home, search) have hover-preview thumbnails
  // that are real <video> elements. Only show the video UI on a genuine watch
  // page. Known sites are gated by URL; unknown sites fall back to a size
  // heuristic in findMainVideo (a main player is large; a thumbnail is not).
  function isVideoPage(): boolean {
    const host = location.hostname;
    const path = location.pathname;
    if (/(^|\.)youtube\.com$/.test(host)) return /^\/(watch|shorts|embed)\b/.test(path);
    if (/(^|\.)bilibili\.com$/.test(host)) {
      return /^\/(video|bangumi|cheese|medialist|watchlater|list|festival)\b/.test(path);
    }
    return true;
  }

  const urlGatedSite = /(^|\.)(youtube|bilibili)\.com$/.test(location.hostname);

  // The main <video> on the page — anchors the FAB + subtitle panel.
  function findMainVideo(): HTMLVideoElement | null {
    if (!isVideoPage()) return null;
    // Unknown sites: require the player to occupy a meaningful part of the
    // viewport so feed thumbnails don't qualify.
    const minMainWidth = Math.min(window.innerWidth * 0.5, 600);
    const videos = [...document.querySelectorAll('video')].filter((v) => {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 120) return false;
      if (urlGatedSite) return true; // URL already confirms a watch page
      return r.width >= minMainWidth && r.height >= 170;
    });
    if (videos.length === 0) return null;
    return videos.reduce((best, v) => {
      const area = (el: HTMLVideoElement) => {
        const r = el.getBoundingClientRect();
        return r.width * r.height;
      };
      return area(v) > area(best) ? v : best;
    });
  }

  // Track the main video's rect continuously (resize / scroll / fullscreen /
  // layout changes), so the floating buttons stay pinned to the video.
  let videoLayoutStarted = false;
  function startVideoLayoutSync(): void {
    if (videoLayoutStarted) return;
    videoLayoutStarted = true;
    let frame = 0;
    let observed: HTMLVideoElement | null = null;
    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measure())
        : null;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const video = findMainVideo();
        if (video && video !== observed) {
          if (observed) resizeObserver?.unobserve(observed);
          resizeObserver?.observe(video);
          observed = video;
        }
        const rect = video?.getBoundingClientRect();
        const hasVideo = !!rect && rect.width > 0;
        uiStore.set({
          videoDetected: hasVideo,
          videoRect: hasVideo
            ? { left: rect!.left, top: rect!.top, width: rect!.width, height: rect!.height }
            : null,
        });
        // Close a lingering subtitle panel when the main video is gone
        // (e.g. SPA navigation away from a watch page on any site).
        if (!hasVideo && uiStore.get().subtitleVisible) {
          subtitleController.detach();
          uiStore.set({ subtitleVisible: false, transcript: [], transcriptVisible: false });
          resetAutoSubtitle();
        }
      });
    };
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    document.addEventListener('fullscreenchange', measure);
    // YouTube resizes the player (theater/mini) without firing resize; poll.
    setInterval(measure, 1000);
    measure();
  }

  // Set when an embedded player frame (e.g. YouTube in Khan Academy) reports a
  // video. The player and its two lines live in the child; the top frame only
  // offers the toggle and forwards the command.
  let hasEmbeddedVideoFrame = false;

  // Forward the subtitle command to embedded player frames so their two-line
  // runtime toggles in lock-step. Only the command crosses the boundary.
  function broadcastSubtitleCommand(command: SubtitleFrameCommand) {
    for (const frame of document.querySelectorAll('iframe')) {
      frame.contentWindow?.postMessage(makeFrameCommand(command), '*');
    }
  }

  // A child frame (possibly relayed up through nesting) hosts a player. Expose
  // the subtitle affordance and, if subtitles are already open, tell it to open.
  window.addEventListener('message', (event) => {
    if (!isFrameMessage(event.data)) return;
    if (event.data.type === 'subtitle-frame-ready') {
      hasEmbeddedVideoFrame = true;
      if (!uiStore.get().videoDetected) uiStore.set({ videoDetected: true });
      if (uiStore.get().subtitleVisible) broadcastSubtitleCommand('open');
    }
  });

  async function toggleSubtitlePanel() {
    const closing = uiStore.get().subtitleVisible;
    broadcastSubtitleCommand(closing ? 'close' : 'open');

    // No local video but an embedded frame has one: it renders the two lines
    // itself, so don't attach / show a top-frame panel — just track the state.
    if (!findMainVideo() && hasEmbeddedVideoFrame) {
      uiStore.set({ subtitleVisible: !closing, transcript: [], transcriptVisible: false });
      return;
    }

    if (closing) {
      subtitleController.detach();
      uiStore.set({
        subtitleVisible: false,
        transcript: [],
        transcriptVisible: false,
      });
      return;
    }
    uiStore.set({ subtitleVisible: true });
    const state = await subtitleController.attach(location.href);
    if (state.status === 'ready' && !videoWatchedRecorded) {
      videoWatchedRecorded = true;
      void sendRequest('stats.record', {
        kind: 'video-watched',
        url: location.href,
        title: document.title,
      }).catch(() => {});
    }
  }

  // Everything the callback chain needs is now initialized — safe to start.
  detectVideo();

  // Hide the floating widget during fullscreen video playback.
  document.addEventListener('fullscreenchange', () => {
    uiStore.set({ isFullscreen: !!document.fullscreenElement });
  });

  /* ---------- word & sentence cards ---------- */

  async function openWordCard(
    word: string,
    context: string | undefined,
    x: number,
    y: number,
    anchor?: AnchorRect,
  ) {
    const aiOn = settings.ai.kind !== 'none';
    uiStore.set({
      wordCard: { x, y, anchor, word, context, loading: true, saved: false },
      toolbar: null,
    });
    try {
      const entry = await sendRequest('dictionary.lookup', { word, context });
      // Show the base entry (word, IPA, translated definitions) immediately;
      // the AI enrichment (CEFR + collocations) streams in without blocking.
      uiStore.set((prev) =>
        prev.wordCard?.word === word
          ? { wordCard: { ...prev.wordCard, entry, loading: false, enrichLoading: aiOn } }
          : {},
      );
      if (aiOn) {
        sendRequest('dictionary.enrich', { word })
          .then((enrichment) =>
            uiStore.set((prev) =>
              prev.wordCard?.word === word && prev.wordCard.entry
                ? {
                    wordCard: {
                      ...prev.wordCard,
                      entry: {
                        ...prev.wordCard.entry,
                        cefr: enrichment.cefr ?? prev.wordCard.entry.cefr,
                        collocations: enrichment.collocations ?? prev.wordCard.entry.collocations,
                      },
                      enrichLoading: false,
                    },
                  }
                : {},
            ),
          )
          .catch(() =>
            uiStore.set((prev) =>
              prev.wordCard?.word === word
                ? { wordCard: { ...prev.wordCard, enrichLoading: false } }
                : {},
            ),
          );
      }
    } catch (err) {
      uiStore.set((prev) =>
        prev.wordCard?.word === word
          ? {
              wordCard: {
                ...prev.wordCard,
                loading: false,
                error: err instanceof Error ? err.message : '查询失败',
              },
            }
          : {},
      );
    }
  }

  async function openSentenceCard(text: string, x: number, y: number, anchor?: AnchorRect) {
    uiStore.set({
      sentenceCard: { x, y, anchor, text, loading: true, saved: false },
      toolbar: null,
    });
    try {
      const { translations } = await sendRequest('translation.translate', {
        texts: [text],
        from: settings.sourceLanguage,
        to: settings.targetLanguage,
      });
      uiStore.set((prev) =>
        prev.sentenceCard?.text === text
          ? {
              sentenceCard: {
                ...prev.sentenceCard,
                translation: translations[0],
                loading: false,
              },
            }
          : {},
      );
    } catch (err) {
      uiStore.set((prev) =>
        prev.sentenceCard?.text === text
          ? {
              sentenceCard: {
                ...prev.sentenceCard,
                loading: false,
                error: err instanceof Error ? err.message : '翻译失败',
              },
            }
          : {},
      );
    }
  }

  function currentSelectionInfo():
    | { text: string; x: number; y: number; anchor: AnchorRect }
    | null {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!text || !selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return {
      text,
      x: rect.left,
      y: rect.bottom,
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left },
    };
  }

  /* ---------- UI actions ---------- */

  const actions: UIActions = {
    togglePage,
    toolbarTranslate() {
      const t = uiStore.get().toolbar;
      if (t) void openSentenceCard(t.text, t.x, t.y, t.anchor);
    },
    toolbarLookup() {
      const t = uiStore.get().toolbar;
      if (t) void openWordCard(t.text.trim(), undefined, t.x, t.y, t.anchor);
    },
    toolbarExplain() {
      const t = uiStore.get().toolbar;
      if (!t) return;
      void openSentenceCard(t.text, t.x, t.y, t.anchor).then(() => actions.sentenceAI('grammar'));
    },
    toolbarSave() {
      const t = uiStore.get().toolbar;
      if (!t) return;
      void (async () => {
        try {
          const { translations } = await sendRequest('translation.translate', {
            texts: [t.text],
            from: settings.sourceLanguage,
            to: settings.targetLanguage,
          });
          await sendRequest('sentences.add', {
            text: t.text,
            translation: translations[0] ?? '',
            sourceUrl: location.href,
            sourceTitle: document.title,
            tags: [],
          });
          uiStore.set({ toolbar: null });
          showToast('已加入句子本');
        } catch {
          showToast('保存失败');
        }
      })();
    },
    closeWordCard: () => uiStore.set({ wordCard: null }),
    saveWord() {
      const card = uiStore.get().wordCard;
      if (!card) return;
      const sense = card.entry?.senses[0];
      void sendRequest('vocabulary.add', {
        word: card.word,
        translation: sense?.meaningTranslation ?? sense?.meaning ?? '',
        ipa: card.entry?.ipa,
        partOfSpeech: sense?.partOfSpeech,
        example: sense?.example ?? card.context,
        cefr: card.entry?.cefr,
        sourceUrl: location.href,
        sourceTitle: document.title,
        reviewStatus: 'new',
        tags: [],
      })
        .then(() => {
          uiStore.set((prev) => (prev.wordCard ? { wordCard: { ...prev.wordCard, saved: true } } : {}));
          showToast('已加入生词本');
        })
        .catch(() => showToast('保存失败'));
    },
    playWord() {
      const card = uiStore.get().wordCard;
      if (!card) return;
      if (card.entry?.audioUrl) {
        void new Audio(card.entry.audioUrl).play().catch(() => speak(card.word));
      } else {
        speak(card.word);
      }
    },
    wordAI(kind) {
      const card = uiStore.get().wordCard;
      if (!card) return;
      const messages =
        kind === 'explain'
          ? explainWordPrompt(card.word, card.context)
          : generateExamplesPrompt(card.word);
      uiStore.set({ wordCard: { ...card, aiLoading: true, aiText: undefined } });
      sendRequest('ai.complete', { messages, cacheKey: `word-${kind}|${card.word}` })
        .then(({ text }) =>
          uiStore.set((prev) =>
            prev.wordCard ? { wordCard: { ...prev.wordCard, aiLoading: false, aiText: text } } : {},
          ),
        )
        .catch((err: Error) =>
          uiStore.set((prev) =>
            prev.wordCard
              ? { wordCard: { ...prev.wordCard, aiLoading: false, aiText: `AI 调用失败：${err.message}` } }
              : {},
          ),
        );
    },
    closeSentenceCard: () => uiStore.set({ sentenceCard: null }),
    sentenceAI(kind) {
      const card = uiStore.get().sentenceCard;
      if (!card) return;
      const [messages, label] = {
        grammar: [explainGrammarPrompt(card.text), '语法'] as const,
        difficult: [explainDifficultWordsPrompt(card.text), '难词'] as const,
        easier: [rewritePrompt(card.text, 'easier'), '简化'] as const,
        advanced: [rewritePrompt(card.text, 'advanced'), '进阶'] as const,
      }[kind];
      uiStore.set({ sentenceCard: { ...card, aiLoading: true, aiLabel: label, aiText: undefined } });
      sendRequest('ai.complete', { messages, cacheKey: `sent-${kind}|${card.text.slice(0, 200)}` })
        .then(({ text }) =>
          uiStore.set((prev) =>
            prev.sentenceCard
              ? { sentenceCard: { ...prev.sentenceCard, aiLoading: false, aiText: text } }
              : {},
          ),
        )
        .catch((err: Error) =>
          uiStore.set((prev) =>
            prev.sentenceCard
              ? {
                  sentenceCard: {
                    ...prev.sentenceCard,
                    aiLoading: false,
                    aiText: `AI 调用失败：${err.message}`,
                  },
                }
              : {},
          ),
        );
    },
    saveSentence() {
      const card = uiStore.get().sentenceCard;
      if (!card) return;
      void sendRequest('sentences.add', {
        text: card.text,
        translation: card.translation ?? '',
        grammar: card.aiLabel === '语法' ? card.aiText : undefined,
        sourceUrl: location.href,
        sourceTitle: document.title,
        tags: [],
      })
        .then(() => {
          uiStore.set((prev) =>
            prev.sentenceCard ? { sentenceCard: { ...prev.sentenceCard, saved: true } } : {},
          );
          showToast('已加入句子本');
        })
        .catch(() => showToast('保存失败'));
    },
    exportSentence() {
      const card = uiStore.get().sentenceCard;
      if (!card) return;
      const payload = `${card.text}\n${card.translation ?? ''}\n— ${document.title} (${location.href})`;
      void navigator.clipboard.writeText(payload).then(
        () => showToast('已复制'),
        () => showToast('复制失败'),
      );
    },
    toggleSubtitlePanel: () => void toggleSubtitlePanel(),
    subtitlePrev: () => subtitleController.prev(),
    subtitleRepeat: () => subtitleController.repeat(),
    subtitleNext: () => subtitleController.next(),
    subtitleAB: () => subtitleController.toggleABLoop(),
    subtitleSpeed: (rate) => subtitleController.setSpeed(rate),
    subtitleSelectTrack: (id) => subtitleController.selectTrack(id),
    subtitleBookmark() {
      const current = subtitleController.currentWithTranslation();
      if (!current) {
        showToast('当前没有字幕句');
        return;
      }
      void sendRequest('sentences.add', {
        text: current.segment.text,
        translation: current.translation,
        notes: `视频时间点 ${formatTime(current.segment.start)}`,
        sourceUrl: location.href,
        sourceTitle: document.title,
        tags: ['subtitle'],
      })
        .then(() => showToast('已收藏字幕句'))
        .catch(() => showToast('保存失败'));
    },
    subtitleToggleAutoPause() {
      const on = !(uiStore.get().subtitleState?.autoPause ?? false);
      subtitleController.setAutoPause(on);
      showToast(on ? '已开启逐句暂停：每句结束自动停，↻ 重听，⏭ 继续' : '已关闭逐句暂停');
    },
    subtitleToggleTranscript() {
      uiStore.set((prev) => ({ transcriptVisible: !prev.transcriptVisible }));
    },
    subtitleSeekTo(index) {
      subtitleController.seekToSegment(index);
    },
    subtitleExplain() {
      const current = subtitleController.currentWithTranslation();
      if (!current) {
        showToast('当前没有字幕句');
        return;
      }
      void openSentenceCard(
        current.segment.text,
        window.innerWidth / 2 - 190,
        window.innerHeight * 0.2,
      ).then(() => actions.sentenceAI('grammar'));
    },
    openSidePanel: () => void sendRequest('sidepanel.open', null).catch(() => {}),
    openSubtitleStyle: () => void sendRequest('options.open', { hash: 'subtitle' }).catch(() => {}),
    closePlayerMenu: () => uiStore.set({ playerMenu: null }),
    togglePlayerMenu: (anchor) => {
      const open = uiStore.get().playerMenu !== null;
      uiStore.set({ playerMenu: open ? null : { x: anchor.left, y: anchor.top } });
    },
    openSettings: () => void sendRequest('options.open', {}).catch(() => {}),
    quickTranslate: () => {
      uiStore.set({ quickTranslateOpen: !uiStore.get().quickTranslateOpen, playerMenu: null });
    },
    closeQuickTranslate: () => uiStore.set({ quickTranslateOpen: false }),
    translateText: async (text, from, to) => {
      const res = await sendRequest('translation.translate', { texts: [text], from, to });
      return res.translations[0] ?? '';
    },
    // 双语翻译: original on top, translation below (fast machine translation).
    immersiveTranslate: () => translatePageAs('bilingual'),
    // 翻译成中文（替换原文），like Chrome's built-in page translate.
    translateReplace: () => translatePageAs('translation-only'),
    // AI 精译: LLM with context + glossary + title optimization (premium, slower).
    aiQualityTranslate: () => translatePageAs('bilingual', 'ai'),
    saveFabPos: (pos) => {
      uiStore.set({ fabPos: pos });
      void sendRequest('settings.set', { patch: { fabPos: pos } }).catch(() => {});
    },
  };

  function translationLabel(s: UserSettings): string {
    const names: Record<string, string> = {
      google: 'Google 翻译',
      deepl: 'DeepL',
      openai: 'OpenAI',
      azure: 'Azure',
    };
    if (s.translationProvider.startsWith('custom:')) {
      const id = s.translationProvider.slice('custom:'.length);
      const ep = s.customEndpoints.find((e) => e.id === id);
      return ep?.name?.trim() || ep?.model?.trim() || '自定义端点';
    }
    if (s.translationProvider === 'custom') {
      return s.providers.custom?.model?.trim() || '自定义端点';
    }
    return names[s.translationProvider] ?? s.translationProvider;
  }

  createRoot(mount).render(createElement(App, { actions }));
  uiStore.set({
    aiAvailable: settings.ai.kind !== 'none',
    subtitleStyle: settings.subtitleStyle,
    translationLabel: translationLabel(settings),
    fabPos: settings.fabPos,
  });

  /* ---------- selection & word events ---------- */

  // A double-click also fires mouseup; this suppresses the toolbar that mouseup
  // would otherwise raise, so a double-clicked word opens only the dictionary card.
  let suppressToolbarUntil = 0;

  document.addEventListener('mouseup', (e) => {
    if (isOwnEvent(e) || !settings.selectionEnabled) return;
    // Defer so the selection is final (click clears, dblclick sets).
    setTimeout(() => {
      if (Date.now() < suppressToolbarUntil) return; // part of a double-click
      const info = currentSelectionInfo();
      // The toolbar is for a hand-selected phrase/sentence. A single word is
      // handled by double-click → dictionary card, so it never raises the
      // toolbar (avoids the stacked-UI clutter).
      const isPhrase = !!info && /\s/.test(info.text.trim());
      if (info && isPhrase && info.text.length <= 1200 && /[a-zA-Z]/.test(info.text)) {
        uiStore.set({ toolbar: { x: info.x, y: info.y, text: info.text, anchor: info.anchor } });
      } else {
        uiStore.set({ toolbar: null });
      }
    }, 10);
  });

  document.addEventListener('mousedown', (e) => {
    if (isOwnEvent(e)) return;
    uiStore.set({ toolbar: null });
  });

  document.addEventListener('dblclick', (e) => {
    if (isOwnEvent(e)) return;
    const selection = window.getSelection();
    const word = selection?.toString().trim() ?? '';
    if (!/^[A-Za-z][A-Za-z'-]{1,40}$/.test(word)) return;
    // Suppress the toolbar this double-click's mouseup would otherwise show, and
    // clear any toolbar already up, so only the dictionary card remains.
    suppressToolbarUntil = Date.now() + 400;
    uiStore.set({ toolbar: null });
    const context = selection?.anchorNode
      ? sentenceAround(selection.anchorNode, word)
      : undefined;
    // Anchor the card to the selected word's rect so it can flip above/below.
    let x = e.clientX;
    let y = e.clientY;
    let anchor: AnchorRect | undefined;
    if (selection && selection.rangeCount > 0) {
      const r = selection.getRangeAt(0).getBoundingClientRect();
      if (r.width || r.height) {
        x = r.left;
        y = r.bottom + 6;
        anchor = { top: r.top, bottom: r.bottom, left: r.left };
      }
    }
    void openWordCard(word, context, x, y, anchor);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      uiStore.set({ wordCard: null, sentenceCard: null, toolbar: null });
    }
  });

  /* ---------- messages from the extension ---------- */

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const envelope = message as TabEnvelope;
    if (!envelope || envelope.kind !== 'lf-tab-request') return undefined;
    const respond = (data: unknown) => sendResponse({ ok: true, data } satisfies Response<unknown>);

    switch (envelope.type) {
      case 'content.toggleTranslation':
        togglePage();
        respond({ active: translator.active });
        return undefined;
      case 'content.setDisplayMode':
        translator.setMode((envelope.payload as { mode: DisplayMode }).mode);
        if (!translator.active) togglePage();
        respond(null);
        return undefined;
      case 'content.translateSelection': {
        const info = currentSelectionInfo();
        if (info) void openSentenceCard(info.text, info.x, info.y, info.anchor);
        else showToast('请先选中要翻译的文本');
        respond(null);
        return undefined;
      }
      case 'content.getPageContext':
        respond({
          url: location.href,
          title: document.title,
          text: extractPageText(),
          selection: window.getSelection()?.toString() || undefined,
        });
        return undefined;
      case 'content.openQuickTranslate':
        actions.quickTranslate();
        respond(null);
        return undefined;
      case 'content.toggleSubtitle':
        void toggleSubtitlePanel();
        respond(null);
        return undefined;
    }
  });

  /* ---------- settings live-reload ---------- */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lf-settings']) return;
    void sendRequest('settings.get', null).then((next) => {
      settings = next;
      uiStore.set({
        aiAvailable: next.ai.kind !== 'none',
        subtitleStyle: next.subtitleStyle,
        translationLabel: translationLabel(next),
      });
      translator.setMode(next.displayMode);
    });
  });

  /* ---------- reading statistics (local only) ---------- */

  const TICK_MS = 30_000;
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    const videoPlaying = [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
    void sendRequest('stats.record', {
      kind: videoPlaying ? 'video-time' : 'reading-time',
      ms: TICK_MS,
      url: location.href,
      title: document.title,
    }).catch(() => {});
  }, TICK_MS);

  let articleRecorded = false;
  const startedAt = Date.now();
  document.addEventListener(
    'scroll',
    () => {
      if (articleRecorded || Date.now() - startedAt < 30_000) return;
      const scrolled = window.scrollY + window.innerHeight;
      if (scrolled >= document.documentElement.scrollHeight * 0.9) {
        articleRecorded = true;
        void sendRequest('stats.record', {
          kind: 'article-finished',
          url: location.href,
          title: document.title,
        }).catch(() => {});
      }
    },
    { passive: true },
  );

  /* ---------- auto-translate rules ---------- */

  if (shouldAutoTranslate(location.hostname, settings)) {
    togglePage();
  }
}

/**
 * Runs in a child frame that hosts an embedded player. It shows only the
 * two LinguaFlow lines, listens for commands from the parent, and reports
 * status back. No subtitle text, credentials, or provider settings cross the
 * frame boundary — the child fetches its own settings and translates locally.
 */
async function startChildSubtitleRuntime() {
  const settings: UserSettings | null = await sendRequest('settings.get', null).catch(() => null);
  if (!settings) return;

  const isYouTube = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname);
  if (isYouTube) initTimedTextCapture();

  const runtime = createSubtitleRuntime({
    translate: async (texts) =>
      (
        await sendRequest('translation.translate', {
          texts,
          from: settings.sourceLanguage,
          to: settings.targetLanguage,
        })
      ).translations,
    onState: (status, mode) => {
      window.parent?.postMessage(
        mode
          ? { source: 'linguaflow', type: 'subtitle-frame-state', status, mode }
          : { source: 'linguaflow', type: 'subtitle-frame-state', status },
        '*',
      );
    },
  });

  // Announce readiness to the parent once this frame actually hosts a player.
  let announced = false;
  const announce = () => {
    if (announced) return;
    const videos = [...document.querySelectorAll('video')].map((v) => {
      const r = v.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    if (shouldStartSubtitleFrame(window.top === window, videos)) {
      announced = true;
      window.parent?.postMessage({ source: 'linguaflow', type: 'subtitle-frame-ready' }, '*');
    }
  };
  announce();
  const poll = setInterval(announce, 1500);
  setTimeout(() => clearInterval(poll), 30_000);

  const relayDown = (msg: unknown) => {
    for (const frame of document.querySelectorAll('iframe')) {
      frame.contentWindow?.postMessage(msg, '*');
    }
  };

  window.addEventListener('message', (event) => {
    if (!isFrameMessage(event.data)) return;
    const msg = event.data;
    // Commands flow down from the parent; relay to nested frames, and act only
    // in the frame that actually hosts the player.
    if (msg.type === 'subtitle-command' && event.source === window.parent) {
      relayDown(msg);
      if (!runtime.detect()) return;
      if (msg.command === 'open') void runtime.open();
      else if (msg.command === 'close') runtime.close();
      else void runtime.toggle();
      return;
    }
    // A descendant announced readiness; relay it up toward the top frame.
    if (msg.type === 'subtitle-frame-ready' && event.source !== window.parent) {
      window.parent?.postMessage(msg, '*');
    }
  });

  window.addEventListener('pagehide', () => runtime.destroy());
}

// macOS ships many "novelty" voices (Jester, Bells, Zarvox, Bad News, …) and one
// of them can be the system default. SpeechSynthesis with no explicit voice then
// reads words in that silly voice. Prefer a natural English voice and never fall
// through to the system default.
const NOVELTY_VOICE =
  /albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|flo|grandma|grandpa|reed|rocko|sandy|shelley|eddy|junior|kathy|ralph|fred/i;

function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const en = voices.filter((v) => /^en(-|$)/i.test(v.lang));
  if (en.length === 0) return undefined;
  const named = (re: RegExp) => en.find((v) => re.test(v.name));
  return (
    named(/Google US English/i) ||
    named(/Google UK English/i) ||
    named(/^Samantha/i) ||
    named(/^Alex$/i) ||
    named(/^Daniel/i) ||
    en.find((v) => v.lang === 'en-US' && v.default && !NOVELTY_VOICE.test(v.name)) ||
    en.find((v) => v.lang === 'en-US' && !NOVELTY_VOICE.test(v.name)) ||
    en.find((v) => !NOVELTY_VOICE.test(v.name)) ||
    en[0]
  );
}

function speak(text: string, retried = false) {
  const voices = speechSynthesis.getVoices();
  // Voices can load asynchronously — wait once for them before speaking.
  if (voices.length === 0 && !retried) {
    speechSynthesis.addEventListener('voiceschanged', () => speak(text, true), { once: true });
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  const voice = pickEnglishVoice(voices);
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  speechSynthesis.cancel(); // drop any queued utterance (e.g. a novelty one)
  speechSynthesis.speak(utterance);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
