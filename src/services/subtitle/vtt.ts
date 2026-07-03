import type { SubtitleSegment } from '@/types/models';

/**
 * Minimal WebVTT parser: cue timings + text. Ignores NOTE/STYLE/REGION blocks,
 * cue settings, and voice/positioning tags (tags are stripped from text).
 */
export function parseVtt(source: string): SubtitleSegment[] {
  const segments: SubtitleSegment[] = [];
  const blocks = source.replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;
    const first = lines[0]!.trim();
    if (first.startsWith('WEBVTT') || first.startsWith('NOTE') || first.startsWith('STYLE') || first.startsWith('REGION')) {
      continue;
    }

    let timingLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timingLineIndex === -1) continue;
    const timing = lines[timingLineIndex]!;
    const match = timing.match(
      /(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})/,
    );
    if (!match) continue;

    const start = toSeconds(match[1], match[2]!, match[3]!, match[4]!);
    const end = toSeconds(match[5], match[6]!, match[7]!, match[8]!);
    const text = lines
      .slice(timingLineIndex + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;

    segments.push({ index: segments.length, start, end, text });
  }
  return segments;
}

function toSeconds(hoursPart: string | undefined, mins: string, secs: string, ms: string): number {
  const hours = hoursPart ? parseInt(hoursPart, 10) : 0;
  return hours * 3600 + parseInt(mins, 10) * 60 + parseInt(secs, 10) + parseInt(ms, 10) / 1000;
}

/** Convert loaded TextTrack cues into segments (native <track> path). */
export function segmentsFromCues(cues: TextTrackCueList | null): SubtitleSegment[] {
  if (!cues) return [];
  const segments: SubtitleSegment[] = [];
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i] as VTTCue;
    const text = (cue.text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    segments.push({ index: segments.length, start: cue.startTime, end: cue.endTime, text });
  }
  return segments;
}
