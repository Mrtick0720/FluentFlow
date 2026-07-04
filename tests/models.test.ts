import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchModelIds } from '@/services/ai/models';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchModelIds', () => {
  it('lists ids, strips the Gemini models/ prefix, dedupes and sorts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [
          { id: 'models/gemini-2.5-flash' },
          { id: 'models/gemini-2.5-pro' },
          { id: 'gemini-2.5-flash' }, // dup after stripping
        ],
      }),
    );
    const ids = await fetchModelIds('https://generativelanguage.googleapis.com/v1beta/openai', 'k');
    expect(ids).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
    expect((init as RequestInit | undefined)?.headers).toMatchObject({ Authorization: 'Bearer k' });
  });

  it('appends /v1 to a bare host before /models', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: [{ id: 'deepseek-chat' }] }));
    await fetchModelIds('https://api.deepseek.com', 'k');
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.deepseek.com/v1/models');
  });

  it('throws the HTTP status on failure', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    await expect(fetchModelIds('https://x/v1', 'k')).rejects.toThrow(/HTTP 401/);
  });
});
