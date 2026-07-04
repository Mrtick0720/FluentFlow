/**
 * Closed message protocol between the top frame (full LinguaFlow app) and a
 * child frame running the subtitle-only runtime (embedded players such as
 * YouTube in Khan Academy). Only these fixed shapes cross a frame boundary —
 * never subtitle text, credentials, or provider settings.
 */

export type SubtitleFrameCommand = 'toggle' | 'open' | 'close';
export type SubtitleFrameStatus = 'ready' | 'no-video' | 'no-subtitles' | 'closed';

export type FrameMessage =
  | { source: 'linguaflow'; type: 'subtitle-command'; command: SubtitleFrameCommand }
  | { source: 'linguaflow'; type: 'subtitle-frame-ready' }
  | {
      source: 'linguaflow';
      type: 'subtitle-frame-state';
      status: SubtitleFrameStatus;
      mode?: 'track' | 'live';
    };

export const makeFrameCommand = (command: SubtitleFrameCommand): FrameMessage => ({
  source: 'linguaflow',
  type: 'subtitle-command',
  command,
});

export const makeFrameState = (status: SubtitleFrameStatus, mode?: 'track' | 'live'): FrameMessage => ({
  source: 'linguaflow',
  type: 'subtitle-frame-state',
  status,
  ...(mode ? { mode } : {}),
});

export function isFrameMessage(value: unknown): value is FrameMessage {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.source !== 'linguaflow') return false;
  if (v.type === 'subtitle-frame-ready') return true;
  if (v.type === 'subtitle-command') return ['toggle', 'open', 'close'].includes(String(v.command));
  return (
    v.type === 'subtitle-frame-state' &&
    ['ready', 'no-video', 'no-subtitles', 'closed'].includes(String(v.status))
  );
}
