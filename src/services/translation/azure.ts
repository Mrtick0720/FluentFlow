import type { ProviderSettings } from '@/shared/settings';
import {
  expectOk,
  networkError,
  TranslationError,
  type TranslateParams,
  type TranslationProvider,
} from './provider';

const ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate';

export class AzureProvider implements TranslationProvider {
  readonly id = 'azure' as const;
  readonly displayName = 'Azure Translator';
  readonly requiresKey = true;

  async translate({ texts, from, to }: TranslateParams, config: ProviderSettings): Promise<string[]> {
    if (!config.apiKey) throw new TranslationError('auth', 'azure: API key not configured');
    const url = new URL(ENDPOINT);
    url.searchParams.set('api-version', '3.0');
    url.searchParams.set('to', toAzureLang(to));
    if (from !== 'auto') url.searchParams.set('from', toAzureLang(from));

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Ocp-Apim-Subscription-Key': config.apiKey,
          ...(config.region ? { 'Ocp-Apim-Subscription-Region': config.region } : {}),
        },
        body: JSON.stringify(texts.map((Text) => ({ Text }))),
      });
    } catch (e) {
      throw networkError('azure', e);
    }
    await expectOk(res, 'azure');
    const data = (await res.json()) as Array<{ translations?: Array<{ text: string }> }>;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new TranslationError('provider_error', 'azure: unexpected response shape');
    }
    return data.map((item) => item.translations?.[0]?.text ?? '');
  }
}

export function toAzureLang(code: string): string {
  const lower = code.toLowerCase();
  if (lower === 'zh-cn' || lower === 'zh') return 'zh-Hans';
  if (lower === 'zh-tw' || lower === 'zh-hk') return 'zh-Hant';
  return code;
}
