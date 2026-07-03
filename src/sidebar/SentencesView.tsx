import { useEffect, useState } from 'react';
import { Button, TextInput } from '@/components/ui';
import { sendRequest } from '@/shared/messages';
import type { Sentence } from '@/types/models';

export function SentencesView() {
  const [items, setItems] = useState<Sentence[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    void sendRequest('sentences.list', { query: query || undefined }).then(setItems, () => {});
  }, [query]);

  async function remove(id: string) {
    await sendRequest('sentences.remove', { id });
    setItems((prev) => prev.filter((s) => s.id !== id));
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-100 p-2 dark:border-slate-800">
        <TextInput placeholder="搜索句子…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {items.length === 0 && (
          <p className="pt-8 text-center text-xs text-slate-400">
            还没有收藏的句子。在网页上选中文本，点「收藏」即可。
          </p>
        )}
        {items.map((s) => (
          <div key={s.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="text-sm">{s.text}</div>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{s.translation}</div>
            {s.notes && <div className="mt-1 text-xs text-slate-400">{s.notes}</div>}
            {s.grammar && (
              <details className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                <summary className="cursor-pointer">语法笔记</summary>
                <div className="mt-1 whitespace-pre-wrap">{s.grammar}</div>
              </details>
            )}
            <div className="mt-2 flex items-center gap-2">
              {s.tags.map((t) => (
                <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-800">
                  {t}
                </span>
              ))}
              {s.sourceUrl && (
                <a
                  href={s.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="max-w-[150px] truncate text-xs text-slate-400 hover:text-indigo-500"
                >
                  {s.sourceTitle ?? '来源'}
                </a>
              )}
              <Button
                className="!ml-auto !px-2 !py-0.5 !text-xs"
                onClick={() => void navigator.clipboard.writeText(`${s.text}\n${s.translation}`)}
              >
                复制
              </Button>
              <Button variant="danger" className="!px-2 !py-0.5 !text-xs" onClick={() => void remove(s.id)}>
                删除
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
