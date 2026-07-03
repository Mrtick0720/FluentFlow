import { GenericHtml5Adapter } from '@/adapters/generic';
import type { CaptionState } from '@/services/video/adapter';
import type { SubtitleTrack } from '@/types/models';

/**
 * YouTube renders captions into the player DOM rather than exposing text
 * track cues, so this adapter works in "live mode": it observes the caption
 * text the player is already showing to the user (the user enables CC in the
 * player). No internal APIs are called and nothing protected is scraped.
 */
export class YouTubeAdapter extends GenericHtml5Adapter {
  override readonly id = 'youtube';

  override match(url: string): boolean {
    try {
      const host = new URL(url).hostname;
      return host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com';
    } catch {
      return false;
    }
  }

  override getVideo(): HTMLVideoElement | null {
    return (
      document.querySelector<HTMLVideoElement>('video.html5-main-video') ?? super.getVideo()
    );
  }

  override async getSubtitleTracks(): Promise<SubtitleTrack[]> {
    // Native cues are usually unavailable; fall back to live caption mode.
    return super.getSubtitleTracks();
  }

  override getCurrentCaption(): CaptionState | null {
    const segments = [...document.querySelectorAll('.ytp-caption-segment')]
      .map((el) => el.textContent?.trim() ?? '')
      .filter(Boolean);
    if (segments.length > 0) {
      const video = this.getVideo();
      return { text: segments.join(' '), start: video?.currentTime };
    }
    return super.getCurrentCaption();
  }

  override onCaptionChanged(cb: (caption: CaptionState | null) => void): () => void {
    const container =
      document.querySelector('.ytp-caption-window-container') ??
      document.querySelector('#movie_player') ??
      document.body;
    let last = '';
    const observer = new MutationObserver(() => {
      const caption = this.getCurrentCaption();
      const text = caption?.text ?? '';
      if (text !== last) {
        last = text;
        cb(caption);
      }
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    const unsubscribeNative = super.onCaptionChanged(cb);
    return () => {
      observer.disconnect();
      unsubscribeNative();
    };
  }
}
