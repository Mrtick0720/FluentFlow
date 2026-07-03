import type { SubtitleTrack } from '@/types/models';

export interface CaptionState {
  text: string;
  start?: number;
  end?: number;
}

/**
 * Site adapter for video + subtitles. Implementations may only read data the
 * page already exposes to the user (native text tracks, visible caption DOM,
 * public transcripts). Never bypass DRM, paywalls, logins, or protections.
 */
export interface VideoAdapter {
  readonly id: string;
  /** Does this adapter handle the given page URL? */
  match(url: string): boolean;
  getVideo(): HTMLVideoElement | null;
  /**
   * Tracks with full segment lists ("track mode": precise prev/next/A-B).
   * May be empty when only live caption observation is possible.
   */
  getSubtitleTracks(): Promise<SubtitleTrack[]>;
  /** Currently displayed caption ("live mode" fallback). */
  getCurrentCaption(): CaptionState | null;
  seek(seconds: number): void;
  /** Subscribe to caption changes; returns an unsubscribe function. */
  onCaptionChanged(cb: (caption: CaptionState | null) => void): () => void;
}

/** First matching adapter wins; register specific adapters before generic. */
export class VideoAdapterRegistry {
  private adapters: VideoAdapter[] = [];

  register(adapter: VideoAdapter): this {
    this.adapters.push(adapter);
    return this;
  }

  resolve(url: string): VideoAdapter | null {
    return this.adapters.find((a) => a.match(url)) ?? null;
  }
}
