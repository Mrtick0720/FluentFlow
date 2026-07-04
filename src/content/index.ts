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
import type { UserSettings } from '@/shared/settings';
import type { DisplayMode } from '@/types/models';
import { extractPageText, sentenceAround } from '@/utils/dom';
import { PageTranslator } from './pageTranslator';
import { injectYouTubePlayerButton } from './youtubeButton';
import { App, type UIActions } from './ui/App';
import { showToast, uiStore } from './ui/store';

if (window.top === window && document.contentType === 'text/html') {
  void main();
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

  let errorToastShown = false;
  const translator = new PageTranslator({
    translate,
    targetLanguage: settings.targetLanguage,
    mode: settings.displayMode,
    style: settings.translationStyle,
    fontScale: settings.fontScale,
    onProgress: (done, total) => uiStore.set({ progress: { done, total } }),
    onError: (message) => {
      if (errorToastShown) return;
      errorToastShown = true;
      showToast(`翻译失败：${message}`);
      setTimeout(() => {
        errorToastShown = false;
      }, 5000);
    },
  });

  function togglePage() {
    if (translator.active) {
      translator.stop();
      uiStore.set({ pageActive: false, progress: { done: 0, total: 0 } });
    } else {
      translator.start();
      uiStore.set({ pageActive: true });
    }
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
  });

  let autoSubtitleDone = false;
  function detectVideo(attempt = 0) {
    if (isVideoPage() && findMainVideo()) {
      uiStore.set({ videoDetected: true });
      startVideoLayoutSync(); // pin the floating buttons to the video
      // Auto-open the bilingual subtitle panel: globally, or on this site.
      const autoSubtitle =
        settings.autoSubtitleVideoSites || settings.autoSubtitleSites.includes(location.hostname);
      if (autoSubtitle && !autoSubtitleDone && !uiStore.get().subtitleVisible) {
        autoSubtitleDone = true;
        void toggleSubtitlePanel();
      }
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
        if (isVideoPage()) {
          detectVideo();
        } else {
          if (uiStore.get().subtitleVisible) void toggleSubtitlePanel();
          autoSubtitleDone = false;
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
      const ui = uiStore.get();
      if (ui.subtitleVisible && ui.subtitleState?.mode === 'live') {
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
          autoSubtitleDone = false;
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

  async function toggleSubtitlePanel() {
    if (uiStore.get().subtitleVisible) {
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

  /* ---------- word & sentence cards ---------- */

  async function openWordCard(word: string, context: string | undefined, x: number, y: number) {
    uiStore.set({
      wordCard: { x, y, word, context, loading: true, saved: false },
      toolbar: null,
    });
    try {
      const entry = await sendRequest('dictionary.lookup', { word, context });
      uiStore.set((prev) =>
        prev.wordCard?.word === word
          ? { wordCard: { ...prev.wordCard, entry, loading: false } }
          : {},
      );
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

  async function openSentenceCard(text: string, x: number, y: number) {
    uiStore.set({
      sentenceCard: { x, y, text, loading: true, saved: false },
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

  function currentSelectionInfo(): { text: string; x: number; y: number } | null {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, ' ').trim() ?? '';
    if (!text || !selection || selection.rangeCount === 0) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { text, x: rect.left, y: rect.bottom };
  }

  /* ---------- UI actions ---------- */

  const actions: UIActions = {
    togglePage,
    toolbarTranslate() {
      const t = uiStore.get().toolbar;
      if (t) void openSentenceCard(t.text, t.x, t.y);
    },
    toolbarLookup() {
      const t = uiStore.get().toolbar;
      if (t) void openWordCard(t.text.trim(), undefined, t.x, t.y);
    },
    toolbarExplain() {
      const t = uiStore.get().toolbar;
      if (!t) return;
      void openSentenceCard(t.text, t.x, t.y).then(() => actions.sentenceAI('grammar'));
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
  };

  createRoot(mount).render(createElement(App, { actions }));
  uiStore.set({ aiAvailable: settings.ai.kind !== 'none', subtitleStyle: settings.subtitleStyle });

  /* ---------- selection & word events ---------- */

  document.addEventListener('mouseup', (e) => {
    if (isOwnEvent(e) || !settings.selectionEnabled) return;
    // Defer so the selection is final (click clears, dblclick sets).
    setTimeout(() => {
      const info = currentSelectionInfo();
      if (info && info.text.length <= 1200 && /[a-zA-Z]/.test(info.text)) {
        uiStore.set({ toolbar: { x: info.x, y: info.y, text: info.text } });
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
    const context = selection?.anchorNode
      ? sentenceAround(selection.anchorNode, word)
      : undefined;
    void openWordCard(word, context, e.clientX, e.clientY);
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
        if (info) void openSentenceCard(info.text, info.x, info.y);
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
    }
  });

  /* ---------- settings live-reload ---------- */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['lf-settings']) return;
    void sendRequest('settings.get', null).then((next) => {
      settings = next;
      uiStore.set({ aiAvailable: next.ai.kind !== 'none', subtitleStyle: next.subtitleStyle });
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

  const host_ = location.hostname;
  if (
    settings.autoTranslateSites.includes(host_) &&
    !settings.neverTranslateSites.includes(host_)
  ) {
    togglePage();
  }
}

function speak(text: string) {
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  speechSynthesis.speak(utterance);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
