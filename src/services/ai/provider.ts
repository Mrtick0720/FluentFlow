import type { AIMessage } from '@/types/models';
import { TranslationError } from '@/services/translation/provider';

export interface AIProvider {
  complete(messages: AIMessage[]): Promise<string>;
  stream(messages: AIMessage[], onChunk: (text: string) => void): Promise<void>;
}

export class AIError extends TranslationError {}

/** Parse a text/event-stream body, invoking onData for each `data:` payload. */
export async function readSSE(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload && payload !== '[DONE]') onData(payload);
    }
  }
}
