import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import appSource from '../src/content/ui/App.tsx?raw';

const cssSource = readFileSync(new URL('../src/content/ui/shadow.css', import.meta.url), 'utf8');

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

  it('uses fixed dark panes and viewport-safe sizing', () => {
    expect(cssSource).toMatch(/\.lf-qt\s*\{[^}]*background:\s*#171717/s);
    expect(cssSource).toMatch(/\.lf-qt-col-in\s*\{[^}]*background:\s*#262626/s);
    expect(cssSource).toMatch(/\.lf-qt-col-out\s*\{[^}]*background:\s*#181818/s);
    expect(cssSource).toContain('grid-template-columns: 1fr 1fr');
    expect(cssSource).toContain('width: min(96vw, 1400px)');
    expect(cssSource).toContain('height: min(90vh, 900px)');
  });

  it('overlays the swap control on the center boundary', () => {
    expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*position:\s*absolute/s);
    expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*left:\s*50%/s);
    expect(cssSource).toMatch(/\.lf-qt-swap\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  });
});
