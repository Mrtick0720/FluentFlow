import { describe, expect, it } from 'vitest';
import { normalizeOpenAIBaseUrl } from '@/utils/url';

describe('normalizeOpenAIBaseUrl', () => {
  it('appends /v1 when the host has no path (the common mistake)', () => {
    expect(normalizeOpenAIBaseUrl('https://free.v36.cm')).toBe('https://free.v36.cm/v1');
    expect(normalizeOpenAIBaseUrl('https://free.v36.cm/')).toBe('https://free.v36.cm/v1');
  });

  it('leaves an explicit path untouched', () => {
    expect(normalizeOpenAIBaseUrl('https://free.v36.cm/v1')).toBe('https://free.v36.cm/v1');
    expect(normalizeOpenAIBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(normalizeOpenAIBaseUrl('https://x/v1beta/openai')).toBe('https://x/v1beta/openai');
  });

  it('strips a trailing slash and trims whitespace', () => {
    expect(normalizeOpenAIBaseUrl('  https://api.deepseek.com/v1/  ')).toBe(
      'https://api.deepseek.com/v1',
    );
  });

  it('passes through unparseable input and empty strings', () => {
    expect(normalizeOpenAIBaseUrl('')).toBe('');
    expect(normalizeOpenAIBaseUrl('not a url')).toBe('not a url');
  });
});
