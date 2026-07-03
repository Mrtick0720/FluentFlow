import { GenericHtml5Adapter } from '@/adapters/generic';

/**
 * TED serves standard HTML5 video with native subtitle tracks on talk pages,
 * so the generic textTrack path applies; this adapter pins the match and is
 * the extension point for TED-specific transcript handling.
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
}
