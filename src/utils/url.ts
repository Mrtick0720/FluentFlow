/**
 * Normalize an OpenAI-compatible base URL. The most common mistake is
 * omitting the version path (`https://host` instead of `https://host/v1`),
 * which makes requests hit `/chat/completions` and 404. When no meaningful
 * path is given we append `/v1`; an explicit path (e.g. Gemini's
 * `/v1beta/openai`) is left untouched.
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return trimmed;
  const stripSuffix = (path: string) =>
    path.replace(/\/(chat\/completions|completions|models)\/?$/i, '');
  try {
    const url = new URL(trimmed);
    // Users often paste the full endpoint URL; drop the well-known suffix so we
    // don't append /chat/completions or /models twice.
    url.pathname = stripSuffix(url.pathname);
    if (url.pathname === '' || url.pathname === '/') url.pathname = '/v1';
    return url.toString().replace(/\/$/, '');
  } catch {
    return stripSuffix(trimmed.replace(/\/$/, ''));
  }
}
