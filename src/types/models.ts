/** Core data models for LinguaFlow. Single source of truth. */

export type LanguageCode = string; // BCP-47-ish, e.g. 'en', 'zh-CN', 'auto'

export type DisplayMode = 'bilingual' | 'translation-only' | 'original' | 'side-by-side';

export type TranslationProviderId = 'google' | 'deepl' | 'openai' | 'azure' | 'custom';

export type ReviewStatus = 'new' | 'learning' | 'reviewing' | 'mastered';

export interface TranslationRecord {
  id: string;
  sourceText: string;
  translatedText: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  provider: TranslationProviderId;
  createdAt: number;
}

export interface Vocabulary {
  id: string;
  word: string;
  translation: string;
  ipa?: string;
  partOfSpeech?: string;
  example?: string;
  exampleTranslation?: string;
  cefr?: 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2';
  sourceUrl?: string;
  sourceTitle?: string;
  createdAt: number;
  reviewStatus: ReviewStatus;
  tags: string[];
}

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  notes?: string;
  grammar?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  createdAt: number;
  tags: string[];
}

export interface SubtitleSegment {
  index: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
  translation?: string;
}

export interface SubtitleTrack {
  id: string;
  label: string;
  language: LanguageCode;
  kind: 'captions' | 'subtitles' | 'transcript';
  segments: SubtitleSegment[];
}

export interface Article {
  id: string;
  url: string;
  title: string;
  wordCount: number;
  finishedAt?: number;
  createdAt: number;
}

export interface ReadingSession {
  id: string;
  url: string;
  title?: string;
  startedAt: number;
  durationMs: number;
  kind: 'reading' | 'video';
}

export interface ReviewHistory {
  id: string;
  vocabularyId: string;
  reviewedAt: number;
  outcome: 'again' | 'hard' | 'good' | 'easy';
}

export interface AIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AIConversation {
  id: string;
  title: string;
  pageUrl?: string;
  pageTitle?: string;
  messages: AIMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface DictionaryEntry {
  word: string;
  ipa?: string;
  audioUrl?: string;
  senses: Array<{
    partOfSpeech: string;
    meaning: string;
    meaningTranslation?: string;
    example?: string;
    synonyms: string[];
  }>;
  /** AI-enriched fields; present only when an AI provider is configured. */
  cefr?: Vocabulary['cefr'];
  collocations?: string[];
}

export interface StatsSnapshot {
  wordsLearned: number;
  sentencesCollected: number;
  readingTimeMs: number;
  videosWatched: number;
  articlesFinished: number;
}

export type TranslationErrorCode =
  | 'rate_limited'
  | 'auth'
  | 'network'
  | 'unsupported'
  | 'provider_error';

export interface AppError {
  code: TranslationErrorCode | 'internal' | 'not_configured' | 'permission_denied';
  message: string;
}
