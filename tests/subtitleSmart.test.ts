import { describe, expect, it } from 'vitest';
import {
  alignSentences,
  parseSmartSentences,
  wordsFromSegments,
} from '@/services/subtitle/smart';
import type { SubtitleSegment } from '@/types/models';

const cues: SubtitleSegment[] = [
  { index: 0, start: 0, end: 4, text: 'smells like milk' }, // words at 0, 1.33, 2.67
  { index: 1, start: 4, end: 7, text: 'yeah it does have' }, // words at 4, 4.75, 5.5, 6.25
];

describe('wordsFromSegments', () => {
  it('flattens cues into timed words', () => {
    const { words, end } = wordsFromSegments(cues);
    expect(words.map((w) => w.text)).toEqual(['smells', 'like', 'milk', 'yeah', 'it', 'does', 'have']);
    expect(words[0]!.start).toBe(0);
    expect(words[3]!.start).toBe(4);
    expect(end).toBe(7);
  });
});

describe('alignSentences', () => {
  it('aligns model sentences to the word stream so boundary words land right', () => {
    const { words, end } = wordsFromSegments(cues);
    const out = alignSentences(words, end, [
      { en: 'smells like milk.', zh: '闻起来像牛奶' },
      { en: 'yeah, it does have.', zh: '是的，它确实有' },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ start: 0, end: 4, text: 'smells like milk', translation: '闻起来像牛奶' });
    expect(out[1]).toMatchObject({ start: 4, end: 7, text: 'yeah it does have', translation: '是的，它确实有' });
  });

  it('tolerates minor edits (added punctuation) and keeps original words', () => {
    const { words, end } = wordsFromSegments(cues);
    const out = alignSentences(words, end, [{ en: 'Smells like milk, yeah it does have!', zh: 'x' }])!;
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('smells like milk yeah it does have');
  });

  it('returns null when the model output barely matches the stream', () => {
    const { words, end } = wordsFromSegments(cues);
    expect(alignSentences(words, end, [{ en: 'completely different text here', zh: 'x' }])).toBeNull();
  });
});

describe('parseSmartSentences', () => {
  it('parses the sentences JSON, tolerant of prose and fences', () => {
    expect(parseSmartSentences('{"sentences":[{"en":"a","zh":"你好"}]}')).toEqual([
      { en: 'a', zh: '你好' },
    ]);
    expect(parseSmartSentences('```json\n{"sentences":[{"en":"a","zh":"b"}]}\n```')).toEqual([
      { en: 'a', zh: 'b' },
    ]);
    expect(parseSmartSentences('sure: {"sentences":[{"en":"a","zh":"b"}]} done')).toEqual([
      { en: 'a', zh: 'b' },
    ]);
  });
});
