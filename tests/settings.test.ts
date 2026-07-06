import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  migrateSettings,
  shouldAutoTranslate,
  type UserSettings,
} from '@/shared/settings';
import {
  getSettings,
  getSettingsRedacted,
  REDACTED_KEY,
  updateSettings,
} from '@/services/storage/settingsStore';
import { openSecret, sealSecret } from '@/utils/crypto';
import { __clearChromeStorage } from './setup';

beforeEach(() => {
  __clearChromeStorage();
});

describe('shouldAutoTranslate — page translation is opt-in per site', () => {
  const withSites = (auto: string[], never: string[] = []): UserSettings => ({
    ...DEFAULT_SETTINGS,
    autoTranslateSites: auto,
    neverTranslateSites: never,
  });

  it('is OFF by default for every site (empty allowlist)', () => {
    expect(DEFAULT_SETTINGS.autoTranslateSites).toEqual([]);
    expect(shouldAutoTranslate('example.com', DEFAULT_SETTINGS)).toBe(false);
    expect(shouldAutoTranslate('news.ycombinator.com', withSites([]))).toBe(false);
  });

  it('auto-enables only hosts in autoTranslateSites', () => {
    const s = withSites(['example.com']);
    expect(shouldAutoTranslate('example.com', s)).toBe(true);
    expect(shouldAutoTranslate('other.com', s)).toBe(false); // not listed → off
  });

  it('lets neverTranslateSites override the allowlist', () => {
    const s = withSites(['example.com'], ['example.com']);
    expect(shouldAutoTranslate('example.com', s)).toBe(false);
  });

  it('does not auto-enable a host that was only manually toggled (not persisted to the allowlist)', () => {
    // A manual/session enable never writes to autoTranslateSites, so on the next
    // visit the allowlist is unchanged and the decision stays off.
    const afterSessionToggle = withSites([]); // session enable leaves the list empty
    expect(shouldAutoTranslate('manually-enabled.com', afterSessionToggle)).toBe(false);
  });

  it('matches by exact hostname (existing allowlist behavior is stable)', () => {
    const s = withSites(['sub.example.com']);
    expect(shouldAutoTranslate('sub.example.com', s)).toBe(true);
    expect(shouldAutoTranslate('example.com', s)).toBe(false);
    expect(shouldAutoTranslate('other.sub.example.com', s)).toBe(false);
  });
});

describe('migrateSettings', () => {
  it('returns defaults for empty input', () => {
    expect(migrateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('merges stored values over defaults without losing new fields', () => {
    const migrated = migrateSettings({ targetLanguage: 'ja', subtitleStyle: { fontSize: 30 } });
    expect(migrated.targetLanguage).toBe('ja');
    expect(migrated.subtitleStyle.fontSize).toBe(30);
    expect(migrated.subtitleStyle.position).toBe(DEFAULT_SETTINGS.subtitleStyle.position);
    expect(migrated.cache.enabled).toBe(true);
  });
});

describe('custom endpoints', () => {
  it('defaults to an empty list', () => {
    expect(migrateSettings(undefined).customEndpoints).toEqual([]);
  });

  it('migrates a legacy single custom provider into a named endpoint', () => {
    const migrated = migrateSettings({
      translationProvider: 'custom',
      providers: {
        custom: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'enc:v1:x' },
      },
    });
    expect(migrated.customEndpoints).toHaveLength(1);
    const ep = migrated.customEndpoints[0]!;
    expect(ep.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(ep.model).toBe('deepseek-chat');
    expect(ep.apiKey).toBe('enc:v1:x');
    expect(migrated.translationProvider).toBe(`custom:${ep.id}`);
    expect(migrated.providers.custom).toBeUndefined();
  });

  it('seals, redacts, and preserves each endpoint key by id', async () => {
    const saved = await updateSettings({
      customEndpoints: [
        { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-secret' },
      ],
    });
    expect(saved.customEndpoints[0]!.apiKey).toBe('sk-secret');

    const redacted = await getSettingsRedacted();
    expect(redacted.customEndpoints[0]!.apiKey).toBe(REDACTED_KEY);

    // Re-saving with the redaction sentinel must keep the stored key.
    await updateSettings({
      customEndpoints: [{ id: 'a', name: 'DeepSeek', baseUrl: 'x', model: 'y', apiKey: REDACTED_KEY }],
    });
    const full = await getSettings();
    expect(full.customEndpoints[0]!.apiKey).toBe('sk-secret');
  });
});

describe('crypto seal/open', () => {
  it('round-trips a secret and tolerates plaintext passthrough', async () => {
    const sealed = await sealSecret('sk-test-123');
    expect(sealed).toMatch(/^enc:v1:/);
    expect(await openSecret(sealed)).toBe('sk-test-123');
    expect(await openSecret('plain')).toBe('plain');
  });
});

describe('settingsStore', () => {
  it('persists settings, seals secrets at rest, redacts over RPC', async () => {
    await updateSettings({
      providers: { deepl: { apiKey: 'deepl-key' } },
      ai: { kind: 'openai', apiKey: 'sk-abc' },
    });

    const full = await getSettings();
    expect(full.providers.deepl?.apiKey).toBe('deepl-key');
    expect(full.ai.apiKey).toBe('sk-abc');

    const raw = await chrome.storage.local.get('lf-settings');
    const stored = raw['lf-settings'] as typeof full;
    expect(stored.providers.deepl?.apiKey).toMatch(/^enc:v1:/);
    expect(stored.ai.apiKey).toMatch(/^enc:v1:/);

    const redacted = await getSettingsRedacted();
    expect(redacted.providers.deepl?.apiKey).toBe(REDACTED_KEY);
    expect(redacted.ai.apiKey).toBe(REDACTED_KEY);
  });

  it('keeps existing secret when the redaction sentinel is sent back', async () => {
    await updateSettings({ ai: { kind: 'openai', apiKey: 'sk-original' } });
    await updateSettings({ ai: { kind: 'openai', apiKey: REDACTED_KEY, model: 'gpt-4o-mini' } });
    const full = await getSettings();
    expect(full.ai.apiKey).toBe('sk-original');
    expect(full.ai.model).toBe('gpt-4o-mini');
  });
});
