import { describe, expect, it } from 'vitest';
import {
  extractCaptionTracks,
  normalizeTimedTextUrl,
  pickCaptionTrack,
  segmentsFromTimedText,
  timedTextVideoId,
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

describe('normalizeTimedTextUrl', () => {
  it('forces json3 and drops player auto-translate, keeping the POT token', () => {
    const raw =
      'https://www.youtube.com/api/timedtext?v=abc&lang=en&pot=TOKEN123&fmt=srv3&tlang=zh-Hans';
    const url = new URL(normalizeTimedTextUrl(raw));
    expect(url.searchParams.get('fmt')).toBe('json3');
    expect(url.searchParams.get('tlang')).toBeNull();
    expect(url.searchParams.get('pot')).toBe('TOKEN123');
    expect(url.searchParams.get('lang')).toBe('en');
  });

  it('resolves relative URLs against the YouTube origin', () => {
    expect(normalizeTimedTextUrl('/api/timedtext?v=abc&lang=en')).toContain(
      'https://www.youtube.com/api/timedtext',
    );
  });

  it('extracts the video id for stale-capture rejection', () => {
    expect(timedTextVideoId('https://www.youtube.com/api/timedtext?v=abc&lang=en')).toBe('abc');
    expect(timedTextVideoId('not a url')).toBeNull();
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

  it('splits on speaker-change markers and drops them', () => {
    const segments = segmentsFromTimedText({
      events: [
        {
          tStartMs: 0,
          segs: [
            { utf8: '>>' },
            { utf8: 'First', tOffsetMs: 100 },
            { utf8: 'speaker', tOffsetMs: 300 },
            { utf8: '>>', tOffsetMs: 600 },
            { utf8: 'Second', tOffsetMs: 700 },
            { utf8: 'speaker', tOffsetMs: 900 },
          ],
        },
      ],
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]!.text).toBe('First speaker');
    expect(segments[1]!.text).toBe('Second speaker');
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

  it('ends a sentence at the source cue end (dDurationMs), matching YouTube', () => {
    // Manual captions: each cue is a full line lasting several seconds.
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 160, dDurationMs: 4720, segs: [{ utf8: 'Today I am here with Eric.' }] },
        { tStartMs: 4880, dDurationMs: 5120, segs: [{ utf8: 'And before that, senior role.' }] },
        { tStartMs: 10000, dDurationMs: 5760, segs: [{ utf8: 'You have been on sabbatical.' }] },
      ],
    });
    expect(segments[0]).toMatchObject({ start: 0.16, end: 4.88 });
    expect(segments[1]).toMatchObject({ start: 4.88, end: 10 });
    expect(segments[2]).toMatchObject({ start: 10, end: 15.76 });
  });

  it('leaves back-to-back cues contiguous — no gaps, no overlap', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: 'One two three.' }] },
        { tStartMs: 3000, dDurationMs: 3000, segs: [{ utf8: 'Four five six.' }] },
        { tStartMs: 6000, dDurationMs: 3000, segs: [{ utf8: 'Seven eight nine.' }] },
      ],
    });
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBeGreaterThanOrEqual(segments[i - 1]!.end); // no overlap
      expect(segments[i]!.start - segments[i - 1]!.end).toBeLessThanOrEqual(0.001); // no gap
    }
  });

  it('preserves a real gap when a cue ends well before the next begins', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'Hello.' }] }, // [0, 2]
        { tStartMs: 5000, dDurationMs: 2000, segs: [{ utf8: 'World.' }] }, // [5, 7] after 3s silence
      ],
    });
    expect(segments[0]).toMatchObject({ end: 2 }); // cue end, NOT extended to 5
    expect(segments[1]).toMatchObject({ start: 5 });
  });

  it('clamps a cue that overruns the next sentence (no overlap)', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, dDurationMs: 6000, segs: [{ utf8: 'Overlong.' }] }, // cue claims [0, 6]
        { tStartMs: 4000, dDurationMs: 2000, segs: [{ utf8: 'Next.' }] }, // but next starts at 4
      ],
    });
    expect(segments[0]!.end).toBe(4); // clamped to next start
  });

  it('falls back to the next cue start when no duration is available', () => {
    const segments = segmentsFromTimedText({
      events: [
        { tStartMs: 0, segs: [{ utf8: 'Hello.' }] }, // no dDurationMs
        { tStartMs: 3000, segs: [{ utf8: 'World.' }] },
      ],
    });
    expect(segments[0]).toMatchObject({ end: 3 }); // contiguous with next
  });
});
