import { useEffect, useState, type ReactNode } from 'react';
import { Button, SegmentedControl, Switch } from '@/components/ui';
import { activeTabHost, activeTabId } from '@/hooks/useActiveTab';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { COMMON_LANGUAGES } from '@/shared/constants';
import { sendRequest, sendToTab } from '@/shared/messages';
import type { DisplayMode, StatsSnapshot, TranslationProviderId } from '@/types/models';

const PROVIDERS: Array<{ value: TranslationProviderId; label: string }> = [
  { value: 'google', label: '谷歌翻译（免费）' },
  { value: 'deepl', label: 'DeepL' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'azure', label: 'Azure' },
  { value: 'custom', label: '自定义端点' },
];

/**
 * A small colored monogram identifying the service/model. These are generic
 * stylized badges (letter + brand-ish color), not reproductions of any
 * company's logo artwork.
 */
function brandBadge(
  provider: TranslationProviderId,
  model?: string,
): { label: string; bg: string } {
  if (provider !== 'custom') {
    return {
      google: { label: 'G', bg: '#4285F4' },
      deepl: { label: 'D', bg: '#0F2B46' },
      openai: { label: '◍', bg: '#10A37F' },
      azure: { label: 'Az', bg: '#0078D4' },
      custom: { label: '⚙', bg: '#64748B' },
    }[provider];
  }
  const m = (model ?? '').toLowerCase();
  if (m.includes('gemini')) return { label: '✦', bg: '#1A73E8' };
  if (m.includes('deepseek')) return { label: 'DS', bg: '#4D6BFE' };
  if (m.includes('gpt') || /\bo[13]\b/.test(m)) return { label: '◍', bg: '#10A37F' };
  if (m.includes('claude')) return { label: '✳', bg: '#D97757' };
  if (m.includes('qwen') || m.includes('tongyi')) return { label: 'Q', bg: '#615CED' };
  if (m.includes('glm') || m.includes('zhipu')) return { label: 'G', bg: '#3859FF' };
  if (m.includes('kimi') || m.includes('moonshot')) return { label: 'K', bg: '#111827' };
  if (m.includes('llama')) return { label: 'L', bg: '#0866FF' };
  return { label: '⚙', bg: '#64748B' };
}

function Badge({ label, bg }: { label: string; bg: string }) {
  return (
    <span
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
      style={{ backgroundColor: bg }}
      aria-hidden
    >
      {label}
    </span>
  );
}

const MODES: Array<{ value: DisplayMode; label: string }> = [
  { value: 'bilingual', label: '双语' },
  { value: 'translation-only', label: '仅译文' },
  { value: 'original', label: '仅原文' },
  { value: 'side-by-side', label: '左右对照' },
];

const SOURCE_LANGUAGES = [{ code: 'auto', label: '自动检测' }, ...COMMON_LANGUAGES];

export function Popup() {
  const { settings, update } = useSettings();
  useTheme(settings?.theme);
  const [host, setHost] = useState<string>();
  const [pageActive, setPageActive] = useState(false);
  const [stats, setStats] = useState<StatsSnapshot>();
  const [busy, setBusy] = useState(false);
  const version = chrome.runtime.getManifest().version;

  useEffect(() => {
    void activeTabHost().then(setHost);
    void sendRequest('stats.get', null).then(setStats, () => {});
  }, []);

  if (!settings) {
    return <div className="w-[360px] p-6 text-center text-sm text-slate-400">加载中…</div>;
  }

  const always = host ? settings.autoTranslateSites.includes(host) : false;
  const never = host ? settings.neverTranslateSites.includes(host) : false;
  const customModel = settings.providers.custom?.model?.trim();
  // For the custom endpoint, show the chosen model id instead of a generic label.
  const providerLabel = (p: (typeof PROVIDERS)[number]) =>
    p.value === 'custom' && customModel ? customModel : p.label;
  const activeBadge = brandBadge(settings.translationProvider, customModel);

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
    <div className="flex w-[360px] flex-col">
      <div className="space-y-3 p-4">
        <header className="flex items-center gap-2">
          <img src={chrome.runtime.getURL('icons/icon48.png')} alt="" className="h-6 w-6 rounded-lg" />
          <span className="text-base font-bold">LinguaFlow</span>
        </header>

        {/* 源语言 → 目标语言 */}
        <div className="flex items-center gap-2">
          <BigSelect
            value={settings.sourceLanguage}
            onChange={(v) => void update({ sourceLanguage: v })}
            aria-label="源语言"
          >
            {SOURCE_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </BigSelect>
          <span className="shrink-0 text-slate-400">→</span>
          <BigSelect
            value={settings.targetLanguage}
            onChange={(v) => void update({ targetLanguage: v })}
            aria-label="目标语言"
          >
            {COMMON_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </BigSelect>
        </div>

        {/* 翻译服务（单行紧凑：标签 + 徽标 + 服务/模型名 + 下拉） */}
        <div className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 dark:border-slate-700">
          <span className="shrink-0 text-xs text-slate-400">翻译服务</span>
          <Badge label={activeBadge.label} bg={activeBadge.bg} />
          <div className="relative min-w-0 flex-1">
            <select
              className="w-full cursor-pointer appearance-none truncate bg-transparent pr-5 text-sm font-semibold outline-none"
              value={settings.translationProvider}
              onChange={(e) =>
                void update({ translationProvider: e.target.value as TranslationProviderId })
              }
              aria-label="翻译服务"
            >
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 text-slate-400">
              ▾
            </span>
          </div>
        </div>

        <Button
          variant="primary"
          className="w-full py-2.5 text-base font-semibold"
          onClick={toggleTranslate}
          disabled={busy}
        >
          {busy ? '处理中…' : pageActive ? '还原此页（Alt+T）' : '翻译此页（Alt+T）'}
        </Button>

        <SegmentedControl options={MODES} value={settings.displayMode} onChange={(m) => void setMode(m)} />

        {stats && (
          <div className="flex justify-between rounded-xl bg-slate-50 px-3 py-2 text-center text-xs dark:bg-slate-800">
            <Stat label="生词" value={stats.wordsLearned} />
            <Stat label="句子" value={stats.sentencesCollected} />
            <Stat label="阅读" value={`${Math.round(stats.readingTimeMs / 60000)}分`} />
            <Stat label="视频" value={stats.videosWatched} />
            <Stat label="文章" value={stats.articlesFinished} />
          </div>
        )}

        <div className="rounded-xl border border-slate-200 px-3 py-1 dark:border-slate-700">
          {host && <div className="pt-1 text-xs text-slate-400">{host}</div>}
          {host && (
            <Switch
              checked={always}
              onChange={(v) => void toggleSiteRule('autoTranslateSites', v)}
              label="总是翻译此网站"
            />
          )}
          <Switch
            checked={settings.selectionEnabled}
            onChange={(v) => void update({ selectionEnabled: v })}
            label="划词翻译（选中弹出工具条）"
          />
          <Switch
            checked={settings.autoSubtitleVideoSites}
            onChange={(v) => void update({ autoSubtitleVideoSites: v })}
            label="进入视频网站自动开双语字幕"
          />
          {host && (
            <Switch
              checked={never}
              onChange={(v) => void toggleSiteRule('neverTranslateSites', v)}
              label="从不自动翻译此网站"
            />
          )}
        </div>

        <Button
          className="w-full"
          onClick={async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
            window.close();
          }}
        >
          打开学习面板（生词本 · 句子本 · AI）
        </Button>

        <Button
          className="w-full"
          onClick={() =>
            chrome.tabs.create({ url: chrome.runtime.getURL('options.html#subtitle') })
          }
        >
          🎬 字幕样式
        </Button>
      </div>

      {/* 底部：左下角设置，中间版本号 */}
      <div className="relative flex items-center border-t border-slate-200 px-4 py-2.5 dark:border-slate-700">
        <button
          className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          <span>⚙</span> 设置
        </button>
        <span className="absolute left-1/2 -translate-x-1/2 text-xs text-slate-400">V {version}</span>
      </div>
    </div>
  );
}

function BigSelect({
  value,
  onChange,
  children,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  'aria-label': string;
}) {
  return (
    <div className="relative flex-1">
      <select
        aria-label={ariaLabel}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full cursor-pointer appearance-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-medium outline-none focus:border-indigo-400 dark:border-slate-700 dark:bg-slate-800"
      >
        {children}
      </select>
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400">▾</span>
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
