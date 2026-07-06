import type { DisplayMode, LanguageCode, TranslationProviderId } from '@/types/models';

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * Sentinel returned instead of stored API keys over RPC. Plaintext keys exist
 * only inside the service worker; UIs see this marker and send it back
 * unchanged unless the user typed a new key.
 */
export const REDACTED_KEY = '••••••••';

export interface ProviderSettings {
  /** Stored obfuscated (AES-GCM with extension-local key); see utils/crypto. */
  apiKey?: string;
  /** Azure region; DeepL plan is inferred from key suffix. */
  region?: string;
  /** Custom / OpenAI-compatible endpoint base URL. */
  baseUrl?: string;
  model?: string;
}

/** A named, user-saved OpenAI-compatible endpoint (DeepSeek, Gemini, GLM, …). */
export interface CustomEndpoint {
  id: string;
  name: string;
  baseUrl?: string;
  model?: string;
  /** Stored obfuscated (AES-GCM); see utils/crypto. */
  apiKey?: string;
}

/** Either a built-in provider, or a saved custom endpoint by id. */
export type ProviderSelection = TranslationProviderId | `custom:${string}`;

export interface AISettings {
  kind: 'openai' | 'anthropic' | 'custom' | 'none';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface SubtitleStyle {
  fontSize: number; // px, original line
  background: number; // 0..1 backdrop opacity
  position: 'overlay' | 'below';
  showOriginal: boolean;
  showTranslation: boolean;
}

export interface UserSettings {
  schemaVersion: number;
  targetLanguage: LanguageCode;
  sourceLanguage: LanguageCode; // 'auto' to detect
  displayMode: DisplayMode;
  /** Provider for selection / quick-translate / sentence cards. */
  translationProvider: ProviderSelection;
  /**
   * Provider for bulk whole-page translation. Kept separate so a slow LLM
   * endpoint (great for word/sentence explanations) doesn't make整页翻译 crawl —
   * defaults to fast MT (Google) like Trancy. Falls back to translationProvider.
   */
  pageTranslationProvider: ProviderSelection;
  /**
   * Whole-page translation quality. 'fast' = machine translation
   * (pageTranslationProvider). 'ai' = LLM with context + shared glossary +
   * title optimization (slower, premium). Default fast.
   */
  pageTranslationMode: 'fast' | 'ai';
  providers: Partial<Record<TranslationProviderId, ProviderSettings>>;
  /** Saved custom endpoints, each selectable as `custom:<id>`. */
  customEndpoints: CustomEndpoint[];
  ai: AISettings;
  theme: 'system' | 'light' | 'dark';
  fontScale: number; // multiplier for injected translation text
  translationStyle: 'plain' | 'underline' | 'tinted';
  subtitleStyle: SubtitleStyle;
  hotkeysEnabled: boolean;
  /** Show the selection toolbar (划词翻译) when text is selected. */
  selectionEnabled: boolean;
  /** Auto-open the bilingual subtitle panel on ANY video site. */
  autoSubtitleVideoSites: boolean;
  /** Hostnames where the bilingual subtitle panel auto-opens on video pages. */
  autoSubtitleSites: string[];
  autoTranslateSites: string[]; // hostnames
  neverTranslateSites: string[]; // hostnames
  /** Dragged position of the floating widget; null = default (right, centered). */
  fabPos: { left: number; top: number } | null;
  privacy: {
    cloudSync: boolean; // reserved; no backend in v0.1
  };
  cache: {
    enabled: boolean;
    ttlHours: number;
  };
}

export const DEFAULT_SETTINGS: UserSettings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  targetLanguage: 'zh-CN',
  sourceLanguage: 'auto',
  displayMode: 'bilingual',
  translationProvider: 'google',
  pageTranslationProvider: 'google',
  pageTranslationMode: 'fast',
  providers: {},
  customEndpoints: [],
  ai: { kind: 'none' },
  theme: 'system',
  fontScale: 0.92,
  translationStyle: 'tinted',
  subtitleStyle: {
    fontSize: 22,
    background: 0.55,
    position: 'overlay',
    showOriginal: true,
    showTranslation: true,
  },
  hotkeysEnabled: true,
  selectionEnabled: true,
  autoSubtitleVideoSites: false,
  autoSubtitleSites: [],
  autoTranslateSites: [],
  neverTranslateSites: [],
  fabPos: null,
  privacy: { cloudSync: false },
  cache: { enabled: true, ttlHours: 24 * 14 },
};

/**
 * Whether page bilingual translation should auto-enable on this hostname.
 * OFF for every site by default: it turns on only when the user has explicitly
 * added the host to `autoTranslateSites`, and `neverTranslateSites` always wins.
 * Manual/session enablement is a separate path that never writes to
 * `autoTranslateSites`, so it cannot make a site auto-translate on later visits.
 */
export function shouldAutoTranslate(hostname: string, settings: UserSettings): boolean {
  return (
    settings.autoTranslateSites.includes(hostname) &&
    !settings.neverTranslateSites.includes(hostname)
  );
}

/** Merge stored settings over defaults, applying migrations as needed. */
export function migrateSettings(stored: unknown): UserSettings {
  if (!stored || typeof stored !== 'object') return structuredClone(DEFAULT_SETTINGS);
  const merged = deepMerge(
    structuredClone(DEFAULT_SETTINGS) as unknown as Record<string, unknown>,
    stored as Record<string, unknown>,
  ) as unknown as UserSettings;
  merged.schemaVersion = SETTINGS_SCHEMA_VERSION;
  migrateLegacyCustom(merged);
  return merged;
}

/**
 * Fold a legacy single `providers.custom` slot into the named endpoint list so
 * older installs keep working (keys are still sealed at this point — moving the
 * string preserves them).
 */
function migrateLegacyCustom(s: UserSettings): void {
  if (!Array.isArray(s.customEndpoints)) s.customEndpoints = [];
  const legacy = s.providers.custom;
  if (!legacy || (!legacy.baseUrl && !legacy.model && !legacy.apiKey)) return;
  const id = 'default';
  if (!s.customEndpoints.some((e) => e.id === id)) {
    s.customEndpoints.unshift({
      id,
      name: '自定义端点',
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      apiKey: legacy.apiKey,
    });
  }
  delete s.providers.custom;
  if (s.translationProvider === 'custom') s.translationProvider = `custom:${id}`;
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof base[k] === 'object' && base[k] && !Array.isArray(base[k])) {
      deepMerge(base[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      base[k] = v;
    }
  }
  return base;
}
