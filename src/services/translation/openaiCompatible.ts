import type { ProviderSettings } from '@/shared/settings';
import { normalizeOpenAIBaseUrl } from '@/utils/url';
import { expectOk, networkError, TranslationError, type TranslateParams } from './provider';

const SYSTEM_PROMPT = `You are a professional translator. Translate each string in the JSON array the user sends from {FROM} to {TO}.
Rules:
- Preserve meaning, tone, inline formatting and placeholders.
- Do not add explanations.
- Respond with ONLY a JSON object: {"translations": ["...", ...]} with exactly one item per input, same order.`;

// Language codes → human names — models translate to "Malay" reliably but not
// to a bare code like "ms".
const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  ms: 'Malay',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? LANGUAGE_NAMES[code.split('-')[0]!] ?? code;
}

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
    from === 'auto' ? 'the detected source language' : languageName(from),
  ).replace('{TO}', languageName(to));

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
    parsed = undefined;
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as { translations?: unknown })?.translations;
  const translations = Array.isArray(raw) ? raw : raw != null ? [raw] : undefined;
  if (
    Array.isArray(translations) &&
    translations.length === expectedCount &&
    translations.every((t) => typeof t === 'string')
  ) {
    return translations as string[];
  }

  // Fallback: for a single input (subtitles, quick-translate) a model that
  // ignored the JSON instruction returns either plain text or a differently
  // shaped object — recover the translation from a known field (never a
  // metadata field like target_language), else the raw text.
  if (expectedCount === 1) {
    const fromJson = extractTranslation(parsed);
    if (fromJson) return [fromJson];
    const text = rawText(content);
    if (text && !/^[[{]/.test(text)) return [text];
  }

  throw new TranslationError(
    'provider_error',
    `${providerName}: expected ${expectedCount} translations in response`,
  );
}

/** First non-empty string anywhere in a parsed JSON value. */
// Keys that hold a translation — recurse only through these so we never pick
// up a metadata string (e.g. a "target_language": "Malaysia" field).
const TRANSLATION_KEYS = [
  'translation',
  'translations',
  'translated',
  'translated_text',
  'text',
  'output',
  'result',
  'zh',
  'content',
  'value',
];

function extractTranslation(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Array.isArray(v)) return v.length ? extractTranslation(v[0]) : undefined;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const key of TRANSLATION_KEYS) {
      if (key in obj) {
        const s = extractTranslation(obj[key]);
        if (s) return s;
      }
    }
  }
  return undefined;
}

/** Extract a JSON object/array even when wrapped in fences or surrounding prose. */
function extractJson(content: string): string {
  const s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const obj = s.indexOf('{');
  const arr = s.indexOf('[');
  const start = obj === -1 ? arr : arr === -1 ? obj : Math.min(obj, arr);
  if (start >= 0) {
    const close = s[start] === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end > start) return s.slice(start, end + 1);
  }
  return s;
}

/** Strip fences/quotes to recover a plain-text translation. */
function rawText(content: string): string {
  let s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) s = fenced[1].trim();
  if (/^".*"$/s.test(s)) {
    try {
      return String(JSON.parse(s));
    } catch {
      /* fall through */
    }
  }
  return s;
}
