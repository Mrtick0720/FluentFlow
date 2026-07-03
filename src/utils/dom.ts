import { ATTR_TRANSLATED } from '@/shared/constants';

const CANDIDATE_SELECTOR = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'dd',
  'dt',
  'figcaption',
  'caption',
  'summary',
  'td',
  'th',
].join(',');

const SKIP_CLOSEST = [
  'pre',
  'code',
  'kbd',
  'samp',
  'script',
  'style',
  'noscript',
  'textarea',
  'select',
  'svg',
  'math',
  '[contenteditable]',
  '[translate="no"]',
  '.notranslate',
  `[${ATTR_TRANSLATED}]`,
].join(',');

/**
 * Collect block-level elements worth translating inside `root`.
 * Leaf-most candidates win (an <li> containing a <p> yields the <p>).
 */
export function collectTranslatableBlocks(root: ParentNode): HTMLElement[] {
  const candidates = [...root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)];
  const blocks: HTMLElement[] = [];
  for (const el of candidates) {
    if (el.closest(SKIP_CLOSEST)) continue;
    if (el.querySelector(CANDIDATE_SELECTOR)) continue; // keep leaf-most only
    const text = el.textContent?.trim() ?? '';
    if (text.length < 2 || !/[a-zA-Z]{2,}/.test(text)) continue;
    if (!isRenderable(el)) continue;
    blocks.push(el);
  }
  return blocks;
}

function isRenderable(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false;
  return true;
}

/** Heuristic: is this text already (mostly) in the target language? */
export function looksLikeTargetLanguage(text: string, targetLang: string): boolean {
  if (!targetLang.toLowerCase().startsWith('zh')) return false;
  let cjk = 0;
  let letters = 0;
  for (const ch of text) {
    if (/[一-鿿㐀-䶿]/.test(ch)) cjk++;
    else if (/[a-zA-Z]/.test(ch)) letters++;
  }
  return cjk > 0 && cjk >= letters;
}

/** The sentence around a clicked word, for dictionary context. */
export function sentenceAround(node: Node, word: string): string | undefined {
  const blockText = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))
    ?.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, div')
    ?.textContent?.replace(/\s+/g, ' ')
    .trim();
  if (!blockText) return undefined;
  const sentences = blockText.match(/[^.!?。！？]+[.!?。！？]?/g) ?? [blockText];
  const hit = sentences.find((s) => s.toLowerCase().includes(word.toLowerCase()));
  return (hit ?? blockText).trim().slice(0, 300);
}

/** Rough main-content extraction for AI page context. */
export function extractPageText(maxChars = 16000): string {
  const clone = document.body.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('script, style, noscript, nav, aside, footer, header, iframe, svg, [aria-hidden="true"]')
    .forEach((el) => el.remove());
  clone.querySelectorAll(`[${ATTR_TRANSLATED}] .lf-trans`).forEach((el) => el.remove());
  const text = (clone.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, maxChars);
}
