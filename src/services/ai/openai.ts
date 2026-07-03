import type { AIMessage } from '@/types/models';
import { expectOk, networkError } from '@/services/translation/provider';
import { AIError, readSSE, type AIProvider } from './provider';

export interface OpenAICompatibleConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
}

/** OpenAI and any OpenAI-compatible chat-completions endpoint. */
export class OpenAICompatibleAI implements AIProvider {
  constructor(private config: OpenAICompatibleConfig) {}

  private async request(messages: AIMessage[], stream: boolean): Promise<Response> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.config.model, messages, stream, temperature: 0.4 }),
      });
    } catch (e) {
      throw networkError('ai', e);
    }
    return expectOk(res, 'ai');
  }

  async complete(messages: AIMessage[]): Promise<string> {
    const res = await this.request(messages, false);
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AIError('provider_error', 'ai: empty completion');
    return content;
  }

  async stream(messages: AIMessage[], onChunk: (text: string) => void): Promise<void> {
    const res = await this.request(messages, true);
    if (!res.body) throw new AIError('provider_error', 'ai: empty stream body');
    await readSSE(res.body, (payload) => {
      try {
        const data = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {
        // tolerate keep-alive / non-JSON lines
      }
    });
  }
}
