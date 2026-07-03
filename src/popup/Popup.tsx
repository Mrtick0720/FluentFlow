import { useEffect, useState } from 'react';
import { Button, SegmentedControl, Select, Switch } from '@/components/ui';
import { activeTabHost, activeTabId } from '@/hooks/useActiveTab';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { COMMON_LANGUAGES } from '@/shared/constants';
import { sendRequest, sendToTab } from '@/shared/messages';
import type { DisplayMode, StatsSnapshot, TranslationProviderId } from '@/types/models';

const PROVIDERS: Array<{ value: TranslationProviderId; label: string }> = [
  { value: 'google', label: 'Google（免费）' },
  { value: 'deepl', label: 'DeepL' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure' },
  { value: 'custom', label: '自定义端点' },
];

const MODES: Array<{ value: DisplayMode; label: string }> = [
  { value: 'bilingual', label: '双语' },
  { value: 'translation-only', label: '仅译文' },
  { value: 'original', label: '仅原文' },
  { value: 'side-by-side', label: '左右对照' },
];

export function Popup() {
  const { settings, update } = useSettings();
  useTheme(settings?.theme);
  const [host, setHost] = useState<string>();
  const [pageActive, setPageActive] = useState(false);
  const [stats, setStats] = useState<StatsSnapshot>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void activeTabHost().then(setHost);
    void sendRequest('stats.get', null).then(setStats, () => {});
  }, []);

  if (!settings) {
    return <div className="w-[340px] p-6 text-center text-sm text-slate-400">加载中…</div>;
  }

  const always = host ? settings.autoTranslateSites.includes(host) : false;
  const never = host ? settings.neverTranslateSites.includes(host) : false;

  async function toggleTranslate() {
    const tabId = await activeTabId();
    if (tabId === undefined) return;
    setBusy(true);
    try {
      const res = await sendToTab(tabId, 'content.toggleTranslation', null);
      setPageActive(res.active);
    } catch {
      // page without content script (chrome://, store)
    } finally {
      setBusy(false);
    }
  }

  async function setMode(mode: DisplayMode) {
    await update({ displayMode: mode });
    const tabId = await activeTabId();
    if (tabId !== undefined) {
      await sendToTab(tabId, 'content.setDisplayMode', { mode }).catch(() => {});
      setPageActive(true);
    }
  }

  async function toggleSiteRule(list: 'autoTranslateSites' | 'neverTranslateSites', on: boolean) {
    if (!host || !settings) return;
    const current = new Set(settings[list]);
    if (on) current.add(host);
    else current.delete(host);
    await update({ [list]: [...current] });
  }

  return (
    <div className="w-[340px] space-y-3 p-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block h-5 w-5 rounded-md bg-gradient-to-br from-indigo-500 to-teal-500" />
          <span className="text-sm font-bold">LinguaFlow</span>
        </div>
        <button
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          title="设置"
          aria-label="打开设置"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          ⚙
        </button>
      </header>

      <Button variant="primary" className="w-full py-2 font-medium" onClick={toggleTranslate} disabled={busy}>
        {busy ? '处理中…' : pageActive ? '还原此页' : '翻译此页（Alt+T）'}
      </Button>

      <SegmentedControl options={MODES} value={settings.displayMode} onChange={(m) => void setMode(m)} />

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-slate-500 dark:text-slate-400">
          翻译引擎
          <Select
            className="mt-1 w-full"
            value={settings.translationProvider}
            onChange={(e) => void update({ translationProvider: e.target.value as TranslationProviderId })}
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-slate-500 dark:text-slate-400">
          目标语言
          <Select
            className="mt-1 w-full"
            value={settings.targetLanguage}
            onChange={(e) => void update({ targetLanguage: e.target.value })}
          >
            {COMMON_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {host && (
        <div className="rounded-xl border border-slate-200 px-3 py-1 dark:border-slate-700">
          <div className="pt-1 text-xs text-slate-400">{host}</div>
          <Switch checked={always} onChange={(v) => void toggleSiteRule('autoTranslateSites', v)} label="总是翻译此站点" />
          <Switch checked={never} onChange={(v) => void toggleSiteRule('neverTranslateSites', v)} label="从不自动翻译此站点" />
        </div>
      )}

      {stats && (
        <div className="flex justify-between rounded-xl bg-slate-50 px-3 py-2 text-center text-xs dark:bg-slate-800">
          <Stat label="生词" value={stats.wordsLearned} />
          <Stat label="句子" value={stats.sentencesCollected} />
          <Stat label="阅读" value={`${Math.round(stats.readingTimeMs / 60000)}分`} />
          <Stat label="视频" value={stats.videosWatched} />
          <Stat label="文章" value={stats.articlesFinished} />
        </div>
      )}

      <Button
        className="w-full"
        onClick={async () => {
          const tabId = await activeTabId();
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
          void tabId;
          window.close();
        }}
      >
        打开学习面板（生词本 · 句子本 · AI）
      </Button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="font-semibold text-slate-700 dark:text-slate-200">{value}</div>
      <div className="text-slate-400">{label}</div>
    </div>
  );
}
