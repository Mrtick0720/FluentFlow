import { ATTR_TRANSLATED } from '@/shared/constants';
import type { DisplayMode } from '@/types/models';
import { debounce } from '@/utils/async';
import {
  collectTranslatableBlocks,
  introducesUnsafeLayout,
  isOccluded,
  layoutGuardTargets,
  looksLikeTargetLanguage,
  shouldReplaceInPlace,
  snapshotWithTargets,
  type LayoutSnapshot,
} from '@/utils/dom';

/**
 * Snapshot an element's layout before a translation and expose a fresh
 * after-snapshot, reusing the exact clipping ancestors and siblings selected
 * before mutation so array positions stay comparable.
 */
function createLayoutGuard(el: HTMLElement): { before: LayoutSnapshot; after: () => LayoutSnapshot } {
  const { clips, siblings } = layoutGuardTargets(el);
  return {
    before: snapshotWithTargets(el, clips, siblings),
    after: () => snapshotWithTargets(el, clips, siblings),
  };
}

export interface PageTranslatorOptions {
  translate: (texts: string[]) => Promise<string[]>;
  targetLanguage: string;
  mode: DisplayMode;
  style: 'plain' | 'underline' | 'tinted';
  fontScale: number;
  onProgress?: (done: number, total: number) => void;
  onError?: (message: string) => void;
}

const MODE_ATTR = 'data-lf-mode';
const BATCH_DEBOUNCE_MS = 120;
const MAX_PER_FLUSH = 16;
/** Overlapping provider requests — the main lever for whole-page speed. */
const MAX_CONCURRENT_FLUSHES = 3;

/**
 * Translates page blocks lazily (viewport-first) and inserts translations
 * next to the originals. Fully reversible: stop() restores the page.
 *
 * DOM shape per translated block:
 *   <p data-lf-translated>
 *     <span class="lf-original">…original child nodes…</span>
 *     <span class="lf-trans lf-tinted">…translation…</span>
 *   </p>
 * Display modes toggle via a single attribute on <html>.
 */
export class PageTranslator {
  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private queue = new Set<HTMLElement>();
  private inflight = new Set<HTMLElement>();
  private activeFlushes = 0;
  private attempts = new WeakMap<HTMLElement, number>();
  private spinners = new WeakMap<HTMLElement, HTMLElement>();
  private doneCount = 0;
  private totalCount = 0;
  private selfMutations = 0;
  public active = false;

  constructor(private opts: PageTranslatorOptions) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    document.documentElement.setAttribute(MODE_ATTR, this.opts.mode);

    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.queue.add(entry.target as HTMLElement);
            this.io?.unobserve(entry.target);
          }
        }
        this.pumpSoon();
      },
      { rootMargin: '200px 0px' },
    );

    this.observeBlocks(collectTranslatableBlocks(document.body));

    this.mo = new MutationObserver((records) => {
      if (this.selfMutations > 0) return;
      const added = records.some((r) => r.addedNodes.length > 0);
      if (added) this.rescanSoon();
    });
    this.mo.observe(document.body, { childList: true, subtree: true });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = null;
    this.mo = null;
    this.queue.clear();
    this.activeFlushes = 0;
    this.pumpSoon.cancel();
    this.rescanSoon.cancel();
    document.documentElement.removeAttribute(MODE_ATTR);

    this.withSelfMutation(() => {
      for (const el of document.querySelectorAll<HTMLElement>('.lf-loading')) el.remove();
      for (const el of document.querySelectorAll<HTMLElement>(`[${ATTR_TRANSLATED}]`)) {
        const original = el.querySelector(':scope > .lf-original');
        el.querySelector(':scope > .lf-trans')?.remove();
        if (original) {
          while (original.firstChild) el.insertBefore(original.firstChild, original);
          original.remove();
        }
        el.removeAttribute(ATTR_TRANSLATED);
        el.classList.remove('lf-replaced');
      }
    });
    this.doneCount = 0;
    this.totalCount = 0;
  }

  setMode(mode: DisplayMode): void {
    this.opts.mode = mode;
    if (this.active) document.documentElement.setAttribute(MODE_ATTR, mode);
  }

  private observeBlocks(blocks: HTMLElement[]): void {
    for (const block of blocks) {
      const text = block.textContent?.trim() ?? '';
      if (looksLikeTargetLanguage(text, this.opts.targetLanguage)) continue;
      this.totalCount++;
      this.io?.observe(block);
    }
    this.opts.onProgress?.(this.doneCount, this.totalCount);
  }

  private rescanSoon = debounce(() => {
    if (!this.active) return;
    this.observeBlocks(collectTranslatableBlocks(document.body));
  }, 400);

  private pumpSoon = debounce(() => this.pump(), BATCH_DEBOUNCE_MS);

  /** Keep up to MAX_CONCURRENT_FLUSHES provider requests in flight at once. */
  private pump(): void {
    if (!this.active) return;
    while (this.activeFlushes < MAX_CONCURRENT_FLUSHES && this.queue.size > 0) {
      this.activeFlushes++;
      // flush() runs synchronously through batch selection before its first
      // await, so concurrent calls pick disjoint batches.
      void this.flush().finally(() => {
        this.activeFlushes--;
        this.pump();
      });
    }
  }

  private async flush(): Promise<void> {
    if (!this.active || this.queue.size === 0) return;
    const batch = [...this.queue].slice(0, MAX_PER_FLUSH).filter((el) => {
      this.queue.delete(el);
      if (!el.isConnected || this.inflight.has(el) || el.hasAttribute(ATTR_TRANSLATED)) return false;
      // Skip content covered by an overlay (carousel slides / mega-menus stacked
      // behind the page via z-index) — translating them causes overlapping mess.
      if (isOccluded(el)) return false;
      return true;
    });
    if (batch.length === 0) return;
    batch.forEach((el) => this.inflight.add(el));
    // Tiny spinner after each paragraph so the user sees it loading.
    this.withSelfMutation(() => batch.forEach((el) => this.showSpinner(el)));

    try {
      const texts = batch.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
      const translations = await this.opts.translate(texts);
      if (!this.active) return;
      let applied = 0;
      this.withSelfMutation(() => {
        batch.forEach((el, i) => {
          this.hideSpinner(el); // remove before applyTranslation moves children
          const translation = translations[i];
          if (!translation || !el.isConnected) return;
          // Layout guard: if the rendered translation newly overflows the
          // element or a clipping ancestor, or newly overlaps a neighbour,
          // revert — better untranslated than breaking the layout.
          const layout = createLayoutGuard(el);
          this.applyTranslation(el, translation);
          if (introducesUnsafeLayout(layout.before, layout.after())) {
            this.revertTranslation(el);
          } else {
            applied++;
          }
        });
      });
      this.doneCount += applied;
      this.opts.onProgress?.(this.doneCount, this.totalCount);
    } catch (err) {
      // Retry a few times (transient proxy/network errors), then give up so the
      // paragraph doesn't spin forever.
      batch.forEach((el) => {
        const n = (this.attempts.get(el) ?? 0) + 1;
        this.attempts.set(el, n);
        if (n < 3 && el.isConnected) this.queue.add(el);
      });
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      // Remove any spinners still up (error path / skipped elements).
      this.withSelfMutation(() => batch.forEach((el) => this.hideSpinner(el)));
      batch.forEach((el) => this.inflight.delete(el));
    }
  }

  private showSpinner(el: HTMLElement): void {
    if (this.spinners.has(el) || el.hasAttribute(ATTR_TRANSLATED)) return;
    const spinner = document.createElement('span');
    spinner.className = 'lf-loading';
    spinner.setAttribute('aria-hidden', 'true');
    el.appendChild(spinner);
    this.spinners.set(el, spinner);
  }

  private hideSpinner(el: HTMLElement): void {
    const spinner = this.spinners.get(el);
    if (spinner) {
      spinner.remove();
      this.spinners.delete(el);
    }
  }

  /** Undo a single element's translation (layout guard rejected it). */
  private revertTranslation(el: HTMLElement): void {
    const original = el.querySelector(':scope > .lf-original');
    el.querySelector(':scope > .lf-trans')?.remove();
    if (original) {
      while (original.firstChild) el.insertBefore(original.firstChild, original);
      original.remove();
    }
    el.removeAttribute(ATTR_TRANSLATED);
    el.classList.remove('lf-replaced');
  }

  private applyTranslation(el: HTMLElement, translation: string): void {
    if (el.hasAttribute(ATTR_TRANSLATED)) return;

    // Decide BEFORE moving children out (it inspects el.textContent).
    // Layout-sensitive elements: hide the original and show only the
    // translation in place (no added block) so tight layouts don't break.
    const replace = shouldReplaceInPlace(el);
    if (replace) el.classList.add('lf-replaced');

    const original = document.createElement('span');
    original.className = 'lf-original';
    while (el.firstChild) original.appendChild(el.firstChild);

    // Headings read cleaner as plain text below the title, without the
    // tinted/underline block the body paragraphs use.
    const isHeading = /^H[1-6]$/.test(el.tagName);
    const style = replace || isHeading ? 'plain' : this.opts.style;
    const trans = document.createElement('span');
    trans.className = `lf-trans lf-style-${style}${isHeading && !replace ? ' lf-heading' : ''}`;
    trans.setAttribute('translate', 'no');
    trans.style.setProperty('--lf-font-scale', String(this.opts.fontScale));
    trans.textContent = translation;

    el.appendChild(original);
    el.appendChild(trans);
    el.setAttribute(ATTR_TRANSLATED, '');
  }

  private withSelfMutation(fn: () => void): void {
    this.selfMutations++;
    try {
      fn();
    } finally {
      // MutationObserver callbacks are queued as microtasks after the batch.
      setTimeout(() => {
        this.selfMutations--;
      }, 0);
    }
  }
}
