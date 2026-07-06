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

const MAX_SENTENCE_CHARS = 100;
const SOFT_SENTENCE_CHARS = 65;
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
  // `cueEnd` = the source cue's real end (tStartMs + dDurationMs), undefined for
  // legacy word-streams that don't expose a duration.
  const words: Array<{ text: string; startMs: number; cueEnd?: number; boundary?: boolean }> = [];
  let pendingBoundary = false;
  for (const event of data.events ?? []) {
    if (!event.segs || event.aAppend) continue;
    const base = event.tStartMs ?? 0;
    const cueEnd = event.dDurationMs ? base + event.dDurationMs : undefined;
    for (const seg of event.segs) {
      let text = (seg.utf8 ?? '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // CC speaker-change markers: force a boundary, drop the marker itself.
      if (/^>{1,2}$/.test(text)) {
        pendingBoundary = true;
        continue;
      }
      if (/^>{1,2}\s*/.test(text)) {
        pendingBoundary = true;
        text = text.replace(/^>+\s*/, '');
        if (!text) continue;
      }
      words.push({ text, startMs: base + (seg.tOffsetMs ?? 0), cueEnd, boundary: pendingBoundary });
      pendingBoundary = false;
    }
  }

  const segments: SubtitleSegment[] = [];
  let current: { parts: string[]; startMs: number; cueEnd?: number } | null = null;

  // End a sentence from the SOURCE cue timing when possible, so the timeline
  // matches what YouTube actually displays. Priority:
  //   1) the cue's real end (tStartMs + dDurationMs)
  //   2) the next sentence's start (contiguous — no artificial gap)
  //   3) legacy: lastWord + SENTENCE_GAP_MS (only when no duration at all)
  // The end never crosses the next sentence's start (no overlap).
  const flush = (nextStartMs?: number) => {
    if (!current) return;
    const text = current.parts.join(' ').replace(/\s+/g, ' ').trim();
    if (text) {
      let endMs = current.cueEnd ?? nextStartMs ?? current.startMs + SENTENCE_GAP_MS;
      if (nextStartMs !== undefined && endMs > nextStartMs) endMs = nextStartMs; // no overlap
      if (endMs <= current.startMs) endMs = current.startMs + 200; // keep a visible duration
      segments.push({
        index: segments.length,
        start: current.startMs / 1000,
        end: endMs / 1000,
        text,
      });
    }
    current = null;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const next = words[i + 1];
    if (word.boundary) flush(word.startMs); // speaker change
    current ??= { parts: [], startMs: word.startMs, cueEnd: word.cueEnd };
    current.parts.push(word.text);
    current.cueEnd = word.cueEnd; // extend to this word's cue end (undefined = no duration)

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
    if (shouldBreak) flush(next?.startMs);
  }
  flush();

  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('lf-subtitle-debug') === '1') {
      const rawCues = (data.events ?? [])
        .filter((e) => e.segs && !e.aAppend)
        .slice(0, 10)
        .map((e, i) => {
          const start = (e.tStartMs ?? 0) / 1000;
          const end = ((e.tStartMs ?? 0) + (e.dDurationMs ?? 0)) / 1000;
          const text = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
          return `  #${i} [${start.toFixed(2)}‥${end.toFixed(2)}] "${text.slice(0, 40)}"`;
        })
        .join('\n');
      console.log('[Timeline raw] first 10 YouTube caption cues (start‥end):\n' + rawCues);
      const grouped = segments
        .slice(0, 10)
        .map((s) => `  #${s.index} [${s.start.toFixed(2)}‥${s.end.toFixed(2)}] "${s.text.slice(0, 40)}"`)
        .join('\n');
      console.log('[Timeline grouped] first 10 grouped sentences (start‥end):\n' + grouped);
    }
  } catch {
    /* logging only */
  }
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
