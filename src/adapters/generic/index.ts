import { parseVtt, segmentsFromCues } from '@/services/subtitle/vtt';
import type { CaptionState, VideoAdapter } from '@/services/video/adapter';
import type { SubtitleTrack } from '@/types/models';

/**
 * Fallback adapter for any page with an HTML5 video. Reads native
 * textTracks / <track> elements only.
 */
export class GenericHtml5Adapter implements VideoAdapter {
  readonly id: string = 'generic';

  match(_url: string): boolean {
    return true;
  }

  getVideo(): HTMLVideoElement | null {
    const videos = [...document.querySelectorAll('video')];
    if (videos.length === 0) return null;
    // Prefer the largest visible video (the main player).
    return videos.reduce((best, v) => {
      const area = (el: HTMLVideoElement) => {
        const r = el.getBoundingClientRect();
        return r.width * r.height;
      };
      return area(v) > area(best) ? v : best;
    });
  }

  async getSubtitleTracks(): Promise<SubtitleTrack[]> {
    const video = this.getVideo();
    if (!video) return [];
    const tracks: SubtitleTrack[] = [];

    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i]!;
      if (tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;

      let segments = segmentsFromCues(tt.cues);
      if (segments.length === 0) {
        // Force the browser to load cues, then re-read.
        const previousMode = tt.mode;
        tt.mode = 'hidden';
        await new Promise((r) => setTimeout(r, 300));
        segments = segmentsFromCues(tt.cues);
        if (previousMode === 'disabled' && segments.length > 0) tt.mode = previousMode;
      }
      if (segments.length === 0) {
        segments = await this.fetchTrackElement(video, tt);
      }
      if (segments.length === 0) continue;

      tracks.push({
        id: `${this.id}-${i}`,
        label: tt.label || tt.language || `Track ${i + 1}`,
        language: tt.language || 'und',
        kind: tt.kind === 'captions' ? 'captions' : 'subtitles',
        segments,
      });
    }
    return tracks;
  }

  /** Try the corresponding <track src> and parse it as WebVTT. */
  private async fetchTrackElement(
    video: HTMLVideoElement,
    tt: TextTrack,
  ): Promise<SubtitleTrack['segments']> {
    const trackEl = [...video.querySelectorAll('track')].find(
      (t) => t.track === tt && t.src,
    );
    if (!trackEl) return [];
    try {
      const res = await fetch(trackEl.src, { credentials: 'same-origin' });
      if (!res.ok) return [];
      return parseVtt(await res.text());
    } catch {
      return [];
    }
  }

  getCurrentCaption(): CaptionState | null {
    const video = this.getVideo();
    if (!video) return null;
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i]!;
      if (tt.mode === 'disabled' || !tt.activeCues?.length) continue;
      const cue = tt.activeCues[0] as VTTCue;
      const text = cue.text?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) return { text, start: cue.startTime, end: cue.endTime };
    }
    return null;
  }

  seek(seconds: number): void {
    const video = this.getVideo();
    if (video) video.currentTime = Math.max(0, seconds);
  }

  onCaptionChanged(cb: (caption: CaptionState | null) => void): () => void {
    const video = this.getVideo();
    if (!video) return () => {};
    const handler = () => cb(this.getCurrentCaption());
    const tracks: TextTrack[] = [];
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i]!;
      tt.addEventListener('cuechange', handler);
      tracks.push(tt);
    }
    return () => tracks.forEach((tt) => tt.removeEventListener('cuechange', handler));
  }
}
