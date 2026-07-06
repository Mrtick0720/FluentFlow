import { BbcAdapter } from '@/adapters/bbc';
import { GenericHtml5Adapter } from '@/adapters/generic';
import { TedAdapter } from '@/adapters/ted';
import { YouTubeAdapter } from '@/adapters/youtube';
import { VideoAdapterRegistry } from '@/services/video/adapter';
import { SubtitleController, type SubtitleViewState } from '@/services/video/controller';
import type { SubtitleFrameStatus } from './frameBridge';

export interface SubtitleRuntimeOptions {
  /** Translate caption lines. Runs in the caller's frame — no text crosses frames. */
  translate: (texts: string[]) => Promise<string[]>;
  /** Report readiness / status back to the caller (e.g. to post to the parent). */
  onState?: (status: SubtitleFrameStatus, mode?: 'track' | 'live') => void;
}

export interface SubtitleRuntime {
  detect(): boolean;
  open(): Promise<void>;
  close(): void;
  toggle(): Promise<void>;
  destroy(): void;
}

const OVERLAY_CSS = `
:host { all: initial; }
.lf-sub-overlay {
  position: fixed;
  left: 50%;
  bottom: 8%;
  transform: translateX(-50%);
  max-width: 92%;
  z-index: 2147483000;
  text-align: center;
  pointer-events: none;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.lf-sub-original,
.lf-sub-translation {
  display: block;
  margin: 2px 0;
  padding: 2px 10px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  line-height: 1.35;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
}
.lf-sub-original { font-size: 20px; }
.lf-sub-translation { font-size: 18px; color: #ffe9a8; }
.lf-sub-overlay[hidden] { display: none; }
`;

/**
 * A self-contained, subtitle-only runtime: it hides the player's native
 * captions and shows exactly two FluentFlow lines (English original + Chinese
 * translation). Used inside embedded player frames (e.g. YouTube in Khan
 * Academy). It never bypasses login/DRM/paywalls and never scrapes protected
 * caption data — it reuses the same public adapters as the top-frame app.
 */
export function createSubtitleRuntime(options: SubtitleRuntimeOptions): SubtitleRuntime {
  const registry = new VideoAdapterRegistry()
    .register(new YouTubeAdapter())
    .register(new TedAdapter())
    .register(new BbcAdapter())
    .register(new GenericHtml5Adapter());

  const controller = new SubtitleController(registry, {
    translate: options.translate,
    onState: (state) => render(state),
  });

  // Open shadow root so the two lines are style-isolated yet still queryable
  // (e.g. for verification); nothing else from the page can leak in.
  const host = document.createElement('div');
  host.id = 'lf-sub-host';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  const overlay = document.createElement('div');
  overlay.className = 'lf-sub-overlay';
  overlay.hidden = true;
  const originalLine = document.createElement('div');
  originalLine.className = 'lf-sub-original';
  const translationLine = document.createElement('div');
  translationLine.className = 'lf-sub-translation';
  overlay.append(originalLine, translationLine);
  shadow.append(style, overlay);

  let open = false;
  let mounted = false;
  // Native <track> modes we forced to 'hidden' — restored on close.
  const restoredTrackModes: Array<{ track: TextTrack; mode: TextTrackMode }> = [];

  function mount() {
    if (mounted) return;
    document.documentElement.appendChild(host);
    mounted = true;
  }

  function hideNativeTextTracks(): void {
    const video = registry.resolve(location.href)?.getVideo?.() ?? document.querySelector('video');
    if (!video) return;
    for (let i = 0; i < video.textTracks.length; i++) {
      const tt = video.textTracks[i]!;
      if (tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;
      if (tt.mode === 'showing') {
        restoredTrackModes.push({ track: tt, mode: tt.mode });
        tt.mode = 'hidden';
      }
    }
  }

  function restoreNativeTextTracks(): void {
    for (const { track, mode } of restoredTrackModes) track.mode = mode;
    restoredTrackModes.length = 0;
  }

  function render(state: SubtitleViewState): void {
    if (!open) return;
    originalLine.textContent = state.original || '';
    translationLine.textContent = state.translation || '';
    // Only ever the two FluentFlow lines are shown; the player's native line
    // stays hidden while subtitles are open.
    const hasText = Boolean(state.original || state.translation);
    overlay.hidden = !hasText;
    options.onState?.(
      state.status === 'ready' ? 'ready' : state.status === 'no-subtitles' ? 'no-subtitles' : 'no-video',
      state.mode,
    );
  }

  function detect(): boolean {
    const video = registry.resolve(location.href)?.getVideo?.() ?? document.querySelector('video');
    if (!video) return false;
    const r = video.getBoundingClientRect();
    return r.width >= 200 && r.height >= 120;
  }

  async function doOpen(): Promise<void> {
    if (open) return;
    open = true;
    mount();
    overlay.hidden = false;
    // Belt-and-suspenders native hiding: the adapter fades its own caption
    // window (SubtitleController.attach), and we also mute native <track> cues.
    hideNativeTextTracks();
    const state = await controller.attach(location.href);
    if (state.status !== 'ready') {
      options.onState?.(state.status === 'no-subtitles' ? 'no-subtitles' : 'no-video');
    }
  }

  function doClose(): void {
    if (!open) return;
    open = false;
    controller.detach();
    restoreNativeTextTracks();
    overlay.hidden = true;
    originalLine.textContent = '';
    translationLine.textContent = '';
    options.onState?.('closed');
  }

  return {
    detect,
    open: doOpen,
    close: doClose,
    toggle: async () => {
      if (open) doClose();
      else await doOpen();
    },
    destroy: () => {
      doClose();
      if (mounted) host.remove();
      mounted = false;
    },
  };
}
