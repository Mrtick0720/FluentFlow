import { beforeEach, describe, expect, it } from 'vitest';
import { __resetDbForTests } from '@/services/storage/db';
import {
  nextReviewStatus,
  ReviewHistoryRepository,
  VocabularyRepository,
} from '@/services/storage/repositories';

describe('nextReviewStatus', () => {
  it('climbs one rung on good', () => {
    expect(nextReviewStatus('new', 'good')).toBe('learning');
    expect(nextReviewStatus('learning', 'good')).toBe('reviewing');
    expect(nextReviewStatus('reviewing', 'good')).toBe('mastered');
    expect(nextReviewStatus('mastered', 'good')).toBe('mastered');
  });

  it('drops back to learning on again', () => {
    expect(nextReviewStatus('new', 'again')).toBe('learning');
    expect(nextReviewStatus('reviewing', 'again')).toBe('learning');
    expect(nextReviewStatus('mastered', 'again')).toBe('learning');
  });
});

describe('review flow', () => {
  beforeEach(async () => {
    await __resetDbForTests();
  });

  it('updates status and records history', async () => {
    const vocab = new VocabularyRepository();
    const reviews = new ReviewHistoryRepository();
    const word = await vocab.add({
      word: 'ephemeral',
      translation: '短暂的',
      reviewStatus: 'new',
      tags: [],
    });

    const updated = { ...word, reviewStatus: nextReviewStatus(word.reviewStatus, 'good') };
    await vocab.update(updated);
    await reviews.record({ vocabularyId: word.id, reviewedAt: Date.now(), outcome: 'good' });

    expect((await vocab.get(word.id))?.reviewStatus).toBe('learning');
    expect(await reviews.listForWord(word.id)).toHaveLength(1);
  });
});
