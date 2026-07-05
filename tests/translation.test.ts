import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleProvider, parseGoogleResponse } from '@/services/translation/google';
import { DeepLProvider, toDeepLLang } from '@/services/translation/deepl';
import { AzureProvider, toAzureLang } from '@/services/translation/azure';
import { OpenAIProvider } from '@/services/translation/openai';
import { parseTranslationsJson } from '@/services/translation/openaiCompatible';
import { TranslationError } from '@/services/translation/provider';
import { createDefaultRegistry } from '@/services/translation/registry';
import { TranslationService } from '@/services/translation/service';
import { __resetDbForTests } from '@/services/storage/db';
import { updateSettings } from '@/services/storage/settingsStore';
import { __clearChromeStorage } from './setup';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GoogleProvider', () => {
  it('parses the nested chunk response and preserves order', async () => {
    fetchMock.mockImplementation(async (url: URL) => {
      const q = url.searchParams.get('q');
      return jsonResponse([[[`译:${q}`, q, null]], null, 'en']);
    });
    const provider = new GoogleProvider();
    const out = await provider.translate({ texts: ['one', 'two'], from: 'auto', to: 'zh-CN' }, {});
    expect(out).toEqual(['译:one', '译:two']);
  });

  it('joins multi-chunk responses', () => {
    expect(parseGoogleResponse([[['你好，', 'Hello, '], ['世界', 'world']]])).toBe('你好，世界');
  });

  it('classifies HTTP 429 as rate_limited', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429));
    const provider = new GoogleProvider();
    await expect(
      provider.translate({ texts: ['x'], from: 'auto', to: 'zh-CN' }, {}),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('DeepLProvider', () => {
  it('uses the free host for :fx keys and maps languages', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ translations: [{ text: '你好' }] }));
    const provider = new DeepLProvider();
    const out = await provider.translate(
      { texts: ['hello'], from: 'en', to: 'zh-CN' },
      { apiKey: 'abc:fx' },
    );
    expect(out).toEqual(['你好']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('api-free.deepl.com');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.target_lang).toBe('ZH-HANS');
    expect(body.source_lang).toBe('EN');
  });

  it('throws auth error without a key', async () => {
    const provider = new DeepLProvider();
    await expect(
      provider.translate({ texts: ['x'], from: 'auto', to: 'zh-CN' }, {}),
    ).rejects.toMatchObject({ code: 'auth' });
  });

  it('maps language edge cases', () => {
    expect(toDeepLLang('zh-TW')).toBe('ZH-HANT');
    expect(toDeepLLang('en')).toBe('EN-US');
    expect(toDeepLLang('ja')).toBe('JA');
  });
});

describe('AzureProvider', () => {
  it('sends one item per text and reads translations back', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { translations: [{ text: '一' }] },
        { translations: [{ text: '二' }] },
      ]),
    );
    const provider = new AzureProvider();
    const out = await provider.translate(
      { texts: ['one', 'two'], from: 'auto', to: 'zh-CN' },
      { apiKey: 'key', region: 'eastasia' },
    );
    expect(out).toEqual(['一', '二']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('to=zh-Hans');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Region']).toBe('eastasia');
  });

  it('maps chinese variants', () => {
    expect(toAzureLang('zh-CN')).toBe('zh-Hans');
    expect(toAzureLang('zh-TW')).toBe('zh-Hant');
  });
});

describe('OpenAI-compatible parsing', () => {
  it('accepts {"translations": [...]} and bare arrays and fenced JSON', () => {
    expect(parseTranslationsJson('t', '{"translations": ["a"]}', 1)).toEqual(['a']);
    expect(parseTranslationsJson('t', '["a", "b"]', 2)).toEqual(['a', 'b']);
    expect(parseTranslationsJson('t', '```json\n{"translations": ["a"]}\n```', 1)).toEqual(['a']);
  });

  it('rejects count mismatches', () => {
    expect(() => parseTranslationsJson('t', '{"translations": ["a"]}', 2)).toThrow(
      TranslationError,
    );
  });

  it('extracts JSON embedded in prose', () => {
    expect(parseTranslationsJson('t', 'Sure! {"translations": ["a"]} done', 1)).toEqual(['a']);
  });

  it('falls back to raw text for a single line (model ignored JSON format)', () => {
    expect(parseTranslationsJson('t', '你好世界', 1)).toEqual(['你好世界']);
    expect(parseTranslationsJson('t', '"你好"', 1)).toEqual(['你好']);
  });

  it('recovers a single translation from a differently shaped object', () => {
    expect(parseTranslationsJson('t', '{"translation": "你好"}', 1)).toEqual(['你好']);
    expect(parseTranslationsJson('t', '{"result": {"text": "你好"}}', 1)).toEqual(['你好']);
  });

  it('classifies 401 as auth error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 401));
    const provider = new OpenAIProvider();
    await expect(
      provider.translate({ texts: ['x'], from: 'auto', to: 'zh-CN' }, { apiKey: 'sk-x' }),
    ).rejects.toMatchObject({ code: 'auth' });
  });
});

describe('TranslationService', () => {
  beforeEach(async () => {
    __clearChromeStorage();
    await __resetDbForTests();
  });

  it('serves repeat requests from cache (provider called once)', async () => {
    await updateSettings({ translationProvider: 'google' });
    fetchMock.mockImplementation(async (url: URL) =>
      jsonResponse([[[`译:${url.searchParams.get('q')}`, '', null]]]),
    );
    const service = new TranslationService(createDefaultRegistry());

    const first = await service.translate({ texts: ['hello'], from: 'auto', to: 'zh-CN' });
    expect(first.translations).toEqual(['译:hello']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const second = await service.translate({ texts: ['hello'], from: 'auto', to: 'zh-CN' });
    expect(second.translations).toEqual(['译:hello']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('degrades a failed batch to per-line requests', async () => {
    await updateSettings({
      translationProvider: 'custom:a',
      customEndpoints: [
        { id: 'a', name: 'X', baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk' },
      ],
    });
    // Batch request (2 texts) returns unparseable prose; single-text requests
    // return the plain translation (recovered by the single-line fallback).
    fetchMock.mockImplementation(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const inputs = JSON.parse(body.messages[1]!.content) as string[];
      if (inputs.length > 1) {
        return jsonResponse({ choices: [{ message: { content: 'sorry, no json here' } }] });
      }
      return jsonResponse({ choices: [{ message: { content: `译:${inputs[0]}` } }] });
    });
    const service = new TranslationService(createDefaultRegistry());
    const out = await service.translate({ texts: ['a', 'b'], from: 'auto', to: 'zh-CN' });
    expect(out.translations).toEqual(['译:a', '译:b']);
  });

  it('bypasses cache read with refresh', async () => {
    await updateSettings({ translationProvider: 'google' });
    fetchMock.mockImplementation(async (url: URL) =>
      jsonResponse([[[`译:${url.searchParams.get('q')}`, '', null]]]),
    );
    const service = new TranslationService(createDefaultRegistry());
    await service.translate({ texts: ['hi'], from: 'auto', to: 'zh-CN' });
    await service.translate({ texts: ['hi'], from: 'auto', to: 'zh-CN', refresh: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('routes custom:<id> to the selected saved endpoint config', async () => {
    await updateSettings({
      translationProvider: 'custom:a',
      customEndpoints: [
        { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-a' },
      ],
    });
    fetchMock.mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ translations: ['你好'] }) } }] }),
    );
    const service = new TranslationService(createDefaultRegistry());
    const out = await service.translate({ texts: ['hello'], from: 'auto', to: 'zh-CN' });

    expect(out.translations).toEqual(['你好']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.deepseek.com/v1/chat/completions');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-a');
  });
});
