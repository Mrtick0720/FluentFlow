import { useEffect, useRef, useState } from 'react';
import { Button, Field, Section, SegmentedControl, Select, Switch, TextInput } from '@/components/ui';
import { useSettings, useTheme } from '@/hooks/useSettings';
import { COMMON_LANGUAGES } from '@/shared/constants';
import { sendRequest } from '@/shared/messages';
import { REDACTED_KEY, type ProviderSelection, type UserSettings } from '@/shared/settings';
import { providerLogo } from '@/shared/providerLogos';
import type { Sentence, TranslationProviderId, Vocabulary } from '@/types/models';
import { downloadFile, toCsv } from '@/utils/csv';

/** Common OpenAI-compatible endpoints; picking one fills base URL + model. */
const AI_PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'Gemini（OpenAI 兼容）', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  { label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
  { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
];

/**
 * Ask Chrome for access to an endpoint's origin. Must run in the page (user
 * gesture); routing it through the service worker loses the gesture and gets
 * rejected.
 */
async function grantOrigin(rawUrl: string): Promise<boolean> {
  try {
    const origin = new URL(rawUrl).origin + '/*';
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export function Options() {
  const { settings, update } = useSettings();
  useTheme(settings?.theme);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Deep link: options.html#subtitle scrolls to the subtitle style section.
  useEffect(() => {
    if (!settings || !location.hash) return;
    const el = document.querySelector(location.hash);
    if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth' }));
  }, [settings]);

  if (!settings) return <div className="p-10 text-center text-slate-400">加载中…</div>;

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 2500);
  };

  const setProvider = (id: TranslationProviderId, patch: Record<string, string>) =>
    void update({ providers: { ...settings.providers, [id]: { ...settings.providers[id], ...patch } } });

  const setAI = (patch: Partial<UserSettings['ai']>) => void update({ ai: { ...settings.ai, ...patch } });

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
    downloadFile(`fluentflow-backup-${Date.now()}.json`, JSON.stringify(backup, null, 2), 'application/json');
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
    downloadFile('fluentflow-vocabulary.csv', csv, 'text/csv');
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-6 pb-16">
      <header className="flex items-center gap-3">
        <img src={chrome.runtime.getURL('icons/icon48.png')} alt="" className="h-7 w-7 rounded-lg" />
        <div>
          <h1 className="text-lg font-bold">FluentFlow 设置</h1>
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
          <Field label="划词 / 快捷翻译引擎">
            <Select
              className="w-full"
              value={settings.translationProvider}
              onChange={(e) => void update({ translationProvider: e.target.value as ProviderSelection })}
            >
              <option value="google">Google（免费，无需密钥）</option>
              <option value="deepl">DeepL</option>
              <option value="openai">OpenAI</option>
              <option value="azure">Azure Translator</option>
              {settings.customEndpoints.map((ep) => (
                <option key={ep.id} value={`custom:${ep.id}`}>
                  {ep.name || ep.model || '自定义端点'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="整页翻译引擎" hint="建议用快速机器翻译（Google/DeepL）；大模型端点整页翻译会很慢">
            <Select
              className="w-full"
              value={settings.pageTranslationProvider}
              onChange={(e) => void update({ pageTranslationProvider: e.target.value as ProviderSelection })}
            >
              <option value="google">Google（免费，无需密钥）</option>
              <option value="deepl">DeepL</option>
              <option value="openai">OpenAI</option>
              <option value="azure">Azure Translator</option>
              {settings.customEndpoints.map((ep) => (
                <option key={ep.id} value={`custom:${ep.id}`}>
                  {ep.name || ep.model || '自定义端点'}
                </option>
              ))}
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
          <SecretInput
            stored={!!settings.providers.deepl?.apiKey}
            onSave={(v) => {
              setProvider('deepl', { apiKey: v });
              flash('DeepL 密钥已保存');
            }}
          />
        </Field>
        <Field label="OpenAI API Key">
          <SecretInput
            stored={!!settings.providers.openai?.apiKey}
            onSave={(v) => {
              setProvider('openai', { apiKey: v });
              flash('OpenAI 密钥已保存');
            }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Azure Key">
            <SecretInput
              stored={!!settings.providers.azure?.apiKey}
              onSave={(v) => {
                setProvider('azure', { apiKey: v });
                flash('Azure 密钥已保存');
              }}
            />
          </Field>
          <Field label="Azure 区域">
            <SavedInput
              value={settings.providers.azure?.region ?? ''}
              placeholder="如 eastasia"
              onSave={(v) => setProvider('azure', { region: v })}
            />
          </Field>
        </div>
        <CustomEndpointsEditor settings={settings} update={update} flash={flash} />
      </Section>

      <Section title="AI 助手">
        <div className="grid grid-cols-2 gap-3">
          <Field label="AI 提供方">
            <Select
              className="w-full"
              value={settings.ai.kind}
              onChange={(e) => setAI({ kind: e.target.value as UserSettings['ai']['kind'] })}
            >
              <option value="none">未启用</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI</option>
              <option value="custom">其他模型（OpenAI 兼容端点）</option>
            </Select>
          </Field>
          <Field label="模型（可选）" hint={settings.ai.kind === 'custom' ? '可点「拉取」获取列表' : undefined}>
            {settings.ai.kind === 'custom' ? (
              <ModelPicker value={settings.ai.model ?? ''} target="ai" onSave={(v) => setAI({ model: v.trim() })} />
            ) : (
              <SavedInput
                value={settings.ai.model ?? ''}
                placeholder="留空使用默认"
                onSave={(v) => setAI({ model: v })}
              />
            )}
          </Field>
        </div>
        {settings.ai.kind === 'custom' && (
          <>
            <Field label="常用端点预设" hint="DeepSeek、Kimi、通义、智谱、Ollama 等均为 OpenAI 兼容接口">
              <Select
                className="w-full"
                value=""
                onChange={async (e) => {
                  const preset = AI_PRESETS.find((p) => p.label === e.target.value);
                  if (!preset) return;
                  setAI({ kind: 'custom', baseUrl: preset.baseUrl, model: preset.model || settings.ai.model });
                  const granted = await grantOrigin(preset.baseUrl);
                  flash(granted ? `已选择 ${preset.label} 并授权端点访问` : `已选择 ${preset.label}（未授权，请点击下方授权按钮）`);
                }}
              >
                <option value="">选择预设…</option>
                {AI_PRESETS.map((p) => (
                  <option key={p.label} value={p.label}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Base URL">
              <SavedInput
                value={settings.ai.baseUrl ?? ''}
                placeholder="https://…/v1"
                onSave={async (v) => {
                  setAI({ baseUrl: v });
                  if (v) flash((await grantOrigin(v)) ? '已保存并授权' : '已保存（未授权）');
                }}
              />
            </Field>
          </>
        )}
        {settings.ai.kind !== 'none' && (
          <Field label="API Key">
            <SecretInput
              stored={!!settings.ai.apiKey}
              onSave={(v) => {
                setAI({ apiKey: v });
                flash('AI 密钥已保存');
              }}
            />
          </Field>
        )}
        {settings.ai.kind !== 'none' && (
          <EndpointTester
            getUrl={() => settings.ai.baseUrl}
            run={async () => {
              const r = await sendRequest('ai.complete', {
                messages: [{ role: 'user', content: '只回复两个字：你好' }],
              });
              return `连接成功：${r.text.slice(0, 24) || '(空)'}`;
            }}
          />
        )}
      </Section>

      <Section id="subtitle" title="界面与字幕">
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
      </Section>

      <ShortcutsSection />

      <Section title="隐私">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          FluentFlow 默认<b>不上传</b>浏览历史、URL、页面标题、字幕内容，不含任何统计分析。只有你主动翻译/查询的文本会发送给所选翻译或
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

/**
 * Keyboard shortcuts for the current features. Chrome only lets the user
 * rebind extension shortcuts on chrome://extensions/shortcuts, so this lists
 * the commands with their current keys and links there.
 */
function ShortcutsSection() {
  const [commands, setCommands] = useState<chrome.commands.Command[]>([]);

  useEffect(() => {
    chrome.commands.getAll().then(setCommands, () => {});
  }, []);

  // Ignore Chrome's built-in action command; show only our feature commands.
  const items = commands.filter((c) => c.name && !c.name.startsWith('_'));

  return (
    <Section title="快捷键">
      <p className="text-xs text-slate-400">
        以下是各功能的键盘快捷键。Chrome 只允许在其快捷键设置页修改键位。
      </p>
      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {items.map((c) => (
          <div key={c.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <span className="text-sm">{c.description || c.name}</span>
            {c.shortcut ? (
              <kbd className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium dark:border-slate-700 dark:bg-slate-800">
                {c.shortcut}
              </kbd>
            ) : (
              <span className="text-xs text-slate-400">未设置</span>
            )}
          </div>
        ))}
        {items.length === 0 && (
          <div className="px-3 py-2.5 text-xs text-slate-400">加载中…</div>
        )}
      </div>
      <Button
        variant="primary"
        onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}
      >
        在 Chrome 中修改快捷键
      </Button>
    </Section>
  );
}

/**
 * Manage the list of saved custom endpoints (DeepSeek, Gemini, GLM, …). Each
 * keeps its own Base URL / model / key and is selectable as the default engine.
 */
function CustomEndpointsEditor({
  settings,
  update,
  flash,
}: {
  settings: UserSettings;
  update: (patch: Partial<UserSettings>) => void;
  flash: (msg: string) => void;
}) {
  const endpoints = settings.customEndpoints;
  const uid = () =>
    globalThis.crypto?.randomUUID?.() ?? `ep-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const patch = (id: string, p: Partial<(typeof endpoints)[number]>) =>
    update({ customEndpoints: endpoints.map((e) => (e.id === id ? { ...e, ...p } : e)) });
  const add = (ep: (typeof endpoints)[number]) => update({ customEndpoints: [...endpoints, ep] });
  const remove = (id: string) =>
    update({
      customEndpoints: endpoints.filter((e) => e.id !== id),
      ...(settings.translationProvider === `custom:${id}`
        ? { translationProvider: 'google' as ProviderSelection }
        : {}),
      ...(settings.pageTranslationProvider === `custom:${id}`
        ? { pageTranslationProvider: 'google' as ProviderSelection }
        : {}),
    });

  return (
    <div className="space-y-3">
      {endpoints.length === 0 && (
        <p className="text-xs text-slate-400">
          还没有自定义端点。用下方「从预设新建」或「新建空白端点」添加。
        </p>
      )}

      {endpoints.map((ep) => {
        const isDefault = settings.translationProvider === `custom:${ep.id}`;
        return (
          <div
            key={ep.id}
            className={`space-y-2 rounded-xl border p-3 ${
              isDefault
                ? 'border-indigo-400 dark:border-indigo-500'
                : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            <div className="flex items-center gap-2">
              {(() => {
                const logo = providerLogo(ep.name, ep.model);
                if (!logo) return null;
                const px = Math.round(24 * logo.scale);
                return (
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                    <img src={logo.src} alt="" style={{ width: px, height: px }} />
                  </span>
                );
              })()}
              <div className="min-w-0 flex-1">
                <SavedInput
                  value={ep.name}
                  placeholder="名称，如 DeepSeek"
                  onSave={(v) => patch(ep.id, { name: v.trim() || '自定义端点' })}
                />
              </div>
              <Button
                className="shrink-0"
                disabled={isDefault}
                onClick={() => update({ translationProvider: `custom:${ep.id}` as ProviderSelection })}
              >
                {isDefault ? '默认 ✓' : '设为默认'}
              </Button>
              <Button className="shrink-0" onClick={() => remove(ep.id)}>
                删除
              </Button>
            </div>
            <Field label="Base URL" hint="OpenAI 兼容，需带 /v1（漏填自动补上）">
              <SavedInput
                value={ep.baseUrl ?? ''}
                placeholder="https://…/v1"
                onSave={async (v) => {
                  patch(ep.id, { baseUrl: v });
                  if (v) flash((await grantOrigin(v)) ? '已保存并授权访问该端点' : '已保存（未授权）');
                }}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="模型" hint="可点「拉取」从端点获取列表">
                <ModelPicker
                  value={ep.model ?? ''}
                  target="translationCustom"
                  endpointId={ep.id}
                  onSave={(v) => patch(ep.id, { model: v.trim() })}
                />
              </Field>
              <Field label="Key（可选）">
                <SecretInput stored={!!ep.apiKey} onSave={(v) => patch(ep.id, { apiKey: v })} />
              </Field>
            </div>
            {ep.baseUrl && (
              <EndpointTester
                getUrl={() => ep.baseUrl}
                run={async () => {
                  const r = await sendRequest('translation.translate', {
                    texts: ['Hello, world.'],
                    from: 'en',
                    to: settings.targetLanguage,
                    provider: `custom:${ep.id}`,
                    refresh: true,
                  });
                  return `连接成功：${r.translations[0] || '(空)'}`;
                }}
              />
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="min-w-[220px]"
          value=""
          onChange={async (e) => {
            const preset = AI_PRESETS.find((p) => p.label === e.target.value);
            if (!preset) return;
            add({ id: uid(), name: preset.label.replace(/（.*?）/, ''), baseUrl: preset.baseUrl, model: preset.model });
            const granted = await grantOrigin(preset.baseUrl);
            flash(granted ? `已添加 ${preset.label} 并授权` : `已添加 ${preset.label}（未授权）`);
          }}
        >
          <option value="">从预设新建…（DeepSeek、Gemini、Kimi、通义、GLM…）</option>
          {AI_PRESETS.map((p) => (
            <option key={p.label} value={p.label}>
              {p.label}
            </option>
          ))}
        </Select>
        <Button onClick={() => add({ id: uid(), name: '自定义端点', baseUrl: '', model: '' })}>
          新建空白端点
        </Button>
      </div>
      <p className="text-xs text-slate-400">
        每个端点各自保存 Base URL / 模型 / 密钥（AES-GCM 本地加密，绝不上传）。点「设为默认」即用该端点翻译，也可在上方「默认引擎」或工具栏弹窗里随时切换。
      </p>
    </div>
  );
}

/**
 * Runs a live round-trip against a configured endpoint and shows the real
 * result or error, so a misconfigured URL / key / model stops failing
 * silently. Requests the origin permission first (button click is a user
 * gesture, required for chrome.permissions.request).
 */
function EndpointTester({
  getUrl,
  run,
}: {
  getUrl: () => string | undefined;
  run: () => Promise<string>;
}) {
  const [state, setState] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState('');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={state === 'testing'}
        onClick={async () => {
          setState('testing');
          setMsg('');
          try {
            const url = getUrl();
            if (url) await grantOrigin(url);
            setMsg(await run());
            setState('ok');
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
            setState('err');
          }
        }}
      >
        {state === 'testing' ? '测试中…' : '测试连接'}
      </Button>
      {state === 'ok' && <span className="text-xs text-green-600 dark:text-green-400">✓ {msg}</span>}
      {state === 'err' && <span className="max-w-md break-all text-xs text-red-500">✗ {msg}</span>}
    </div>
  );
}

/**
 * Model field with a "拉取" button that lists the endpoint's available models
 * (GET /models via the service worker) into a dropdown — so the user picks a
 * currently-valid id instead of guessing (and hitting model_not_found / "no
 * longer available"). Save the Base URL and key first.
 */
function ModelPicker({
  value,
  target,
  endpointId,
  onSave,
}: {
  value: string;
  target: 'translationCustom' | 'ai';
  endpointId?: string;
  onSave: (value: string) => void;
}) {
  const [models, setModels] = useState<string[] | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'err'>('idle');
  const [err, setErr] = useState('');
  return (
    <div className="space-y-1.5">
      <div className="flex items-stretch gap-2">
        <div className="min-w-0 flex-1">
          <SavedInput value={value} placeholder="如 gemini-2.5-flash" onSave={(v) => onSave(v.trim())} />
        </div>
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={status === 'loading'}
          onClick={async () => {
            setStatus('loading');
            setErr('');
            try {
              const { models: list } = await sendRequest('models.list', { target, endpointId });
              setModels(list);
              setStatus('idle');
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e));
              setStatus('err');
            }
          }}
        >
          {status === 'loading' ? '…' : '拉取'}
        </Button>
      </div>
      {models && models.length > 0 && (
        <Select
          className="w-full"
          value=""
          onChange={(e) => {
            if (e.target.value) onSave(e.target.value);
            setModels(null); // used once — collapse so it doesn't duplicate the input
          }}
        >
          <option value="">从 {models.length} 个可用模型中选择…</option>
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      )}
      {models && models.length === 0 && (
        <span className="text-xs text-slate-400">该端点未返回模型列表，请手动填写</span>
      )}
      {status === 'err' && <span className="block max-w-md break-all text-xs text-red-500">✗ {err}</span>}
    </div>
  );
}

/**
 * API-key input. Keys are write-only: the stored value never appears in the
 * field (the backend only ever returns a redaction mark), so this keeps its
 * own draft state and commits on blur / Enter. Fixes the bug where saving on
 * every keystroke echoed the redaction mark back into the field.
 */
function SecretInput({ stored, onSave }: { stored: boolean; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const v = draft.trim();
    if (!v || v === REDACTED_KEY) return;
    onSave(v);
    setDraft('');
  };
  return (
    <TextInput
      type="password"
      value={draft}
      placeholder={stored ? '已保存（输入新密钥可更换）' : '未设置'}
      autoComplete="off"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

/** Text input that commits on blur / Enter instead of every keystroke. */
function SavedInput({
  value,
  onSave,
  placeholder,
}: {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onSave(draft.trim());
  };
  return (
    <TextInput
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}
