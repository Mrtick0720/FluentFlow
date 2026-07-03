import type { AIMessage } from '@/types/models';
import { expectOk, networkError } from '@/services/translation/provider';
import { AIError, readSSE, type AIProvider } from './provider';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export class AnthropicAI implements AIProvider {
  constructor(private config: AnthropicConfig) {}

  private async request(messages: AIMessage[], stream: boolean): Promise<Response> {
    const baseUrl = (this.config.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const chat = messages.filter((m) => m.role !== 'system');

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: this.config.model || 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          ...(system ? { system } : {}),
          messages: chat,
          stream,
        }),
      });
    } catch (e) {
      throw networkError('ai', e);
    }
    return expectOk(res, 'ai');
  }

  async complete(messages: AIMessage[]): Promise<string> {
    const res = await this.request(messages, false);
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content
      ?.filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    if (!text) throw new AIError('provider_error', 'ai: empty completion');
    return text;
  }

  async stream(messages: AIMessage[], onChunk: (text: string) => void): Promise<void> {
    const res = await this.request(messages, true);
    if (!res.body) throw new AIError('provider_error', 'ai: empty stream body');
    await readSSE(res.body, (payload) => {
      try {
        const event = JSON.parse(payload) as {
          type?: string;
          delta?: { type?: string; text?: string };
        };
        if (event.type === 'content_block_delta' && event.delta?.text) {
          onChunk(event.delta.text);
        }
      } catch {
        // tolerate non-JSON lines
      }
    });
  }
}
