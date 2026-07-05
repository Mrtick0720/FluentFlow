import type { ProviderSettings } from '@/shared/settings';
import { normalizeOpenAIBaseUrl } from '@/utils/url';
import { languageName } from './openaiCompatible';
import { expectOk, networkError, TranslationError } from './provider';

/** One paragraph to translate, with optional surrounding context and a title flag. */
export interface QualitySegment {
  text: string;
  /** Preceding paragraph (reference only — not translated). */
  before?: string;
  /** Following paragraph (reference only — not translated). */
  after?: string;
  /** Heading/title — translated for intent, not literally. */
  isTitle?: boolean;
}

/** A glossary entry: a term's chosen translation and the domain it belongs to. */
export interface GlossaryEntry {
  translation: string;
  domain?: string;
}
/** Source term → domain-tagged translation, reused for document-wide consistency. */
export type Glossary = Record<string, GlossaryEntry>;

export interface QualityRequest {
  segments: QualitySegment[];
  from: string;
  to: string;
  /** Domain established by an earlier batch — reused so it isn't re-inferred. */
  domain?: string;
  glossary?: Glossary;
}

export interface QualityResult {
  translations: string[];
  /** Merged glossary (given terms + any new key terms the model standardized). */
  glossary: Glossary;
  /** The article's domain (echoed when given, otherwise inferred). */
  domain?: string;
}

function systemPrompt(from: string, to: string): string {
  const fromName = from === 'auto' ? 'the detected source language' : languageName(from);
  const toName = languageName(to);
  return `You are LinguaFlow's professional bilingual translation engine. Translate from ${fromName} to ${toName} to give the reader a high-quality bilingual reading experience: natural and fluent, faithful to the author's meaning, tone, logic and style. Never translate word-for-word, never summarize, never omit, never invent.

Prefer the article domain's terminology, not the most common dictionary sense. For example in AI "alignment" → 对齐; in finance "position" → 仓位. Translate every technical term the SAME way throughout.

The user sends a JSON object:
{"domain":"...", "segments":[{"text":"...","before":"...","after":"...","title":true|false}, ...], "glossary":{"term":{"translation":"...","domain":"..."}, ...}}

Rules:
- DOMAIN: if "domain" is a non-empty string, it is the article's already-established domain — translate with its terminology and echo the SAME value back; do NOT re-infer. If "domain" is absent or empty, infer the article's single domain (e.g. AI, Finance, Law, Medicine, Programming, Fly Fishing) and return it.
- Translate ONLY each segment's "text". "before"/"after" are neighbouring paragraphs provided for context — use them to resolve references (this, that, it, former, latter, instead, however …) but do NOT translate or output them.
- GLOSSARY: each entry maps a source term to {"translation", "domain"}. Reuse every given translation exactly; this keeps terminology consistent across the document.
- Segments with "title":true are headings — render them as a natural, professional title that preserves the author's intent, not a literal translation.
- You may split long sentences so the ${toName} reads naturally. Keep people's names in their original script on first use. Translate idioms by meaning, not words.

Respond with ONLY a JSON object, no markdown, no commentary:
{"translations":["...", ...], "domain":"...", "glossary":{"term":{"translation":"...","domain":"..."}, ...}}
- "translations": exactly one item per input segment, in the same order.
- "domain": the domain used (echoed if given, otherwise inferred).
- "glossary": the given glossary merged with any new key terms you standardized, each as {"translation": <${toName}>, "domain": <domain>}.`;
}

/** Translate a batch of paragraphs with context + glossary via an OpenAI-compatible LLM. */
export async function qualityTranslate(
  providerName: string,
  req: QualityRequest,
  config: ProviderSettings,
): Promise<QualityResult> {
  if (!config.apiKey && !config.baseUrl) {
    throw new TranslationError('auth', `${providerName}: API key not configured`);
  }
  const baseUrl = normalizeOpenAIBaseUrl(config.baseUrl || 'https://api.openai.com/v1');
  const model = config.model || 'gpt-4o-mini';
  const userPayload = {
    ...(req.domain ? { domain: req.domain } : {}),
    segments: req.segments.map((s) => ({
      text: s.text,
      ...(s.before ? { before: s.before } : {}),
      ...(s.after ? { after: s.after } : {}),
      ...(s.isTitle ? { title: true } : {}),
    })),
    glossary: req.glossary ?? {},
  };

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
          { role: 'system', content: systemPrompt(req.from, req.to) },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw networkError(providerName, e);
  }
  await expectOk(res, providerName);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new TranslationError('provider_error', `${providerName}: empty completion`);
  return parseQualityJson(providerName, content, req.segments.length);
}

export function parseQualityJson(
  providerName: string,
  content: string,
  expectedCount: number,
): QualityResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/```(?:json)?|```/g, '').trim());
  } catch {
    throw new TranslationError('provider_error', `${providerName}: response was not valid JSON`);
  }
  const obj = (parsed ?? {}) as { translations?: unknown; glossary?: unknown; domain?: unknown };
  const translations = obj.translations;
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
  const domain = typeof obj.domain === 'string' && obj.domain.trim() ? obj.domain.trim() : undefined;
  const glossary: Glossary = {};
  if (obj.glossary && typeof obj.glossary === 'object') {
    for (const [term, v] of Object.entries(obj.glossary as Record<string, unknown>)) {
      if (!term) continue;
      // Accept both the domain-tagged shape and a bare "term": "translation".
      if (typeof v === 'string') {
        glossary[term] = { translation: v, domain };
      } else if (v && typeof v === 'object') {
        const entry = v as { translation?: unknown; domain?: unknown };
        if (typeof entry.translation === 'string') {
          glossary[term] = {
            translation: entry.translation,
            domain: typeof entry.domain === 'string' ? entry.domain : domain,
          };
        }
      }
    }
  }
  return { translations: translations as string[], glossary, domain };
}
