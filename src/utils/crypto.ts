/**
 * At-rest obfuscation for API keys using AES-GCM with an extension-local key
 * kept in chrome.storage.local. This raises the bar against casual disk
 * inspection but is NOT true security: anything with access to the profile
 * directory can recover the key. Documented limitation of the platform.
 */

const KEY_STORAGE = 'lf-local-key';
const PREFIX = 'enc:v1:';

let keyPromise: Promise<CryptoKey> | null = null;

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function getKey(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const stored = await chrome.storage.local.get(KEY_STORAGE);
    let raw: Uint8Array;
    if (typeof stored[KEY_STORAGE] === 'string') {
      raw = b64decode(stored[KEY_STORAGE]);
    } else {
      raw = crypto.getRandomValues(new Uint8Array(32));
      await chrome.storage.local.set({ [KEY_STORAGE]: b64encode(raw) });
    }
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
  })();
  return keyPromise;
}

export async function sealSecret(plain: string): Promise<string> {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plain),
  );
  return `${PREFIX}${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`;
}

export async function openSecret(sealed: string): Promise<string> {
  if (!sealed || !sealed.startsWith(PREFIX)) return sealed;
  const [ivB64, ctB64] = sealed.slice(PREFIX.length).split(':');
  if (!ivB64 || !ctB64) return '';
  try {
    const key = await getKey();
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64decode(ivB64) as BufferSource },
      key,
      b64decode(ctB64) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return '';
  }
}
