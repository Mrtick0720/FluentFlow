import { idb, STORES } from '@/services/storage/db';

export type CacheScope = 'translation' | 'dictionary' | 'ai';

interface CacheEntry<T = unknown> {
  key: string; // `${scope}:${key}`
  scope: CacheScope;
  value: T;
  expiresAt: number;
}

export async function cacheGet<T>(scope: CacheScope, key: string): Promise<T | undefined> {
  const entry = await idb.get<CacheEntry<T>>(STORES.cache, `${scope}:${key}`);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    await idb.delete(STORES.cache, entry.key);
    return undefined;
  }
  return entry.value;
}

export async function cacheSet<T>(
  scope: CacheScope,
  key: string,
  value: T,
  ttlMs: number,
): Promise<void> {
  const entry: CacheEntry<T> = {
    key: `${scope}:${key}`,
    scope,
    value,
    expiresAt: Date.now() + ttlMs,
  };
  await idb.put(STORES.cache, entry);
}

export async function cacheClear(scope: CacheScope | 'all'): Promise<void> {
  if (scope === 'all') {
    await idb.clear(STORES.cache);
    return;
  }
  await idb.deleteByIndex(STORES.cache, 'scope', scope);
}

/** Drop expired entries; call opportunistically from the service worker. */
export async function cacheSweep(): Promise<void> {
  await idb.deleteByIndex(STORES.cache, 'expiresAt', IDBKeyRange.upperBound(Date.now()));
}
