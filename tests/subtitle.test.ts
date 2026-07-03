import { describe, expect, it } from 'vitest';
import { parseVtt } from '@/services/subtitle/vtt';
import { VideoAdapterRegistry, type VideoAdapter } from '@/services/video/adapter';

const SAMPLE_VTT = `WEBVTT

NOTE this is a comment

1
00:00:01.000 --> 00:00:04.000
Hello <b>world</b>

00:12.500 --> 00:15.000 align:start
Second line
continues here

STYLE
::cue { color: red }

01:00:00.000 --> 01:00:02.000
With hours
`;

describe('parseVtt', () => {
  it('parses cues, strips tags, joins wrapped lines, skips NOTE/STYLE', () => {
    const segments = parseVtt(SAMPLE_VTT);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ start: 1, end: 4, text: 'Hello world' });
    expect(segments[1]).toMatchObject({ start: 12.5, end: 15, text: 'Second line continues here' });
    expect(segments[2]).toMatchObject({ start: 3600, end: 3602, text: 'With hours' });
  });

  it('handles comma decimal separators (SRT-style)', () => {
    const segments = parseVtt('00:00:01,000 --> 00:00:02,000\nHi');
    expect(segments[0]).toMatchObject({ start: 1, end: 2, text: 'Hi' });
  });

  it('returns empty array for empty or header-only input', () => {
    expect(parseVtt('WEBVTT\n')).toEqual([]);
    expect(parseVtt('')).toEqual([]);
  });
});

function fakeAdapter(id: string, matcher: (url: string) => boolean): VideoAdapter {
  return {
    id,
    match: matcher,
    getVideo: () => null,
    getSubtitleTracks: async () => [],
    getCurrentCaption: () => null,
    seek: () => {},
    onCaptionChanged: () => () => {},
  };
}

describe('VideoAdapterRegistry', () => {
  it('resolves the first matching adapter, specific before generic', () => {
    const registry = new VideoAdapterRegistry()
      .register(fakeAdapter('youtube', (u) => u.includes('youtube.com')))
      .register(fakeAdapter('generic', () => true));

    expect(registry.resolve('https://www.youtube.com/watch?v=x')?.id).toBe('youtube');
    expect(registry.resolve('https://example.com/video')?.id).toBe('generic');
  });

  it('returns null when nothing matches', () => {
    const registry = new VideoAdapterRegistry().register(
      fakeAdapter('youtube', (u) => u.includes('youtube.com')),
    );
    expect(registry.resolve('https://example.com')).toBeNull();
  });
});
