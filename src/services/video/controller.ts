import type { SubtitleSegment, SubtitleTrack } from '@/types/models';
import type { CaptionState, VideoAdapter, VideoAdapterRegistry } from './adapter';

export interface SubtitleViewState {
  status: 'idle' | 'no-video' | 'no-subtitles' | 'ready';
  /** 'track': full segment list; 'live': only the caption on screen. */
  mode: 'track' | 'live';
  original: string;
  translation: string;
  index: number;
  total: number;
  abLoop: { a: number; b: number } | null;
  playbackRate: number;
  tracks: Array<{ id: string; label: string; language: string }>;
  activeTrackId?: string;
}

export interface SubtitleControllerDeps {
  translate(texts: string[]): Promise<string[]>;
  onState(state: SubtitleViewState): void;
}

const LIVE_SKIP_SECONDS = 5;

/**
 * Drives subtitle playback features on top of a VideoAdapter: bilingual
 * captions, sentence repeat, A-B loop, prev/next, speed, bookmarking.
 */
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
    index: -1,
    total: 0,
    abLoop: null,
    playbackRate: 1,
    tracks: [],
  };
  private liveTranslateToken = 0;

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
      const initial = this.adapter.getCurrentCaption();
      this.setState({ status: 'ready', mode: 'live', tracks: [] });
      if (initial) void this.onLiveCaption(initial);
    }

    const onRate = () => this.setState({ playbackRate: this.video?.playbackRate ?? 1 });
    this.video.addEventListener('ratechange', onRate);
    this.cleanup.push(() => this.video?.removeEventListener('ratechange', onRate));
    return this.state;
  }

  detach(): void {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
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
    this.syncTrackMode(true);
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
  }

  prev(): void {
    if (this.state.mode === 'track' && this.index > 0) {
      this.adapter?.seek(this.segments[this.index - 1]!.start + 0.01);
    } else if (this.video) {
      this.video.currentTime = Math.max(0, this.video.currentTime - LIVE_SKIP_SECONDS);
    }
  }

  next(): void {
    if (this.state.mode === 'track' && this.index < this.segments.length - 1) {
      this.adapter?.seek(this.segments[this.index + 1]!.start + 0.01);
    } else if (this.video) {
      this.video.currentTime += LIVE_SKIP_SECONDS;
    }
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
    this.index = idx;
    const segment = this.segments[idx];
    if (!segment) {
      this.setState({ original: '', translation: '', index: -1 });
      return;
    }
    this.setState({ original: segment.text, translation: segment.translation ?? '', index: idx });
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
      this.setState({ translation: this.segments[idx]?.translation ?? '' });
    }
  }

  private async onLiveCaption(caption: CaptionState | null): Promise<void> {
    const text = caption?.text ?? '';
    const token = ++this.liveTranslateToken;
    if (!text) {
      this.setState({ original: '', translation: '' });
      return;
    }
    this.setState({ original: text, translation: '…' });
    try {
      const [translation] = await this.deps.translate([text]);
      if (token === this.liveTranslateToken) this.setState({ translation: translation ?? '' });
    } catch {
      if (token === this.liveTranslateToken) this.setState({ translation: '' });
    }
  }
}
