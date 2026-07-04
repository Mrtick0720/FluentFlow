import type {
  AIConversation,
  AIMessage,
  AppError,
  DictionaryEntry,
  DisplayMode,
  LanguageCode,
  Sentence,
  StatsSnapshot,
  TranslationProviderId,
  Vocabulary,
} from '@/types/models';
import type { UserSettings } from '@/shared/settings';

/**
 * Typed RPC between contexts. Every request type maps to its request/response
 * payloads; both sides get compile-time checking through `sendRequest` and the
 * background router's handler map.
 */
export interface RequestMap {
  'translation.translate': {
    req: {
      texts: string[];
      from: LanguageCode;
      to: LanguageCode;
      provider?: TranslationProviderId;
      /** skip cache read (still writes) */
      refresh?: boolean;
    };
    res: { translations: string[]; provider: TranslationProviderId };
  };
  'dictionary.lookup': {
    req: { word: string; context?: string };
    res: DictionaryEntry;
  };
  'vocabulary.add': { req: Omit<Vocabulary, 'id' | 'createdAt'>; res: Vocabulary };
  'vocabulary.list': {
    req: { query?: string; tag?: string; status?: Vocabulary['reviewStatus'] };
    res: Vocabulary[];
  };
  'vocabulary.update': { req: Vocabulary; res: Vocabulary };
  'vocabulary.remove': { req: { id: string }; res: null };
  'vocabulary.import': { req: { items: Vocabulary[] }; res: { imported: number } };
  /** Flashcard review: updates review status and logs history. */
  'vocabulary.review': { req: { id: string; outcome: 'again' | 'good' }; res: Vocabulary };
  'sentences.add': { req: Omit<Sentence, 'id' | 'createdAt'>; res: Sentence };
  'sentences.list': { req: { query?: string; tag?: string }; res: Sentence[] };
  'sentences.update': { req: Sentence; res: Sentence };
  'sentences.remove': { req: { id: string }; res: null };
  'settings.get': { req: null; res: UserSettings };
  'settings.set': { req: { patch: Partial<UserSettings> }; res: UserSettings };
  'stats.record': {
    req:
      | { kind: 'reading-time' | 'video-time'; ms: number; url: string; title?: string }
      | { kind: 'video-watched' | 'article-finished'; url: string; title?: string };
    res: null;
  };
  'stats.get': { req: null; res: StatsSnapshot };
  'ai.complete': {
    req: { messages: AIMessage[]; cacheKey?: string };
    res: { text: string };
  };
  'conversations.list': { req: null; res: AIConversation[] };
  'conversations.save': { req: AIConversation; res: AIConversation };
  'conversations.remove': { req: { id: string }; res: null };
  'cache.clear': { req: { scope: 'translation' | 'dictionary' | 'ai' | 'all' }; res: null };
  /** List model ids from an OpenAI-compatible endpoint's /models. */
  'models.list': { req: { target: 'translationCustom' | 'ai' }; res: { models: string[] } };
  'permissions.requestOrigin': { req: { origin: string }; res: { granted: boolean } };
  'sidepanel.open': { req: null; res: null };
}

/** Messages the background sends to a tab's content script. */
export interface TabRequestMap {
  'content.toggleTranslation': { req: null; res: { active: boolean } };
  'content.setDisplayMode': { req: { mode: DisplayMode }; res: null };
  'content.translateSelection': { req: null; res: null };
  'content.getPageContext': {
    req: null;
    res: { url: string; title: string; text: string; selection?: string };
  };
}

export type RequestType = keyof RequestMap;
export type TabRequestType = keyof TabRequestMap;

export interface Envelope<T extends RequestType = RequestType> {
  kind: 'lf-request';
  type: T;
  payload: RequestMap[T]['req'];
}

export interface TabEnvelope<T extends TabRequestType = TabRequestType> {
  kind: 'lf-tab-request';
  type: T;
  payload: TabRequestMap[T]['req'];
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: AppError };

export async function sendRequest<T extends RequestType>(
  type: T,
  payload: RequestMap[T]['req'],
): Promise<RequestMap[T]['res']> {
  const envelope: Envelope<T> = { kind: 'lf-request', type, payload };
  const res = (await chrome.runtime.sendMessage(envelope)) as Response<RequestMap[T]['res']>;
  if (!res) throw Object.assign(new Error('No response from background'), { code: 'internal' });
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}

export async function sendToTab<T extends TabRequestType>(
  tabId: number,
  type: T,
  payload: TabRequestMap[T]['req'],
): Promise<TabRequestMap[T]['res']> {
  const envelope: TabEnvelope<T> = { kind: 'lf-tab-request', type, payload };
  const res = (await chrome.tabs.sendMessage(tabId, envelope)) as Response<
    TabRequestMap[T]['res']
  >;
  if (!res) throw Object.assign(new Error('No response from tab'), { code: 'internal' });
  if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}

/** Streaming AI over a long-lived port. */
export const AI_STREAM_PORT = 'lf-ai-stream';

export interface AIStreamRequest {
  messages: AIMessage[];
}

export type AIStreamEvent =
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: AppError };
