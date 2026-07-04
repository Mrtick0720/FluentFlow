import { DEFAULT_SETTINGS, migrateSettings, REDACTED_KEY, type UserSettings } from '@/shared/settings';
import { openSecret, sealSecret } from '@/utils/crypto';

const SETTINGS_KEY = 'lf-settings';

export { REDACTED_KEY };

async function mapSecrets(
  settings: UserSettings,
  fn: (value: string) => Promise<string> | string,
): Promise<UserSettings> {
  const out = structuredClone(settings);
  for (const provider of Object.values(out.providers)) {
    if (provider.apiKey) provider.apiKey = await fn(provider.apiKey);
  }
  if (out.ai.apiKey) out.ai.apiKey = await fn(out.ai.apiKey);
  return out;
}

/** Full settings with decrypted secrets. Service-worker use only. */
export async function getSettings(): Promise<UserSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = migrateSettings(stored[SETTINGS_KEY]);
  return mapSecrets(settings, openSecret);
}

/** Settings safe to hand to UIs: secrets replaced by REDACTED_KEY. */
export async function getSettingsRedacted(): Promise<UserSettings> {
  const settings = await getSettings();
  return mapSecrets(settings, () => REDACTED_KEY);
}

export async function updateSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getSettings();
  const merged = migrateSettings(mergeDeep(current, patch));
  // Preserve existing secrets where the UI sent the redaction sentinel back.
  for (const [id, provider] of Object.entries(merged.providers)) {
    if (provider.apiKey === REDACTED_KEY) {
      provider.apiKey = current.providers[id as keyof typeof current.providers]?.apiKey;
    }
  }
  if (merged.ai.apiKey === REDACTED_KEY) merged.ai.apiKey = current.ai.apiKey;

  const sealed = await mapSecrets(merged, sealSecret);
  await chrome.storage.local.set({ [SETTINGS_KEY]: sealed });
  return merged;
}

export async function resetSettings(): Promise<UserSettings> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: structuredClone(DEFAULT_SETTINGS) });
  return structuredClone(DEFAULT_SETTINGS);
}

function mergeDeep(base: UserSettings, patch: Partial<UserSettings>): UserSettings {
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  merge(out, patch as Record<string, unknown>);
  return out as unknown as UserSettings;

  function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
    for (const [k, v] of Object.entries(source)) {
      if (
        v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        target[k] &&
        typeof target[k] === 'object' &&
        !Array.isArray(target[k])
      ) {
        merge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else if (v !== undefined) {
        target[k] = structuredClone(v);
      }
    }
  }
}
