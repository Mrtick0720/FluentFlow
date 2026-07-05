import type { ProviderSettings } from '@/shared/settings';
import type { SubtitleSegment } from '@/types/models';
import { normalizeOpenAIBaseUrl } from '@/utils/url';

/** One merged sentence: how many consecutive cues it covers, plus its translation. */
export interface SmartSentence {
  count: number;
  translation: string;
}

/**
 * Rebuild raw caption cues into sentence segments from an LLM grouping. Timing
 * is taken from the covered cues (so it stays aligned with the audio). Returns
 * null if the counts don't consume exactly every cue (caller falls back).
 */
export function rebuildSentences(
  cues: SubtitleSegment[],
  sentences: SmartSentence[],
): SubtitleSegment[] | null {
  const total = sentences.reduce((n, s) => n + (Number.isInteger(s.count) && s.count > 0 ? s.count : 0), 0);
  if (total !== cues.length) return null;
  const out: SubtitleSegment[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const group = cues.slice(cursor, cursor + s.count);
    cursor += s.count;
    if (group.length === 0) continue;
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const text = group
      .map((c) => c.text.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    out.push({
      index: out.length,
      start: first.start,
      end: last.end,
      text,
      translation: s.translation?.trim() || undefined,
    });
  }
  return out;
}

const SYSTEM = `You segment and translate auto-generated video subtitles (ASR, no punctuation).
You are given a JSON array of consecutive caption fragments. Merge consecutive fragments into complete, natural sentences and translate each sentence into {TO}.
Return ONLY JSON: {"sentences":[{"count":N,"zh":"the translation"}, ...]}
- "count" is how many consecutive fragments (in the given order) that sentence covers.
- The counts MUST sum to the number of fragments and cover every fragment exactly once, in order. Never reorder, drop, or duplicate fragments.`;

/** Group + translate a window of cue texts via an OpenAI-compatible endpoint. */
export async function smartGroupTranslate(
  config: ProviderSettings,
  texts: string[],
  to: string,
  defaults: { baseUrl: string; model: string },
): Promise<SmartSentence[]> {
  const baseUrl = normalizeOpenAIBaseUrl(config.baseUrl || defaults.baseUrl);
  const model = config.model || defaults.model;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM.replace('{TO}', to) },
        { role: 'user', content: JSON.stringify(texts) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`smart segment HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? '';
  return parseSmartSentences(content);
}

/** Parse the {"sentences":[{count,zh}]} response, tolerant of prose/fences. */
export function parseSmartSentences(content: string): SmartSentence[] {
  const jsonText = extractJsonObject(content);
  const parsed = JSON.parse(jsonText) as { sentences?: Array<{ count?: unknown; zh?: unknown }> };
  const list = parsed?.sentences;
  if (!Array.isArray(list)) throw new Error('smart segment: no sentences');
  return list.map((s) => ({
    count: Number(s.count),
    translation: typeof s.zh === 'string' ? s.zh : '',
  }));
}

function extractJsonObject(content: string): string {
  const s = content.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return s.slice(start, end + 1);
  return s;
}
