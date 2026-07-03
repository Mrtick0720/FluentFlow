import { cacheGet, cacheSet } from '@/services/cache/ttlCache';
import { getSettings } from '@/services/storage/settingsStore';
import type { AISettings } from '@/shared/settings';
import type { AIMessage } from '@/types/models';
import { AnthropicAI } from './anthropic';
import { OpenAICompatibleAI } from './openai';
import { AIError, type AIProvider } from './provider';

export function createAIProvider(ai: AISettings): AIProvider {
  switch (ai.kind) {
    case 'openai':
      if (!ai.apiKey) throw new AIError('not_configured', 'AI: OpenAI API key not configured');
      return new OpenAICompatibleAI({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl || 'https://api.openai.com/v1',
        model: ai.model || 'gpt-4o-mini',
      });
    case 'anthropic':
      if (!ai.apiKey) throw new AIError('not_configured', 'AI: Anthropic API key not configured');
      return new AnthropicAI({ apiKey: ai.apiKey, baseUrl: ai.baseUrl, model: ai.model });
    case 'custom':
      if (!ai.baseUrl) throw new AIError('not_configured', 'AI: custom base URL not configured');
      return new OpenAICompatibleAI({
        apiKey: ai.apiKey,
        baseUrl: ai.baseUrl,
        model: ai.model || 'gpt-4o-mini',
      });
    case 'none':
      throw new AIError('not_configured', 'AI: no provider configured (see Options → AI)');
  }
}

export class AIService {
  async isConfigured(): Promise<boolean> {
    const settings = await getSettings();
    return settings.ai.kind !== 'none';
  }

  async complete(messages: AIMessage[], cacheKey?: string): Promise<string> {
    const settings = await getSettings();
    if (cacheKey && settings.cache.enabled) {
      const hit = await cacheGet<string>('ai', cacheKey);
      if (hit !== undefined) return hit;
    }
    const provider = createAIProvider(settings.ai);
    const text = await provider.complete(messages);
    if (cacheKey && settings.cache.enabled) {
      await cacheSet('ai', cacheKey, text, settings.cache.ttlHours * 3600_000);
    }
    return text;
  }

  async stream(messages: AIMessage[], onChunk: (text: string) => void): Promise<void> {
    const settings = await getSettings();
    const provider = createAIProvider(settings.ai);
    await provider.stream(messages, onChunk);
  }
}
