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
  getSettingsRedacted,
  updateSettings,
} from '@/services/storage/settingsStore';
import { createDefaultRegistry } from '@/services/translation/registry';
import { TranslationService } from '@/services/translation/service';
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

const router = new MessageRouter()
  .on('translation.translate', (req) => translationService.translate(req))
  .on('dictionary.lookup', ({ word, context }) => dictionaryService.lookup(word, context))
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
  chrome.contextMenus.create({
    id: MENU.translateSelection,
    title: 'LinguaFlow: 翻译选中文本',
    contexts: ['selection'],
  });
  chrome.contextMenus.create({
    id: MENU.togglePage,
    title: 'LinguaFlow: 翻译/还原整页',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: MENU.openPanel,
    title: 'LinguaFlow: 打开学习面板',
    contexts: ['page', 'selection'],
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
