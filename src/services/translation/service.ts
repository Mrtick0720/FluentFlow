import { cacheGet, cacheSet } from '@/services/cache/ttlCache';
import { getSettings } from '@/services/storage/settingsStore';
import { MAX_BATCH_CHARS, MAX_BATCH_SEGMENTS } from '@/shared/constants';
import type { LanguageCode, TranslationProviderId } from '@/types/models';
import { batchBy } from '@/utils/async';
import { fnv1a64 } from '@/utils/hash';
import type { ProviderRegistry } from './registry';

export interface TranslateRequest {
  texts: string[];
  from: LanguageCode;
  to: LanguageCode;
  provider?: TranslationProviderId;
  refresh?: boolean;
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
    const providerId = req.provider ?? settings.translationProvider;
    const provider = this.registry.get(providerId);
    const config = settings.providers[providerId] ?? {};
    const cacheEnabled = settings.cache.enabled;
    const ttlMs = settings.cache.ttlHours * 3600_000;

    const results = new Array<string>(req.texts.length);
    const missing: Array<{ index: number; text: string; key: string }> = [];

    for (let i = 0; i < req.texts.length; i++) {
      const text = req.texts[i]!;
      const key = fnv1a64(`${providerId}|${req.from}|${req.to}|${text}`);
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
    for (const batch of batches) {
      const translated = await provider.translate(
        { texts: batch.map((m) => m.text), from: req.from, to: req.to },
        config,
      );
      for (let i = 0; i < batch.length; i++) {
        const { index, key } = batch[i]!;
        const value = translated[i] ?? '';
        results[index] = value;
        if (cacheEnabled && value) await cacheSet('translation', key, value, ttlMs);
      }
    }

    return { translations: results, provider: providerId };
  }
}
