import type { ProviderSettings } from '@/shared/settings';
import { normalizeOpenAIBaseUrl } from '@/utils/url';
import { expectOk, networkError, TranslationError, type TranslateParams } from './provider';

const SYSTEM_PROMPT = `You are a professional translator. Translate each string in the JSON array the user sends from {FROM} to {TO}.
Rules:
- Preserve meaning, tone, inline formatting and placeholders.
- Do not add explanations.
- Respond with ONLY a JSON object: {"translations": ["...", ...]} with exactly one item per input, same order.`;

/** Shared implementation for OpenAI and any OpenAI-compatible endpoint. */
export async function openAICompatibleTranslate(
  providerName: string,
  { texts, from, to }: TranslateParams,
  config: ProviderSettings,
  defaults: { baseUrl: string; model: string },
): Promise<string[]> {
  if (!config.apiKey && !config.baseUrl) {
    throw new TranslationError('auth', `${providerName}: API key not configured`);
  }
  const baseUrl = normalizeOpenAIBaseUrl(config.baseUrl || defaults.baseUrl);
  const model = config.model || defaults.model;
  const system = SYSTEM_PROMPT.replace(
    '{FROM}',
    from === 'auto' ? 'the detected source language' : from,
  ).replace('{TO}', to);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(texts) },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      // Don't let a hung endpoint (flaky proxy) spin forever — abort and retry.
      signal: AbortSignal.timeout(45_000),
    });
  } catch (e) {
    throw networkError(providerName, e);
  }
  await expectOk(res, providerName);
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new TranslationError('provider_error', `${providerName}: empty completion`);
  return parseTranslationsJson(providerName, content, texts.length);
}

export function parseTranslationsJson(
  providerName: string,
  content: string,
  expectedCount: number,
): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(content));
  } catch {
    throw new TranslationError('provider_error', `${providerName}: completion is not valid JSON`);
  }
  const translations = Array.isArray(parsed)
    ? parsed
    : (parsed as { translations?: unknown })?.translations;
  if (
    !Array.isArray(translations) ||
    translations.length !== expectedCount ||
    !translations.every((t) => typeof t === 'string')
  ) {
    throw new TranslationError(
      'provider_error',
      `${providerName}: expected ${expectedCount} translations in response`,
    );
  }
  return translations;
}

/** Tolerate models that wrap JSON in markdown fences. */
function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? content).trim();
}
