import { describe, expect, it } from 'vitest';
import {
  parseSmartSentences,
  rebuildFromWords,
  wordsFromSegments,
  type TimedWord,
} from '@/services/subtitle/smart';
import type { SubtitleSegment } from '@/types/models';

const cues: SubtitleSegment[] = [
  { index: 0, start: 0, end: 4, text: 'smells like milk' }, // 3 words → 0, 1.33, 2.67
  { index: 1, start: 4, end: 7, text: 'yeah it does have' }, // 4 words → 4, 4.75, 5.5, 6.25
];

describe('wordsFromSegments', () => {
  it('flattens cues into timed words with interpolated per-word time', () => {
    const { words, end } = wordsFromSegments(cues);
    expect(words.map((w) => w.text)).toEqual(['smells', 'like', 'milk', 'yeah', 'it', 'does', 'have']);
    expect(words[0]!.start).toBe(0);
    expect(words[3]!.start).toBe(4); // 'yeah' starts at cue 1's start
    expect(end).toBe(7);
  });
});

describe('rebuildFromWords', () => {
  it('re-cuts at word level so a boundary word joins the right sentence', () => {
    const { words, end } = wordsFromSegments(cues);
    // "milk" (3 words) stays with sentence 1; "yeah it does have" is sentence 2.
    const out = rebuildFromWords(words, end, [
      { count: 3, translation: '闻起来像牛奶' },
      { count: 4, translation: '是的，它确实有' },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ start: 0, end: 4, text: 'smells like milk' });
    expect(out[1]).toMatchObject({ start: 4, end: 7, text: 'yeah it does have' });
  });

  it('returns null when counts do not consume every word', () => {
    const { words, end } = wordsFromSegments(cues);
    expect(rebuildFromWords(words, end, [{ count: 3, translation: 'x' }])).toBeNull();
    expect(rebuildFromWords(words, end, [{ count: 99, translation: 'x' }])).toBeNull();
  });
});

describe('parseSmartSentences', () => {
  it('parses the sentences JSON, tolerant of prose and fences', () => {
    expect(parseSmartSentences('{"sentences":[{"count":2,"zh":"你好"}]}')).toEqual([
      { count: 2, translation: '你好' },
    ]);
    expect(parseSmartSentences('```json\n{"sentences":[{"count":1,"zh":"a"}]}\n```')).toEqual([
      { count: 1, translation: 'a' },
    ]);
    expect(parseSmartSentences('sure: {"sentences":[{"count":1,"zh":"a"}]} done')).toEqual([
      { count: 1, translation: 'a' },
    ]);
  });
});

const _typecheck: TimedWord = { text: 'x', start: 0 };
void _typecheck;
