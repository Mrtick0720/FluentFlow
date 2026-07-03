import type { ProviderSettings } from '@/shared/settings';
import {
  expectOk,
  networkError,
  TranslationError,
  type TranslateParams,
  type TranslationProvider,
} from './provider';

/** DeepL API. Free-plan keys end in ':fx' and use the api-free host. */
export class DeepLProvider implements TranslationProvider {
  readonly id = 'deepl' as const;
  readonly displayName = 'DeepL';
  readonly requiresKey = true;

  async translate({ texts, from, to }: TranslateParams, config: ProviderSettings): Promise<string[]> {
    if (!config.apiKey) throw new TranslationError('auth', 'deepl: API key not configured');
    const host = config.apiKey.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
    const body: Record<string, unknown> = {
      text: texts,
      target_lang: toDeepLLang(to),
    };
    if (from !== 'auto') body.source_lang = toDeepLLang(from).split('-')[0];

    let res: Response;
    try {
      res = await fetch(`https://${host}/v2/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `DeepL-Auth-Key ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw networkError('deepl', e);
    }
    await expectOk(res, 'deepl');
    const data = (await res.json()) as { translations?: Array<{ text: string }> };
    if (!data.translations || data.translations.length !== texts.length) {
      throw new TranslationError('provider_error', 'deepl: unexpected response shape');
    }
    return data.translations.map((t) => t.text);
  }
}

export function toDeepLLang(code: string): string {
  const lower = code.toLowerCase();
  if (lower === 'zh-cn' || lower === 'zh') return 'ZH-HANS';
  if (lower === 'zh-tw' || lower === 'zh-hk') return 'ZH-HANT';
  if (lower === 'en') return 'EN-US';
  if (lower === 'pt') return 'PT-BR';
  return code.toUpperCase();
}
