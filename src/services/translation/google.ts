import { mapWithConcurrency } from '@/utils/async';
import {
  expectOk,
  networkError,
  TranslationError,
  type TranslateParams,
  type TranslationProvider,
} from './provider';

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * Google's public web-translation endpoint. No API key; suitable as the
 * out-of-the-box default. One request per text, limited concurrency.
 */
export class GoogleProvider implements TranslationProvider {
  readonly id = 'google' as const;
  readonly displayName = 'Google Translate';
  readonly requiresKey = false;

  async translate({ texts, from, to }: TranslateParams): Promise<string[]> {
    return mapWithConcurrency(texts, 4, async (text) => {
      const url = new URL(ENDPOINT);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', from === 'auto' ? 'auto' : from);
      url.searchParams.set('tl', to);
      url.searchParams.set('dt', 't');
      url.searchParams.set('q', text);

      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw networkError('google', e);
      }
      await expectOk(res, 'google');
      const data = (await res.json()) as unknown;
      return parseGoogleResponse(data);
    });
  }
}

export function parseGoogleResponse(data: unknown): string {
  // Shape: [[[translated, original, ...], ...], ...]
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new TranslationError('provider_error', 'google: unexpected response shape');
  }
  return (data[0] as unknown[])
    .map((chunk) => (Array.isArray(chunk) && typeof chunk[0] === 'string' ? chunk[0] : ''))
    .join('');
}
