import { describe, expect, it } from 'vitest';
import { parseQualityJson } from '@/services/translation/quality';

describe('parseQualityJson', () => {
  it('parses translations, domain, and a domain-tagged glossary', () => {
    const out = parseQualityJson(
      'custom',
      JSON.stringify({
        translations: ['对齐陷阱', '一段正文'],
        domain: 'AI',
        glossary: { alignment: { translation: '对齐', domain: 'AI' } },
      }),
      2,
    );
    expect(out.translations).toEqual(['对齐陷阱', '一段正文']);
    expect(out.domain).toBe('AI');
    expect(out.glossary).toEqual({ alignment: { translation: '对齐', domain: 'AI' } });
  });

  it('tags a bare "term": "translation" entry with the response domain', () => {
    const out = parseQualityJson(
      'custom',
      JSON.stringify({ translations: ['x'], domain: 'Finance', glossary: { position: '仓位' } }),
      1,
    );
    expect(out.glossary).toEqual({ position: { translation: '仓位', domain: 'Finance' } });
  });

  it('tolerates a missing glossary and domain', () => {
    const out = parseQualityJson('custom', JSON.stringify({ translations: ['你好'] }), 1);
    expect(out.translations).toEqual(['你好']);
    expect(out.glossary).toEqual({});
    expect(out.domain).toBeUndefined();
  });

  it('strips code fences before parsing', () => {
    const out = parseQualityJson('custom', '```json\n{"translations":["嗨"]}\n```', 1);
    expect(out.translations).toEqual(['嗨']);
  });

  it('throws when the translation count does not match', () => {
    expect(() =>
      parseQualityJson('custom', JSON.stringify({ translations: ['只有一个'] }), 2),
    ).toThrow(/expected 2 translations/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseQualityJson('custom', 'not json at all', 1)).toThrow(/valid JSON/);
  });

  it('ignores glossary entries without a string translation', () => {
    const out = parseQualityJson(
      'custom',
      JSON.stringify({
        translations: ['x'],
        glossary: { a: { translation: '甲', domain: 'Law' }, b: { note: 5 } },
      }),
      1,
    );
    expect(out.glossary).toEqual({ a: { translation: '甲', domain: 'Law' } });
  });
});
