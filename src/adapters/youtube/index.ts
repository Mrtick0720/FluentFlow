import { GenericHtml5Adapter } from '@/adapters/generic';
import type { CaptionState } from '@/services/video/adapter';
import type { SubtitleTrack } from '@/types/models';

export const normalizeCaptionText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function chooseCaptionText(
  candidates: Array<{ text: string; visible: boolean }>,
): string {
  return normalizeCaptionText(
    candidates
      .filter((candidate) => candidate.visible)
      .map((candidate) => normalizeCaptionText(candidate.text))
      .filter(Boolean)
      .join(' '),
  );
}

function isVisibleCaptionWindow(element: Element): boolean {
  const node = element as HTMLElement;
  const style = getComputedStyle(node);
  return (
    node.getClientRects().length > 0 &&
    node.getAttribute('aria-hidden') !== 'true' &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

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
    const windows = [...document.querySelectorAll('.ytp-caption-window-container .caption-window')];
    const candidates = windows.map((window) => ({
      text: [...window.querySelectorAll('.ytp-caption-segment')]
        .map((segment) => segment.textContent ?? '')
        .join(' '),
      visible: isVisibleCaptionWindow(window),
    }));
    const fallback = [...document.querySelectorAll('.ytp-caption-segment')]
      .map((segment) => segment.textContent ?? '')
      .join(' ');
    const text = windows.length > 0
      ? chooseCaptionText(candidates)
      : normalizeCaptionText(fallback);
    if (text) {
      const video = this.getVideo();
      return { text, start: video?.currentTime };
    }
    return super.getCurrentCaption();
  }

  /** Fade out the player's caption window (opacity keeps the DOM updating). */
  hideNativeCaptions(): () => void {
    const style = document.createElement('style');
    style.id = 'lf-hide-native-cc';
    style.textContent = '.ytp-caption-window-container { opacity: 0 !important; }';
    document.head.appendChild(style);
    return () => style.remove();
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
