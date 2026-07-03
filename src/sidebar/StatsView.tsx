import { useEffect, useState } from 'react';
import { sendRequest } from '@/shared/messages';
import type { StatsSnapshot } from '@/types/models';

export function StatsView() {
  const [stats, setStats] = useState<StatsSnapshot | null>(null);

  useEffect(() => {
    void sendRequest('stats.get', null).then(setStats, () => {});
  }, []);

  if (!stats) return <div className="p-6 text-center text-xs text-slate-400">加载中…</div>;

  const hours = (stats.readingTimeMs / 3600_000).toFixed(1);
  const cards = [
    { label: '学到的生词', value: stats.wordsLearned, icon: '📖' },
    { label: '收藏的句子', value: stats.sentencesCollected, icon: '✏️' },
    { label: '阅读时长（小时）', value: hours, icon: '⏱' },
    { label: '看过的视频', value: stats.videosWatched, icon: '🎬' },
    { label: '读完的文章', value: stats.articlesFinished, icon: '📰' },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border border-slate-200 p-4 text-center dark:border-slate-700">
          <div className="text-xl">{c.icon}</div>
          <div className="mt-1 text-2xl font-bold">{c.value}</div>
          <div className="text-xs text-slate-400">{c.label}</div>
        </div>
      ))}
      <p className="col-span-2 pt-2 text-center text-xs text-slate-400">
        所有统计数据仅保存在本机。
      </p>
    </div>
  );
}
