import type { SubtitleSegment, SubtitleTrack } from '@/types/models';

/**
 * YouTube full-transcript support via the public timedtext data.
 *
 * The player itself downloads the complete caption track (including
 * auto-generated ASR tracks) for every viewer: the watch page embeds
 * `captionTracks` with a `baseUrl` per track inside ytInitialPlayerResponse.
 * Fetching that URL with `fmt=json3` returns every word with precise timing
 * for the whole video. This is the same publicly accessible data the player's
 * transcript panel shows — no login, DRM, or protection is bypassed.
 */

/* ---------- player-URL capture (POT-signed) ----------
 * YouTube's timedtext endpoint now requires a proof-of-origin token that only
 * the live player generates: the bare baseUrl from page HTML returns an empty
 * body. A read-only MAIN-world hook (public/pagehook.js) reports the URL the
 * player itself fetches (available once the user enables CC); we reuse it.
 */

let capturedUrl: string | null = null;
const captureCallbacks: Array<(url: string) => void> = [];

export function initTimedTextCapture(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { source?: string; type?: string; url?: string } | null;
    if (data?.source !== 'linguaflow-pagehook' || data.type !== 'timedtext-url') return;
    if (typeof data.url !== 'string' || !data.url.includes('/api/timedtext')) return;
    const changed = data.url !== capturedUrl;
    capturedUrl = data.url;
    if (changed) for (const cb of captureCallbacks) cb(data.url);
  });
  // Ask the hook for anything it saw before we loaded.
  window.postMessage({ source: 'linguaflow', type: 'timedtext-query' }, location.origin);
}

export function onTimedTextCaptured(cb: (url: string) => void): void {
  captureCallbacks.push(cb);
}

/** Ask for the full track in json3, in the source language (drop player auto-translate). */
export function normalizeTimedTextUrl(raw: string, origin = 'https://www.youtube.com'): string {
  const url = new URL(raw, origin);
  url.searchParams.set('fmt', 'json3');
  url.searchParams.delete('tlang');
  return url.toString();
}

/** The v= param of a timedtext URL, to reject captures from a previous video. */
export function timedTextVideoId(raw: string, origin = 'https://www.youtube.com'): string | null {
  try {
    return new URL(raw, origin).searchParams.get('v');
  } catch {
    return null;
  }
}

export interface CaptionTrackInfo {
  baseUrl: string;
  languageCode: string;
  kind?: string; // 'asr' for auto-generated
  name?: { simpleText?: string; runs?: Array<{ text: string }> };
}

/** Extract the captionTracks JSON array from watch-page HTML. */
export function extractCaptionTracks(source: string): CaptionTrackInfo[] {
  const key = '"captionTracks":';
  const at = source.indexOf(key);
  if (at === -1) return [];
  const start = source.indexOf('[', at + key.length);
  if (start === -1) return [];

  // Balanced-bracket scan that respects JSON strings.
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) return [];
  try {
    const parsed = JSON.parse(source.slice(start, end)) as CaptionTrackInfo[];
    return parsed.filter((t) => typeof t.baseUrl === 'string');
  } catch {
    return [];
  }
}

/** Prefer a human-made English track, then English ASR, then the first track. */
export function pickCaptionTrack(
  tracks: CaptionTrackInfo[],
  preferredLanguage = 'en',
): CaptionTrackInfo | undefined {
  const lang = (t: CaptionTrackInfo) => t.languageCode.toLowerCase();
  return (
    tracks.find((t) => lang(t).startsWith(preferredLanguage) && t.kind !== 'asr') ??
    tracks.find((t) => lang(t).startsWith(preferredLanguage)) ??
    tracks[0]
  );
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
}

const MAX_SENTENCE_CHARS = 160;
const SOFT_SENTENCE_CHARS = 110;
const SENTENCE_GAP_MS = 2000;
const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_PUNCT_END = /[,;:，；：]$/;
const CLAUSE_CONJUNCTION = /^(and|but|so|or|because|which|that|when|while|then|where|although)$/i;

/**
 * Turn the word/line stream of a json3 timedtext document into sentences:
 * break on end punctuation, long pauses, or excessive length. Past a soft
 * length cap, clause boundaries (comma / conjunction) also break, so
 * punctuation-light ASR speech still yields readable lines.
 */
export function segmentsFromTimedText(data: { events?: Json3Event[] }): SubtitleSegment[] {
  const words: Array<{ text: string; startMs: number }> = [];
  for (const event of data.events ?? []) {
    if (!event.segs || event.aAppend) continue;
    const base = event.tStartMs ?? 0;
    for (const seg of event.segs) {
      const text = (seg.utf8 ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      words.push({ text, startMs: base + (seg.tOffsetMs ?? 0) });
    }
  }

  const segments: SubtitleSegment[] = [];
  let current: { parts: string[]; startMs: number } | null = null;

  const flush = (endMs: number) => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      segments.push({
        index: segments.length,
        start: current.startMs / 1000,
        end: Math.max(endMs, current.startMs + 200) / 1000,
        text,
      });
    }
    current = null;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = words[i + 1];
    current ??= { parts: [], startMs: word.startMs };
    current.parts.push(word.text);

    const gapMs = next ? next.startMs - word.startMs : Number.POSITIVE_INFINITY;
    const length = current.parts.join(' ').length;
    const clauseBreak =
      length > SOFT_SENTENCE_CHARS &&
      (CLAUSE_PUNCT_END.test(word.text) || (next !== undefined && CLAUSE_CONJUNCTION.test(next.text)));
    const shouldBreak =
      SENTENCE_END.test(word.text) ||
      gapMs > SENTENCE_GAP_MS ||
      length > MAX_SENTENCE_CHARS ||
      clauseBreak;
    if (shouldBreak) {
      flush(next ? Math.min(next.startMs, word.startMs + SENTENCE_GAP_MS) : word.startMs + SENTENCE_GAP_MS);
    }
  }
  flush(words.length ? words[words.length - 1]!.startMs + SENTENCE_GAP_MS : 0);
  return segments;
}

function trackLabel(info: CaptionTrackInfo): string {
  const name = info.name?.simpleText ?? info.name?.runs?.map((r) => r.text).join('');
  return name || info.languageCode;
}

async function fetchSegments(url: string): Promise<SubtitleSegment[]> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) return [];
  const body = await res.text();
  if (!body) return []; // POT-rejected requests return 200 with an empty body
  try {
    return segmentsFromTimedText(JSON.parse(body) as { events?: Json3Event[] });
  } catch {
    return [];
  }
}

function currentVideoId(): string | null {
  return new URLSearchParams(location.search).get('v');
}

/**
 * Fetch the full transcript for the video on the current watch page.
 * Prefers the POT-signed URL the player itself used (captured by the page
 * hook once the user enables CC); falls back to the bare baseUrl, which
 * still works in some regions. Returns [] when nothing is available
 * (caller falls back to live caption mirroring).
 */
export async function fetchYouTubeTranscript(): Promise<SubtitleTrack[]> {
  // 1) The player's own caption request, reused verbatim (minus format).
  if (capturedUrl) {
    const videoId = currentVideoId();
    const capturedFor = timedTextVideoId(capturedUrl, location.origin);
    if (!videoId || !capturedFor || capturedFor === videoId) {
      const segments = await fetchSegments(normalizeTimedTextUrl(capturedUrl, location.origin));
      if (segments.length > 0) {
        const lang = new URL(capturedUrl, location.origin).searchParams.get('lang') ?? 'und';
        return [
          {
            id: 'yt-transcript',
            label: `${lang} · 完整字幕`,
            language: lang,
            kind: 'captions',
            segments,
          },
        ];
      }
    }
  }

  // 2) Bare baseUrl from the watch page (may be rejected with an empty body).
  const pageRes = await fetch(location.href, { credentials: 'same-origin' });
  if (!pageRes.ok) return [];
  const tracks = extractCaptionTracks(await pageRes.text());
  const info = pickCaptionTrack(tracks);
  if (!info) return [];

  const segments = await fetchSegments(normalizeTimedTextUrl(info.baseUrl, location.origin));
  if (segments.length === 0) return [];

  return [
    {
      id: 'yt-transcript',
      label: info.kind === 'asr' ? `${trackLabel(info)} · 自动生成` : trackLabel(info),
      language: info.languageCode,
      kind: 'captions',
      segments,
    },
  ];
}
