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

describe('SubtitleController live captions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('translates promptly and refines as the caption grows (no stability wait)', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const harness = liveHarness(async ([text]) => {
      requests.push(text!);
      return [`译：${text}`];
    });
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'I am thrilled' });
    await vi.advanceTimersByTimeAsync(120);
    expect(latest(harness.states)).toMatchObject({
      original: 'I am thrilled',
      translation: '译：I am thrilled',
      translating: false,
    });

    // Growing caption: the partial translation stays visible, then refines —
    // it must NOT wait for the caption to stop changing.
    harness.emit({ text: 'I am thrilled we get to' });
    expect(latest(harness.states)).toMatchObject({
      original: 'I am thrilled we get to',
      translation: '译：I am thrilled',
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(latest(harness.states).translation).toBe('译：I am thrilled we get to');

    // A brand-new sentence drops the stale translation immediately.
    harness.emit({ text: 'Second sentence' });
    expect(latest(harness.states)).toMatchObject({
      original: 'Second sentence',
      translation: '',
      translating: true,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(requests).toEqual(['I am thrilled', 'I am thrilled we get to', 'Second sentence']);
  });

  it('fills the spinner with a stale result, then corrects it with the next one', async () => {
    vi.useFakeTimers();
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const translate = vi
      .fn<(texts: string[]) => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const harness = liveHarness(translate);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'First' });
    await vi.advanceTimersByTimeAsync(200); // request 1 in flight
    harness.emit({ text: 'Second' }); // unrelated → spinner, queued behind it
    first.resolve(['旧中文']);
    await vi.advanceTimersByTimeAsync(0);
    // Policy: a slightly stale translation beats an endless spinner.
    expect(latest(harness.states)).toMatchObject({
      original: 'Second',
      translation: '旧中文',
      translating: false,
    });

    await vi.advanceTimersByTimeAsync(200); // politeness gap → request 2
    second.resolve(['新中文']);
    await vi.advanceTimersByTimeAsync(0);
    expect(latest(harness.states)).toMatchObject({
      original: 'Second',
      translation: '新中文',
      translating: false,
    });
  });

  it('clears translating after a current request fails', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async () => {
      throw new Error('offline');
    });
    await harness.controller.attach('https://example.com/video');
    harness.emit({ text: 'Current caption' });
    await vi.advanceTimersByTimeAsync(200);
    expect(latest(harness.states)).toMatchObject({
      original: 'Current caption',
      translation: '',
      translating: false,
    });
  });

  it('ends the pending state when a caption disappears before translation', async () => {
    vi.useFakeTimers();
    const translate = vi.fn(async () => ['不会显示']);
    const harness = liveHarness(translate);
    await harness.controller.attach('https://example.com/video');
    harness.emit({ text: 'Short caption' });
    harness.emit(null);
    await vi.advanceTimersByTimeAsync(200);

    expect(translate).not.toHaveBeenCalled();
    expect(latest(harness.states)).toMatchObject({
      original: 'Short caption',
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
    await Promise.resolve();

    expect(latest(harness.states)).toMatchObject({
      status: 'idle',
      original: '',
      translation: '',
      translating: false,
    });
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

describe('SubtitleController rolling captions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps translations flowing while the caption window rolls', async () => {
    vi.useFakeTimers();
    const harness = liveHarness(async ([text]) => [`译：${text}`]);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'a much speculated about' });
    await vi.advanceTimersByTimeAsync(120);
    expect(latest(harness.states).translation).toBe('译：a much speculated about');

    // Window rolls: leading word drops off. Must be treated as the same
    // sentence — translation stays visible and then refreshes; the panel must
    // never fall back into a permanent "翻译中…" state.
    harness.emit({ text: 'much speculated about project' });
    expect(latest(harness.states)).toMatchObject({
      original: 'much speculated about project',
      translation: '译：a much speculated about',
      translating: false,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(latest(harness.states).translation).toBe('译：much speculated about project');
  });

  it('applies a slightly stale result rather than showing an endless spinner', async () => {
    vi.useFakeTimers();
    const first = deferred<string[]>();
    const translate = vi
      .fn<(texts: string[]) => Promise<string[]>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(['译：当前']);
    const harness = liveHarness(translate);
    await harness.controller.attach('https://example.com/video');

    harness.emit({ text: 'First sentence' });
    await vi.advanceTimersByTimeAsync(200); // request 1 in flight
    harness.emit({ text: 'Unrelated new words' }); // spinner state, queued
    first.resolve(['译：第一句']);
    await vi.advanceTimersByTimeAsync(0);
    // Stale but applied: better than a stuck spinner; next request corrects it.
    expect(latest(harness.states)).toMatchObject({
      translation: '译：第一句',
      translating: false,
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(latest(harness.states).translation).toBe('译：当前');
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
