import type { LanguageCode, TranslationErrorCode, TranslationProviderId } from '@/types/models';
import type { ProviderSettings } from '@/shared/settings';

export interface TranslateParams {
  texts: string[];
  from: LanguageCode; // 'auto' allowed
  to: LanguageCode;
}

export interface TranslationProvider {
  readonly id: TranslationProviderId;
  readonly displayName: string;
  readonly requiresKey: boolean;
  /** Translate texts in order; must return one translation per input text. */
  translate(params: TranslateParams, config: ProviderSettings): Promise<string[]>;
}

export class TranslationError extends Error {
  constructor(
    public readonly code: TranslationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TranslationError';
  }
}

export function classifyStatus(status: number): TranslationErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_error';
  return 'provider_error';
}

export async function expectOk(res: Response, provider: string): Promise<Response> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TranslationError(
      classifyStatus(res.status),
      `${provider}: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    );
  }
  return res;
}

export function networkError(provider: string, cause: unknown): TranslationError {
  return new TranslationError(
    'network',
    `${provider}: network request failed (${cause instanceof Error ? cause.message : String(cause)})`,
  );
}
