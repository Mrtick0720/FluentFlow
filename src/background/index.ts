import { AIService } from '@/services/ai/service';
import { cacheClear, cacheSweep } from '@/services/cache/ttlCache';
import { DictionaryService } from '@/services/dictionary/service';
import {
  ConversationRepository,
  nextReviewStatus,
  ReviewHistoryRepository,
  SentenceRepository,
  StatsRepository,
  VocabularyRepository,
} from '@/services/storage/repositories';
import {
  getSettings,
  getSettingsRedacted,
  updateSettings,
} from '@/services/storage/settingsStore';
import { fetchModelIds } from '@/services/ai/models';
import { createDefaultRegistry } from '@/services/translation/registry';
import { TranslationService, resolveProvider } from '@/services/translation/service';
import { smartGroupTranslate } from '@/services/subtitle/smart';
import {
  AI_STREAM_PORT,
  sendToTab,
  type AIStreamEvent,
  type AIStreamRequest,
} from '@/shared/messages';
import { MessageRouter, toAppError } from './router';

const translationService = new TranslationService(createDefaultRegistry());
const aiService = new AIService();
const dictionaryService = new DictionaryService(translationService, aiService);
const vocabulary = new VocabularyRepository();
const sentences = new SentenceRepository();
const conversations = new ConversationRepository();
const reviews = new ReviewHistoryRepository();
const stats = new StatsRepository();

const DEFAULT_ICON = {
  16: 'icons/icon16.png',
  32: 'icons/icon32.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
} as const;

let baseIconBitmap: ImageBitmap | null = null;

/**
 * Overlay a small green rounded square with a white check on the toolbar icon
 * while a tab is being translated; restore the default icon otherwise.
 */
async function setTranslatingIcon(tabId: number, active: boolean): Promise<void> {
  try {
    if (!active) {
      await chrome.action.setIcon({ tabId, path: DEFAULT_ICON });
      return;
    }
    const size = 48;
    baseIconBitmap ??= await createImageBitmap(
      await (await fetch(chrome.runtime.getURL('icons/icon128.png'))).blob(),
    );
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(baseIconBitmap, 0, 0, size, size);

    // Small badge in the bottom-right corner.
    const b = 22;
    const x = size - b - 1;
    const y = size - b - 1;
    const roundRect = (rx: number, ry: number, rw: number, rh: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(rx + r, ry);
      ctx.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
      ctx.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      ctx.arcTo(rx, ry + rh, rx, ry, r);
      ctx.arcTo(rx, ry, rx + rw, ry, r);
      ctx.closePath();
    };
    // White ring for separation, then the green square.
    roundRect(x - 1.5, y - 1.5, b + 3, b + 3, 7);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    roundRect(x, y, b, b, 6);
    ctx.fillStyle = '#22c55e';
    ctx.fill();
    // White check.
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x + b * 0.27, y + b * 0.52);
    ctx.lineTo(x + b * 0.44, y + b * 0.68);
    ctx.lineTo(x + b * 0.74, y + b * 0.33);
    ctx.stroke();

    const imageData = ctx.getImageData(0, 0, size, size);
    await chrome.action.setIcon({ tabId, imageData });
  } catch {
    // tab closed / offscreen canvas unavailable
  }
}

const router = new MessageRouter()
  .on('translation.translate', (req) => translationService.translate(req))
  .on('translation.translateQuality', (req) => translationService.translateQuality(req))
  .on('dictionary.lookup', ({ word, context }) => dictionaryService.lookup(word, context))
  .on('dictionary.enrich', ({ word }) => dictionaryService.enrich(word))
  .on('vocabulary.add', (req) => vocabulary.add(req))
  .on('vocabulary.list', (req) => vocabulary.list(req))
  .on('vocabulary.update', (req) => vocabulary.update(req))
  .on('vocabulary.remove', async ({ id }) => {
    await vocabulary.remove(id);
    return null;
  })
  .on('vocabulary.import', async ({ items }) => ({ imported: await vocabulary.importMany(items) }))
  .on('vocabulary.review', async ({ id, outcome }) => {
    const item = await vocabulary.get(id);
    if (!item) throw new Error('word not found');
    const updated = { ...item, reviewStatus: nextReviewStatus(item.reviewStatus, outcome) };
    await vocabulary.update(updated);
    await reviews.record({ vocabularyId: id, reviewedAt: Date.now(), outcome });
    return updated;
  })
  .on('sentences.add', (req) => sentences.add(req))
  .on('sentences.list', (req) => sentences.list(req))
  .on('sentences.update', (req) => sentences.update(req))
  .on('sentences.remove', async ({ id }) => {
    await sentences.remove(id);
    return null;
  })
  .on('settings.get', () => getSettingsRedacted())
  .on('settings.set', async ({ patch }) => {
    await updateSettings(patch);
    return getSettingsRedacted();
  })
  .on('stats.record', async (req) => {
    if (req.kind === 'reading-time' || req.kind === 'video-time') {
      await stats.recordTime(req.ms, req.url, req.kind === 'video-time' ? 'video' : 'reading', req.title);
    } else {
      await stats.increment(req.kind);
    }
    return null;
  })
  .on('stats.get', () => stats.snapshot())
  .on('ai.complete', async ({ messages, cacheKey }) => ({
    text: await aiService.complete(messages, cacheKey),
  }))
  .on('conversations.list', () => conversations.list())
  .on('conversations.save', (req) => conversations.save(req))
  .on('conversations.remove', async ({ id }) => {
    await conversations.remove(id);
    return null;
  })
  .on('models.list', async ({ target, endpointId }) => {
    const settings = await getSettings(); // real keys, service-worker only
    const endpoint = endpointId
      ? settings.customEndpoints.find((e) => e.id === endpointId)
      : undefined;
    const { baseUrl, apiKey } =
      target === 'ai'
        ? { baseUrl: settings.ai.baseUrl, apiKey: settings.ai.apiKey }
        : { baseUrl: endpoint?.baseUrl, apiKey: endpoint?.apiKey };
    if (!baseUrl) throw new Error('未设置 Base URL');
    return { models: await fetchModelIds(baseUrl, apiKey) };
  })
  .on('subtitle.smartTranslate', async ({ texts, to }) => {
    const settings = await getSettings();
    const { implId, config } = resolveProvider(settings.translationProvider, settings);
    // Only OpenAI-compatible chat providers can group + translate. `null` means
    // "not capable" (the caller stops); transient errors throw so it can retry.
    if (implId !== 'custom' && implId !== 'openai') return { sentences: null };
    const defaults =
      implId === 'openai'
        ? { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
        : { baseUrl: '', model: '' };
    if (!config.baseUrl && !defaults.baseUrl) return { sentences: null };
    return { sentences: await smartGroupTranslate(config, texts, to, defaults) };
  })
  .on('cache.clear', async ({ scope }) => {
    await cacheClear(scope === 'all' ? 'all' : scope);
    return null;
  })
  .on('permissions.requestOrigin', async ({ origin }) => ({
    granted: await chrome.permissions.request({ origins: [origin] }),
  }))
  .on('sidepanel.open', async (_req, sender) => {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) await chrome.sidePanel.open({ windowId });
    return null;
  })
  .on('options.open', async ({ hash }) => {
    const url = chrome.runtime.getURL(`options.html${hash ? `#${hash}` : ''}`);
    await chrome.tabs.create({ url });
    return null;
  })
  .on('action.setBadge', async ({ active }, sender) => {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) await setTranslatingIcon(tabId, active);
    return null;
  });

router.listen();

/** Streaming AI over a long-lived port. */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== AI_STREAM_PORT) return;
  port.onMessage.addListener(async (msg: AIStreamRequest) => {
    const post = (event: AIStreamEvent) => {
      try {
        port.postMessage(event);
      } catch {
        // port closed mid-stream; nothing to do
      }
    };
    try {
      await aiService.stream(msg.messages, (text) => post({ type: 'chunk', text }));
      post({ type: 'done' });
    } catch (err) {
      post({ type: 'error', error: toAppError(err) });
    }
  });
});

/** Context menus. */
const MENU = {
  translateSelection: 'lf-translate-selection',
  togglePage: 'lf-toggle-page',
  openPanel: 'lf-open-panel',
} as const;

chrome.runtime.onInstalled.addListener(() => {
  // removeAll first: onInstalled also fires on update/reload, and recreating an
  // existing menu id throws "Cannot create item with duplicate id" (surfaces as
  // the extension card's red "错误" badge).
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.translateSelection,
      title: 'FluentFlow: 翻译选中文本',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.togglePage,
      title: 'FluentFlow: 翻译/还原整页',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU.openPanel,
      title: 'FluentFlow: 打开学习面板',
      contexts: ['page', 'selection'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;
  if (info.menuItemId === MENU.translateSelection) {
    void sendToTab(tab.id, 'content.translateSelection', null).catch(() => {});
  } else if (info.menuItemId === MENU.togglePage) {
    void sendToTab(tab.id, 'content.toggleTranslation', null).catch(() => {});
  } else if (info.menuItemId === MENU.openPanel && tab.windowId !== undefined) {
    void chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

/** Keyboard commands (defined in the manifest). */
chrome.commands.onCommand.addListener(async (command, tab) => {
  const tabId = tab?.id;
  if (tabId === undefined) return;
  try {
    if (command === 'toggle-translation') {
      await sendToTab(tabId, 'content.toggleTranslation', null);
    } else if (command === 'open-quick-translate') {
      await sendToTab(tabId, 'content.openQuickTranslate', null);
    } else if (command === 'toggle-subtitle') {
      await sendToTab(tabId, 'content.toggleSubtitle', null);
    } else if (command === 'open-side-panel') {
      if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
    } else if (command === 'translate-selection') {
      await sendToTab(tabId, 'content.translateSelection', null);
    } else if (command === 'cycle-display-mode') {
      const settings = await getSettingsRedacted();
      const order = ['bilingual', 'translation-only', 'original'] as const;
      const next = order[(order.indexOf(settings.displayMode as (typeof order)[number]) + 1) % order.length]!;
      await updateSettings({ displayMode: next });
      await sendToTab(tabId, 'content.setDisplayMode', { mode: next });
    }
  } catch {
    // Tab without a content script (chrome://, web store) — ignore.
  }
});

/** Opportunistic cache hygiene at service-worker startup. */
void cacheSweep().catch(() => {});
