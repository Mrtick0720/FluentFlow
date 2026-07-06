import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseVtt } from '@/services/subtitle/vtt';
import {
  VideoAdapterRegistry,
  type CaptionState,
  type VideoAdapter,
} from '@/services/video/adapter';
import {
  claimByProximity,
  isNonSpeechCue,
  isRelatedCaption,
  mergeCaptions,
  pickDefaultTrack,
  poolBandSize,
  SubtitleController,
  trackSourceScore,
  type SubtitleViewState,
} from '@/services/video/controller';
import { chooseCaptionText, normalizeCaptionText, YouTubeAdapter } from '@/adapters/youtube';
import { preferEnglishTracks } from '@/adapters/ted';
import type { SubtitleTrack } from '@/types/models';

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
  const setTime = (t: number) => {
    (video as unknown as { currentTime: number }).currentTime = t;
  };
  const tick = (t: number) => {
    setTime(t);
    video.dispatchEvent(new Event('timeupdate'));
  };
  // Simulate a native progress-bar seek: the browser fires `seeking` (optionally
  // repeatedly during a drag) then `seeked` once it settles.
  const emitSeek = (type: 'seeking' | 'seeked', t?: number) => {
    if (t !== undefined) setTime(t);
    video.dispatchEvent(new Event(type));
  };
  const seekNative = (t: number) => {
    emitSeek('seeking', t);
    emitSeek('seeked', t);
  };
  return { controller, video, states, tick, setTime, emitSeek, seekNative };
}

describe('SubtitleController track mode', () => {
  it('holds the previous line through a short gap (< hold threshold)', async () => {
    const segs = [
      { index: 0, start: 0, end: 2, text: 'First sentence' },
      { index: 1, start: 3, end: 5, text: 'Second sentence' }, // 1s gap
    ];
    const h = trackHarness(segs, async ([t]) => [`译：${t}`]);
    await h.controller.attach('https://example.com/video');

    h.tick(1);
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(2.5); // in the 1s gap (< 1.5s hold) → keep the previous line
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(3.2); // second segment active → switch
    expect(latest(h.states).original).toBe('Second sentence');

    h.controller.detach();
  });

  it('clears only once the gap exceeds the hold threshold', async () => {
    const segs = [
      { index: 0, start: 0, end: 2, text: 'First sentence' },
      { index: 1, start: 6, end: 8, text: 'Second sentence' }, // 4s pause
    ];
    const h = trackHarness(segs, async ([t]) => [`译：${t}`]);
    await h.controller.attach('https://example.com/video');

    h.tick(1);
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(3.0); // 1.0s into the gap (< 1.5s hold) → still holding
    expect(latest(h.states).original).toBe('First sentence');

    h.tick(3.6); // 1.6s into the gap (> 1.5s hold) → clear
    expect(latest(h.states).original).toBe('');
    expect(latest(h.states).translation).toBe('');

    h.tick(6.2); // second segment active → switch
    expect(latest(h.states).original).toBe('Second sentence');

    h.controller.detach();
  });

  it('keeps the current line while paused in a gap (learning mode)', async () => {
    const segs = [
      { index: 0, start: 0, end: 2, text: 'First sentence' },
      { index: 1, start: 3, end: 5, text: 'Second sentence' },
    ];
    const h = trackHarness(segs, async ([t]) => [`译：${t}`]);
    await h.controller.attach('https://example.com/video');

    h.tick(1);
    expect(latest(h.states).original).toBe('First sentence');

    (h.video as unknown as { paused: boolean }).paused = true; // studying this line
    h.tick(2.5); // gap, but paused → do not blank the studied line
    expect(latest(h.states).original).toBe('First sentence');

    h.controller.detach();
  });
});

describe('SubtitleController native seek (translation timeline reset)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const URL = 'https://example.com/video';
  // Fresh objects per test: selectTrack keeps the same segment objects and
  // writes translations onto them, so a shared array would leak across tests.
  const makeSegs = () => [
    { index: 0, start: 0, end: 2, text: 'One' },
    { index: 1, start: 2, end: 4, text: 'Two' },
    { index: 2, start: 4, end: 6, text: 'Three' },
    { index: 3, start: 6, end: 8, text: 'Four' },
    { index: 4, start: 8, end: 10, text: 'Five' },
    { index: 5, start: 10, end: 12, text: 'Six' },
  ];
  /** Translate mock that hands back a controllable promise per call. */
  function recorder() {
    const calls: Array<{ texts: string[]; resolve: (v: string[]) => void }> = [];
    const fn = (texts: string[]) =>
      new Promise<string[]>((resolve) => {
        calls.push({ texts, resolve });
      });
    const p0For = (text: string) => calls.find((c) => c.texts.length === 1 && c.texts[0] === text);
    return { fn, calls, p0For };
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it('re-anchors P0 to the new cue after a native seek and renders it', async () => {
    vi.useFakeTimers();
    const { fn, p0For } = recorder();
    const h = trackHarness(makeSegs(), fn);
    await h.controller.attach(URL);
    h.tick(1); // playing seg0
    expect(latest(h.states).original).toBe('One');

    h.seekNative(10.5); // jump to seg5
    await flush();
    const p0 = p0For('Six');
    expect(p0).toBeTruthy(); // current cue dispatched immediately as a single-line P0
    expect(latest(h.states)).toMatchObject({ original: 'Six', translating: true });

    p0!.resolve(['译:Six']);
    await flush();
    expect(latest(h.states)).toMatchObject({ original: 'Six', translation: '译:Six', translating: false });
  });

  it('discards a prefill result that resolves after a native seek', async () => {
    vi.useFakeTimers();
    const { fn, p0For } = recorder();
    const h = trackHarness(makeSegs(), fn);
    await h.controller.attach(URL);
    h.tick(1); // seg0 current, its P0 is in flight (generation G0)
    const stale = p0For('One');
    expect(stale).toBeTruthy();

    h.seekNative(10.5); // reset bumps the generation; re-anchors on seg5
    await flush();
    stale!.resolve(['STALE']); // the pre-seek request finally returns

    await flush();
    // The stale result must not surface — the view stays on seg5.
    expect(latest(h.states).original).toBe('Six');
    expect(latest(h.states).translation).not.toBe('STALE');
  });

  it('issues no translation requests while scrubbing, then a P0 on release', async () => {
    vi.useFakeTimers();
    const { fn, calls, p0For } = recorder();
    const h = trackHarness(makeSegs(), fn);
    await h.controller.attach(URL);
    h.tick(1);
    await flush();
    calls.length = 0; // ignore attach/P0/pool traffic before the drag

    // Drag across intermediate cues: many `seeking` events, no `seeked` yet.
    h.emitSeek('seeking', 3.5); // seg1
    h.tick(3.5);
    h.emitSeek('seeking', 7.5); // seg3
    h.tick(7.5);
    h.emitSeek('seeking', 9.5); // seg4
    h.tick(9.5);
    await flush();
    expect(calls).toEqual([]); // nothing sent during the scrub

    h.emitSeek('seeked', 9.5); // release on seg4
    await flush();
    expect(p0For('Five')).toBeTruthy(); // exactly the released cue is dispatched
    expect(calls.some((c) => c.texts.length === 1 && c.texts[0] === 'Two')).toBe(false); // no intermediate P0
  });

  it('does not reset the pipeline for our own control seeks', async () => {
    vi.useFakeTimers();
    const { fn, p0For } = recorder();
    const h = trackHarness(makeSegs(), fn);
    await h.controller.attach(URL);
    h.tick(1); // seg0 current, P0 in flight
    const p0 = p0For('One');

    // A control seek (repeat) followed by the browser's seeking/seeked for it
    // must NOT be treated as a user timeline reset.
    h.controller.repeat();
    h.emitSeek('seeking');
    h.emitSeek('seeked');

    p0!.resolve(['译:One']); // generation was not bumped → result still applies
    await flush();
    expect(latest(h.states)).toMatchObject({ original: 'One', translation: '译:One', translating: false });
  });

  it('watchdog frees a stuck P0 so the line can be retranslated later', async () => {
    vi.useFakeTimers();
    let hangOne = true;
    const h = trackHarness(makeSegs(), async (texts) => {
      if (texts.length === 1 && texts[0] === 'One' && hangOne) {
        hangOne = false;
        return new Promise<string[]>(() => {}); // first seg0 P0 never settles
      }
      return texts.map((t) => `译:${t}`);
    });
    await h.controller.attach(URL);
    h.tick(1);
    expect(latest(h.states)).toMatchObject({ original: 'One', translating: true });

    await vi.advanceTimersByTimeAsync(8000); // watchdog fires → P0 rejects, latch cleared

    h.seekNative(1); // back on seg0 → P0 re-dispatched, now succeeds
    await vi.advanceTimersByTimeAsync(0);
    expect(latest(h.states)).toMatchObject({ original: 'One', translation: '译:One', translating: false });
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

  it('matches standard and privacy-enhanced YouTube embeds', () => {
    const adapter = new YouTubeAdapter();
    expect(adapter.match('https://www.youtube.com/embed/abc')).toBe(true);
    expect(adapter.match('https://www.youtube-nocookie.com/embed/abc')).toBe(true);
    expect(adapter.match('https://example.com/embed/abc')).toBe(false);
  });
});

describe('preferEnglishTracks', () => {
  it('puts an English-only track first without requiring a translated track', () => {
    const tracks: SubtitleTrack[] = [
      { id: 'en', label: 'English', language: 'en', kind: 'subtitles', segments: [] },
    ];
    expect(preferEnglishTracks(tracks).map((t) => t.id)).toEqual(['en']);
  });

  it('prefers English when several TED tracks are available', () => {
    const tracks: SubtitleTrack[] = [
      { id: 'fr', label: 'Français', language: 'fr', kind: 'subtitles', segments: [] },
      { id: 'en', label: 'English', language: 'en-US', kind: 'subtitles', segments: [] },
    ];
    expect(preferEnglishTracks(tracks).map((t) => t.id)).toEqual(['en', 'fr']);
  });
});

describe('claimByProximity', () => {
  const allFree = () => true;
  const fixed = (n: number) => () => n;
  // Priority bands mirroring the controller: distance 0 → 1, ≤3 → 3, else 10.
  const band = (d: number) => (d === 0 ? 1 : d <= 3 ? 3 : 10);

  it('claims the nearest free lines ahead of the playhead', () => {
    expect(claimByProximity(10, allFree, 4, fixed(6))).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('wraps behind the playhead only when nothing is free ahead', () => {
    const onlyStart = (i: number) => i < 3; // 0,1,2 free
    expect(claimByProximity(10, onlyStart, 4, fixed(6))).toEqual([0, 1, 2]);
  });

  it('sizes the batch by the nearest free line’s distance from the playhead', () => {
    // Current line free → P0 band of 1.
    expect(claimByProximity(100, allFree, 0, band)).toEqual([0]);
    // Current line done → nearest free at distance 1 → band of 3.
    expect(claimByProximity(100, (i) => i !== 0, 0, band)).toEqual([1, 2, 3]);
    // Nearest free far away → background band of 10.
    expect(claimByProximity(100, (i) => i >= 20, 0, band)).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });

  it('skips busy lines while collecting the batch', () => {
    const free = (i: number) => i !== 5 && i !== 6;
    expect(claimByProximity(20, free, 4, fixed(4))).toEqual([4, 7, 8, 9]);
  });

  it('returns nothing when every line is busy', () => {
    expect(claimByProximity(5, () => false, 0, fixed(6))).toEqual([]);
  });

  it('clamps an out-of-range playhead', () => {
    expect(claimByProximity(5, allFree, 99, fixed(3))).toEqual([0, 1, 2]);
    expect(claimByProximity(5, allFree, -3, fixed(3))).toEqual([0, 1, 2]);
  });

  it('produces the 1 → 3 → 3 → 5 → 10 → 20 → 40 preload sequence', () => {
    // P0 (translateNow) owns the current line; the pool claims the rest.
    const done = new Set<number>([0]);
    const sizes: number[] = [];
    for (let claim = 0; claim < 7; claim++) {
      const idxs = claimByProximity(300, (i) => !done.has(i), 0, poolBandSize);
      sizes.push(idxs.length);
      idxs.forEach((i) => done.add(i));
    }
    expect(sizes).toEqual([3, 3, 5, 10, 20, 40, 40]);
  });
});

describe('subtitle track selection', () => {
  const track = (label: string, language: string): SubtitleTrack => ({
    id: label,
    label,
    language,
    kind: 'captions',
    segments: [],
  });

  it('scores real English above auto-generated above auto-translated above non-English', () => {
    expect(trackSourceScore(track('English', 'en'))).toBe(3);
    expect(trackSourceScore(track('English (auto-generated)', 'en'))).toBe(2);
    expect(trackSourceScore(track('English (auto-translated)', 'en'))).toBe(1);
    expect(trackSourceScore(track('English (translated)', 'en'))).toBe(1);
    expect(trackSourceScore(track('中文', 'zh-CN'))).toBe(0);
    expect(trackSourceScore(track('English (United States)', 'en-US'))).toBe(3);
  });

  it('prefers the real English track over auto-generated / auto-translated', () => {
    const tracks = [
      track('English (auto-translated)', 'en'),
      track('English (auto-generated)', 'en'),
      track('English', 'en'),
      track('日本語', 'ja'),
    ];
    expect(pickDefaultTrack(tracks)?.label).toBe('English');
  });

  it('falls back to English auto-generated when no real English track exists', () => {
    const tracks = [track('日本語', 'ja'), track('English (auto-generated)', 'en')];
    expect(pickDefaultTrack(tracks)?.label).toBe('English (auto-generated)');
  });

  it('does not prefer auto-translated English over auto-generated English', () => {
    const tracks = [track('English (auto-translated)', 'en'), track('English (auto-generated)', 'en')];
    expect(pickDefaultTrack(tracks)?.label).toBe('English (auto-generated)');
  });

  it('uses a non-English track only as a last resort, keeping original order', () => {
    const tracks = [track('日本語', 'ja'), track('Deutsch', 'de')];
    expect(pickDefaultTrack(tracks)?.label).toBe('日本語');
  });
});

describe('isNonSpeechCue', () => {
  it('flags whole-line descriptive cues', () => {
    for (const t of ['[music]', '(applause)', '[Singing]', '[speaking Chinese]', '【掌声】', '（音乐）', '♪♪', '  [MUSIC]  ']) {
      expect(isNonSpeechCue(t)).toBe(true);
    }
  });

  it('keeps real speech, including mid-sentence brackets', () => {
    for (const t of ['Hello world', 'I said [wait] to him', 'The (best) idea', 'Music is my life']) {
      expect(isNonSpeechCue(t)).toBe(false);
    }
  });

  it('treats blank text as non-speech', () => {
    expect(isNonSpeechCue('   ')).toBe(true);
  });
});
