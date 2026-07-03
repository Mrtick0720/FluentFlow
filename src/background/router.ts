import type { Envelope, RequestMap, RequestType, Response } from '@/shared/messages';
import type { AppError } from '@/types/models';
import { TranslationError } from '@/services/translation/provider';

type Handler<T extends RequestType> = (
  payload: RequestMap[T]['req'],
  sender: chrome.runtime.MessageSender,
) => Promise<RequestMap[T]['res']>;

/** Typed request/response hub for the service worker. */
export class MessageRouter {
  private handlers = new Map<RequestType, Handler<RequestType>>();

  on<T extends RequestType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as Handler<RequestType>);
    return this;
  }

  listen(): void {
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      const envelope = message as Envelope;
      if (!envelope || envelope.kind !== 'lf-request') return undefined;
      const handler = this.handlers.get(envelope.type);
      if (!handler) {
        sendResponse({
          ok: false,
          error: { code: 'internal', message: `No handler for ${envelope.type}` },
        } satisfies Response<never>);
        return undefined;
      }
      handler(envelope.payload, sender)
        .then((data) => sendResponse({ ok: true, data } satisfies Response<unknown>))
        .catch((err: unknown) => {
          sendResponse({ ok: false, error: toAppError(err) } satisfies Response<never>);
        });
      return true; // keep the channel open for the async response
    });
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof TranslationError) return { code: err.code, message: err.message };
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return { code: (err as AppError).code, message: String((err as AppError).message) };
  }
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}
