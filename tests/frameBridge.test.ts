import { describe, expect, it } from 'vitest';
import {
  isFrameMessage,
  makeFrameCommand,
  makeFrameState,
  shouldStartSubtitleFrame,
} from '@/content/frameBridge';

describe('subtitle frame messages', () => {
  it('accepts only the fixed LinguaFlow command contract', () => {
    expect(isFrameMessage(makeFrameCommand('toggle'))).toBe(true);
    expect(isFrameMessage({ source: 'other', type: 'subtitle-command', command: 'toggle' })).toBe(false);
    expect(isFrameMessage({ source: 'linguaflow', type: 'subtitle-command', command: 'delete' })).toBe(false);
  });

  it('serializes child readiness and subtitle status', () => {
    expect(makeFrameState('ready', 'track')).toEqual({
      source: 'linguaflow', type: 'subtitle-frame-state', status: 'ready', mode: 'track',
    });
  });
});

describe('shouldStartSubtitleFrame', () => {
  it('starts child runtime only for a meaningful video frame', () => {
    expect(shouldStartSubtitleFrame(false, [{ width: 800, height: 450 }])).toBe(true);
    expect(shouldStartSubtitleFrame(false, [{ width: 120, height: 80 }])).toBe(false);
    expect(shouldStartSubtitleFrame(true, [{ width: 800, height: 450 }])).toBe(false);
  });
});
