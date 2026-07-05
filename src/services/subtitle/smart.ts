import type { ProviderSettings } from '@/shared/settings';
import type { SubtitleSegment } from '@/types/models';
import { normalizeOpenAIBaseUrl } from '@/utils/url';

/** One sentence the model produced: its (rough) English text and translation. */
export interface SmartSentence {
  en: string;
  zh: string;
}

export interface TimedWord {
  text: string;
  start: number;
}

/**
 * Flatten cue segments into a timed word list. Per-word time is interpolated
 * within each cue's span so we can re-cut sentences at any word and keep them
 * aligned with the audio.
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

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Align model sentences to the source word stream to find each sentence's word
 * range (so we don't rely on the model counting). The displayed text stays the
 * original ASR words; timing comes from the aligned words. Returns null if the
 * alignment covers too few words to trust.
 */
export function alignSentences(
  words: TimedWord[],
  end: number,
  sentences: SmartSentence[],
): SubtitleSegment[] | null {
  const spans: Array<{ from: number; to: number; zh: string }> = [];
  let si = 0;
  for (const sent of sentences) {
    const enWords = sent.en.split(/\s+/).map(norm).filter(Boolean);
    const from = si;
    for (const ew of enWords) {
      // Find this word at/after the cursor within a small look-ahead window.
      for (let k = si; k < Math.min(si + 6, words.length); k++) {
        if (norm(words[k]!.text) === ew) {
          si = k + 1;
          break;
        }
      }
    }
    if (si > from) spans.push({ from, to: si, zh: sent.zh });
  }
  // Too little of the stream consumed → the model reworded/hallucinated; bail.
  if (spans.length === 0 || si < words.length * 0.6) return null;
  // Make sure the last span reaches the end so no words are dropped.
  spans[spans.length - 1]!.to = words.length;
  return spans.map((s, i) => ({
    index: i,
    start: words[s.from]!.start,
    end: words[spans[i + 1]?.from ?? words.length]?.start ?? end,
    text: words
      .slice(s.from, s.to)
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    translation: s.zh?.trim() || undefined,
  }));
}

const SYSTEM = `You segment and translate auto-generated video subtitles (ASR: a stream of words with no punctuation).
You are given a JSON array of consecutive WORDS. Split them into complete, natural sentences and translate each into {TO}.
Rules:
- One sentence per item. Only merge into one item if a sentence is very short (a few words).
- Put boundary words on the correct sentence (a trailing "milk" belongs to the sentence it ends, not the next one).
- Keep the original words in order; you may add punctuation, but do not paraphrase or drop words.
Return ONLY JSON: {"sentences":[{"en":"the sentence in English","zh":"the translation"}, ...]}, covering every word in order.`;

/** Split a window of words into sentences + translate, via an OpenAI-compatible endpoint. */
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

/** Parse the {"sentences":[{en,zh}]} response, tolerant of prose/fences. */
export function parseSmartSentences(content: string): SmartSentence[] {
  const parsed = JSON.parse(extractJsonObject(content)) as {
    sentences?: Array<{ en?: unknown; zh?: unknown }>;
  };
  const list = parsed?.sentences;
  if (!Array.isArray(list)) throw new Error('smart segment: no sentences');
  return list.map((s) => ({
    en: typeof s.en === 'string' ? s.en : '',
    zh: typeof s.zh === 'string' ? s.zh : '',
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
