import type { SubtitleSegment, SubtitleTrack } from '@/types/models';
import type { SmartSentence } from '@/services/subtitle/smart';
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

/** Live pre-fill + sync snapshot for the dev debug panel (lf-subtitle-debug=1). */
export interface SubtitleDebugInfo {
  trackLabel: string;
  trackLanguage: string;
  /** manual | auto-generated | translated | non-English */
  trackKind: string;
  index: number;
  currentTime: number;
  segStart: number | null;
  segEnd: number | null;
  inRange: boolean;
  translated: number;
  failed: number;
  total: number;
  inFlight: number;
  workers: number;
  retries: number;
  prebuffer: number;
}

export interface SubtitleControllerDeps {
  translate(texts: string[]): Promise<string[]>;
  onState(state: SubtitleViewState): void;
  /** Dev-only live stats, pushed only while lf-subtitle-debug=1. */
  onDebug?(info: SubtitleDebugInfo): void;
  /**
   * Full transcript for the lyrics-style list. Track mode: all segments up
   * front. Live mode: grows as captions are seen (no pre-fetching).
   */
  onTranscript?(segments: SubtitleSegment[]): void;
  /**
   * Group raw ASR caption fragments into complete sentences and translate them
   * (LLM providers only). Returns null when unavailable — the controller then
   * keeps the raw cues.
   */
  smartTranslate?(texts: string[]): Promise<SmartSentence[] | null>;
}

const LIVE_SKIP_SECONDS = 5;
/** Show a track-mode line slightly early to offset render/paint latency. */
const SUBTITLE_LEAD_SECONDS = 0.15;
/**
 * Short-gap hold policy (rendering only): during a gap between segments, keep
 * the previous subtitle on screen until the gap exceeds this. Short natural
 * pauses hold the line (and switch the instant the next segment becomes active),
 * matching YouTube; only a real pause longer than this — or the end of the
 * track — blanks the overlay.
 */
const SUBTITLE_HOLD_SECONDS = 1.5;

// ─────────────────────────────────────────────────────────────────────────────
// Whole-video subtitle pre-fill tuning. Subtitles stay on the configured
// translation provider (the LLM); these knobs control how aggressively the
// worker pool translates ahead of the playhead. Adjust here.
// ─────────────────────────────────────────────────────────────────────────────
/** Subtitle lines sent per LLM request. */
const FILL_CHUNK = 40;
/**
 * Near-playhead translation is a priority scheduler, not fixed batches. The
 * current line (P0) is dispatched on its OWN the instant playback reaches an
 * untranslated line (`translateNow`). The worker pool then claims by PROXIMITY
 * to the live playhead, the batch size growing with distance. With the current
 * line taken by P0, successive claims from the playhead yield sizes
 * 3, 3, 5, 10, 20, 40, 40… — so the full preload sequence is
 *   1 → 3 → 3 → 5 → 10 → 20 → 40 → 40 → …
 * Bands (distance from the playhead → batch size):
 *   1‑6   → 3    (the next two claims are 3 + 3)
 *   7‑11  → 5
 *   12‑21 → 10
 *   22‑41 → 20
 *   42+   → 40   (background fill)
 * Because size grows with distance, a 40-line batch can never claim a
 * near-playhead line, and every claim re-anchors to the current playhead — so
 * background work always yields to the current position.
 */
const POOL_BANDS: ReadonlyArray<readonly [maxDistance: number, size: number]> = [
  [6, 3],
  [11, 5],
  [21, 10],
  [41, 20],
];
export function poolBandSize(distance: number): number {
  for (const [maxDistance, size] of POOL_BANDS) if (distance <= maxDistance) return size;
  return FILL_CHUNK;
}
/** Parallel pre-fill requests (worker-pool size). */
const FILL_CONCURRENCY = 3;
/** Upcoming lines kept in flight ahead of the playhead (≈ prebuffer window). */
const FILL_PREBUFFER_AHEAD = FILL_CHUNK * FILL_CONCURRENCY; // 120 lines
/** Per-line attempts before giving up (the line stays original-only). */
const FILL_MAX_ATTEMPTS = 3;
/** Backoff after a failed chunk before the worker retries. */
const FILL_RETRY_BACKOFF_MS = 500;
/**
 * Watchdog for the P0 single-line request. A subtitle translation that never
 * settles must not latch its line in `urgentInFlight` forever (that would block
 * every retry and leave the overlay stuck on "翻译中…"). Mirrors the live-caption
 * pump's timeout.
 */
const SUBTITLE_TRANSLATE_TIMEOUT_MS = 8000;

/**
 * Subtitle pre-fill debug logging, toggled at runtime (no rebuild): run
 *   localStorage.setItem('lf-subtitle-debug', '1')
 * on the video page (then '0' or remove to stop). Reads fresh each call, so it
 * takes effect immediately without reloading the extension.
 */
function subtitleDebugEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('lf-subtitle-debug') === '1';
  } catch {
    return false;
  }
}

/**
 * Priority claim: find the nearest FREE line to the playhead (ahead first, then
 * wrapping behind), then take a run of free lines whose length is `bandSize` of
 * that line's distance from the playhead — small near the head, large far away.
 * Re-anchoring to the playhead on every call is what makes background work yield
 * to the current position. Pure, for testing.
 */
export function claimByProximity(
  total: number,
  isFree: (i: number) => boolean,
  playhead: number,
  bandSize: (distance: number) => number,
): number[] {
  const head = Math.max(0, Math.min(playhead, total));
  let nearest = -1;
  for (let i = head; i < total; i++)
    if (isFree(i)) {
      nearest = i;
      break;
    }
  if (nearest === -1)
    for (let i = 0; i < head; i++)
      if (isFree(i)) {
        nearest = i;
        break;
      }
  if (nearest === -1) return [];
  // A line behind the playhead is lowest priority → background band.
  const distance = nearest >= head ? nearest - head : Number.MAX_SAFE_INTEGER;
  const size = bandSize(distance);
  const out: number[] = [];
  for (let i = nearest; i < total && out.length < size; i++) if (isFree(i)) out.push(i);
  return out;
}

const IS_ENGLISH = /^en(-|_|$)/i;
/** Label markers for a machine-translated track (English produced from another
 * language, or "auto-translated" in the player). Checked before auto-generated. */
const AUTO_TRANSLATED = /translat|翻译|翻訳|번역/i;
/** Label markers for an auto-generated (ASR) track. */
const AUTO_GENERATED = /auto-?generat|automatic|speech|自动生成|자동/i;

/**
 * Rank a subtitle track as a default translation source. Higher is better:
 *   3 real English subtitle track
 *   2 English auto-generated (ASR)
 *   1 English auto-translated / translated-to-English
 *   0 not English (only used if nothing English exists)
 * Type is read from the label, since the track model only carries label/language.
 */
export function trackSourceScore(track: SubtitleTrack): number {
  if (!IS_ENGLISH.test(track.language)) return 0;
  const label = track.label ?? '';
  if (AUTO_TRANSLATED.test(label)) return 1;
  if (AUTO_GENERATED.test(label)) return 2;
  return 3;
}

/** Human-readable track kind from its source score. */
export function trackKindLabel(score: number): string {
  return score === 3
    ? 'manual'
    : score === 2
      ? 'auto-generated'
      : score === 1
        ? 'translated'
        : 'non-English';
}

/**
 * Choose the default track: a real English subtitle track wins over an English
 * auto-generated one, which wins over an auto-translated English one. Non-English
 * tracks are picked only as a last resort (no English present); the user can
 * still switch tracks manually. Ties keep the adapter's original order.
 */
export function pickDefaultTrack(tracks: SubtitleTrack[]): SubtitleTrack | undefined {
  let best: SubtitleTrack | undefined;
  let bestScore = -1;
  for (const track of tracks) {
    const score = trackSourceScore(track);
    if (score > bestScore) {
      best = track;
      bestScore = score;
    }
  }
  return best;
}

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

/** Drop CC speaker-change markers ('>>', leading dashes) from a caption. */
export function stripSpeakerMarkers(text: string): string {
  return text.replace(/^\s*(?:>{1,2}|[-–—]{1,2})\s*/, '').trim();
}

/**
 * Is this caption a non-speech descriptive cue rather than spoken words? These
 * are whole-line annotations like [music], (applause), [singing], [speaking
 * Chinese], 【掌声】, or bare musical notes — we never display or translate them.
 * Only lines that are ENTIRELY such a cue are filtered (mid-sentence brackets
 * are left alone).
 */
export function isNonSpeechCue(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Fully wrapped in brackets/parens (ASCII or full-width), no inner brackets.
  if (/^[[(（【][^[\]()（）【】]*[\])）】]$/.test(t)) return true;
  // Only musical notes / symbols (no letters or CJK).
  if (/^[\s♪♫♬♩𝄞🎵🎶]+$/u.test(t)) return true;
  return false;
}

const CLAUSE_CONJUNCTION =
  /\s+(and|but|so|or|because|which|that|when|while|then|where|although)\s+/gi;

const MIN_SPLIT_CHARS = 24;

/**
 * Where to break a live-caption buffer into a displayable line. The goal is
 * one screen line per language, so chunks are kept short: clause boundaries
 * are only considered inside the [MIN_SPLIT_CHARS, hardChars] window and the
 * hard cap always splits at a word boundary. Returns null while the buffer
 * should keep growing.
 */
export function findLiveSplit(
  text: string,
  softChars: number,
  hardChars: number,
): { completed: string; rest: string } | null {
  // 0) Speaker change ('>>' in CC streams) is always a boundary; the marker
  //    itself is noise and is dropped.
  const speaker = text.match(/^(.{2,}?)\s*>{1,2}\s*(\S[\s\S]*)$/);
  if (speaker) return { completed: speaker[1]!.trim(), rest: speaker[2]!.trim() };

  // 1) Finished sentence(s): break after the last terminator.
  const sentence = text.match(/^([\s\S]*[.!?…]["')\]]?)\s+(\S[\s\S]*)$/);
  if (sentence) return { completed: sentence[1]!.trim(), rest: sentence[2]!.trim() };
  if (text.length <= softChars) return null;

  // 2) Clause boundary: the latest comma/semicolon/colon or conjunction that
  //    still keeps the chunk within the hard cap.
  let cut = -1;
  for (const m of text.matchAll(/[,;:，；：]\s+/g)) {
    const end = m.index! + 1; // include the punctuation mark
    if (end >= MIN_SPLIT_CHARS && end <= hardChars) cut = Math.max(cut, end);
  }
  if (cut === -1) {
    for (const m of text.matchAll(CLAUSE_CONJUNCTION)) {
      if (m.index !== undefined && m.index >= MIN_SPLIT_CHARS && m.index <= hardChars) {
        cut = Math.max(cut, m.index);
      }
    }
  }
  if (cut !== -1 && text.length - cut >= 8) {
    return { completed: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
  }

  // 3) Hard cap: last word boundary before the limit.
  if (text.length > hardChars) {
    const space = text.lastIndexOf(' ', hardChars);
    if (space > MIN_SPLIT_CHARS) {
      return { completed: text.slice(0, space).trim(), rest: text.slice(space + 1).trim() };
    }
    return { completed: text.trim(), rest: '' };
  }
  return null;
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
  /** Sentence being spoken right now: buffered silently, translated ahead. */
  private liveSentence: {
    text: string;
    start: number;
    translation: string;
    translatedText: string;
  } | null = null;
  private livePending: { text: string; start: number } | null = null;
  private liveInflight = false;
  private liveThrottle: ReturnType<typeof setTimeout> | undefined;
  private liveSeq = 0;
  private liveAppliedSeq = 0;
  private liveIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private liveHistory: SubtitleSegment[] = [];
  private autoPause = false;
  // Whole-video pre-fill worker pool: lines currently being translated (dedups
  // background + on-demand), per-line failure counts, and the generation the
  // running pool belongs to (-1 = idle).
  private inFlight = new Set<number>();
  /** Lines the urgent path owns — the pool never claims these. Separate from
   * `inFlight` so urgent can fast-track the current line without the pool's
   * claims making it drift forward. */
  private urgentInFlight = new Set<number>();
  private fillAttempts = new Map<number, number>();
  private fillingGeneration = -1;
  /** Workers with a request currently in flight (for debug logging). */
  private activeWorkers = 0;
  private lastDebugPush = 0;
  private lastGapLog = 0;
  /** True from a native `seeking` until the matching `seeked`: suppress P0 for
   * intermediate scrub positions so a drag issues no translation traffic. */
  private seeking = false;
  /** Timestamp of the last seek WE initiated (repeat/prev/next/AB-loop/
   * auto-pause/transcript click). Native seek events within
   * INTERNAL_SEEK_WINDOW_MS of this are treated as ours, not a user scrub. */
  private lastInternalSeekAt = 0;
  private static readonly INTERNAL_SEEK_WINDOW_MS = 600;

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

    // Our panel replaces the player's caption display in both modes.
    if (this.adapter.hideNativeCaptions) this.cleanup.push(this.adapter.hideNativeCaptions());

    if (this.tracks.length > 0) {
      // Prefer a real English track over auto-generated / auto-translated ones.
      const picked = pickDefaultTrack(this.tracks) ?? this.tracks[0]!;
      this.logTrackSelection(picked);
      this.selectTrack(picked.id);
      this.setState({ status: 'ready', mode: 'track', tracks: trackInfos });
      const onTime = () => this.syncTrackMode();
      this.video.addEventListener('timeupdate', onTime);
      this.cleanup.push(() => this.video?.removeEventListener('timeupdate', onTime));
      // `timeupdate` only fires ~4x/sec, so subtitles can lag the audio by up
      // to ~250ms. Additionally poll via requestAnimationFrame so the line
      // switches within a frame of the word's timestamp.
      if (typeof requestAnimationFrame === 'function') {
        let rafId = 0;
        const tick = () => {
          this.syncTrackMode();
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        this.cleanup.push(() => cancelAnimationFrame(rafId));
      }
    } else {
      // Live mode: follow whatever caption the page displays.
      const unsubscribe = this.adapter.onCaptionChanged((c) => this.onLiveCaption(c));
      this.cleanup.push(unsubscribe);
      const initial = this.adapter.getCurrentCaption();
      this.setState({ status: 'ready', mode: 'live', tracks: [] });
      this.deps.onTranscript?.([]);
      if (initial) this.onLiveCaption(initial);
    }

    const onRate = () => this.setState({ playbackRate: this.video?.playbackRate ?? 1 });
    this.video.addEventListener('ratechange', onRate);
    this.cleanup.push(() => this.video?.removeEventListener('ratechange', onRate));

    // Native seeks (progress-bar drag/click) are a translation-timeline reset:
    // invalidate old prefill on `seeking`, re-anchor at the new position on
    // `seeked`. Our own control seeks are excluded via `lastInternalSeekAt`.
    const onSeeking = () => this.onSeeking();
    const onSeeked = () => this.onSeeked();
    this.video.addEventListener('seeking', onSeeking);
    this.video.addEventListener('seeked', onSeeked);
    this.cleanup.push(() => {
      this.video?.removeEventListener('seeking', onSeeking);
      this.video?.removeEventListener('seeked', onSeeked);
    });
    return this.state;
  }

  detach(): void {
    this.cleanup.forEach((fn) => fn());
    this.cleanup = [];
    clearTimeout(this.liveThrottle);
    this.liveThrottle = undefined;
    clearTimeout(this.liveIdleTimer);
    this.liveIdleTimer = undefined;
    this.livePending = null;
    this.liveSentence = null;
    this.lastLiveText = '';
    this.liveHistory = [];
    this.translateGeneration++; // stop pre-fill workers
    this.inFlight.clear();
    this.urgentInFlight.clear();
    this.fillAttempts.clear();
    // Invalidate any in-flight live translation.
    this.liveSeq++;
    this.liveAppliedSeq = this.liveSeq;
    this.seeking = false;
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
    // Drop non-speech cues ([music], [speaking Chinese], ♪…) so they're never
    // shown or translated; their time ranges become gaps (overlay clears).
    const grouped = [...track.segments].sort((a, b) => a.start - b.start);
    this.segments = grouped.filter((s) => !isNonSpeechCue(s.text));
    if (subtitleDebugEnabled()) {
      const fmt = (segs: SubtitleSegment[]) =>
        segs
          .slice(0, 10)
          .map((s, i) => `  #${i} [${s.start.toFixed(2)}‥${s.end.toFixed(2)}] "${s.text.slice(0, 40)}"`)
          .join('\n');
      const removedCount = grouped.length - this.segments.length;
      console.log('[Timeline final] first 10 this.segments (overlay uses these):\n' + fmt(this.segments));
      // Show the gaps between the first segments — a gap is where findSegmentIndex()=-1.
      const gaps = this.segments
        .slice(0, 10)
        .map((s, i) =>
          i === 0 ? `#0 starts ${s.start.toFixed(2)}` : `gap[${i - 1}→${i}]=${(s.start - this.segments[i - 1]!.end).toFixed(2)}s`,
        )
        .join(' · ');
      console.log(`[Timeline gaps] ${gaps}`);
      console.log(`[Timeline filter] removed ${removedCount} non-speech cue(s)`);
    }
    this.index = -1;
    this.setState({ activeTrackId: trackId, total: this.segments.length });
    this.emitTranscript();
    this.logGapStats();
    this.resetFill();
    this.syncTrackMode(true); // sets the current index (fires the urgent batch)
    this.kickFill();
    // NOTE: AI re-segmentation (smartResegmentInBackground) is disabled — on
    // messy ASR (fillers, stutters, no punctuation) the alignment was
    // unreliable and could merge a whole chunk into one giant block. The raw
    // per-cue path below stays the stable default.
  }

  /**
   * Whole-video pre-fill. A pool of FILL_CONCURRENCY workers translates the
   * transcript in FILL_CHUNK batches, always claiming the untranslated lines
   * nearest ahead of the playhead first (prebuffering upcoming subtitles) and
   * wrapping to the start. The shared `inFlight` set dedups work between the
   * pool and the on-demand path; failed chunks are retried with backoff and
   * only given up (original-only) after FILL_MAX_ATTEMPTS. Cancelled by detach
   * or a track switch via `translateGeneration`.
   */
  private translateGeneration = 0;

  private resetFill(): void {
    this.translateGeneration++; // cancel any running workers
    this.inFlight.clear();
    this.urgentInFlight.clear();
    this.fillAttempts.clear();
  }

  /**
   * Seek initiated by our own controls (repeat/prev/next/AB-loop/auto-pause/
   * transcript click). Timestamped so the native seek handlers can tell these
   * apart from a user dragging the scrub bar and skip the timeline reset.
   */
  private seekTo(seconds: number): void {
    this.lastInternalSeekAt = Date.now();
    this.adapter?.seek(seconds);
  }

  private isInternalSeek(): boolean {
    return Date.now() - this.lastInternalSeekAt < SubtitleController.INTERNAL_SEEK_WINDOW_MS;
  }

  /**
   * User began seeking the native progress bar. Treat it as a translation
   * timeline reset: `resetFill` bumps the generation (so every in-flight prefill/
   * P0 result is discarded on return) and clears the urgent/in-flight sets.
   * Deduped so a drag firing many `seeking` events resets only once; P0 stays
   * suppressed (see syncTrackMode) until `seeked`, so intermediate scrub
   * positions issue no requests.
   */
  private onSeeking(): void {
    if (this.state.mode !== 'track' || this.segments.length === 0) return;
    if (this.isInternalSeek() || this.seeking) return;
    this.seeking = true;
    if (subtitleDebugEnabled()) console.log('[Seek] native seek START → reset prefill');
    this.resetFill();
  }

  /**
   * Seek settled at the new position. Re-anchor the pipeline here: force
   * syncTrackMode to re-evaluate the current cue (now that `seeking` is false it
   * dispatches that cue's P0) and restart the prefill pool from the new playhead.
   */
  private onSeeked(): void {
    if (this.isInternalSeek()) return; // our own corrective seek — not a reset
    if (this.state.mode !== 'track' || this.segments.length === 0) return;
    if (!this.seeking) this.resetFill(); // a `seeked` with no captured `seeking`
    this.seeking = false;
    if (subtitleDebugEnabled()) console.log('[Seek] native seek END → re-anchor at new position');
    this.index = -1; // force re-evaluation against the new time
    this.syncTrackMode(true); // re-anchor + dispatch P0 for the current cue
    this.kickFill(); // restart the pool anchored at the new index
  }

  /**
   * P0 — the current line, dispatched on its OWN the instant playback reaches an
   * untranslated line, so the visible subtitle renders as fast as possible.
   * A lone 1-line request; the pool (P1–P4) fills everything else by proximity.
   * Claims into `urgentInFlight` (the pool skips it); cancelled by a video/track
   * change via `translateGeneration`. Best-effort.
   */
  private async translateNow(index: number): Promise<void> {
    const i = Math.max(0, index);
    if (i >= this.segments.length) return;
    const seg = this.segments[i]!;
    if (seg.translation !== undefined || this.urgentInFlight.has(i)) return; // done or already dispatched
    const gen = this.translateGeneration;
    this.urgentInFlight.add(i);
    const dbg = subtitleDebugEnabled();
    const t0 = Date.now();
    if (dbg) console.log(`[P0] current line ${i} START "${seg.text.slice(0, 32)}"`);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // Watchdog: a request that never settles must not latch this line in
      // urgentInFlight — the guard above would then block every retry forever.
      const out = await Promise.race([
        this.deps.translate([seg.text]),
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () => reject(new Error('subtitle translate timeout')),
            SUBTITLE_TRANSLATE_TIMEOUT_MS,
          );
        }),
      ]);
      if (gen !== this.translateGeneration) {
        if (dbg) console.log(`[P0] line ${i} DISCARDED after ${Date.now() - t0}ms (video/track changed)`);
        return;
      }
      seg.translation = out[0] ?? '';
      if (dbg) console.log(`[P0] line ${i} DONE in ${Date.now() - t0}ms`);
      this.emitTranscript();
      this.refreshCurrentTranslation(); // render immediately
    } catch (err) {
      if (dbg) console.log(`[P0] line ${i} FAILED after ${Date.now() - t0}ms —`, err instanceof Error ? err.message : err);
    } finally {
      clearTimeout(watchdog);
      this.urgentInFlight.delete(i);
    }
  }

  /** Ensure a pre-fill worker pool is running for the current generation. */
  private kickFill(): void {
    if (this.fillingGeneration === this.translateGeneration) return;
    void this.runBackgroundFill();
  }

  private async runBackgroundFill(): Promise<void> {
    const generation = this.translateGeneration;
    this.fillingGeneration = generation;
    this.debugFill('pre-fill start');
    try {
      await Promise.all(Array.from({ length: FILL_CONCURRENCY }, () => this.fillWorker(generation)));
    } finally {
      if (this.fillingGeneration === generation) this.fillingGeneration = -1;
      if (generation === this.translateGeneration) this.debugFill('pre-fill idle');
    }
  }

  private async fillWorker(generation: number): Promise<void> {
    while (generation === this.translateGeneration) {
      // Claim by proximity to the live playhead: nearest free lines first, with
      // the batch size growing with distance (small/fast near the head, large
      // far away). Re-anchoring here on every claim is what makes the pool yield
      // to the current position when playback moves. Skips the P0 line (urgent).
      const idxs = claimByProximity(
        this.segments.length,
        (i) =>
          this.segments[i]!.translation === undefined &&
          !this.inFlight.has(i) &&
          !this.urgentInFlight.has(i),
        Math.max(0, this.index),
        poolBandSize,
      );
      if (idxs.length === 0) return; // whole track translated (or in flight)
      idxs.forEach((i) => this.inFlight.add(i));
      this.activeWorkers++;
      try {
        const translations = await this.deps.translate(idxs.map((i) => this.segments[i]!.text));
        if (generation !== this.translateGeneration) return;
        if (subtitleDebugEnabled()) {
          const o = this.segments[idxs[0]!]!.text.slice(0, 36);
          const t = (translations[0] ?? '∅').slice(0, 36);
          console.log(`[Fill] provider returned ${translations.length}/${idxs.length} · sample: "${o}" → "${t}"`);
        }
        idxs.forEach((i, j) => {
          this.segments[i]!.translation = translations[j] ?? '';
        });
        this.emitTranscript();
        this.refreshCurrentTranslation();
        this.debugFill(`batch ok [${idxs[0]}‥${idxs[idxs.length - 1]}]`);
      } catch {
        if (generation !== this.translateGeneration) return;
        // Count the attempt and give up after a few tries so a persistently
        // failing line can't wedge the pool; a later pass retries the rest.
        let gaveUp = 0;
        for (const i of idxs) {
          const n = (this.fillAttempts.get(i) ?? 0) + 1;
          this.fillAttempts.set(i, n);
          if (n >= FILL_MAX_ATTEMPTS) {
            this.segments[i]!.translation = '';
            gaveUp++;
          }
        }
        this.debugFill(`batch FAILED [${idxs[0]}‥${idxs[idxs.length - 1]}] gaveUp ${gaveUp}`);
        await new Promise((resolve) => setTimeout(resolve, FILL_RETRY_BACKOFF_MS));
      } finally {
        this.activeWorkers--;
        idxs.forEach((i) => this.inFlight.delete(i));
      }
    }
  }

  /** Snapshot the pre-fill pool state to the console when debug is enabled. */
  private debugFill(event: string): void {
    if (!subtitleDebugEnabled()) return;
    let translated = 0;
    let failed = 0;
    for (const s of this.segments) {
      if (s.translation === undefined) continue;
      if (s.translation === '') failed++;
      else translated++;
    }
    let retries = 0;
    for (const n of this.fillAttempts.values()) retries += n;
    console.log(
      `[LinguaFlow subtitle] ${event} — translated ${translated}/${this.segments.length}` +
        ` · failed ${failed} · inFlight ${this.inFlight.size} · playhead ${this.index}` +
        ` · workers ${this.activeWorkers}/${FILL_CONCURRENCY} · aheadTarget ${FILL_PREBUFFER_AHEAD}` +
        ` · retries ${retries}`,
    );
    this.pushDebug();
  }

  /** Dump the finalized grouped timeline the overlay uses — per-sentence start,
   * end, gap-to-previous, text — plus a gap summary (dev flag only). This is
   * `this.segments` after grouping AND non-speech-cue filtering, so any gap here
   * is exactly what the overlay sees. */
  private logGapStats(): void {
    if (!subtitleDebugEnabled() || this.segments.length === 0) return;
    const rows = this.segments.map((s, i) => ({
      i,
      start: +s.start.toFixed(2),
      end: +s.end.toFixed(2),
      dur: +(s.end - s.start).toFixed(2),
      gapToPrev: i === 0 ? 0 : +(s.start - this.segments[i - 1]!.end).toFixed(2),
      text: s.text.length > 70 ? s.text.slice(0, 70) + '…' : s.text,
    }));
    console.log(`[Subtitle Timeline] ${this.segments.length} sentences (used by the overlay):`, rows);

    const gaps = rows.slice(1).map((r) => r.gapToPrev).sort((a, b) => a - b);
    const pct = (p: number) => gaps[Math.floor(gaps.length * p)] ?? 0;
    const over = (x: number) => gaps.filter((g) => g > x).length;
    console.log(
      `[Subtitle Gaps] median ${pct(0.5).toFixed(2)}s · p90 ${pct(0.9).toFixed(2)}s` +
        ` · max ${(gaps[gaps.length - 1] ?? 0).toFixed(2)}s` +
        ` · gaps >hold(${SUBTITLE_HOLD_SECONDS}s): ${over(SUBTITLE_HOLD_SECONDS)}` +
        ` (shorter gaps hold the previous line)`,
    );
  }

  /** Log the chosen default track and why (dev flag only). */
  private logTrackSelection(picked: SubtitleTrack): void {
    if (!subtitleDebugEnabled()) return;
    const kind = trackKindLabel(trackSourceScore(picked));
    const hasRealEnglish = this.tracks.some((t) => trackSourceScore(t) === 3);
    const reason =
      kind === 'manual'
        ? 'real English subtitle track (top priority)'
        : kind === 'auto-generated'
          ? 'no real English track; using English auto-generated'
          : kind === 'translated'
            ? 'only auto-translated English available'
            : hasRealEnglish
              ? 'unexpected: real English exists but was not chosen'
              : 'no English track available; using first track';
    console.log(
      `[Subtitle Track] selected "${picked.label}" · lang ${picked.language} · kind ${kind}` +
        ` · reason: ${reason} · ${this.tracks.length} tracks` +
        ` [${this.tracks.map((t) => `${t.label}(${t.language})`).join(', ')}]`,
    );
  }

  /** Snapshot for the dev debug panel. */
  private debugSnapshot(): SubtitleDebugInfo {
    const seg = this.segments[this.index];
    const now = this.video?.currentTime ?? 0;
    let translated = 0;
    let failed = 0;
    for (const s of this.segments) {
      if (s.translation === undefined) continue;
      if (s.translation === '') failed++;
      else translated++;
    }
    let retries = 0;
    for (const n of this.fillAttempts.values()) retries += n;
    const track = this.tracks.find((t) => t.id === this.state.activeTrackId);
    return {
      trackLabel: track?.label ?? '',
      trackLanguage: track?.language ?? '',
      trackKind: track ? trackKindLabel(trackSourceScore(track)) : '',
      index: this.index,
      currentTime: now,
      segStart: seg?.start ?? null,
      segEnd: seg?.end ?? null,
      inRange: seg ? now >= seg.start && now < seg.end : false,
      translated,
      failed,
      total: this.segments.length,
      inFlight: this.inFlight.size,
      workers: this.activeWorkers,
      retries,
      prebuffer: FILL_PREBUFFER_AHEAD,
    };
  }

  private pushDebug(): void {
    if (!this.deps.onDebug || !subtitleDebugEnabled()) return;
    this.deps.onDebug(this.debugSnapshot());
  }

  /** Throttled push so the panel's playback time stays live without flooding. */
  private maybePushDebug(): void {
    if (!this.deps.onDebug || !subtitleDebugEnabled()) return;
    const now = Date.now();
    if (now - this.lastDebugPush < 250) return;
    this.lastDebugPush = now;
    this.deps.onDebug(this.debugSnapshot());
  }

  /** Push the freshly-filled translation to the overlay if it's the live line. */
  private refreshCurrentTranslation(): void {
    const current = this.segments[this.index];
    const willUpdate =
      !!current &&
      current.translation !== undefined &&
      this.state.index === this.index &&
      (this.state.translating || this.state.translation !== current.translation);
    if (subtitleDebugEnabled()) {
      const clip = (s: string | undefined) => (s === undefined ? '∅(undefined)' : `"${s.slice(0, 40)}"`);
      console.log(
        `[Refresh] index=${this.index} · stateIndex=${this.state.index}` +
          ` · pushToOverlay=${willUpdate} · translating=${this.state.translating}` +
          `\n         orig=${clip(current?.text)}` +
          `\n         segTranslation=${clip(current?.translation)}` +
          `\n         stateTranslation=${clip(this.state.translation)}` +
          `\n         segTranslation===orig? ${current?.translation === current?.text}`,
      );
    }
    if (willUpdate) {
      this.setState({ translation: current!.translation, translating: false });
    }
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
    this.seekTo(segment.start + 0.01);
    this.resumeIfAutoPaused();
    // Reprioritize around the seek target immediately: dispatch P0 for the
    // target line (this.index catches up via syncTrackMode after the seek), and
    // let the pool re-anchor on its next claim. Keep the pool running.
    if (this.state.mode === 'track') {
      void this.translateNow(index);
      this.kickFill();
    }
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
    if (segment && this.state.mode === 'track') this.seekTo(segment.start + 0.01);
    else if (this.video) this.video.currentTime = Math.max(0, this.video.currentTime - LIVE_SKIP_SECONDS);
    this.resumeIfAutoPaused();
  }

  prev(): void {
    if (this.state.mode === 'track' && this.index > 0) {
      this.seekTo(this.segments[this.index - 1]!.start + 0.01);
    } else if (this.video) {
      this.video.currentTime = Math.max(0, this.video.currentTime - LIVE_SKIP_SECONDS);
    }
    this.resumeIfAutoPaused();
  }

  next(): void {
    if (this.state.mode === 'track' && this.index < this.segments.length - 1) {
      this.seekTo(this.segments[this.index + 1]!.start + 0.01);
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
    // Small lead so the line switches a touch before the word, cancelling
    // React render + paint latency (feels in sync rather than a beat late).
    const t = this.video.currentTime + SUBTITLE_LEAD_SECONDS;
    this.maybePushDebug(); // keep the dev panel's clock live (throttled, dev only)

    if (this.abLoop && Number.isFinite(this.abLoop.b) && t >= this.abLoop.b) {
      this.seekTo(this.abLoop.a + 0.01);
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
        this.seekTo(Math.max(finished.start, finished.end - 0.05));
        return;
      }
    }

    // No active segment at the current time (gap between sentences, before the
    // first, or after the last). Clear the overlay so no stale line lingers —
    // but only on a genuine pause. Keep the line when:
    //  • paused (learning mode studies the current line),
    //  • within the brief hold window (avoids boundary blink), or
    //  • the next sentence is imminent (continuous speech has gappy ASR timing;
    //    clearing here would drop the line before the speaker finishes).
    if (idx === -1) {
      const now = this.video.currentTime;
      const last = this.index >= 0 ? this.segments[this.index] : undefined;
      const gapSoFar = last ? now - last.end : Infinity;
      // Short-gap hold: keep the previous line until the gap exceeds the hold
      // threshold. A short natural pause never reaches it (the next segment
      // becomes active first → switch); only a real pause or the end of the
      // track blanks the overlay.
      const willClear = this.index !== -1 && !this.video.paused && gapSoFar >= SUBTITLE_HOLD_SECONDS;
      if (subtitleDebugEnabled() && Date.now() - this.lastGapLog > 300) {
        this.lastGapLog = Date.now();
        const nextStart = this.nextSegmentStart(now);
        const nativeCaption = this.adapter?.getCurrentCaption()?.text?.trim() ?? '';
        const decision = this.video.paused
          ? 'HOLD (paused)'
          : this.index === -1
            ? 'already blank'
            : gapSoFar < SUBTITLE_HOLD_SECONDS
              ? `HOLD (short gap, ${gapSoFar.toFixed(2)}s < ${SUBTITLE_HOLD_SECONDS}s)`
              : 'CLEAR (gap exceeded hold / end of track)';
        console.log(
          `[Sync gap] currentTime=${now.toFixed(2)} · findSegmentIndex=-1 · activeIndex=${this.index}` +
            `\n  lastSeg=${last ? `[${last.start.toFixed(2)}‥${last.end.toFixed(2)}] "${last.text.slice(0, 30)}"` : '—'}` +
            ` · nextStart=${Number.isFinite(nextStart) ? nextStart.toFixed(2) : '∞'}` +
            ` · gapSoFar=${gapSoFar === Infinity ? '∞' : gapSoFar.toFixed(2)}s` +
            `\n  → decision=${decision}${willClear ? ' → overlay blanks' : ''}` +
            `\n  YouTube native caption=${nativeCaption ? `"${nativeCaption.slice(0, 48)}"` : '(none)'}`,
        );
      }
      if (!willClear) return; // paused, already blank, or still within the hold window
      this.index = -1;
      this.setState({ original: '', translation: '', translating: false, index: -1 });
      return;
    }

    this.index = idx;
    const segment = this.segments[idx]!;
    if (subtitleDebugEnabled()) {
      const now = this.video.currentTime;
      const inRange = now >= segment.start && now < segment.end;
      console.log(
        `[LinguaFlow sync] t=${now.toFixed(2)} rate=${this.video.playbackRate} → idx ${idx}` +
          ` [${segment.start.toFixed(2)}‥${segment.end.toFixed(2)}] inRange=${inRange}` +
          ` "${segment.text.slice(0, 32)}"`,
      );
    }
    this.setState({
      original: segment.text,
      translation: segment.translation ?? '',
      translating: segment.translation === undefined,
      index: idx,
    });
    // Playback reached an untranslated line (pool behind, or a jump): dispatch
    // P0 for it immediately (absolute priority) and make sure the pool is
    // running — it re-anchors to this playhead on its next claim. While a native
    // seek is in progress, skip this: the current cue is an intermediate scrub
    // position, so P0 is deferred to `seeked` (onSeeked re-anchors).
    if (segment.translation === undefined && !this.seeking) {
      if (subtitleDebugEnabled()) {
        console.log(`[P0] trigger from syncTrackMode → activeIndex=${idx} (force=${force})`);
      }
      void this.translateNow(idx);
      this.kickFill();
    } else if (subtitleDebugEnabled()) {
      console.log(`[P0] not triggered — activeIndex=${idx} already translated`);
    }
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

  /** Start time of the first segment beginning after `t` (Infinity if none). */
  private nextSegmentStart(t: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    let ans = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = this.segments[mid]!.start;
      if (start > t) {
        ans = start;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    return ans;
  }

  /**
   * Live captions (e.g. YouTube) render word by word, so waiting for the text
   * to "stabilize" stalls forever during continuous speech. Instead run a
   * small pipeline: keep at most one translation request in flight and, when
   * it returns, immediately translate the newest caption. Partial sentences
   * are translated too — the Chinese refines as the English grows, lagging by
   * roughly one request round-trip instead of until the speaker pauses.
   */
  /**
   * Whole-sentence mode: the sentence being spoken is buffered (and
   * translated ahead) silently — nothing renders word by word. At the
   * sentence boundary (caption gap, or a switch to unrelated text) the full
   * English + Chinese pair appears at once, replacing the previous pair.
   */
  private onLiveCaption(caption: CaptionState | null): void {
    const raw = caption?.text ?? '';
    if (raw === this.lastLiveText) return;
    const prev = this.lastLiveText;
    this.lastLiveText = raw;
    clearTimeout(this.liveIdleTimer);

    // Gap between cues = sentence boundary.
    if (!raw) {
      this.finalizeLiveSentence();
      if (this.autoPause && prev) this.video?.pause();
      // Long silence: don't leave the last pair on screen forever.
      this.liveIdleTimer = setTimeout(() => {
        if (this.lastLiveText === '') {
          this.setState({ original: '', translation: '', translating: false });
        }
      }, 7000);
      return;
    }

    // Leading speaker markers ('>>') are display noise; internal ones are
    // split into separate sentences by findLiveSplit.
    const text = stripSpeakerMarkers(raw);
    if (!text || isNonSpeechCue(text)) return; // marker-only or a non-speech cue

    const start = caption?.start ?? this.video?.currentTime ?? 0;
    if (this.liveSentence) {
      const merged = mergeCaptions(this.liveSentence.text, text);
      if (merged !== null) {
        this.liveSentence.text = merged;
      } else {
        // New sentence began without a gap.
        this.finalizeLiveSentence();
        if (this.autoPause) this.video?.pause();
        this.liveSentence = { text, start, translation: '', translatedText: '' };
      }
    } else {
      this.liveSentence = { text, start, translation: '', translatedText: '' };
    }
    // Continuous speech may never produce a caption gap: split as soon as
    // the buffer contains completed sentences (or grows past a hard cap).
    this.splitCompletedLiveSentences();

    if (this.liveSentence) {
      // Translate in the background while the sentence builds, so the pair
      // is (nearly) ready the moment the sentence completes. Never clobber a
      // pending exact-translation request for a sentence already on screen.
      this.livePending ??= { text: this.liveSentence.text, start: this.liveSentence.start };
      this.schedulePump(this.liveInflight ? 0 : 120);
    }
  }

  /** Comfortable one-line subtitle length; look for a clause break past this. */
  private static readonly LIVE_SOFT_CHARS = 65;
  /** Hard cap for clause-less streams; split at a word boundary here. */
  private static readonly LIVE_MAX_BUFFER_CHARS = 100;

  /**
   * Display the finished part of the buffer and keep only the tail:
   * 1) full sentences (terminator followed by more words);
   * 2) past the soft cap, clause boundaries — a comma/semicolon or a
   *    conjunction (and/but/so/which/because…) — so run-on ASR speech
   *    still breaks into readable lines;
   * 3) past the hard cap, the last word boundary.
   */
  private splitCompletedLiveSentences(): void {
    const sentence = this.liveSentence;
    if (!sentence) return;
    const split = findLiveSplit(
      sentence.text,
      SubtitleController.LIVE_SOFT_CHARS,
      SubtitleController.LIVE_MAX_BUFFER_CHARS,
    );
    if (!split) return;
    this.displayLiveSentence(split.completed, sentence.start, sentence);
    if (this.autoPause) this.video?.pause();
    this.liveSentence = split.rest
      ? {
          text: split.rest,
          start: this.video?.currentTime ?? sentence.start,
          translation: '',
          translatedText: '',
        }
      : null;
  }

  /** Sentence completed: show English + best-available Chinese together. */
  private finalizeLiveSentence(): void {
    const sentence = this.liveSentence;
    this.liveSentence = null;
    if (!sentence) return;
    this.displayLiveSentence(sentence.text, sentence.start, sentence);
  }

  private displayLiveSentence(
    text: string,
    start: number,
    stash: { translation: string; translatedText: string },
  ): void {
    this.setState({
      original: text,
      translation: stash.translation,
      translating: stash.translation === '',
    });
    this.appendLiveHistory(text, stash.translation, start);
    // The stashed translation may cover only a prefix (or more) of this
    // sentence — fetch the exact translation and refresh when it lands.
    if (stash.translatedText !== text) {
      this.livePending = { text, start };
      this.schedulePump(0);
    }
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
      if (seq > this.liveAppliedSeq && this.adapter) {
        this.liveAppliedSeq = seq;
        if (this.liveSentence && mergeCaptions(text, this.liveSentence.text) !== null) {
          // Sentence still building: stash the translation for the moment
          // the sentence completes.
          this.liveSentence.translation = translation;
          this.liveSentence.translatedText = text;
        } else if (
          this.state.original !== '' &&
          (text === this.state.original || isRelatedCaption(this.state.original, text))
        ) {
          // Exact translation for the pair already on screen.
          this.setState({ translation, translating: false });
          this.appendLiveHistory(this.state.original, translation, start);
        }
      }
    } catch {
      // A failing provider degrades to "original only"; the next sentence
      // retries. Never leave the spinner up.
      if (seq > this.liveAppliedSeq && this.state.translating) {
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
