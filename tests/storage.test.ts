import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetDbForTests } from '@/services/storage/db';
import {
  SentenceRepository,
  StatsRepository,
  VocabularyRepository,
} from '@/services/storage/repositories';
import { cacheClear, cacheGet, cacheSet, cacheSweep } from '@/services/cache/ttlCache';

beforeEach(async () => {
  await __resetDbForTests();
});

describe('VocabularyRepository', () => {
  it('adds, lists, filters and removes words', async () => {
    const repo = new VocabularyRepository();
    const a = await repo.add({
      word: 'serendipity',
      translation: '意外发现珍宝的运气',
      reviewStatus: 'new',
      tags: ['reading'],
    });
    await repo.add({
      word: 'ubiquitous',
      translation: '无处不在的',
      reviewStatus: 'learning',
      tags: [],
    });

    expect(await repo.list()).toHaveLength(2);
    expect(await repo.list({ query: 'seren' })).toHaveLength(1);
    expect(await repo.list({ tag: 'reading' })).toHaveLength(1);
    expect(await repo.list({ status: 'learning' })).toHaveLength(1);
    expect((await repo.findByWord('serendipity'))?.id).toBe(a.id);

    await repo.remove(a.id);
    expect(await repo.list()).toHaveLength(1);
  });

  it('imports items, filling missing fields', async () => {
    const repo = new VocabularyRepository();
    const imported = await repo.importMany([
      { word: 'hello', translation: '你好' } as never,
      { word: '', translation: 'skipped' } as never,
    ]);
    expect(imported).toBe(1);
    const [item] = await repo.list();
    expect(item?.reviewStatus).toBe('new');
    expect(item?.tags).toEqual([]);
  });
});

describe('SentenceRepository', () => {
  it('supports query filtering', async () => {
    const repo = new SentenceRepository();
    await repo.add({ text: 'The die is cast.', translation: '木已成舟。', tags: [] });
    expect(await repo.list({ query: 'die is' })).toHaveLength(1);
    expect(await repo.list({ query: 'nope' })).toHaveLength(0);
  });
});

describe('StatsRepository', () => {
  it('aggregates counters and store counts', async () => {
    const stats = new StatsRepository();
    const vocab = new VocabularyRepository();
    await vocab.add({ word: 'x', translation: 'y', reviewStatus: 'new', tags: [] });
    await stats.recordTime(60_000, 'https://example.com', 'reading');
    await stats.increment('article-finished');
    await stats.increment('video-watched');

    const snap = await stats.snapshot();
    expect(snap.wordsLearned).toBe(1);
    expect(snap.readingTimeMs).toBe(60_000);
    expect(snap.articlesFinished).toBe(1);
    expect(snap.videosWatched).toBe(1);
  });
});

describe('ttlCache', () => {
  // Only mock the clock, not timers: fake-indexeddb needs real timers to run.
  let nowOffset = 0;
  const realNow = Date.now.bind(Date);

  beforeEach(() => {
    nowOffset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + nowOffset);
  });

  it('stores and expires entries', async () => {
    await cacheSet('translation', 'k1', 'hello', 1000);
    expect(await cacheGet('translation', 'k1')).toBe('hello');
    nowOffset = 1500;
    expect(await cacheGet('translation', 'k1')).toBeUndefined();
  });

  it('clears by scope and sweeps expired', async () => {
    await cacheSet('translation', 'a', 1, 1000);
    await cacheSet('dictionary', 'b', 2, 1000);
    await cacheClear('translation');
    expect(await cacheGet('translation', 'a')).toBeUndefined();
    expect(await cacheGet('dictionary', 'b')).toBe(2);

    nowOffset = 2000;
    await cacheSweep();
    expect(await cacheGet('dictionary', 'b')).toBeUndefined();
  });
});
