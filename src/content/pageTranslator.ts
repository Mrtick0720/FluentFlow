import { ATTR_TRANSLATED } from '@/shared/constants';
import type { DisplayMode } from '@/types/models';
import { debounce } from '@/utils/async';
import { collectTranslatableBlocks, looksLikeTargetLanguage } from '@/utils/dom';

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
const MAX_PER_FLUSH = 24;

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
        this.flushSoon();
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
    this.flushSoon.cancel();
    this.rescanSoon.cancel();
    document.documentElement.removeAttribute(MODE_ATTR);

    this.withSelfMutation(() => {
      for (const el of document.querySelectorAll<HTMLElement>(`[${ATTR_TRANSLATED}]`)) {
        const original = el.querySelector(':scope > .lf-original');
        el.querySelector(':scope > .lf-trans')?.remove();
        if (original) {
          while (original.firstChild) el.insertBefore(original.firstChild, original);
          original.remove();
        }
        el.removeAttribute(ATTR_TRANSLATED);
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

  private flushSoon = debounce(() => void this.flush(), BATCH_DEBOUNCE_MS);

  private async flush(): Promise<void> {
    if (!this.active || this.queue.size === 0) return;
    const batch = [...this.queue].slice(0, MAX_PER_FLUSH).filter((el) => {
      this.queue.delete(el);
      return el.isConnected && !this.inflight.has(el) && !el.hasAttribute(ATTR_TRANSLATED);
    });
    if (batch.length === 0) return;
    batch.forEach((el) => this.inflight.add(el));

    try {
      const texts = batch.map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
      const translations = await this.opts.translate(texts);
      if (!this.active) return;
      this.withSelfMutation(() => {
        batch.forEach((el, i) => {
          const translation = translations[i];
          if (translation && el.isConnected) this.applyTranslation(el, translation);
        });
      });
      this.doneCount += batch.length;
      this.opts.onProgress?.(this.doneCount, this.totalCount);
    } catch (err) {
      // Re-queue so a later scroll retries; surface the error once.
      batch.forEach((el) => this.queue.add(el));
      this.opts.onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      batch.forEach((el) => this.inflight.delete(el));
      if (this.queue.size > 0) this.flushSoon();
    }
  }

  private applyTranslation(el: HTMLElement, translation: string): void {
    if (el.hasAttribute(ATTR_TRANSLATED)) return;
    const original = document.createElement('span');
    original.className = 'lf-original';
    while (el.firstChild) original.appendChild(el.firstChild);

    const trans = document.createElement('span');
    trans.className = `lf-trans lf-style-${this.opts.style}`;
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
