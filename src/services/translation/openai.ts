import type { ProviderSettings } from '@/shared/settings';
import { openAICompatibleTranslate } from './openaiCompatible';
import { TranslationError, type TranslateParams, type TranslationProvider } from './provider';

export class OpenAIProvider implements TranslationProvider {
  readonly id = 'openai' as const;
  readonly displayName = 'OpenAI';
  readonly requiresKey = true;

  translate(params: TranslateParams, config: ProviderSettings): Promise<string[]> {
    if (!config.apiKey) throw new TranslationError('auth', 'openai: API key not configured');
    return openAICompatibleTranslate('openai', params, config, {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
    });
  }
}

/** Any OpenAI-compatible endpoint (e.g. a local Ollama or a proxy). */
export class CustomProvider implements TranslationProvider {
  readonly id = 'custom' as const;
  readonly displayName = 'Custom endpoint';
  readonly requiresKey = false;

  translate(params: TranslateParams, config: ProviderSettings): Promise<string[]> {
    if (!config.baseUrl) {
      throw new TranslationError('not_configured', 'custom: base URL not configured');
    }
    return openAICompatibleTranslate('custom', params, config, {
      baseUrl: config.baseUrl,
      model: config.model || 'gpt-4o-mini',
    });
  }
}
