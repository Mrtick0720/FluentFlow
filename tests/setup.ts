import 'fake-indexeddb/auto';

/** Minimal in-memory chrome.* mock for unit tests. */
const localData = new Map<string, unknown>();

const chromeMock = {
  storage: {
    local: {
      async get(key?: string | string[] | null) {
        if (key == null) return Object.fromEntries(localData);
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) if (localData.has(k)) out[k] = localData.get(k);
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [k, v] of Object.entries(items)) localData.set(k, structuredClone(v));
      },
      async remove(key: string | string[]) {
        for (const k of Array.isArray(key) ? key : [key]) localData.delete(k);
      },
      async clear() {
        localData.clear();
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    id: 'test-extension-id',
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
    sendMessage: async () => undefined,
  },
} as unknown as typeof chrome;

globalThis.chrome = chromeMock;

export function __clearChromeStorage() {
  localData.clear();
}
