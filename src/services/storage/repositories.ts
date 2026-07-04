import { idb, STORES } from '@/services/storage/db';
import type {
  AIConversation,
  ReadingSession,
  ReviewHistory,
  Sentence,
  StatsSnapshot,
  Vocabulary,
} from '@/types/models';

function newId(): string {
  return crypto.randomUUID();
}

function matchesQuery(haystack: Array<string | undefined>, query: string): boolean {
  const q = query.toLowerCase();
  return haystack.some((h) => h?.toLowerCase().includes(q));
}

/** Simple ladder: again drops back to learning, good climbs one rung. */
export function nextReviewStatus(
  current: Vocabulary['reviewStatus'],
  outcome: 'again' | 'good',
): Vocabulary['reviewStatus'] {
  if (outcome === 'again') return 'learning';
  const ladder: Record<Vocabulary['reviewStatus'], Vocabulary['reviewStatus']> = {
    new: 'learning',
    learning: 'reviewing',
    reviewing: 'mastered',
    mastered: 'mastered',
  };
  return ladder[current];
}

export class VocabularyRepository {
  async get(id: string): Promise<Vocabulary | undefined> {
    return idb.get<Vocabulary>(STORES.vocabulary, id);
  }

  async add(input: Omit<Vocabulary, 'id' | 'createdAt'>): Promise<Vocabulary> {
    const item: Vocabulary = { ...input, id: newId(), createdAt: Date.now() };
    await idb.put(STORES.vocabulary, item);
    return item;
  }

  async list(filter?: {
    query?: string;
    tag?: string;
    status?: Vocabulary['reviewStatus'];
  }): Promise<Vocabulary[]> {
    let items = await idb.getAll<Vocabulary>(STORES.vocabulary);
    if (filter?.query) {
      items = items.filter((v) => matchesQuery([v.word, v.translation, v.example], filter.query!));
    }
    if (filter?.tag) items = items.filter((v) => v.tags.includes(filter.tag!));
    if (filter?.status) items = items.filter((v) => v.reviewStatus === filter.status);
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async findByWord(word: string): Promise<Vocabulary | undefined> {
    const matches = await idb.getAllByIndex<Vocabulary>(STORES.vocabulary, 'word', word);
    return matches[0];
  }

  async update(item: Vocabulary): Promise<Vocabulary> {
    await idb.put(STORES.vocabulary, item);
    return item;
  }

  async remove(id: string): Promise<void> {
    await idb.delete(STORES.vocabulary, id);
  }

  async importMany(items: Vocabulary[]): Promise<number> {
    let imported = 0;
    for (const item of items) {
      if (!item.word) continue;
      await idb.put(STORES.vocabulary, {
        ...item,
        id: item.id || newId(),
        createdAt: item.createdAt || Date.now(),
        tags: item.tags ?? [],
        reviewStatus: item.reviewStatus ?? 'new',
      });
      imported++;
    }
    return imported;
  }

  count(): Promise<number> {
    return idb.count(STORES.vocabulary);
  }
}

export class SentenceRepository {
  async add(input: Omit<Sentence, 'id' | 'createdAt'>): Promise<Sentence> {
    const item: Sentence = { ...input, id: newId(), createdAt: Date.now() };
    await idb.put(STORES.sentences, item);
    return item;
  }

  async list(filter?: { query?: string; tag?: string }): Promise<Sentence[]> {
    let items = await idb.getAll<Sentence>(STORES.sentences);
    if (filter?.query) {
      items = items.filter((s) => matchesQuery([s.text, s.translation, s.notes], filter.query!));
    }
    if (filter?.tag) items = items.filter((s) => s.tags.includes(filter.tag!));
    return items.sort((a, b) => b.createdAt - a.createdAt);
  }

  async update(item: Sentence): Promise<Sentence> {
    await idb.put(STORES.sentences, item);
    return item;
  }

  async remove(id: string): Promise<void> {
    await idb.delete(STORES.sentences, id);
  }

  count(): Promise<number> {
    return idb.count(STORES.sentences);
  }
}

export class ConversationRepository {
  async save(conversation: AIConversation): Promise<AIConversation> {
    const item: AIConversation = {
      ...conversation,
      id: conversation.id || newId(),
      updatedAt: Date.now(),
      createdAt: conversation.createdAt || Date.now(),
    };
    await idb.put(STORES.conversations, item);
    return item;
  }

  async list(): Promise<AIConversation[]> {
    const items = await idb.getAll<AIConversation>(STORES.conversations);
    return items.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string): Promise<void> {
    await idb.delete(STORES.conversations, id);
  }
}

export class ReviewHistoryRepository {
  async record(entry: Omit<ReviewHistory, 'id'>): Promise<ReviewHistory> {
    const item: ReviewHistory = { ...entry, id: newId() };
    await idb.put(STORES.reviewHistory, item);
    return item;
  }

  listForWord(vocabularyId: string): Promise<ReviewHistory[]> {
    return idb.getAllByIndex<ReviewHistory>(STORES.reviewHistory, 'vocabularyId', vocabularyId);
  }
}

interface Counters {
  key: 'counters';
  readingTimeMs: number;
  videosWatched: number;
  articlesFinished: number;
}

export class StatsRepository {
  private vocab = new VocabularyRepository();
  private sentences = new SentenceRepository();

  private async counters(): Promise<Counters> {
    return (
      (await idb.get<Counters>(STORES.stats, 'counters')) ?? {
        key: 'counters',
        readingTimeMs: 0,
        videosWatched: 0,
        articlesFinished: 0,
      }
    );
  }

  async recordTime(ms: number, url: string, kind: 'reading' | 'video', title?: string) {
    const counters = await this.counters();
    counters.readingTimeMs += ms;
    await idb.put(STORES.stats, counters);
    const session: ReadingSession = {
      id: crypto.randomUUID(),
      url,
      title,
      startedAt: Date.now() - ms,
      durationMs: ms,
      kind,
    };
    await idb.put(STORES.readingSessions, session);
  }

  async increment(kind: 'video-watched' | 'article-finished') {
    const counters = await this.counters();
    if (kind === 'video-watched') counters.videosWatched++;
    else counters.articlesFinished++;
    await idb.put(STORES.stats, counters);
  }

  async snapshot(): Promise<StatsSnapshot> {
    const [counters, wordsLearned, sentencesCollected] = await Promise.all([
      this.counters(),
      this.vocab.count(),
      this.sentences.count(),
    ]);
    return {
      wordsLearned,
      sentencesCollected,
      readingTimeMs: counters.readingTimeMs,
      videosWatched: counters.videosWatched,
      articlesFinished: counters.articlesFinished,
    };
  }
}
