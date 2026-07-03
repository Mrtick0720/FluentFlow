import { GenericHtml5Adapter } from '@/adapters/generic';
import type { CaptionState } from '@/services/video/adapter';

/**
 * BBC (including BBC Learning English) uses an HTML5-based media player.
 * Native text tracks are used when exposed; otherwise the visible caption
 * DOM the player renders is observed (live mode).
 */
export class BbcAdapter extends GenericHtml5Adapter {
  override readonly id = 'bbc';

  override match(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host.endsWith('.bbc.co.uk') || host.endsWith('.bbc.com');
    } catch {
      return false;
    }
  }

  override getCurrentCaption(): CaptionState | null {
    const native = super.getCurrentCaption();
    if (native) return native;
    const el = document.querySelector('[class*="subtitle" i] p, [data-testid*="subtitle" i]');
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return { text, start: this.getVideo()?.currentTime };
    return null;
  }
}
