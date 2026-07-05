import { describe, expect, it } from 'vitest';
import appSource from '../src/content/ui/App.tsx?raw';

describe('Quick Translate reference UI', () => {
  it('uses a two-pane main layer without the old drag bar', () => {
    expect(appSource).toContain('className="lf-qt-main"');
    expect(appSource).toContain('className="lf-qt-cols"');
    expect(appSource).not.toContain('className="lf-qt-dragbar"');
  });

  it('preserves dialog and control semantics', () => {
    expect(appSource).toContain('role="dialog"');
    expect(appSource).toContain('aria-label="输入语言"');
    expect(appSource).toContain('aria-label="输出语言"');
    expect(appSource).toContain('aria-label="交换语言"');
    expect(appSource).toContain('aria-label="清空"');
  });

  it('keeps footer structure and actions unchanged', () => {
    expect(appSource).toContain('className="lf-qt-footer"');
    expect(appSource).toContain('className="lf-muted lf-qt-model"');
    expect(appSource).toContain('aria-label="复制译文"');
    expect(appSource).toContain('onClick={actions.closeQuickTranslate}');
  });
});
