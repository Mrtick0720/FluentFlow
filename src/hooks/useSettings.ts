import { useCallback, useEffect, useState } from 'react';
import { sendRequest } from '@/shared/messages';
import type { UserSettings } from '@/shared/settings';

export function useSettings() {
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sendRequest('settings.get', null).then(setSettings, (e: Error) => setError(e.message));
  }, []);

  const update = useCallback(async (patch: Partial<UserSettings>) => {
    const next = await sendRequest('settings.set', { patch });
    setSettings(next);
    return next;
  }, []);

  return { settings, update, error };
}

/** Apply light/dark theme to the page based on the setting. */
export function useTheme(theme: UserSettings['theme'] | undefined) {
  useEffect(() => {
    if (!theme) return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
