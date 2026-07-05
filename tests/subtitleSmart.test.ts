import { describe, expect, it } from 'vitest';
import { parseSmartSentences, rebuildSentences } from '@/services/subtitle/smart';
import type { SubtitleSegment } from '@/types/models';

const cues: SubtitleSegment[] = [
  { index: 0, start: 0, end: 2, text: "it's a bit salty" },
  { index: 1, start: 2, end: 4, text: 'saltier than normal milk' },
  { index: 2, start: 4, end: 6, text: "but it's quite creamy" },
];

describe('rebuildSentences', () => {
  it('merges cues per grouping, taking timing from the covered cues', () => {
    const out = rebuildSentences(cues, [
      { count: 2, translation: '它有点咸，比普通牛奶更咸' },
      { count: 1, translation: '但它相当顺滑' },
    ])!;
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      start: 0,
      end: 4,
      text: "it's a bit salty saltier than normal milk",
      translation: '它有点咸，比普通牛奶更咸',
    });
    expect(out[1]).toMatchObject({ start: 4, end: 6, translation: '但它相当顺滑' });
  });

  it('returns null when counts do not consume every cue', () => {
    expect(rebuildSentences(cues, [{ count: 2, translation: 'x' }])).toBeNull();
    expect(rebuildSentences(cues, [{ count: 5, translation: 'x' }])).toBeNull();
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
