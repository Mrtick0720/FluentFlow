import { describe, expect, it } from 'vitest';
import {
  extractCaptionTracks,
  pickCaptionTrack,
  segmentsFromTimedText,
} from '@/adapters/youtube/timedtext';

describe('extractCaptionTracks', () => {
  const html =
    'noise{"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[' +
    '{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=en","languageCode":"en","kind":"asr","name":{"simpleText":"English (auto)"}},' +
    '{"baseUrl":"https://www.youtube.com/api/timedtext?v=abc\\u0026lang=de","languageCode":"de","name":{"runs":[{"text":"Deutsch"}]}}' +
    '],"audioTracks":[]}}}more noise';

  it('parses the balanced captionTracks array out of page HTML', () => {
    const tracks = extractCaptionTracks(html);
    expect(tracks).toHaveLength(2);
    expect(tracks[0]).toMatchObject({ languageCode: 'en', kind: 'asr' });
    expect(tracks[0]!.baseUrl).toContain('&lang=en'); // & unescaped by JSON.parse
  });

  it('returns [] when the marker is missing or malformed', () => {
    expect(extractCaptionTracks('<html>no captions</html>')).toEqual([]);
    expect(extractCaptionTracks('"captionTracks":[{"broken":')).toEqual([]);
  });
});

describe('pickCaptionTrack', () => {
  const en = { baseUrl: 'u1', languageCode: 'en' };
  const enAsr = { baseUrl: 'u2', languageCode: 'en', kind: 'asr' };
  const de = { baseUrl: 'u3', languageCode: 'de' };

  it('prefers human English over ASR English over anything else', () => {
    expect(pickCaptionTrack([de, enAsr, en])).toBe(en);
    expect(pickCaptionTrack([de, enAsr])).toBe(enAsr);
    expect(pickCaptionTrack([de])).toBe(de);
    expect(pickCaptionTrack([])).toBeUndefined();
  });
});

describe('segmentsFromTimedText', () => {
  it('joins words into sentences broken at punctuation', () => {
    const segments = segmentsFromTimedText({
      events: [
        {
          tStartMs: 1000,
          segs: [
            { utf8: 'But', tOffsetMs: 0 },
            { utf8: 'these', tOffsetMs: 300 },
            { utf8: 'models', tOffsetMs: 600 },
            { utf8: 'keep', tOffsetMs: 900 },
            { utf8: 'getting', tOffsetMs: 1200 },
            { utf8: 'better.', tOffsetMs: 1500 },
          ],
        },
        {
          tStartMs: 3000,
          segs: [
            { utf8: 'Closing', tOffsetMs: 0 },
            { utf8: 'the', tOffsetMs: 300 },
            { utf8: 'gap.', tOffsetMs: 600 },
          ],
        },
      ],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      start: 1,
      text: 'But these models keep getting better.',
    });
    expect(segments[1]).toMatchObject({ start: 3, text: 'Closing the gap.' });
  });

  it('breaks on long pauses even without punctuation', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'first' }, { utf8: 'part', tOffsetMs: 400 }] },
        { tStartMs: 5000, segs: [{ utf8: 'after' }, { utf8: 'silence', tOffsetMs: 400 }] },
      ],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('first part');
    expect(segments[1]!.text).toBe('after silence');
  });

  it('skips aAppend display events and whitespace-only segs', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Real words.' }] },
        { tStartMs: 100, aAppend: 1, segs: [{ utf8: 'Real words.' }] },
        { tStartMs: 200, segs: [{ utf8: '\n' }] },
      ],
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe('Real words.');
  });

  it('caps runaway sentences at a max length', () => {
    const words = Array.from({ length: 60 }, (_, i) => ({
      utf8: `word${i}`,
      tOffsetMs: i * 200,
    }));
    const segments = segmentsFromTimedText({ events: [{ tStartMs: 0, segs: words }] });
    expect(segments.length).toBeGreaterThan(1);
    for (const s of segments) expect(s.text.length).toBeLessThanOrEqual(200);
  });
});
