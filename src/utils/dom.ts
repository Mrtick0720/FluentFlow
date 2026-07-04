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
  // Navigation items often keep hidden dropdown/mega-menu content inside the
  // same <li>. Translate the link/control (or its deeper label span), never
  // the structural <li>, so hrefs and click handlers remain intact.
  'nav li > a',
  'nav li > button',
  'nav a > span',
  'nav button > span',
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
  '[aria-hidden="true"]', // collapsed dropdowns / off-screen menus
  '[hidden]',
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

type WithCheckVisibility = HTMLElement & { checkVisibility?: (options?: object) => boolean };

function isRenderable(el: HTMLElement): boolean {
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const rect = rects[0]!;
  // Off-screen hiding (menus parked far off the page).
  if (rect.right < -800 || rect.bottom < -800) return false;
  if (rect.left > window.innerWidth + 2000 || rect.top > document.documentElement.scrollHeight + 2000) {
    return false;
  }

  // display:none / visibility:hidden / opacity:0 (INCLUDING ancestors) and
  // content-visibility — this is what catches collapsed dropdown menus like
  // NBA's "Teams" mega-menu, which hide the container via ancestor opacity.
  const check = (el as WithCheckVisibility).checkVisibility;
  if (typeof check === 'function') {
    if (
      !check.call(el, {
        opacityProperty: true,
        visibilityProperty: true,
        contentVisibilityAuto: true,
        // older option names (ignored if unknown)
        checkOpacity: true,
        checkVisibilityCSS: true,
      })
    ) {
      return false;
    }
  } else {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (parseFloat(style.opacity) === 0) return false;
  }

  // Clipped to (near) nothing by an overflow-hidden ancestor (collapsed panels).
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth++) {
    const s = getComputedStyle(node);
    if (s.overflow !== 'visible' || s.overflowX !== 'visible' || s.overflowY !== 'visible') {
      const r = node.getBoundingClientRect();
      if (r.height <= 1 || r.width <= 1) return false;
    }
    node = node.parentElement;
  }
  return true;
}

/**
 * Is this element visually covered by something else (hit-testing)? Catches
 * stacked carousel slides and mega-menus parked behind the page via z-index,
 * which checkVisibility can't see. Only judges elements within the viewport;
 * returns false (don't skip) for off-screen elements.
 */
export function isOccluded(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false; // off-screen: can't judge
  if (rect.width < 2 || rect.height < 2) return true;
  const xs = [rect.left + Math.min(12, rect.width * 0.15), rect.left + rect.width / 2];
  const ys = [rect.top + rect.height * 0.35, rect.top + rect.height * 0.5, rect.top + rect.height * 0.65];
  let tested = 0;
  for (const x of xs) {
    for (const y of ys) {
      if (x < 1 || y < 1 || x > window.innerWidth - 1 || y > window.innerHeight - 1) continue;
      tested++;
      const top = document.elementFromPoint(x, y);
      if (top && (top === el || el.contains(top))) return false; // owns a point → visible
    }
  }
  return tested > 0; // tested in-viewport points, owned none → covered
}

/** Ancestors (up to 6 levels) that clip their content (overflow hidden/clip). */
export function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  let node = el.parentElement;
  for (let depth = 0; node && depth < 6; depth++) {
    const s = getComputedStyle(node);
    if (/hidden|clip/.test(s.overflowX) || /hidden|clip/.test(s.overflowY)) out.push(node);
    node = node.parentElement;
  }
  return out;
}

/** Does this box's content overflow its clipped bounds? */
export function overflows(el: HTMLElement): boolean {
  return el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
}

/** A pure, testable snapshot of an element's layout safety at a point in time. */
export interface LayoutSnapshot {
  selfOverflow: boolean;
  clippingOverflow: boolean[];
  siblingOverlaps: boolean[];
}

function newlyTrue(before: boolean[], after: boolean[]): boolean {
  return after.some((value, index) => value && !before[index]);
}

/** Did applying a translation newly break the element's box, a clipping ancestor, or a neighbour? */
export function introducesUnsafeLayout(before: LayoutSnapshot, after: LayoutSnapshot): boolean {
  return (
    (after.selfOverflow && !before.selfOverflow) ||
    newlyTrue(before.clippingOverflow, after.clippingOverflow) ||
    newlyTrue(before.siblingOverlaps, after.siblingOverlaps)
  );
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Do two boxes intersect? Touching edges (within a 2px tolerance) don't count. */
export function rectanglesOverlap(a: Box, b: Box): boolean {
  const t = 2;
  return a.left < b.right - t && a.right > b.left + t && a.top < b.bottom - t && a.bottom > b.top + t;
}

/** Rendered, non-trivial siblings immediately adjacent to `el` (for overlap checks). */
function nearbyVisibleSiblings(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
    if (!(sib instanceof HTMLElement)) continue;
    const r = sib.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (getComputedStyle(sib).visibility === 'hidden') continue;
    out.push(sib);
  }
  return out;
}

/** The clipping ancestors and siblings a guard must reuse for before/after comparison. */
export function layoutGuardTargets(el: HTMLElement): {
  clips: HTMLElement[];
  siblings: HTMLElement[];
} {
  return { clips: clippingAncestors(el), siblings: nearbyVisibleSiblings(el) };
}

/** Snapshot given a fixed set of clipping ancestors + siblings (order preserved). */
export function snapshotWithTargets(
  el: HTMLElement,
  clips: HTMLElement[],
  siblings: HTMLElement[],
): LayoutSnapshot {
  const rect = el.getBoundingClientRect();
  return {
    selfOverflow: overflows(el),
    clippingOverflow: clips.map(overflows),
    siblingOverlaps: siblings.map((sibling) => rectanglesOverlap(rect, sibling.getBoundingClientRect())),
  };
}

/**
 * Layout-sensitive elements (navigation, controls, short labels, absolutely
 * positioned bits) should be translated in place (original hidden, no added
 * block) rather than getting a bilingual block appended — inserting height
 * there breaks tight layouts (nav bars, cards, carousels). Article paragraphs
 * return false and keep the bilingual layout.
 */
const REPLACE_ROLE_SELECTOR =
  'nav,header,footer,[role="navigation"],[role="tablist"],[role="menubar"],[role="menu"],' +
  'button,[role="button"],[role="tab"],[role="menuitem"],th,' +
  '[class*="hero" i],[class*="banner" i],[class*="carousel" i],[class*="slider" i],' +
  '[class*="slide" i],[class*="card" i]';

export function shouldReplaceInPlace(el: HTMLElement): boolean {
  // Navigation, controls, and hero/banner/carousel/card regions.
  if (el.closest(REPLACE_ROLE_SELECTOR)) return true;

  const text = (el.textContent ?? '').trim();
  if (text.length <= 20) return true; // short UI labels

  const cs = getComputedStyle(el);
  if (cs.position === 'absolute' || cs.position === 'fixed') return true;

  // A positioned ancestor (a stacking context) usually means a compact,
  // layout-sensitive widget rather than a flowing article paragraph.
  let node = el.parentElement;
  for (let depth = 0; node && depth < 4; depth++) {
    const ps = getComputedStyle(node);
    if (ps.position === 'absolute' || ps.position === 'fixed' || ps.position === 'sticky') {
      return true;
    }
    node = node.parentElement;
  }
  return false;
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
