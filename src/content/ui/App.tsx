import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { uiStore, type UIState } from './store';

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
}

function useUI(): UIState {
  return useSyncExternalStore(uiStore.subscribe, uiStore.get);
}

function popupPosition(x: number, y: number, width = 380): CSSProperties {
  return {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 12)),
    top: Math.min(y + 10, window.innerHeight - 160),
  };
}

export function App({ actions }: { actions: UIActions }) {
  const ui = useUI();
  return (
    <div className="lf-layer" aria-live="polite">
      {ui.toolbar && <SelectionToolbar ui={ui} actions={actions} />}
      {ui.wordCard && <WordCard ui={ui} actions={actions} />}
      {ui.sentenceCard && <SentenceCard ui={ui} actions={actions} />}
      {ui.subtitleVisible && ui.subtitleState && <SubtitlePanel ui={ui} actions={actions} />}
      {ui.subtitleVisible && ui.transcriptVisible && <TranscriptPanel ui={ui} actions={actions} />}
      <FabStack ui={ui} actions={actions} />
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
  return (
    <div className="lf-card" style={popupPosition(card.x, card.y)} role="dialog" aria-label={`Dictionary: ${card.word}`}>
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
  return (
    <div className="lf-card" style={popupPosition(card.x, card.y)} role="dialog" aria-label="Sentence learning">
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

function FabStack({ ui, actions }: { ui: UIState; actions: UIActions }) {
  return (
    <div className="lf-fab-stack">
      {ui.pageActive && ui.progress.total > 0 && ui.progress.done < ui.progress.total && (
        <span className="lf-fab-progress">
          {ui.progress.done}/{ui.progress.total}
        </span>
      )}
      {ui.videoDetected && (
        <button
          className={`lf-fab ${ui.subtitleVisible ? 'lf-active' : ''}`}
          onClick={actions.toggleSubtitlePanel}
          title="字幕学习"
          aria-label="字幕学习"
        >
          CC
        </button>
      )}
      <button
        className="lf-fab"
        onClick={actions.openSidePanel}
        title="打开学习面板"
        aria-label="打开学习面板"
      >
        ☰
      </button>
      <button
        className={`lf-fab ${ui.pageActive ? 'lf-active' : ''}`}
        onClick={actions.togglePage}
        title="翻译/还原整页 (Alt+T)"
        aria-label="翻译或还原整页"
      >
        译
      </button>
    </div>
  );
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function SubtitlePanel({ ui, actions }: { ui: UIState; actions: UIActions }) {
  const s = ui.subtitleState!;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const onDragStart = (e: ReactPointerEvent) => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: ReactPointerEvent) => {
    if (!dragRef.current) return;
    setPos({
      left: Math.max(0, e.clientX - dragRef.current.dx),
      top: Math.max(0, e.clientY - dragRef.current.dy),
    });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  // Priority: user drag position > video-bottom anchor > viewport bottom.
  const style: CSSProperties = pos
    ? { left: pos.left, top: pos.top, bottom: 'auto', transform: 'none' }
    : ui.subtitleAnchor
      ? {
          left: Math.min(Math.max(ui.subtitleAnchor.x, 190), window.innerWidth - 190),
          top: Math.max(8, Math.min(ui.subtitleAnchor.y, window.innerHeight - 200)),
          bottom: 'auto',
        }
      : {};

  const abLabel = !s.abLoop ? 'A-B' : s.abLoop.b === -1 ? 'B?' : 'A-B ✓';

  return (
    <div className="lf-subtitle-panel" style={style} ref={panelRef} role="region" aria-label="字幕学习面板">
      <div
        className="lf-subtitle-header"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <span className="lf-muted">
          字幕学习{s.mode === 'live' ? '（跟随播放器字幕）' : ` · ${s.index + 1}/${s.total}`}
        </span>
        <span className="lf-row">
          <button
            className={`lf-btn ${ui.transcriptVisible ? 'lf-btn-primary' : ''}`}
            onClick={actions.subtitleToggleTranscript}
            title="字幕列表（歌词模式）"
          >
            ≡ 列表
          </button>
          {s.tracks.length > 0 && (
            <select
              className="lf-select"
              value={s.activeTrackId}
              onChange={(e) => actions.subtitleSelectTrack(e.target.value)}
              aria-label="选择字幕轨道"
            >
              {s.tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          )}
          <button className="lf-close" style={{ position: 'static' }} onClick={actions.toggleSubtitlePanel} aria-label="关闭面板">
            ✕
          </button>
        </span>
      </div>
      <div
        className="lf-subtitle-body"
        style={
          ui.subtitleStyle
            ? ({ '--lf-sub-size': `${ui.subtitleStyle.fontSize}px` } as CSSProperties)
            : undefined
        }
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
            {(ui.subtitleStyle?.showOriginal ?? true) && (
              <div className="lf-subtitle-original">{s.original || '…'}</div>
            )}
            {(ui.subtitleStyle?.showTranslation ?? true) && (
              <div className="lf-subtitle-translation">{s.translation}</div>
            )}
          </>
        )}
      </div>
      <div className="lf-subtitle-controls">
        <button className="lf-btn" onClick={actions.subtitlePrev} title="上一句" aria-label="上一句">
          ⏮
        </button>
        <button className="lf-btn" onClick={actions.subtitleRepeat} title="重复本句" aria-label="重复本句">
          ↻
        </button>
        <button className="lf-btn" onClick={actions.subtitleNext} title="下一句" aria-label="下一句">
          ⏭
        </button>
        <button
          className={`lf-btn ${s.abLoop ? 'lf-btn-primary' : ''}`}
          onClick={actions.subtitleAB}
          title="A-B 循环：第一次按设起点，第二次按设终点，第三次按取消"
        >
          {abLabel}
        </button>
        <button
          className={`lf-btn ${s.autoPause ? 'lf-btn-primary' : ''}`}
          onClick={actions.subtitleToggleAutoPause}
          title="学习模式：每句结束自动暂停，按 ↻ 重听、⏭ 继续"
        >
          逐句停
        </button>
        <select
          className="lf-select"
          value={s.playbackRate}
          onChange={(e) => actions.subtitleSpeed(Number(e.target.value))}
          aria-label="播放速度"
        >
          {SPEEDS.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
        <button className="lf-btn" onClick={actions.subtitleBookmark} title="收藏当前字幕句">
          🔖 收藏
        </button>
        <button
          className="lf-btn"
          onClick={actions.subtitleExplain}
          disabled={!ui.aiAvailable}
          title={ui.aiAvailable ? 'AI 讲解当前句' : '需要在设置中配置 AI'}
        >
          ✨ 讲解
        </button>
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

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
      <div className="lf-transcript-list">
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
