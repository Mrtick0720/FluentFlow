import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { COMMON_LANGUAGES } from '@/shared/constants';
import { uiStore, type UIState } from './store';
import { getSubtitleOverlayGeometry } from './subtitleLayout';

export interface UIActions {
  togglePage(): void;
  toolbarTranslate(): void;
  toolbarExplain(): void;
  toolbarSave(): void;
  toolbarLookup(): void;
  closeWordCard(): void;
  saveWord(): void;
  playWord(): void;
  wordAI(kind: 'explain' | 'examples'): void;
  closeSentenceCard(): void;
  sentenceAI(kind: 'grammar' | 'difficult' | 'easier' | 'advanced'): void;
  saveSentence(): void;
  exportSentence(): void;
  toggleSubtitlePanel(): void;
  subtitlePrev(): void;
  subtitleRepeat(): void;
  subtitleNext(): void;
  subtitleAB(): void;
  subtitleSpeed(rate: number): void;
  subtitleSelectTrack(id: string): void;
  subtitleBookmark(): void;
  subtitleExplain(): void;
  subtitleToggleAutoPause(): void;
  subtitleToggleTranscript(): void;
  subtitleSeekTo(index: number): void;
  openSidePanel(): void;
  openSubtitleStyle(): void;
  closePlayerMenu(): void;
  togglePlayerMenu(anchor: { left: number; top: number }): void;
  openSettings(): void;
  quickTranslate(): void;
  immersiveTranslate(): void;
  translateReplace(): void;
  closeQuickTranslate(): void;
  translateText(text: string, from: string, to: string): Promise<string>;
  saveFabPos(pos: { left: number; top: number }): void;
}

const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8L6 18M18 6l1.8-1.8" />
  </svg>
);

const BoltIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
    <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
  </svg>
);

const ImmersiveIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M4 6h16M4 10h10" />
    <path d="M4 15h16M4 19h10" opacity="0.5" />
  </svg>
);

function useUI(): UIState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.get);
}

function popupPosition(x: number, y: number, width = 380): CSSProperties {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 12)),
    top: Math.min(y + 10, window.innerHeight - 160),
  };
}

/**
 * Make a word/sentence card draggable. Starts at its anchor position; dragging
 * any non-interactive part of the card repositions it (buttons and the
 * scrollable answer keep working).
 */
function useDraggableCard(x: number, y: number, width = 380) {
  const base = popupPosition(x, y, width);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);

  const style: CSSProperties = { ...(pos ?? base), cursor: 'move' };

  const onPointerDown = (e: ReactPointerEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('button, a, input, textarea, select, [contenteditable], .lf-ai-answer')) return;
    const start = pos ?? { left: Number(base.left) || 0, top: Number(base.top) || 0 };
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: start.left, oy: start.top };
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        left: Math.max(4, Math.min(d.ox + (ev.clientX - d.sx), window.innerWidth - 60)),
        top: Math.max(4, Math.min(d.oy + (ev.clientY - d.sy), window.innerHeight - 40)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return { style, onPointerDown };
}

export function App({ actions }: { actions: UIActions }) {
  const ui = useUI();
  return (
    <div className="lf-layer" aria-live="polite">
      {ui.toolbar && <SelectionToolbar ui={ui} actions={actions} />}
      {ui.wordCard && <WordCard key={`${ui.wordCard.x},${ui.wordCard.y}`} ui={ui} actions={actions} />}
      {ui.sentenceCard && (
        <SentenceCard key={`${ui.sentenceCard.x},${ui.sentenceCard.y}`} ui={ui} actions={actions} />
      )}
      {ui.subtitleVisible && ui.subtitleState && <SubtitlePanel ui={ui} actions={actions} />}
      {ui.subtitleVisible && ui.transcriptVisible && <TranscriptPanel ui={ui} actions={actions} />}
      {ui.playerMenu && <PlayerMenu ui={ui} actions={actions} />}
      {ui.quickTranslateOpen && <QuickTranslate actions={actions} label={ui.translationLabel} />}
      <FloatingWidget ui={ui} actions={actions} />
      {ui.toast && (
        <div className="lf-toast" role="status">
          {ui.toast}
        </div>
      )}
    </div>
  );
}

function SelectionToolbar({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const { x, y, text } = ui.toolbar!;
  const isWord = /^[A-Za-z][A-Za-z'-]*$/.test(text.trim());
  return (
    <div
      className="lf-toolbar"
      style={{ left: Math.min(x, window.innerWidth - 240), top: Math.max(8, y - 44) }}
      role="toolbar"
      aria-label="LinguaFlow selection actions"
    >
      <button className="lf-btn" onClick={actions.toolbarTranslate}>
        翻译
      </button>
      {isWord && (
        <button className="lf-btn" onClick={actions.toolbarLookup}>
          查词
        </button>
      )}
      <button className="lf-btn" onClick={actions.toolbarExplain} disabled={!ui.aiAvailable}
        title={ui.aiAvailable ? undefined : '需要在设置中配置 AI'}>
        讲解
      </button>
      <button className="lf-btn" onClick={actions.toolbarSave}>
        收藏
      </button>
    </div>
  );
}

function WordCard({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const card = ui.wordCard!;
  const drag = useDraggableCard(card.x, card.y);
  return (
    <div
      className="lf-card"
      style={drag.style}
      onPointerDown={drag.onPointerDown}
      role="dialog"
      aria-label={`Dictionary: ${card.word}`}
    >
      <button className="lf-close" onClick={actions.closeWordCard} aria-label="关闭">
        ✕
      </button>
      <div>
        <span className="lf-word">{card.word}</span>
        {card.entry?.ipa && <span className="lf-ipa">{card.entry.ipa}</span>}
        {card.entry?.cefr && <span className="lf-cefr">{card.entry.cefr}</span>}
      </div>
      {card.loading && (
        <div className="lf-row" style={{ marginTop: 8 }}>
          <span className="lf-spinner" /> <span className="lf-muted">查询中…</span>
        </div>
      )}
      {card.error && <div className="lf-muted" style={{ marginTop: 8 }}>{card.error}</div>}
      {card.entry?.senses.map((sense, i) => (
        <div className="lf-sense" key={i}>
          {sense.partOfSpeech && <span className="lf-pos">{sense.partOfSpeech}</span>}
          <span>{sense.meaningTranslation ?? sense.meaning}</span>
          {sense.meaningTranslation && sense.meaning !== card.word && (
            <div className="lf-muted">{sense.meaning}</div>
          )}
          {sense.example && <div className="lf-sense-example">“{sense.example}”</div>}
          {sense.synonyms.length > 0 && (
            <div className="lf-muted">近义词：{sense.synonyms.join(', ')}</div>
          )}
        </div>
      ))}
      {card.entry?.collocations && card.entry.collocations.length > 0 && (
        <div className="lf-muted" style={{ marginTop: 6 }}>
          常见搭配：{card.entry.collocations.join(' · ')}
        </div>
      )}
      {card.context && (
        <div className="lf-muted" style={{ marginTop: 6 }}>
          语境：{card.context}
        </div>
      )}
      <div className="lf-row" style={{ marginTop: 10 }}>
        <button className="lf-btn" onClick={actions.playWord} aria-label="播放发音">
          🔊 发音
        </button>
        <button className="lf-btn-primary lf-btn" onClick={actions.saveWord} disabled={card.saved}>
          {card.saved ? '已保存' : '＋ 生词本'}
        </button>
        <button
          className="lf-btn"
          onClick={() => actions.wordAI('explain')}
          disabled={!ui.aiAvailable || card.aiLoading}
          title={ui.aiAvailable ? undefined : '需要在设置中配置 AI'}
        >
          ✨ AI 讲解
        </button>
        <button
          className="lf-btn"
          onClick={() => actions.wordAI('examples')}
          disabled={!ui.aiAvailable || card.aiLoading}
          title={ui.aiAvailable ? undefined : '需要在设置中配置 AI'}
        >
          例句
        </button>
      </div>
      {card.aiLoading && (
        <div className="lf-row" style={{ marginTop: 8 }}>
          <span className="lf-spinner" /> <span className="lf-muted">AI 思考中…</span>
        </div>
      )}
      {card.aiText && <div className="lf-ai-answer">{card.aiText}</div>}
    </div>
  );
}

function SentenceCard({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const card = ui.sentenceCard!;
  const drag = useDraggableCard(card.x, card.y);
  return (
    <div
      className="lf-card"
      style={drag.style}
      onPointerDown={drag.onPointerDown}
      role="dialog"
      aria-label="Sentence learning"
    >
      <button className="lf-close" onClick={actions.closeSentenceCard} aria-label="关闭">
        ✕
      </button>
      <div style={{ paddingRight: 18 }}>{card.text}</div>
      {card.loading && (
        <div className="lf-row" style={{ marginTop: 8 }}>
          <span className="lf-spinner" /> <span className="lf-muted">翻译中…</span>
        </div>
      )}
      {card.translation && (
        <div style={{ marginTop: 8, fontWeight: 500 }}>{card.translation}</div>
      )}
      {card.error && <div className="lf-muted" style={{ marginTop: 8 }}>{card.error}</div>}
      <div className="lf-row" style={{ marginTop: 10 }}>
        {(
          [
            ['grammar', '语法'],
            ['difficult', '难词'],
            ['easier', '简化'],
            ['advanced', '进阶'],
          ] as const
        ).map(([kind, label]) => (
          <button
            key={kind}
            className="lf-btn"
            onClick={() => actions.sentenceAI(kind)}
            disabled={!ui.aiAvailable || card.aiLoading}
            title={ui.aiAvailable ? undefined : '需要在设置中配置 AI'}
          >
            {label}
          </button>
        ))}
        <button className="lf-btn lf-btn-primary" onClick={actions.saveSentence} disabled={card.saved}>
          {card.saved ? '已收藏' : '＋ 句子本'}
        </button>
        <button className="lf-btn" onClick={actions.exportSentence}>
          复制
        </button>
      </div>
      {card.aiLoading && (
        <div className="lf-row" style={{ marginTop: 8 }}>
          <span className="lf-spinner" /> <span className="lf-muted">AI（{card.aiLabel}）思考中…</span>
        </div>
      )}
      {card.aiText && <div className="lf-ai-answer">{card.aiText}</div>}
    </div>
  );
}

const QT_SOURCE = [{ code: 'auto', label: '自动检测' }, ...COMMON_LANGUAGES];

/** Quick-translate scratchpad: type on the left, see the translation on the right. */
function QuickTranslate({ actions, label }: { actions: UIActions; label: string }) {
  const [from, setFrom] = useState('auto');
  const [to, setTo] = useState('zh-CN');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const text = input.trim();
    if (!text) {
      setOutput('');
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await actions.translateText(text, from, to);
        if (id === reqId.current) setOutput(result);
      } catch (e) {
        if (id === reqId.current) setOutput(`翻译失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [input, from, to, actions]);

  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const swap = () => {
    setFrom(to);
    setTo(from === 'auto' ? 'en' : from);
    setInput(output);
    setOutput(input);
  };

  const copy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  // Drag from any non-interactive chrome (not the inputs/selects/buttons).
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('select, textarea, input, button, .lf-qt-output')) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: rect.left, oy: rect.top };
    const w = rect.width;
    const onMove = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({
        left: Math.max(4, Math.min(d.ox + (ev.clientX - d.sx), window.innerWidth - w - 4)),
        top: Math.max(4, Math.min(d.oy + (ev.clientY - d.sy), window.innerHeight - 40)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const style: CSSProperties | undefined = pos
    ? { left: pos.left, top: pos.top, transform: 'none' }
    : undefined;

  return (
    <>
      <div className="lf-qt-backdrop" onClick={actions.closeQuickTranslate} />
      <div
        className="lf-qt"
        ref={rootRef}
        style={style}
        onPointerDown={onPointerDown}
        role="dialog"
        aria-label="快捷翻译"
      >
        <div className="lf-qt-main">
          <div className="lf-qt-cols">
            <div className="lf-qt-col lf-qt-col-in">
              <select
                className="lf-qt-lang"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                aria-label="输入语言"
              >
                {QT_SOURCE.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <textarea
                className="lf-qt-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="输入或粘贴要翻译的文本…"
                autoFocus
              />
              <div className="lf-qt-incount">
                <span>{input.length} 字</span>
                {input && (
                  <button
                    className="lf-qt-iconbtn lf-qt-iconbtn-sm"
                    onClick={() => setInput('')}
                    title="清空"
                    aria-label="清空"
                  >
                    <ClearIcon />
                  </button>
                )}
              </div>
            </div>

            <div className="lf-qt-col lf-qt-col-out">
              <select
                className="lf-qt-lang"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                aria-label="输出语言"
              >
                {COMMON_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <div className="lf-qt-output">
                {loading ? <span className="lf-muted">翻译中…</span> : output}
              </div>
            </div>
          </div>

          <button className="lf-qt-swap" onClick={swap} title="交换语言" aria-label="交换语言">
            <SwapIcon />
          </button>
        </div>
        <div className="lf-qt-footer">
          <span className="lf-muted lf-qt-model">{label || 'LinguaFlow'} · 快捷翻译</span>
          <div className="lf-qt-actions">
            <button
              className="lf-qt-iconbtn"
              onClick={copy}
              disabled={!output}
              title="复制译文"
              aria-label="复制译文"
            >
              {copied ? '✓' : <CopyIcon />}
            </button>
            <button className="lf-btn" onClick={actions.closeQuickTranslate}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

const SwapIcon = () => (
  <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M7 8h13l-3.5-3.5M17 16H4l3.5 3.5" />
  </svg>
);

const ClearIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/** Quick-action menu opened from the YouTube control-bar button. */
function PlayerMenu({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const { x, y } = ui.playerMenu!;
  const items: Array<{ label: string; onClick: () => void; disabled?: boolean }> = [
    // Subtitle actions only make sense on a video page.
    ...(ui.videoDetected
      ? [
          {
            label: ui.subtitleVisible ? '关闭双语字幕' : '双语字幕学习',
            onClick: actions.toggleSubtitlePanel,
          },
          { label: '字幕样式设置', onClick: actions.openSubtitleStyle },
        ]
      : []),
    ...(ui.pageActive
      ? [{ label: '还原整页', onClick: actions.immersiveTranslate }]
      : [
          { label: '双语翻译（原文 + 译文）', onClick: actions.immersiveTranslate },
          { label: '翻译成中文（替换原文）', onClick: actions.translateReplace },
        ]),
    { label: '快捷翻译', onClick: actions.quickTranslate },
    { label: '学习面板（生词 · 句子 · AI）', onClick: actions.openSidePanel },
  ];
  // Anchor above the button, right-aligned to it.
  const width = 220;
  const style = {
    left: Math.max(8, Math.min(x - width + 24, window.innerWidth - width - 8)),
    top: Math.max(8, y - 8 - items.length * 40 - 16),
    width,
  };
  return (
    <>
      <div className="lf-menu-backdrop" onClick={actions.closePlayerMenu} />
      <div className="lf-menu" style={style} role="menu" aria-label="LinguaFlow 快捷菜单">
        <div className="lf-menu-title">LinguaFlow</div>
        {items.map((item) => (
          <button
            key={item.label}
            className="lf-menu-item"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              actions.closePlayerMenu();
              item.onClick();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Floating widget shown on every page: brand button (opens the menu) with
 * 设置/快捷翻译 sliding out on hover, and a 沉浸翻译 button. Defaults to the
 * right edge, vertically centered; draggable, with the position persisted.
 */
const FAB_RIGHT_GAP = 10;

function FloatingWidget({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const draggingRef = useRef(false);
  const liveTop = useRef<number | null>(null);
  const [, forceTick] = useState(0);

  // Re-clamp to the viewport when the window is resized/zoomed so the widget
  // never drifts off-screen.
  useEffect(() => {
    const onResize = () => forceTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Hide during fullscreen video playback.
  if (ui.videoDetected && ui.isFullscreen) return null;

  // Always dock to the right edge; only the vertical position is adjustable and
  // it's clamped to the current viewport (stale/off-screen positions snap back).
  const savedTop = draggingRef.current ? liveTop.current : (ui.fabPos?.top ?? null);
  const h = rootRef.current?.offsetHeight ?? 140;
  const style: CSSProperties | undefined =
    savedTop != null
      ? {
          right: FAB_RIGHT_GAP,
          left: 'auto',
          bottom: 'auto',
          top: Math.max(4, Math.min(savedTop, window.innerHeight - h - 4)),
          transform: 'none',
        }
      : undefined; // CSS default: right edge, vertically centered

  // Press-and-drag moves the widget vertically along the right edge; a tap
  // passes through to the button.
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const start = { sx: e.clientX, sy: e.clientY, oy: rect.top, moved: false };
    const height = el.offsetHeight;

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.sx;
      const dy = ev.clientY - start.sy;
      if (!start.moved && Math.abs(dx) + Math.abs(dy) < 5) return; // tap threshold
      start.moved = true;
      draggingRef.current = true;
      const top = Math.max(4, Math.min(start.oy + dy, window.innerHeight - height - 4));
      liveTop.current = top;
      // Move the element directly (right edge fixed) for a smooth drag.
      el.style.top = `${top}px`;
      el.style.right = `${FAB_RIGHT_GAP}px`;
      el.style.left = 'auto';
      el.style.bottom = 'auto';
      el.style.transform = 'none';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (start.moved && liveTop.current != null) {
        suppressClick.current = true; // swallow the click that ends the drag
        actions.saveFabPos({ left: 0, top: liveTop.current });
        draggingRef.current = false;
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Ignore the click that ends a drag.
  const guard =
    (fn: () => void) =>
    () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      fn();
    };

  return (
    <div className="lf-fab-widget" ref={rootRef} style={style} onPointerDown={onPointerDown}>
      {ui.pageActive && ui.progress.total > 0 && ui.progress.done < ui.progress.total && (
        <span className="lf-fab-progress">
          {ui.progress.done}/{ui.progress.total}
        </span>
      )}
      <div className="lf-fab-shortcuts">
        <button
          className="lf-fab lf-fab-mini"
          onClick={guard(actions.openSettings)}
          title="设置"
          aria-label="设置"
        >
          <GearIcon />
        </button>
        <button
          className="lf-fab lf-fab-mini"
          onClick={guard(actions.quickTranslate)}
          title="快捷翻译"
          aria-label="快捷翻译"
        >
          <BoltIcon />
        </button>
      </div>
      <button
        className={`lf-fab lf-fab-brand ${ui.playerMenu ? 'lf-active' : ''}`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          guard(() => actions.togglePlayerMenu(rect))();
        }}
        title="LinguaFlow 菜单"
        aria-label="LinguaFlow 菜单"
      >
        <img src={chrome.runtime.getURL('icons/icon128.png')} alt="" />
      </button>
      <button
        className={`lf-fab lf-fab-mini lf-fab-immersive ${ui.pageActive ? 'lf-active' : ''}`}
        onClick={guard(actions.immersiveTranslate)}
        title="沉浸翻译（原文在上，译文在下）"
        aria-label="沉浸翻译"
      >
        <ImmersiveIcon />
      </button>
    </div>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function SubtitlePanel({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const s = ui.subtitleState!;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [controlsPinned, setControlsPinned] = useState(false);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onDragStart = (e: ReactPointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Track the pointer's offset from the bar's horizontal CENTER, so the bar
    // stays centered on that point as its width changes with sentence length.
    dragRef.current = { dx: e.clientX - (rect.left + rect.width / 2), dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    setPos({
      left: Math.max(60, Math.min(e.clientX - dragRef.current.dx, window.innerWidth - 60)),
      top: Math.max(0, e.clientY - dragRef.current.dy),
    });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  const geometry = getSubtitleOverlayGeometry(ui.videoRect, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  // Content-sized bar: anchored at the video's center line, grows with the
  // sentence up to maxWidth, then wraps. Dragging pins an explicit corner.
  // Both default and dragged states anchor by center x with translateX(-50%),
  // so the bar stays centered on its point regardless of sentence length.
  const style: CSSProperties = {
    left: pos ? pos.left : geometry.centerX,
    top: pos ? pos.top : geometry.top,
    maxWidth: geometry.maxWidth,
    transform: 'translateX(-50%)',
  };

  const abLabel = !s.abLoop ? 'A-B' : s.abLoop.b === -1 ? 'B?' : 'A-B ✓';
  const stopToolbarPointer = (event: ReactPointerEvent) => event.stopPropagation();

  return (
    <div
      className={`lf-subtitle-panel ${controlsPinned ? 'lf-controls-pinned' : ''}`}
      style={style}
      ref={panelRef}
      role="region"
      aria-label="双语字幕"
    >
      <div
        className="lf-subtitle-toolbar"
        role="toolbar"
        aria-label="字幕学习工具"
        onPointerDown={stopToolbarPointer}
      >
        <button
          className={`lf-btn ${ui.transcriptVisible ? 'lf-btn-primary' : ''}`}
          onClick={actions.subtitleToggleTranscript}
          title="字幕列表"
        >
          ≡ 列表
        </button>
        <button className="lf-btn" onClick={actions.subtitlePrev} title="上一句" aria-label="上一句">⏮</button>
        <button className="lf-btn" onClick={actions.subtitleRepeat} title="重复本句" aria-label="重复本句">↻</button>
        <button className="lf-btn" onClick={actions.subtitleNext} title="下一句" aria-label="下一句">⏭</button>
        <button
          className={`lf-btn ${s.abLoop ? 'lf-btn-primary' : ''}`}
          onClick={actions.subtitleAB}
          title="A-B 循环"
        >
          {abLabel}
        </button>
        <button
          className={`lf-btn ${s.autoPause ? 'lf-btn-primary' : ''}`}
          onClick={actions.subtitleToggleAutoPause}
          title="每句结束自动暂停"
        >
          逐句停
        </button>
        <select
          className="lf-select"
          value={s.playbackRate}
          onChange={(event) => actions.subtitleSpeed(Number(event.target.value))}
          aria-label="播放速度"
        >
          {SPEEDS.map((rate) => <option key={rate} value={rate}>{rate}×</option>)}
        </select>
        {s.tracks.length > 0 && (
          <select
            className="lf-select"
            value={s.activeTrackId}
            onChange={(event) => actions.subtitleSelectTrack(event.target.value)}
            aria-label="选择字幕轨道"
          >
            {s.tracks.map((track) => <option key={track.id} value={track.id}>{track.label}</option>)}
          </select>
        )}
        <button className="lf-btn" onClick={actions.subtitleBookmark} title="收藏当前字幕">🔖</button>
        <button
          className="lf-btn"
          onClick={actions.subtitleExplain}
          disabled={!ui.aiAvailable}
          title={ui.aiAvailable ? '讲解当前句' : '需要在设置中配置 AI'}
        >
          ✨
        </button>
        <button className="lf-btn" onClick={actions.toggleSubtitlePanel} aria-label="关闭字幕">✕</button>
      </div>
      <div
        className="lf-subtitle-surface"
        style={
          ui.subtitleStyle
            ? ({ '--lf-sub-size': `${ui.subtitleStyle.fontSize}px` } as CSSProperties)
            : undefined
        }
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onClick={() => setControlsPinned((pinned) => !pinned)}
      >
        {s.status === 'no-video' && <div className="lf-muted">未检测到视频。</div>}
        {s.status === 'no-subtitles' && (
          <div className="lf-muted">
            此视频没有可用的字幕轨道。若播放器支持，请在播放器中开启字幕（CC）后重试。
          </div>
        )}
        {s.status === 'ready' && s.mode === 'live' && !s.original && (
          <div className="lf-muted">等待字幕…（如无反应，请在播放器中开启字幕/CC）</div>
        )}
        {s.status === 'ready' && (s.mode === 'track' || s.original) && (
          <>
            {(ui.subtitleStyle?.showTranslation ?? true) && (
              <div className={`lf-subtitle-translation ${s.translating ? 'lf-pending' : ''}`}>
                {s.translating ? '翻译中…' : s.translation}
              </div>
            )}
            {(ui.subtitleStyle?.showOriginal ?? true) && (
              <div className="lf-subtitle-original">{s.original || '…'}</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Lyrics-style transcript docked on the right; current line follows playback. */
function TranscriptPanel({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const s = ui.subtitleState!;
  const activeIndex = s.mode === 'track' ? s.index : ui.transcript.length - 1;
  const activeRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const active = activeRef.current;
    if (!list || !active) return;
    // Keep the current line at the ~3rd position: scroll so the item two rows
    // above it sits at the top (first/second lines naturally stay higher).
    const prev1 = active.previousElementSibling as HTMLElement | null;
    const prev2 = prev1?.previousElementSibling as HTMLElement | null;
    const anchor = prev2 ?? prev1 ?? active;
    const delta = anchor.getBoundingClientRect().top - list.getBoundingClientRect().top;
    list.scrollBy({ top: delta, behavior: 'smooth' });
  }, [activeIndex, ui.transcript.length]);

  return (
    <div className="lf-transcript" role="region" aria-label="字幕列表">
      <div className="lf-transcript-header">
        <span className="lf-muted">
          字幕列表{s.mode === 'live' ? '（随播放累积）' : ` · ${ui.transcript.length} 句`}
        </span>
        <button
          className="lf-close"
          style={{ position: 'static' }}
          onClick={actions.subtitleToggleTranscript}
          aria-label="关闭字幕列表"
        >
          ✕
        </button>
      </div>
      <div className="lf-transcript-list" ref={listRef}>
        {ui.transcript.length === 0 && (
          <div className="lf-muted" style={{ padding: 12 }}>
            {s.mode === 'live'
              ? '此站点无法预取完整字幕，播放过的句子会陆续出现在这里。'
              : '暂无字幕。'}
          </div>
        )}
        {ui.transcript.map((seg, i) => (
          <button
            key={i}
            ref={i === activeIndex ? activeRef : undefined}
            className={`lf-transcript-item ${i === activeIndex ? 'lf-current' : ''}`}
            onClick={() => actions.subtitleSeekTo(i)}
            aria-current={i === activeIndex}
          >
            <span className="lf-transcript-time">{formatClock(seg.start)}</span>
            <span className="lf-transcript-text">
              {seg.text}
              {seg.translation && <span className="lf-transcript-trans">{seg.translation}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
