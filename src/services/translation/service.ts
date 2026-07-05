import { cacheGet, cacheSet } from '@/services/cache/ttlCache';
import { getSettings } from '@/services/storage/settingsStore';
import { MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS } from '@/shared/constants';
import type { ProviderSelection, ProviderSettings, UserSettings } from '@/shared/settings';
import type { LanguageCode, TranslationProviderId } from '@/types/models';
import { batchBy } from '@/utils/async';
import { fnv1a64 } from '@/utils/hash';
import { TranslationError } from './provider';
import { qualityTranslate, type Glossary, type QualitySegment } from './quality';
import type { ProviderRegistry } from './registry';

export interface QualityTranslateRequest {
  segments: QualitySegment[];
  from: LanguageCode;
  to: LanguageCode;
  provider?: ProviderSelection;
  domain?: string;
  glossary?: Glossary;
  refresh?: boolean;
}

export interface TranslateRequest {
  texts: string[];
  from: LanguageCode;
  to: LanguageCode;
  provider?: ProviderSelection;
  refresh?: boolean;
}

/** Resolve a selection to the registry provider id and its endpoint config. */
export function resolveProvider(
  selection: ProviderSelection,
  settings: UserSettings,
): { implId: TranslationProviderId; config: ProviderSettings } {
  if (selection.startsWith('custom:')) {
    const id = selection.slice('custom:'.length);
    const ep = settings.customEndpoints.find((e) => e.id === id);
    return {
      implId: 'custom',
      config: ep ? { baseUrl: ep.baseUrl, model: ep.model, apiKey: ep.apiKey } : {},
    };
  }
  const implId = selection as TranslationProviderId;
  return { implId, config: settings.providers[implId] ?? {} };
}

/**
 * Orchestrates providers: per-text TTL cache, request batching within provider
 * limits, order-preserving assembly.
 */
export class TranslationService {
  constructor(private registry: ProviderRegistry) {}

  async translate(req: TranslateRequest): Promise<{
    translations: string[];
    provider: TranslationProviderId;
  }> {
    const settings = await getSettings();
    const selection = req.provider ?? settings.translationProvider;
    const { implId: providerId, config } = resolveProvider(selection, settings);
    const provider = this.registry.get(providerId);
    const cacheEnabled = settings.cache.enabled;
    const ttlMs = settings.cache.ttlHours * 3600_000;

    const results = new Array<string>(req.texts.length);
    const missing: Array<{ index: number; text: string; key: string }> = [];

    for (let i = 0; i < req.texts.length; i++) {
      const text = req.texts[i]!;
      const key = fnv1a64(`${selection}|${req.from}|${req.to}|${text}`);
      if (cacheEnabled && !req.refresh) {
        const hit = await cacheGet<string>('translation', key);
        if (hit !== undefined) {
          results[i] = hit;
          continue;
        }
      }
      missing.push({ index: i, text, key });
    }

    const batches = batchBy(missing, MAX_BATCH_SEGMENTS, MAX_BATCH_CHARS, (m) => m.text.length);
    // Sub-batches of one request run concurrently — LLM latency dominates, so
    // overlapping requests translates the page far faster.
    await Promise.all(
      batches.map(async (batch) => {
        const texts = batch.map((m) => m.text);
        let translated: string[];
        try {
          translated = await provider.translate({ texts, from: req.from, to: req.to }, config);
        } catch (err) {
          // A model that can't return a clean JSON array fails the whole batch.
          // Degrade to one request per line, each recovered by the single-line
          // fallback; only rethrow if every line also fails (real config error).
          translated = await Promise.all(
            texts.map(async (t) => {
              try {
                return (await provider.translate({ texts: [t], from: req.from, to: req.to }, config))[0] ?? '';
              } catch {
                return '';
              }
            }),
          );
          if (translated.every((v) => !v)) throw err;
        }
        for (let i = 0; i < batch.length; i++) {
          const { index, key } = batch[i]!;
          const value = translated[i] ?? '';
          results[index] = value;
          if (cacheEnabled && value) await cacheSet('translation', key, value, ttlMs);
        }
      }),
    );

    return { translations: results, provider: providerId };
  }

  /**
   * High-quality "AI 精译" translation: an LLM translates each paragraph with its
   * surrounding context and a shared glossary, so terminology stays consistent
   * and titles read naturally. Batches run sequentially so the glossary grows in
   * order. Requires an OpenAI-compatible provider.
   */
  async translateQuality(
    req: QualityTranslateRequest,
  ): Promise<{ translations: string[]; glossary: Glossary; domain?: string }> {
    const settings = await getSettings();
    const selection = req.provider ?? settings.translationProvider;
    const { implId, config } = resolveProvider(selection, settings);
    if (implId !== 'openai' && implId !== 'custom') {
      throw new TranslationError(
        'provider_error',
        'AI 精译需要 OpenAI 兼容的大模型端点，请在设置中配置后重试',
      );
    }
    const cacheEnabled = settings.cache.enabled;
    const ttlMs = settings.cache.ttlHours * 3600_000;

    const results = new Array<string>(req.segments.length);
    const missing: Array<{ index: number; seg: QualitySegment; key: string }> = [];
    for (let i = 0; i < req.segments.length; i++) {
      const seg = req.segments[i]!;
      const key = fnv1a64(`q|${selection}|${req.from}|${req.to}|${seg.isTitle ? 'T' : ''}|${seg.text}`);
      if (cacheEnabled && !req.refresh) {
        const hit = await cacheGet<string>('translation', key);
        if (hit !== undefined) {
          results[i] = hit;
          continue;
        }
      }
      missing.push({ index: i, seg, key });
    }

    let glossary = req.glossary ?? {};
    let domain = req.domain;
    // Context inflates each request, so keep batches small; run them in order so
    // the glossary accumulates and later paragraphs inherit earlier choices.
    const batches = batchBy(
      missing,
      12,
      3000,
      (m) => m.seg.text.length + (m.seg.before?.length ?? 0) + (m.seg.after?.length ?? 0),
    );
    for (const batch of batches) {
      const out = await qualityTranslate(
        implId,
        { segments: batch.map((m) => m.seg), from: req.from, to: req.to, domain, glossary },
        config,
      );
      glossary = { ...glossary, ...out.glossary };
      domain = domain ?? out.domain; // lock the domain in after the first inference
      for (let i = 0; i < batch.length; i++) {
        const { index, key } = batch[i]!;
        const value = out.translations[i] ?? '';
        results[index] = value;
        if (cacheEnabled && value) await cacheSet('translation', key, value, ttlMs);
      }
    }
    return { translations: results, glossary, domain };
  }
}
