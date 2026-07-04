import { describe, expect, it } from 'vitest';
import { isFrameMessage, makeFrameCommand, makeFrameState } from '@/content/frameBridge';

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
