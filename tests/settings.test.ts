import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, migrateSettings } from '@/shared/settings';
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
