import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVtt } from '@/services/subtitle/vtt';
import {
  VideoAdapterRegistry,
  type CaptionState,
  type VideoAdapter,
} from '@/services/video/adapter';
import {
  isRelatedCaption,
  mergeCaptions,
  SubtitleController,
  type SubtitleViewState,
} from '@/services/video/controller';
import { chooseCaptionText, normalizeCaptionText } from '@/adapters/youtube';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function liveHarness(translate: (texts: string[]) => Promise<string[]>) {
  let emit: (caption: CaptionState | null) => void = () => {};
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    paused: false,
    pause() {
      this.paused = true;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    getBoundingClientRect() {
      return null;
    },
  }) as unknown as HTMLVideoElement;
  const adapter: VideoAdapter = {
    id: 'live-test',
    match: () => true,
    getVideo: () => video,
    getSubtitleTracks: async () => [],
    getCurrentCaption: () => null,
    seek: () => {},
    onCaptionChanged: (callback) => {
      emit = callback;
      return () => {
        emit = () => {};
      };
    },
  };
  const states: SubtitleViewState[] = [];
  const controller = new SubtitleController(new VideoAdapterRegistry().register(adapter), {
    translate,
    onState: (state) => states.push({ ...state }),
  });
  return { controller, emit: (caption: CaptionState | null) => emit(caption), states };
}

const latest = (states: SubtitleViewState[]) => states.at(-1)!;

describe('SubtitleController live captions (whole-sentence mode)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers word-by-word captions and shows the full EN+ZH pair at the gap', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const harness = liveHarness(async ([text]) => {
      requests.push(text!);
      return [`译：${text}`];
    });
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'Hello' });
    await vi.advanceTimersByTimeAsync(120); // partial translated in the background
    // Nothing renders while the sentence is still being spoken.
    expect(latest(harness.states).original).toBe('');

    harness.emit({ text: 'Hello world' });
    expect(latest(harness.states).original).toBe('');

    harness.emit(null); // sentence boundary
    // The pair appears at once: full English + best-available Chinese.
    expect(latest(harness.states)).toMatchObject({
      original: 'Hello world',
      translation: '译：Hello',
    });
    // The exact translation replaces the partial one shortly after.
    await vi.advanceTimersByTimeAsync(300);
    expect(latest(harness.states)).toMatchObject({
      original: 'Hello world',
      translation: '译：Hello world',
      translating: false,
    });
    expect(requests).toEqual(['Hello', 'Hello world']);
  });

  it('stitches rolling windows into one full sentence', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'a much speculated about' });
    harness.emit({ text: 'much speculated about project' });
    expect(latest(harness.states).original).toBe(''); // still buffering

    harness.emit(null);
    expect(latest(harness.states).original).toBe('a much speculated about project');
    await vi.advanceTimersByTimeAsync(300);
    expect(latest(harness.states).translation).toBe('译：a much speculated about project');
  });

  it('replaces the previous pair when a new sentence starts without a gap', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'First sentence here' });
    await vi.advanceTimersByTimeAsync(120); // exact translation ready before the boundary
    harness.emit({ text: 'Totally different words' }); // switch = boundary
    expect(latest(harness.states)).toMatchObject({
      original: 'First sentence here',
      translation: '译：First sentence here',
      translating: false,
    });

    harness.emit(null);
    expect(latest(harness.states).original).toBe('Totally different words');
  });

  it('splits at sentence punctuation when speech never pauses', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'We know something' });
    expect(latest(harness.states).original).toBe(''); // buffering
    harness.emit({ text: 'We know something. And now more' });
    // The finished sentence displays immediately; the tail keeps buffering.
    expect(latest(harness.states).original).toBe('We know something.');
    await vi.advanceTimersByTimeAsync(300);
    expect(latest(harness.states).translation).toBe('译：We know something.');

    harness.emit(null);
    expect(latest(harness.states).original).toBe('And now more');
  });

  it('caps a punctuation-less buffer at a word boundary instead of growing forever', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    let text = 'word';
    while (text.length <= 150) {
      text += ' word';
      harness.emit({ text });
    }
    const shown = latest(harness.states).original;
    expect(shown.length).toBeGreaterThan(60);
    expect(shown.length).toBeLessThanOrEqual(100);
  });

  it('breaks run-on speech at clause boundaries past the soft cap', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    const runOn =
      'You know, we we together provides a secure compliant uh all US-hosted ' +
      'infrastructure for serving these models, and all our customers do typically';
    harness.emit({ text: runOn });
    const shown = latest(harness.states).original;
    // Kept to a single readable line even in one burst.
    expect(shown.length).toBeGreaterThan(60);
    expect(shown.length).toBeLessThanOrEqual(100);
  });

  it('prefers a comma inside the split window', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({
      text:
        "So first you know it's really important to acknowledge the growing consensus, " +
        'on open source models for the economy',
    });
    const shown = latest(harness.states).original;
    expect(shown.endsWith('consensus,')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(100);
  });

  it('splits at speaker-change markers and strips them from display', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: '>> But open source helps companies' });
    expect(latest(harness.states).original).toBe(''); // buffering, marker stripped
    harness.emit({ text: '>> But open source helps companies >> people we talk to' });
    // Speaker change: finished part displays without any '>>' noise.
    expect(latest(harness.states).original).toBe('But open source helps companies');

    harness.emit(null);
    expect(latest(harness.states).original).toBe('people we talk to');
  });

  it('clears the panel after a long silence', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'Hello there friend' });
    await vi.advanceTimersByTimeAsync(120);
    harness.emit(null);
    expect(latest(harness.states).original).toBe('Hello there friend');

    await vi.advanceTimersByTimeAsync(7000);
    expect(latest(harness.states)).toMatchObject({ original: '', translation: '' });
  });

  it('degrades to English-only when translation fails', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async () => {
      throw new Error('offline');
    });
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'Oops line' });
    harness.emit(null);
    await vi.advanceTimersByTimeAsync(300);
    expect(latest(harness.states)).toMatchObject({
      original: 'Oops line',
      translation: '',
      translating: false,
    });
  });

  it('ignores a translation that resolves after detach', async () => {
    vi.useFakeTimers();
    const pending = deferred<string[]>();
    const harness = liveHarness(() => pending.promise);
    await harness.controller.attach('https://example.com/video');
    harness.emit({ text: 'Leaving now' });
    await vi.advanceTimersByTimeAsync(200);
    harness.controller.detach();
    pending.resolve(['迟到的翻译']);
    await vi.advanceTimersByTimeAsync(0);

    expect(latest(harness.states)).toMatchObject({
      status: 'idle',
      original: '',
      translation: '',
      translating: false,
    });
  });
});

function trackHarness(
  segments: Array<{ index: number; start: number; end: number; text: string; translation?: string }>,
  translate: (texts: string[]) => Promise<string[]>,
) {
  const video = Object.assign(new EventTarget(), {
    currentTime: 0,
    playbackRate: 1,
    paused: false,
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    getBoundingClientRect() {
      return null;
    },
  }) as unknown as HTMLVideoElement;
  const adapter: VideoAdapter = {
    id: 'track-test',
    match: () => true,
    getVideo: () => video,
    getSubtitleTracks: async () => [
      { id: 't', label: 'T', language: 'en', kind: 'captions', segments },
    ],
    getCurrentCaption: () => null,
    seek: (s) => {
      (video as unknown as { currentTime: number }).currentTime = s;
    },
    onCaptionChanged: () => () => {},
  };
  const states: SubtitleViewState[] = [];
  const controller = new SubtitleController(new VideoAdapterRegistry().register(adapter), {
    translate,
    onState: (state) => states.push({ ...state }),
  });
  const tick = (t: number) => {
    (video as unknown as { currentTime: number }).currentTime = t;
    video.dispatchEvent(new Event('timeupdate'));
  };
  return { controller, video, states, tick };
}

describe('SubtitleController track mode', () => {
  it('holds the last sentence during gaps between segments (no blank "…")', async () => {
    const segs = [
      { index: 0, start: 0, end: 2, text: 'First sentence' },
      { index: 1, start: 3, end: 5, text: 'Second sentence' },
    ];
    const h = trackHarness(segs, async ([t]) => [`译：${t}`]);
    await h.controller.attach('https://example.com/video');

    h.tick(1); // inside the first segment
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(2.5); // gap between segments — must keep showing the first one
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(3.2); // inside the second segment
    expect(latest(h.states).original).toBe('Second sentence');

    h.controller.detach();
  });
});

describe('mergeCaptions / isRelatedCaption', () => {
  it('recognizes growth and prefix truncation', () => {
    expect(mergeCaptions('Hello', 'Hello world')).toBe('Hello world');
    expect(mergeCaptions('Hello world', 'Hello')).toBe('Hello world');
  });

  it('stitches rolling windows on word overlap', () => {
    expect(mergeCaptions('a much speculated about', 'much speculated about project')).toBe(
      'a much speculated about project',
    );
    expect(isRelatedCaption('we get to do this', 'get to do this in the')).toBe(true);
  });

  it('rejects unrelated sentences and empty input', () => {
    expect(mergeCaptions('First sentence here', 'Totally different words')).toBeNull();
    expect(mergeCaptions('', 'anything')).toBeNull();
    expect(isRelatedCaption('one two', 'three four')).toBe(false);
  });
});

describe('YouTubeAdapter caption selection', () => {
  it('normalizes whitespace before comparing caption mutations', () => {
    expect(normalizeCaptionText('  And  you\nare   going  ')).toBe('And you are going');
  });

  it('uses visible caption windows and ignores hidden stale text', () => {
    expect(
      chooseCaptionText([
        { text: 'Old caption', visible: false },
        { text: ' Current   caption ', visible: true },
        { text: 'continues', visible: true },
      ]),
    ).toBe('Current caption continues');
  });
});
