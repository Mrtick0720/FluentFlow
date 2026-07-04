import type { SubtitleSegment, SubtitleTrack } from '@/types/models';
import type { CaptionState, VideoAdapter, VideoAdapterRegistry } from './adapter';

export interface SubtitleViewState {
  status: 'idle' | 'no-video' | 'no-subtitles' | 'ready';
  /** 'track': full segment list; 'live': only the caption on screen. */
  mode: 'track' | 'live';
  original: string;
  translation: string;
  translating: boolean;
  index: number;
  total: number;
  abLoop: { a: number; b: number } | null;
  playbackRate: number;
  tracks: Array<{ id: string; label: string; language: string }>;
  activeTrackId?: string;
  /** Learning mode: pause the video at the end of every sentence. */
  autoPause: boolean;
}

export interface SubtitleControllerDeps {
  translate(texts: string[]): Promise<string[]>;
  onState(state: SubtitleViewState): void;
  /**
   * Full transcript for the lyrics-style list. Track mode: all segments up
   * front. Live mode: grows as captions are seen (no pre-fetching).
   */
  onTranscript?(segments: SubtitleSegment[]): void;
}

const LIVE_SKIP_SECONDS = 5;

/**
 * Drives subtitle playback features on top of a VideoAdapter: bilingual
 * captions, sentence repeat, A-B loop, prev/next, speed, bookmarking.
 */

/**
 * Merge two live-caption snapshots of the same sentence, or return null if
 * they are unrelated. Handles growth ("Hello" → "Hello world") and rolling
 * windows where leading words scroll off ("a much speculated about" →
 * "much speculated about project"): the word-suffix of the older text must
 * match a word-prefix of the newer one (≥2 words).
 */
export function mergeCaptions(prev: string, next: string): string | null {
  if (!prev || !next) return null;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  const a = prev.split(/\s+/).filter(Boolean);
  const b = next.split(/\s+/).filter(Boolean);
  for (let k = Math.min(a.length, b.length); k >= 2; k--) {
    if (
      a.slice(a.length - k).join(' ').toLowerCase() === b.slice(0, k).join(' ').toLowerCase()
    ) {
      return [...a, ...b.slice(k)].join(' ');
    }
  }
  return null;
}

export function isRelatedCaption(prev: string, next: string): boolean {
  return mergeCaptions(prev, next) !== null;
}

export class SubtitleController {
  private adapter: VideoAdapter | null = null;
  private video: HTMLVideoElement | null = null;
  private tracks: SubtitleTrack[] = [];
  private segments: SubtitleSegment[] = [];
  private index = -1;
  private abLoop: { a: number; b: number } | null = null;
  private cleanup: Array<() => void> = [];
  private state: SubtitleViewState = {
    status: 'idle',
    mode: 'track',
    original: '',
    translation: '',
    translating: false,
    index: -1,
    total: 0,
    abLoop: null,
    playbackRate: 1,
    tracks: [],
    autoPause: false,
  };
  private lastLiveText = '';
  private livePending: { text: string; start: number } | null = null;
  private liveInflight = false;
  private liveThrottle: ReturnType<typeof setTimeout> | undefined;
  private liveSeq = 0;
  private liveAppliedSeq = 0;
  private liveHistory: SubtitleSegment[] = [];
  private autoPause = false;

  constructor(
    private registry: VideoAdapterRegistry,
    private deps: SubtitleControllerDeps,
  ) {}

  async attach(url: string): Promise<SubtitleViewState> {
    this.detach();
    this.adapter = this.registry.resolve(url);
    this.video = this.adapter?.getVideo() ?? null;
    if (!this.adapter || !this.video) {
      this.setState({ status: 'no-video' });
      return this.state;
    }

    this.tracks = await this.adapter.getSubtitleTracks();
    const trackInfos = this.tracks.map((t) => ({ id: t.id, label: t.label, language: t.language }));

    if (this.tracks.length > 0) {
      this.selectTrack(this.tracks[0]!.id);
      this.setState({ status: 'ready', mode: 'track', tracks: trackInfos });
      const onTime = () => this.syncTrackMode();
      this.video.addEventListener('timeupdate', onTime);
      this.cleanup.push(() => this.video?.removeEventListener('timeupdate', onTime));
    } else {
      // Live mode: follow whatever caption the page displays.
      const unsubscribe = this.adapter.onCaptionChanged((c) => this.onLiveCaption(c));
      this.cleanup.push(unsubscribe);
      // Our panel mirrors the caption — hide the player's own display.
      if (this.adapter.hideNativeCaptions) this.cleanup.push(this.adapter.hideNativeCaptions());
      const initial = this.adapter.getCurrentCaption();
      this.setState({ status: 'ready', mode: 'live', tracks: [] });
      this.deps.onTranscript?.([]);
      if (initial) this.onLiveCaption(initial);
    }

    const onRate = () => this.setState({ playbackRate: this.video?.playbackRate ?? 1 });
    this.video.addEventListener('ratechange', onRate);
    this.cleanup.push(() => this.video?.removeEventListener('ratechange', onRate));
    return this.state;
  }

  detach(): void {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    clearTimeout(this.liveThrottle);
    this.liveThrottle = undefined;
    this.livePending = null;
    this.lastLiveText = '';
    this.liveHistory = [];
    // Invalidate any in-flight live translation.
    this.liveSeq++;
    this.liveAppliedSeq = this.liveSeq;
    this.adapter = null;
    this.video = null;
    this.tracks = [];
    this.segments = [];
    this.index = -1;
    this.abLoop = null;
    this.setState({
      status: 'idle',
      original: '',
      translation: '',
      translating: false,
      index: -1,
      total: 0,
      abLoop: null,
      tracks: [],
      activeTrackId: undefined,
    });
  }

  selectTrack(trackId: string): void {
    const track = this.tracks.find((t) => t.id === trackId);
    if (!track) return;
    this.segments = [...track.segments].sort((a, b) => a.start - b.start);
    this.index = -1;
    this.setState({ activeTrackId: trackId, total: this.segments.length });
    this.emitTranscript();
    this.syncTrackMode(true);
  }

  setAutoPause(on: boolean): void {
    this.autoPause = on;
    this.setState({ autoPause: on });
  }

  /** Jump to a transcript line (lyrics list click). */
  seekToSegment(index: number): void {
    const source = this.state.mode === 'track' ? this.segments : this.liveHistory;
    const segment = source[index];
    if (!segment) return;
    this.adapter?.seek(segment.start + 0.01);
    this.resumeIfAutoPaused();
  }

  getVideoRect(): DOMRect | null {
    return this.video?.getBoundingClientRect() ?? null;
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.video;
  }

  private emitTranscript(): void {
    const source = this.state.mode === 'live' ? this.liveHistory : this.segments;
    this.deps.onTranscript?.(source.map((s) => ({ ...s })));
  }

  private resumeIfAutoPaused(): void {
    if (this.autoPause && this.video?.paused) void this.video.play().catch(() => {});
  }

  hasSubtitles(): boolean {
    return this.state.mode === 'live' ? this.state.original !== '' : this.segments.length > 0;
  }

  current(): SubtitleSegment | null {
    if (this.state.mode === 'live') {
      return this.state.original
        ? {
            index: -1,
            start: this.video?.currentTime ?? 0,
            end: this.video?.currentTime ?? 0,
            text: this.state.original,
          }
        : null;
    }
    return this.segments[this.index] ?? null;
  }

  currentWithTranslation(): { segment: SubtitleSegment; translation: string } | null {
    const segment = this.current();
    return segment ? { segment, translation: this.state.translation } : null;
  }

  repeat(): void {
    const segment = this.current();
    if (segment && this.state.mode === 'track') this.adapter?.seek(segment.start + 0.01);
    else if (this.video) this.video.currentTime = Math.max(0, this.video.currentTime - LIVE_SKIP_SECONDS);
    this.resumeIfAutoPaused();
  }

  prev(): void {
    if (this.state.mode === 'track' && this.index > 0) {
      this.adapter?.seek(this.segments[this.index - 1]!.start + 0.01);
    } else if (this.video) {
      this.video.currentTime = Math.max(0, this.video.currentTime - LIVE_SKIP_SECONDS);
    }
    this.resumeIfAutoPaused();
  }

  next(): void {
    if (this.state.mode === 'track' && this.index < this.segments.length - 1) {
      this.adapter?.seek(this.segments[this.index + 1]!.start + 0.01);
    } else if (this.video) {
      this.video.currentTime += LIVE_SKIP_SECONDS;
    }
    this.resumeIfAutoPaused();
  }

  /** First call sets A at the current segment/time, second sets B, third clears. */
  toggleABLoop(): void {
    const now = this.video?.currentTime ?? 0;
    const segment = this.current();
    if (!this.abLoop) {
      this.abLoop = { a: segment && this.state.mode === 'track' ? segment.start : now, b: Number.POSITIVE_INFINITY };
    } else if (!Number.isFinite(this.abLoop.b)) {
      const b = segment && this.state.mode === 'track' ? segment.end : now;
      if (b > this.abLoop.a) this.abLoop.b = b;
      else this.abLoop = null;
    } else {
      this.abLoop = null;
    }
    this.setState({ abLoop: this.abLoop && Number.isFinite(this.abLoop.b) ? this.abLoop : this.abLoop ? { a: this.abLoop.a, b: -1 } : null });
  }

  setSpeed(rate: number): void {
    if (this.video) this.video.playbackRate = rate;
  }

  private setState(patch: Partial<SubtitleViewState>): void {
    this.state = { ...this.state, ...patch };
    this.deps.onState(this.state);
  }

  private syncTrackMode(force = false): void {
    if (!this.video || this.segments.length === 0) {
      if (this.segments.length === 0 && this.state.mode === 'track' && this.state.status === 'ready') {
        this.setState({ status: 'no-subtitles' });
      }
      return;
    }
    const t = this.video.currentTime;

    if (this.abLoop && Number.isFinite(this.abLoop.b) && t >= this.abLoop.b) {
      this.adapter?.seek(this.abLoop.a + 0.01);
      return;
    }

    const idx = this.findSegmentIndex(t);
    if (idx === this.index && !force) return;

    // Learning mode: freeze on the sentence that just finished instead of
    // rolling into the next one.
    if (this.autoPause && !force && this.index >= 0 && idx !== this.index && !this.video.paused) {
      const finished = this.segments[this.index]!;
      if (t >= finished.end) {
        this.video.pause();
        this.adapter?.seek(Math.max(finished.start, finished.end - 0.05));
        return;
      }
    }

    this.index = idx;
    const segment = this.segments[idx];
    if (!segment) {
      this.setState({ original: '', translation: '', index: -1 });
      return;
    }
    this.setState({
      original: segment.text,
      translation: segment.translation ?? '',
      translating: segment.translation === undefined,
      index: idx,
    });
    if (segment.translation === undefined) void this.translateSegment(idx);
  }

  private findSegmentIndex(t: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = this.segments[mid]!;
      if (t < s.start) hi = mid - 1;
      else if (t >= s.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /** Translate the active segment plus a small look-ahead window. */
  private async translateSegment(idx: number): Promise<void> {
    const window = this.segments.slice(idx, idx + 3).filter((s) => s.translation === undefined);
    if (window.length === 0) return;
    try {
      const translations = await this.deps.translate(window.map((s) => s.text));
      window.forEach((s, i) => {
        s.translation = translations[i] ?? '';
      });
    } catch {
      window.forEach((s) => {
        if (s.translation === undefined) s.translation = '';
      });
    }
    if (this.index === idx) {
      this.setState({
        translation: this.segments[idx]?.translation ?? '',
        translating: false,
      });
    }
    this.emitTranscript();
  }

  /**
   * Live captions (e.g. YouTube) render word by word, so waiting for the text
   * to "stabilize" stalls forever during continuous speech. Instead run a
   * small pipeline: keep at most one translation request in flight and, when
   * it returns, immediately translate the newest caption. Partial sentences
   * are translated too — the Chinese refines as the English grows, lagging by
   * roughly one request round-trip instead of until the speaker pauses.
   */
  private onLiveCaption(caption: CaptionState | null): void {
    const text = caption?.text ?? '';
    if (text === this.lastLiveText) return;
    const prev = this.lastLiveText;
    this.lastLiveText = text;

    // Gap between cues: keep the last line + translation visible (no flicker);
    // the gap doubles as the sentence boundary in learning mode.
    if (!text) {
      this.livePending = null;
      this.setState({ translating: false });
      if (this.autoPause && prev) this.video?.pause();
      return;
    }

    this.setState(
      isRelatedCaption(prev, text)
        ? { original: text } // same sentence (grown or rolled): keep the partial translation
        : { original: text, translation: '', translating: true },
    );
    this.livePending = { text, start: caption?.start ?? this.video?.currentTime ?? 0 };
    this.schedulePump(this.liveInflight ? 0 : 120);
  }

  /** Coalesce a couple of word-ticks, then run the pipeline if it is idle. */
  private schedulePump(delayMs: number): void {
    if (this.liveInflight || this.liveThrottle !== undefined) return;
    this.liveThrottle = setTimeout(() => {
      this.liveThrottle = undefined;
      void this.pumpLive();
    }, delayMs);
  }

  private async pumpLive(): Promise<void> {
    if (this.liveInflight || !this.livePending) return;
    const { text, start } = this.livePending;
    this.livePending = null;
    this.liveInflight = true;
    const seq = ++this.liveSeq;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // Watchdog: a request that never settles must not stall the pipeline.
      const translation = await Promise.race([
        this.deps.translate([text]).then((r) => r[0] ?? ''),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(() => reject(new Error('live translate timeout')), 8000);
        }),
      ]);
      // Apply unless a newer result already landed or we detached. Showing a
      // ~300ms-stale translation beats an endless "翻译中…" — if the caption
      // already moved to an unrelated sentence AND something is on screen,
      // skip; otherwise apply and let the next request correct it.
      const related = isRelatedCaption(this.lastLiveText, text);
      const nothingShown = this.state.translating || !this.state.translation;
      if (seq > this.liveAppliedSeq && this.lastLiveText !== '' && (related || nothingShown)) {
        this.liveAppliedSeq = seq;
        this.setState({ translation, translating: false });
      }
      if (this.adapter) this.appendLiveHistory(text, translation, start);
    } catch {
      // Drop the spinner so a failing provider degrades to "original only";
      // the next caption tick retries.
      if (seq > this.liveAppliedSeq) {
        this.setState({ translating: false });
      }
    } finally {
      clearTimeout(watchdog);
      this.liveInflight = false;
      // Politeness gap between successive requests while speech continues.
      if (this.livePending) this.schedulePump(200);
    }
  }

  /**
   * Grow the live transcript. Captions render progressively, so if the new
   * stable text extends the previous entry, replace it instead of appending.
   */
  private appendLiveHistory(text: string, translation: string, start: number): void {
    const last = this.liveHistory[this.liveHistory.length - 1];
    const merged = last ? mergeCaptions(last.text, text) : null;
    if (last && merged !== null) {
      last.text = merged;
      last.translation = translation;
    } else if (!last || last.text !== text) {
      this.liveHistory.push({
        index: this.liveHistory.length,
        start,
        end: start,
        text,
        translation,
      });
      if (this.liveHistory.length > 500) this.liveHistory.shift();
    }
    this.emitTranscript();
  }
}
