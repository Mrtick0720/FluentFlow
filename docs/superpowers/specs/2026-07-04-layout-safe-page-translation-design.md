# Layout-Safe Page Translation Design

Date: 2026-07-04
Status: Approved

## Goal

Increase visible Chinese translation coverage on dense pages such as NBA.com while
preserving the site's layout. Compact interface content is replaced in place;
article prose remains bilingual. Any translation that causes overflow or visual
overlap is rejected and the original English is restored.

## Display policy

- Navigation, score cards, headline lists, buttons, short labels, positioned
  content, and hero content use in-place Chinese replacement.
- Normal article paragraphs retain the configured bilingual presentation.
- Hero content is not excluded merely because it is large or positioned. It is
  translated when the rendered Chinese fits safely.
- A rejected translation remains in its original language. Partial clipping or
  overlap is never accepted to increase translation coverage.

## Translation and validation flow

For each visible candidate:

1. Record the geometry and overflow state of the candidate, relevant clipping
   ancestors, and nearby visible siblings.
2. Classify it as compact/interface content or prose. Apply in-place replacement
   to compact content and the configured bilingual treatment to prose.
3. Measure the result after DOM insertion.
4. Reject and fully revert the translation if it introduces any of these:
   - horizontal or vertical overflow in the translated element;
   - new overflow in a clipping ancestor;
   - overlap with a nearby visible sibling that did not overlap before.
5. Count only accepted translations as completed.

Validation uses rendered geometry rather than translation character count. A
small pixel tolerance avoids false positives from subpixel rounding.

## Classification

In-place replacement applies to semantic interface containers (`nav`, `header`,
menus, tabs, controls, table headers), positioned elements, short labels, dense
cards/lists, and hero/banner/carousel content. Prose-like paragraphs remain
bilingual unless their surrounding layout is clearly compact or positioned.

Classification must be deterministic and isolated in DOM utilities so it can be
unit tested independently from translation-provider behavior.

## Reversibility

Rejected elements are restored to their exact original child-node structure and
have all LinguaFlow attributes/classes removed. Stopping page translation retains
the same restoration behavior for accepted elements.

## Testing

Unit tests cover:

- compact navigation and headline content selecting in-place replacement;
- hero content selecting in-place replacement;
- ordinary article prose retaining bilingual display;
- element overflow detection with tolerance;
- newly introduced clipping-ancestor overflow causing rejection;
- newly introduced sibling overlap causing rejection;
- pre-existing overlap/overflow not being falsely attributed to translation.

Project verification runs the focused tests, complete test suite, typecheck, and
production build. Browser inspection is intentionally left to the user.

## Non-goals

- Site-specific NBA selectors or translation dictionaries.
- Font shrinking, truncating translated text, or changing the host page layout to
  force a translation to fit.
- Automated browser navigation or visual approval.
