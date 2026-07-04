import { normalizeOpenAIBaseUrl } from '@/utils/url';

/**
 * List model ids exposed by an OpenAI-compatible endpoint (`GET /models`).
 * Gemini's OpenAI-compat layer prefixes ids with `models/`; that prefix is
 * stripped so the id can be used directly in a chat request.
 */
export async function fetchModelIds(baseUrl: string, apiKey?: string): Promise<string[]> {
  const url = `${normalizeOpenAIBaseUrl(baseUrl)}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  const ids = (data.data ?? [])
    .map((m) => (typeof m.id === 'string' ? m.id.replace(/^models\//, '') : ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}
