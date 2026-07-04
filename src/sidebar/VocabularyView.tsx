import { useEffect, useState } from 'react';
import { Button, Select, TextInput } from '@/components/ui';
import { sendRequest } from '@/shared/messages';
import type { Vocabulary } from '@/types/models';

const STATUS_LABEL: Record<Vocabulary['reviewStatus'], string> = {
  new: '新词',
  learning: '学习中',
  reviewing: '复习中',
  mastered: '已掌握',
};

const NEXT_STATUS: Record<Vocabulary['reviewStatus'], Vocabulary['reviewStatus']> = {
  new: 'learning',
  learning: 'reviewing',
  reviewing: 'mastered',
  mastered: 'new',
};

function speak(word: string) {
  const u = new SpeechSynthesisUtterance(word);
  u.lang = 'en-US';
  speechSynthesis.speak(u);
}

export function VocabularyView() {
  const [items, setItems] = useState<Vocabulary[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Vocabulary['reviewStatus'] | ''>('');
  const [newWord, setNewWord] = useState('');
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);

  const reload = () =>
    void sendRequest('vocabulary.list', {
      query: query || undefined,
      status: status || undefined,
    }).then(setItems, () => {});

  useEffect(reload, [query, status]);

  /** Manual entry: look the word up so the card is pre-filled, then save. */
  async function addWord() {
    const word = newWord.trim();
    if (!word || adding) return;
    setAdding(true);
    try {
      let translation = '';
      let ipa: string | undefined;
      let partOfSpeech: string | undefined;
      let example: string | undefined;
      let cefr: Vocabulary['cefr'];
      try {
        const entry = await sendRequest('dictionary.lookup', { word });
        const sense = entry.senses[0];
        translation = sense?.meaningTranslation ?? sense?.meaning ?? '';
        ipa = entry.ipa;
        partOfSpeech = sense?.partOfSpeech;
        example = sense?.example;
        cefr = entry.cefr;
      } catch {
        const res = await sendRequest('translation.translate', {
          texts: [word],
          from: 'en',
          to: 'zh-CN',
        });
        translation = res.translations[0] ?? '';
      }
      await sendRequest('vocabulary.add', {
        word,
        translation,
        ipa,
        partOfSpeech,
        example,
        cefr,
        reviewStatus: 'new',
        tags: ['手动录入'],
      });
      setNewWord('');
      reload();
    } finally {
      setAdding(false);
    }
  }

  async function cycleStatus(item: Vocabulary) {
    const updated = { ...item, reviewStatus: NEXT_STATUS[item.reviewStatus] };
    await sendRequest('vocabulary.update', updated);
    setItems((prev) => prev.map((v) => (v.id === item.id ? updated : v)));
  }

  async function remove(id: string) {
    await sendRequest('vocabulary.remove', { id });
    setItems((prev) => prev.filter((v) => v.id !== id));
  }

  if (reviewing) {
    return (
      <Flashcards
        items={items.filter((v) => v.reviewStatus !== 'mastered')}
        onClose={() => {
          setReviewing(false);
          reload();
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-100 p-2 dark:border-slate-800">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addWord();
          }}
        >
          <TextInput
            placeholder="录入生词，自动查释义…"
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
          />
          <Button variant="primary" type="submit" disabled={adding || !newWord.trim()}>
            {adding ? '…' : '＋ 录入'}
          </Button>
        </form>
        <div className="flex gap-2">
          <TextInput placeholder="搜索单词 / 释义…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="按状态筛选">
            <option value="">全部</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
          <Button
            onClick={() => setReviewing(true)}
            disabled={items.filter((v) => v.reviewStatus !== 'mastered').length === 0}
            title="抽认卡模式：看单词想释义，标记认识/不认识"
          >
            🎴 背诵
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="pt-8 text-center text-xs text-slate-400">
            还没有生词。在网页上双击单词，或在上方直接录入。
          </p>
        )}
        {items.map((v) => (
          <div key={v.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <span className="font-semibold">{v.word}</span>
                {v.ipa && <span className="ml-2 text-xs text-slate-400">{v.ipa}</span>}
                {v.cefr && (
                  <span className="ml-2 rounded bg-indigo-500 px-1 text-[10px] font-bold text-white">{v.cefr}</span>
                )}
              </div>
              <button
                onClick={() => speak(v.word)}
                className="text-slate-400 hover:text-indigo-500"
                title="发音"
                aria-label={`播放 ${v.word} 发音`}
              >
                🔊
              </button>
            </div>
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{v.translation}</div>
            {v.example && <div className="mt-1 text-xs italic text-slate-400">“{v.example}”</div>}
            <div className="mt-2 flex items-center gap-2">
              <Button className="!px-2 !py-0.5 !text-xs" onClick={() => void cycleStatus(v)}>
                {STATUS_LABEL[v.reviewStatus]} →
              </Button>
              {v.sourceUrl && (
                <a
                  href={v.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-[140px] truncate text-xs text-slate-400 hover:text-indigo-500"
                >
                  来源
                </a>
              )}
              <Button variant="danger" className="!ml-auto !px-2 !py-0.5 !text-xs" onClick={() => void remove(v.id)}>
                删除
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Flashcard review: front = word, back = meaning; 认识/不认识 drives status. */
function Flashcards({ items, onClose }: { items: Vocabulary[]; onClose: () => void }) {
  const [deck] = useState(() => [...items].sort(() => Math.random() - 0.5));
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [knownCount, setKnownCount] = useState(0);
  const card = deck[idx];

  async function grade(outcome: 'again' | 'good') {
    if (!card) return;
    if (outcome === 'good') setKnownCount((n) => n + 1);
    await sendRequest('vocabulary.review', { id: card.id, outcome }).catch(() => {});
    setRevealed(false);
    setIdx((i) => i + 1);
  }

  if (!card) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-4xl">🎉</div>
        <p className="text-sm">
          本轮完成：{deck.length} 张，认识 {knownCount} 张
        </p>
        <Button variant="primary" onClick={onClose}>
          返回生词本
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-slate-400">
        <span>
          {idx + 1} / {deck.length}
        </span>
        <button onClick={onClose} className="hover:text-slate-700 dark:hover:text-slate-200">
          退出背诵
        </button>
      </div>
      <button
        onClick={() => setRevealed(true)}
        className="flex min-h-0 flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border border-slate-200 p-6 text-center dark:border-slate-700"
        aria-label={revealed ? '卡片背面' : '点击显示释义'}
      >
        <div className="text-3xl font-bold">{card.word}</div>
        {card.ipa && <div className="text-sm text-slate-400">{card.ipa}</div>}
        <span
          onClick={(e) => {
            e.stopPropagation();
            speak(card.word);
          }}
          className="cursor-pointer text-lg text-slate-400 hover:text-indigo-500"
          role="button"
          aria-label="播放发音"
        >
          🔊
        </span>
        {revealed ? (
          <div className="space-y-2">
            <div className="text-lg">{card.translation}</div>
            {card.example && <div className="text-xs italic text-slate-400">“{card.example}”</div>}
          </div>
        ) : (
          <div className="text-xs text-slate-400">点击卡片显示释义</div>
        )}
      </button>
      <div className="mt-3 flex gap-2">
        {revealed ? (
          <>
            <Button className="flex-1 py-2" onClick={() => void grade('again')}>
              ✗ 不认识
            </Button>
            <Button variant="primary" className="flex-1 py-2" onClick={() => void grade('good')}>
              ✓ 认识
            </Button>
          </>
        ) : (
          <Button className="w-full py-2" onClick={() => setRevealed(true)}>
            显示释义
          </Button>
        )}
      </div>
    </div>
  );
}
