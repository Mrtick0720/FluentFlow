import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import appSource from '../src/content/ui/App.tsx?raw';

const cssSource = readFileSync(new URL('../src/content/ui/shadow.css', import.meta.url), 'utf8');

describe('compact subtitle overlay', () => {
  it('renders a passive subtitle surface and a separate hover toolbar', () => {
    expect(appSource).toContain('className="lf-subtitle-surface"');
    expect(appSource).toContain('className="lf-subtitle-toolbar"');
    expect(appSource).not.toContain('className="lf-subtitle-header"');
  });

  it('shows a reserved Chinese pending state instead of stale text', () => {
    expect(appSource).toContain("s.translating ? '翻译中…' : s.translation");
    expect(appSource).toContain("s.translating ? 'lf-pending' : ''");
  });

  it('hides controls until hover, focus, or touch pinning', () => {
    expect(cssSource).toContain('.lf-subtitle-panel:hover .lf-subtitle-toolbar');
    expect(cssSource).toContain('.lf-subtitle-panel:focus-within .lf-subtitle-toolbar');
    expect(cssSource).toContain('.lf-subtitle-panel.lf-controls-pinned .lf-subtitle-toolbar');
    expect(cssSource).toMatch(/\.lf-subtitle-toolbar\s*\{[^}]*opacity:\s*0/s);
  });

  it('uses the approved translucent background and responsive type', () => {
    expect(cssSource).toContain('background: rgba(24, 24, 24, 0.78)');
    expect(cssSource).toContain('backdrop-filter: blur(8px)');
    expect(cssSource).toContain('font-size: clamp(');
  });
});
