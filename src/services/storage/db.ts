/** Minimal promise wrapper over IndexedDB. No dependencies. */

const DB_NAME = 'linguaflow';
const DB_VERSION = 1;

export const STORES = {
  vocabulary: 'vocabulary',
  sentences: 'sentences',
  cache: 'cache',
  readingSessions: 'reading_sessions',
  stats: 'stats',
  conversations: 'conversations',
  reviewHistory: 'review_history',
  articles: 'articles',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.vocabulary)) {
        const s = db.createObjectStore(STORES.vocabulary, { keyPath: 'id' });
        s.createIndex('word', 'word');
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORES.sentences)) {
        const s = db.createObjectStore(STORES.sentences, { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(STORES.cache)) {
        const s = db.createObjectStore(STORES.cache, { keyPath: 'key' });
        s.createIndex('scope', 'scope');
        s.createIndex('expiresAt', 'expiresAt');
      }
      if (!db.objectStoreNames.contains(STORES.readingSessions)) {
        const s = db.createObjectStore(STORES.readingSessions, { keyPath: 'id' });
        s.createIndex('startedAt', 'startedAt');
      }
      if (!db.objectStoreNames.contains(STORES.stats)) {
        db.createObjectStore(STORES.stats, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORES.conversations)) {
        const s = db.createObjectStore(STORES.conversations, { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains(STORES.reviewHistory)) {
        const s = db.createObjectStore(STORES.reviewHistory, { keyPath: 'id' });
        s.createIndex('vocabularyId', 'vocabularyId');
      }
      if (!db.objectStoreNames.contains(STORES.articles)) {
        const s = db.createObjectStore(STORES.articles, { keyPath: 'id' });
        s.createIndex('url', 'url');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function getDb(): Promise<IDBDatabase> {
  dbPromise ??= openDb();
  return dbPromise;
}

/** Close and forget the connection (test isolation). */
export async function __resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
  }
  dbPromise = null;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | Promise<T>,
): Promise<T> {
  const db = await getDb();
  const tx = db.transaction(store, mode);
  const result = fn(tx.objectStore(store));
  return result instanceof IDBRequest ? promisify(result) : result;
}

export const idb = {
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return withStore(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
  },
  put<T>(store: StoreName, value: T): Promise<IDBValidKey> {
    return withStore(store, 'readwrite', (s) => s.put(value));
  },
  delete(store: StoreName, key: IDBValidKey): Promise<undefined> {
    return withStore(store, 'readwrite', (s) => s.delete(key));
  },
  clear(store: StoreName): Promise<undefined> {
    return withStore(store, 'readwrite', (s) => s.clear());
  },
  getAll<T>(store: StoreName): Promise<T[]> {
    return withStore(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>);
  },
  count(store: StoreName): Promise<number> {
    return withStore(store, 'readonly', (s) => s.count());
  },
  getAllByIndex<T>(store: StoreName, index: string, query?: IDBValidKey | IDBKeyRange): Promise<T[]> {
    return withStore(store, 'readonly', (s) => s.index(index).getAll(query) as IDBRequest<T[]>);
  },
  deleteByIndex(store: StoreName, index: string, query: IDBValidKey | IDBKeyRange): Promise<void> {
    return withStore(store, 'readwrite', async (s) => {
      const keys = await promisify(s.index(index).getAllKeys(query));
      await Promise.all(keys.map((k) => promisify(s.delete(k))));
    });
  },
};
