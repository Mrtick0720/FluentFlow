import { GenericHtml5Adapter } from '@/adapters/generic';
import type { SubtitleTrack } from '@/types/models';

/** English-first ordering, tolerant of `en`, `en-US`, `en-GB`, etc. */
export function preferEnglishTracks(tracks: SubtitleTrack[]): SubtitleTrack[] {
  return [...tracks].sort(
    (a, b) => Number(/^en(?:-|$)/i.test(b.language)) - Number(/^en(?:-|$)/i.test(a.language)),
  );
}

/**
 * TED serves standard HTML5 video with native subtitle tracks on talk pages,
 * so the generic textTrack / <track> path applies. This adapter only reorders
 * the publicly exposed tracks to put English first — it never bypasses login,
 * DRM, or paywalls, and returns [] when no public subtitle source exists.
 */
export class TedAdapter extends GenericHtml5Adapter {
  override readonly id = 'ted';

  override match(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'www.ted.com' || host === 'ted.com' || host === 'embed.ted.com';
    } catch {
      return false;
    }
  }

  override async getSubtitleTracks(): Promise<SubtitleTrack[]> {
    // Only the tracks the page already exposes via <track> / textTracks.
    const tracks = await super.getSubtitleTracks();
    return preferEnglishTracks(tracks);
  }
}
