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

export function VocabularyView() {
  const [items, setItems] = useState<Vocabulary[]>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Vocabulary['reviewStatus'] | ''>('');

  const reload = () =>
    void sendRequest('vocabulary.list', {
      query: query || undefined,
      status: status || undefined,
    }).then(setItems, () => {});

  useEffect(reload, [query, status]);

  async function cycleStatus(item: Vocabulary) {
    const updated = { ...item, reviewStatus: NEXT_STATUS[item.reviewStatus] };
    await sendRequest('vocabulary.update', updated);
    setItems((prev) => prev.map((v) => (v.id === item.id ? updated : v)));
  }

  async function remove(id: string) {
    await sendRequest('vocabulary.remove', { id });
    setItems((prev) => prev.filter((v) => v.id !== id));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-2 border-b border-slate-100 p-2 dark:border-slate-800">
        <TextInput placeholder="搜索单词 / 释义…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="按状态筛选">
          <option value="">全部</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="pt-8 text-center text-xs text-slate-400">
            还没有生词。在网页上双击单词即可查询并收藏。
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
                onClick={() => {
                  const u = new SpeechSynthesisUtterance(v.word);
                  u.lang = 'en-US';
                  speechSynthesis.speak(u);
                }}
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
