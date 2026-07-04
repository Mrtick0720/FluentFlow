import type { SubtitleViewState } from '@/services/video/controller';
import type { SubtitleStyle } from '@/shared/settings';
import type { DictionaryEntry, SubtitleSegment } from '@/types/models';

export interface WordCardState {
  x: number;
  y: number;
  word: string;
  context?: string;
  loading: boolean;
  entry?: DictionaryEntry;
  error?: string;
  aiText?: string;
  aiLoading?: boolean;
  saved: boolean;
}

export interface SentenceCardState {
  x: number;
  y: number;
  text: string;
  translation?: string;
  loading: boolean;
  error?: string;
  aiLabel?: string;
  aiText?: string;
  aiLoading?: boolean;
  saved: boolean;
}

export interface UIState {
  toolbar: { x: number; y: number; text: string } | null;
  wordCard: WordCardState | null;
  sentenceCard: SentenceCardState | null;
  videoDetected: boolean;
  subtitleVisible: boolean;
  subtitleState: SubtitleViewState | null;
  subtitleStyle: SubtitleStyle | null;
  /** Current viewport-relative rectangle of the active video. */
  /** Main video's on-screen rect; anchors the FAB stack and subtitle panel. */
  videoRect: { left: number; top: number; width: number; height: number } | null;
  /** A video is playing fullscreen — hide the floating button. */
  isFullscreen: boolean;
  transcript: SubtitleSegment[];
  transcriptVisible: boolean;
  pageActive: boolean;
  progress: { done: number; total: number };
  aiAvailable: boolean;
  /** Quick-action menu anchored to the YouTube control-bar button. */
  playerMenu: { x: number; y: number } | null;
  /** Quick-translate scratchpad window (input → output with language pickers). */
  quickTranslateOpen: boolean;
  /** Current translation service/model label (for the quick-translate footer). */
  translationLabel: string;
  toast: string | null;
}

const initial: UIState = {
  toolbar: null,
  wordCard: null,
  sentenceCard: null,
  videoDetected: false,
  subtitleVisible: false,
  subtitleState: null,
  subtitleStyle: null,
  videoRect: null,
  isFullscreen: false,
  transcript: [],
  transcriptVisible: false,
  pageActive: false,
  progress: { done: 0, total: 0 },
  aiAvailable: false,
  playerMenu: null,
  quickTranslateOpen: false,
  translationLabel: '',
  toast: null,
};

type Listener = () => void;

function createStore(init: UIState) {
  let state = init;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<UIState> | ((prev: UIState) => Partial<UIState>)) {
      const resolved = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...resolved };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const uiStore = createStore(initial);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showToast(message: string): void {
  uiStore.set({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => uiStore.set({ toast: null }), 2400);
}
