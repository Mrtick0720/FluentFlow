import type { ProviderSettings } from '@/shared/settings';
import type { SubtitleSegment } from '@/types/models';
import { normalizeOpenAIBaseUrl } from '@/utils/url';

/** One sentence: how many consecutive WORDS it covers, plus its translation. */
export interface SmartSentence {
  count: number;
  translation: string;
}

export interface TimedWord {
  text: string;
  start: number;
}

/**
 * Flatten cue segments into a timed word list. Per-word time is interpolated
 * within each cue's span, so we can re-cut sentences at any word and still keep
 * them aligned with the audio.
 */
export function wordsFromSegments(segments: SubtitleSegment[]): { words: TimedWord[]; end: number } {
  const words: TimedWord[] = [];
  let end = 0;
  for (const seg of segments) {
    const parts = seg.text.split(/\s+/).filter(Boolean);
    const span = Math.max(0, seg.end - seg.start);
    parts.forEach((text, i) => {
      words.push({ text, start: seg.start + (parts.length ? (i / parts.length) * span : 0) });
    });
    end = Math.max(end, seg.end);
  }
  return { words, end };
}

/**
 * Rebuild sentence segments from an LLM word-count grouping. Each sentence's
 * time span comes from its first word to the next sentence's first word (or the
 * transcript end). Returns null if the counts don't consume exactly every word.
 */
export function rebuildFromWords(
  words: TimedWord[],
  end: number,
  sentences: SmartSentence[],
): SubtitleSegment[] | null {
  const total = sentences.reduce(
    (n, s) => n + (Number.isInteger(s.count) && s.count > 0 ? s.count : 0),
    0,
  );
  if (total !== words.length) return null;
  const out: SubtitleSegment[] = [];
  let cursor = 0;
  for (const s of sentences) {
    const group = words.slice(cursor, cursor + s.count);
    cursor += s.count;
    if (group.length === 0) continue;
    out.push({
      index: out.length,
      start: group[0]!.start,
      end: words[cursor]?.start ?? end,
      text: group.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
      translation: s.translation?.trim() || undefined,
    });
  }
  return out;
}

const SYSTEM = `You segment and translate auto-generated video subtitles (ASR: a stream of words, no punctuation).
You are given a JSON array of consecutive WORDS. Split them into complete, natural sentences and translate each sentence into {TO}.
Rules:
- One sentence per item. Only merge into the same item if a sentence is very short (a few words).
- Put boundary words on the correct sentence (e.g. a trailing "milk" belongs to the sentence it ends, not the next one).
- Do NOT reorder, add, drop, or edit words.
Return ONLY JSON: {"sentences":[{"count":N,"zh":"the translation"}, ...]}
- "count" = how many consecutive words (in the given order) that sentence covers.
- The counts MUST sum to the number of words and cover every word exactly once, in order.`;

/** Group a window of words into sentences + translate, via an OpenAI-compatible endpoint. */
export async function smartGroupTranslate(
  config: ProviderSettings,
  words: string[],
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
        { role: 'user', content: JSON.stringify(words) },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`smart segment HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseSmartSentences(data.choices?.[0]?.message?.content ?? '');
}

/** Parse the {"sentences":[{count,zh}]} response, tolerant of prose/fences. */
export function parseSmartSentences(content: string): SmartSentence[] {
  const parsed = JSON.parse(extractJsonObject(content)) as {
    sentences?: Array<{ count?: unknown; zh?: unknown }>;
  };
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
