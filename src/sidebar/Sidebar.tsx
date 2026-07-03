import { useState } from 'react';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { ChatView } from './ChatView';
import { SentencesView } from './SentencesView';
import { StatsView } from './StatsView';
import { VocabularyView } from './VocabularyView';

const TABS = [
  { id: 'chat', label: 'AI 对话' },
  { id: 'vocabulary', label: '生词本' },
  { id: 'sentences', label: '句子本' },
  { id: 'stats', label: '统计' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function Sidebar() {
  const { settings } = useSettings();
  useTheme(settings?.theme);
  const [tab, setTab] = useState<TabId>('chat');

  return (
    <div className="flex h-screen flex-col">
      <nav className="flex border-b border-slate-200 dark:border-slate-700" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 py-2.5 text-sm transition-colors ${
              tab === t.id
                ? 'border-b-2 border-indigo-500 font-medium text-indigo-600 dark:text-indigo-400'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="min-h-0 flex-1">
        {tab === 'chat' && <ChatView aiConfigured={(settings?.ai.kind ?? 'none') !== 'none'} />}
        {tab === 'vocabulary' && <VocabularyView />}
        {tab === 'sentences' && <SentencesView />}
        {tab === 'stats' && <StatsView />}
      </main>
    </div>
  );
}
