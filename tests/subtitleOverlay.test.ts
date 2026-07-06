import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import appSource from '../src/content/ui/App.tsx?raw';

const cssSource = readFileSync(new URL('../src/content/ui/shadow.css', import.meta.url), 'utf8');

describe('compact subtitle overlay', () => {
  it('renders a passive subtitle surface and a separate hover toolbar', () => {
    expect(appSource).toContain('lf-subtitle-surface');
    expect(appSource).toContain('className="lf-subtitle-toolbar"');
    expect(appSource).not.toContain('className="lf-subtitle-header"');
  });

  it('shows a reserved Chinese pending state instead of stale text', () => {
    expect(appSource).toContain("s.translating ? '翻译中…' : s.translation");
    expect(appSource).toContain("s.translating ? 'lf-pending' : ''");
  });

  it('drives toolbar visibility by hover-intent (lf-controls-visible), keyboard focus only', () => {
    // JS hover-intent state machine, not CSS :hover (which vanishes across the gap).
    expect(cssSource).toContain('.lf-subtitle-panel.lf-controls-visible .lf-subtitle-toolbar');
    // :has(:focus-visible), not :focus-within — a mouse click must not pin the toolbar.
    expect(cssSource).toContain('.lf-subtitle-panel:has(:focus-visible) .lf-subtitle-toolbar');
    expect(cssSource).not.toContain('.lf-subtitle-panel:focus-within');
    expect(cssSource).toMatch(/\.lf-subtitle-toolbar\s*\{[^}]*opacity:\s*0/s);
    expect(appSource).toContain('lf-controls-visible');
    expect(appSource).toContain('scheduleHide');
  });

  it('uses the approved translucent background and responsive type', () => {
    expect(cssSource).toContain('background: rgba(24, 24, 24, 0.78)');
    expect(cssSource).toContain('backdrop-filter: blur(8px)');
    expect(cssSource).toContain('font-size: clamp(');
  });
});
