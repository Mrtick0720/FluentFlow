import { cacheGet, cacheSet } from '@/services/cache/ttlCache';
import { dictionaryEnrichmentPrompt } from '@/services/ai/prompts';
import type { AIService } from '@/services/ai/service';
import { getSettings } from '@/services/storage/settingsStore';
import { TranslationError } from '@/services/translation/provider';
import type { TranslationService } from '@/services/translation/service';
import type { ProviderSelection } from '@/shared/settings';
import type { DictionaryEntry, Vocabulary } from '@/types/models';

const API = 'https://api.dictionaryapi.dev/api/v2/entries/en/';

/**
 * Free dictionary lookup with translated glosses; AI enrichment (CEFR,
 * collocations) only when the user configured an AI provider.
 */
export class DictionaryService {
  constructor(
    private translation: TranslationService,
    private ai: AIService,
  ) {}

  async lookup(word: string, _context?: string): Promise<DictionaryEntry> {
    const normalized = word.trim().toLowerCase();
    if (!normalized) throw new TranslationError('provider_error', 'dictionary: empty word');

    const settings = await getSettings();
    const cacheKey = `${normalized}|${settings.targetLanguage}`;
    if (settings.cache.enabled) {
      const hit = await cacheGet<DictionaryEntry>('dictionary', cacheKey);
      if (hit) return hit;
    }

    // Base entry only: dictionary fetch + fast-MT glosses. AI enrichment (CEFR,
    // collocations) is a separate call (enrich) the popup fires after it's
    // already visible, so the card never blocks on the LLM. Glosses use the
    // fast page-translation engine, not the (possibly slow) sentence LLM.
    const entry = await this.fetchBase(normalized);
    await this.translateGlosses(entry, settings.targetLanguage, settings.pageTranslationProvider);

    if (settings.cache.enabled) {
      await cacheSet('dictionary', cacheKey, entry, settings.cache.ttlHours * 3600_000);
    }
    return entry;
  }

  /**
   * AI enrichment for a word (CEFR level + collocations). Called separately by
   * the popup after the base entry renders, so it never blocks the card.
   * Best-effort: returns an empty object when no AI provider is configured or
   * on any failure. The AI call itself is cached (see AIService).
   */
  async enrich(word: string): Promise<{ cefr?: Vocabulary['cefr']; collocations?: string[] }> {
    const normalized = word.trim().toLowerCase();
    if (!normalized || !(await this.ai.isConfigured())) return {};
    try {
      const raw = await this.ai.complete(
        dictionaryEnrichmentPrompt(normalized),
        `dict-enrich|${normalized}`,
      );
      const parsed = JSON.parse(raw.replace(/```(?:json)?|```/g, '').trim()) as {
        cefr?: Vocabulary['cefr'];
        collocations?: string[];
      };
      const out: { cefr?: Vocabulary['cefr']; collocations?: string[] } = {};
      if (parsed.cefr && ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(parsed.cefr)) {
        out.cefr = parsed.cefr;
      }
      if (Array.isArray(parsed.collocations)) {
        out.collocations = parsed.collocations.filter((c) => typeof c === 'string').slice(0, 6);
      }
      return out;
    } catch {
      return {};
    }
  }

  private async fetchBase(word: string): Promise<DictionaryEntry> {
    let res: Response;
    try {
      res = await fetch(API + encodeURIComponent(word));
    } catch {
      throw new TranslationError('network', 'dictionary: network request failed');
    }
    if (res.status === 404) {
      // Unknown to the dictionary — return a bare entry; translation gloss still helps.
      return { word, senses: [] };
    }
    if (!res.ok) throw new TranslationError('provider_error', `dictionary: HTTP ${res.status}`);
    return parseDictionaryApiResponse(word, await res.json());
  }

  private async translateGlosses(
    entry: DictionaryEntry,
    targetLang: string,
    provider?: ProviderSelection,
  ): Promise<void> {
    const texts = [entry.word, ...entry.senses.map((s) => s.meaning)];
    try {
      const { translations } = await this.translation.translate({
        texts,
        from: 'en',
        to: targetLang,
        provider,
      });
      // First item: gloss for the word itself when there are no senses.
      if (entry.senses.length === 0 && translations[0]) {
        entry.senses.push({
          partOfSpeech: '',
          meaning: entry.word,
          meaningTranslation: translations[0],
          synonyms: [],
        });
      }
      entry.senses.forEach((s, i) => {
        if (s.meaningTranslation === undefined) s.meaningTranslation = translations[i + 1];
      });
    } catch {
      // Glosses are enhancement; the base entry is still useful.
    }
  }

}

export function parseDictionaryApiResponse(word: string, data: unknown): DictionaryEntry {
  if (!Array.isArray(data) || data.length === 0) return { word, senses: [] };
  const first = data[0] as {
    phonetics?: Array<{ text?: string; audio?: string }>;
    meanings?: Array<{
      partOfSpeech?: string;
      definitions?: Array<{ definition?: string; example?: string; synonyms?: string[] }>;
      synonyms?: string[];
    }>;
  };

  const withAudio = first.phonetics?.find((p) => p.audio);
  const withText = first.phonetics?.find((p) => p.text);

  const senses: DictionaryEntry['senses'] = [];
  for (const meaning of first.meanings ?? []) {
    for (const def of (meaning.definitions ?? []).slice(0, 2)) {
      if (!def.definition) continue;
      senses.push({
        partOfSpeech: meaning.partOfSpeech ?? '',
        meaning: def.definition,
        example: def.example,
        synonyms: [...new Set([...(def.synonyms ?? []), ...(meaning.synonyms ?? [])])].slice(0, 5),
      });
    }
  }

  return {
    word,
    ipa: withText?.text,
    audioUrl: withAudio?.audio,
    senses: senses.slice(0, 6),
  };
}
