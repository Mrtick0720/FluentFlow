import { useRef, useState } from 'react';
import { Button, Field, Section, SegmentedControl, Select, Switch, TextInput } from '@/components/ui';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { COMMON_LANGUAGES } from '@/shared/constants';
import { sendRequest } from '@/shared/messages';
import type { UserSettings } from '@/shared/settings';
import type { Sentence, TranslationProviderId, Vocabulary } from '@/types/models';
import { downloadFile, toCsv } from '@/utils/csv';

export function Options() {
  const { settings, update } = useSettings();
  useTheme(settings?.theme);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!settings) return <div className="p-10 text-center text-slate-400">加载中…</div>;

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2500);
  };

  const setProvider = (id: TranslationProviderId, patch: Record<string, string>) =>
    void update({ providers: { ...settings.providers, [id]: { ...settings.providers[id], ...patch } } });

  async function exportBackup() {
    if (!settings) return;
    const [vocabulary, sentences, conversations] = await Promise.all([
      sendRequest('vocabulary.list', {}),
      sendRequest('sentences.list', {}),
      sendRequest('conversations.list', null),
    ]);
    const backup = {
      app: 'linguaflow',
      version: 1,
      exportedAt: new Date().toISOString(),
      vocabulary,
      sentences,
      conversations,
      settings: { ...settings, providers: {}, ai: { kind: settings.ai.kind } }, // never export keys
    };
    downloadFile(`linguaflow-backup-${Date.now()}.json`, JSON.stringify(backup, null, 2), 'application/json');
    flash('备份已导出（不含 API 密钥）');
  }

  async function importBackup(file: File) {
    try {
      const data = JSON.parse(await file.text()) as {
        vocabulary?: Vocabulary[];
        sentences?: Sentence[];
      };
      let count = 0;
      if (Array.isArray(data.vocabulary)) {
        count += (await sendRequest('vocabulary.import', { items: data.vocabulary })).imported;
      }
      if (Array.isArray(data.sentences)) {
        for (const s of data.sentences) {
          await sendRequest('sentences.add', { ...s, tags: s.tags ?? [] });
          count++;
        }
      }
      flash(`导入完成：${count} 条记录`);
    } catch {
      flash('导入失败：文件格式不正确');
    }
  }

  async function exportVocabCsv() {
    const items = await sendRequest('vocabulary.list', {});
    const csv = toCsv([
      ['word', 'translation', 'ipa', 'partOfSpeech', 'example', 'cefr', 'sourceUrl', 'reviewStatus', 'tags', 'createdAt'],
      ...items.map((v) => [
        v.word,
        v.translation,
        v.ipa,
        v.partOfSpeech,
        v.example,
        v.cefr,
        v.sourceUrl,
        v.reviewStatus,
        v.tags.join(';'),
        new Date(v.createdAt).toISOString(),
      ]),
    ]);
    downloadFile('linguaflow-vocabulary.csv', csv, 'text/csv');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6 pb-16">
      <header className="flex items-center gap-3">
        <span className="inline-block h-7 w-7 rounded-lg bg-gradient-to-br from-indigo-500 to-teal-500" />
        <div>
          <h1 className="text-lg font-bold">LinguaFlow 设置</h1>
          <p className="text-xs text-slate-400">双语阅读 · 视频字幕学习 · AI 助手 — 默认本地存储，注重隐私</p>
        </div>
      </header>

      {notice && (
        <div className="rounded-lg bg-indigo-50 px-4 py-2 text-sm text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
          {notice}
        </div>
      )}

      <Section title="翻译">
        <div className="grid grid-cols-2 gap-3">
          <Field label="默认引擎">
            <Select
              className="w-full"
              value={settings.translationProvider}
              onChange={(e) => void update({ translationProvider: e.target.value as TranslationProviderId })}
            >
              <option value="google">Google（免费，无需密钥）</option>
              <option value="deepl">DeepL</option>
              <option value="openai">OpenAI</option>
              <option value="azure">Azure Translator</option>
              <option value="custom">自定义端点</option>
            </Select>
          </Field>
          <Field label="目标语言">
            <Select
              className="w-full"
              value={settings.targetLanguage}
              onChange={(e) => void update({ targetLanguage: e.target.value })}
            >
              {COMMON_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="译文样式">
            <Select
              className="w-full"
              value={settings.translationStyle}
              onChange={(e) => void update({ translationStyle: e.target.value as UserSettings['translationStyle'] })}
            >
              <option value="plain">朴素</option>
              <option value="underline">虚线下划线</option>
              <option value="tinted">浅色底纹</option>
            </Select>
          </Field>
          <Field label={`译文字号比例：${settings.fontScale.toFixed(2)}`}>
            <input
              type="range"
              min={0.7}
              max={1.2}
              step={0.02}
              value={settings.fontScale}
              onChange={(e) => void update({ fontScale: Number(e.target.value) })}
              className="w-full accent-indigo-500"
            />
          </Field>
        </div>
      </Section>

      <Section title="翻译引擎密钥">
        <Field label="DeepL API Key" hint="Free 计划的 key 以 :fx 结尾，自动使用 api-free 主机">
          <TextInput
            type="password"
            value={settings.providers.deepl?.apiKey ?? ''}
            placeholder="未设置"
            onChange={(e) => setProvider('deepl', { apiKey: e.target.value })}
          />
        </Field>
        <Field label="OpenAI API Key">
          <TextInput
            type="password"
            value={settings.providers.openai?.apiKey ?? ''}
            placeholder="未设置"
            onChange={(e) => setProvider('openai', { apiKey: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Azure Key">
            <TextInput
              type="password"
              value={settings.providers.azure?.apiKey ?? ''}
              placeholder="未设置"
              onChange={(e) => setProvider('azure', { apiKey: e.target.value })}
            />
          </Field>
          <Field label="Azure 区域">
            <TextInput
              value={settings.providers.azure?.region ?? ''}
              placeholder="如 eastasia"
              onChange={(e) => setProvider('azure', { region: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="自定义端点 Base URL" hint="OpenAI 兼容，如 http://localhost:11434/v1">
            <TextInput
              value={settings.providers.custom?.baseUrl ?? ''}
              placeholder="https://…/v1"
              onChange={(e) => setProvider('custom', { baseUrl: e.target.value })}
            />
          </Field>
          <Field label="模型">
            <TextInput
              value={settings.providers.custom?.model ?? ''}
              placeholder="如 qwen2.5"
              onChange={(e) => setProvider('custom', { model: e.target.value })}
            />
          </Field>
          <Field label="Key（可选）">
            <TextInput
              type="password"
              value={settings.providers.custom?.apiKey ?? ''}
              placeholder="未设置"
              onChange={(e) => setProvider('custom', { apiKey: e.target.value })}
            />
          </Field>
        </div>
        {settings.providers.custom?.baseUrl && (
          <Button
            onClick={async () => {
              try {
                const origin = new URL(settings.providers.custom!.baseUrl!).origin + '/*';
                const { granted } = await sendRequest('permissions.requestOrigin', { origin });
                flash(granted ? '已授权访问该端点' : '未授权');
              } catch {
                flash('Base URL 无效');
              }
            }}
          >
            为自定义端点授权访问权限
          </Button>
        )}
        <p className="text-xs text-slate-400">
          密钥使用 AES-GCM 加密存储在本地（属于混淆级防护），只在后台 Service Worker 中解密，绝不上传。
        </p>
      </Section>

      <Section title="AI 助手">
        <div className="grid grid-cols-2 gap-3">
          <Field label="AI 提供方">
            <Select
              className="w-full"
              value={settings.ai.kind}
              onChange={(e) => void update({ ai: { ...settings.ai, kind: e.target.value as UserSettings['ai']['kind'] } })}
            >
              <option value="none">未启用</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="custom">自定义（OpenAI 兼容）</option>
            </Select>
          </Field>
          <Field label="模型（可选）">
            <TextInput
              value={settings.ai.model ?? ''}
              placeholder="留空使用默认"
              onChange={(e) => void update({ ai: { ...settings.ai, model: e.target.value } })}
            />
          </Field>
        </div>
        {settings.ai.kind !== 'none' && (
          <>
            <Field label="API Key">
              <TextInput
                type="password"
                value={settings.ai.apiKey ?? ''}
                placeholder="未设置"
                onChange={(e) => void update({ ai: { ...settings.ai, apiKey: e.target.value } })}
              />
            </Field>
            {settings.ai.kind === 'custom' && (
              <Field label="Base URL">
                <TextInput
                  value={settings.ai.baseUrl ?? ''}
                  placeholder="https://…/v1"
                  onChange={(e) => void update({ ai: { ...settings.ai, baseUrl: e.target.value } })}
                />
              </Field>
            )}
          </>
        )}
      </Section>

      <Section title="界面与字幕">
        <Field label="主题">
          <SegmentedControl
            options={[
              { value: 'system', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
            value={settings.theme}
            onChange={(theme) => void update({ theme })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`字幕字号：${settings.subtitleStyle.fontSize}px`}>
            <input
              type="range"
              min={14}
              max={36}
              value={settings.subtitleStyle.fontSize}
              onChange={(e) =>
                void update({ subtitleStyle: { ...settings.subtitleStyle, fontSize: Number(e.target.value) } })
              }
              className="w-full accent-indigo-500"
            />
          </Field>
          <div className="space-y-1 pt-4">
            <Switch
              checked={settings.subtitleStyle.showOriginal}
              onChange={(v) => void update({ subtitleStyle: { ...settings.subtitleStyle, showOriginal: v } })}
              label="显示原文字幕"
            />
            <Switch
              checked={settings.subtitleStyle.showTranslation}
              onChange={(v) => void update({ subtitleStyle: { ...settings.subtitleStyle, showTranslation: v } })}
              label="显示译文字幕"
            />
          </div>
        </div>
        <p className="text-xs text-slate-400">
          快捷键：Alt+T 翻译/还原整页 · Alt+M 切换显示模式 · Alt+S 翻译选中文本。可在
          chrome://extensions/shortcuts 修改。
        </p>
      </Section>

      <Section title="隐私">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          LinguaFlow 默认<b>不上传</b>浏览历史、URL、页面标题、字幕内容，不含任何统计分析。只有你主动翻译/查询的文本会发送给所选翻译或
          AI 服务方。所有学习数据（生词本、句子本、统计、缓存）仅存储在本机。
        </p>
        <Switch
          checked={settings.privacy.cloudSync}
          onChange={() => flash('云同步在本版本中未提供后端，保持关闭')}
          label="云同步（预留，本版本不可用）"
        />
      </Section>

      <Section title="缓存">
        <Switch
          checked={settings.cache.enabled}
          onChange={(v) => void update({ cache: { ...settings.cache, enabled: v } })}
          label="启用离线缓存（翻译 / 词典 / AI 回答）"
        />
        <Field label={`缓存有效期：${Math.round(settings.cache.ttlHours / 24)} 天`}>
          <input
            type="range"
            min={1}
            max={90}
            value={Math.round(settings.cache.ttlHours / 24)}
            onChange={(e) => void update({ cache: { ...settings.cache, ttlHours: Number(e.target.value) * 24 } })}
            className="w-full accent-indigo-500"
          />
        </Field>
        <div className="flex gap-2">
          {(
            [
              ['translation', '清空翻译缓存'],
              ['dictionary', '清空词典缓存'],
              ['ai', '清空 AI 缓存'],
              ['all', '全部清空'],
            ] as const
          ).map(([scope, label]) => (
            <Button
              key={scope}
              onClick={() => void sendRequest('cache.clear', { scope }).then(() => flash('已清空'))}
            >
              {label}
            </Button>
          ))}
        </div>
      </Section>

      <Section title="数据备份">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void exportBackup()}>
            导出完整备份（JSON）
          </Button>
          <Button onClick={() => fileRef.current?.click()}>导入备份 / 生词</Button>
          <Button onClick={() => void exportVocabCsv()}>导出生词本（CSV）</Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void importBackup(file);
            e.target.value = '';
          }}
        />
      </Section>
    </div>
  );
}
