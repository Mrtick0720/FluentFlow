# Quick Translate Reference UI Design

Date: 2026-07-05
Status: Approved

## Goal

Restyle LinguaFlow's Quick Translate window to match the supplied dark reference
as closely as practical while preserving all existing translation behavior. The
footer containing the model label, copy action, and close action is explicitly
excluded from this visual pass.

## Visual contract

The Quick Translate window always uses a dedicated dark appearance, independent
of the extension's light/dark theme:

- window background: near-black (`#171717`), with a subtle dark border, large
  rounded corners, and a deep soft shadow;
- viewport-relative size: approximately 90–96% of viewport width and 80–90% of
  viewport height, constrained so it never leaves the visible viewport;
- two strictly equal main panes, with no gutter between them;
- input pane background near `#262626` and output pane near `#181818`;
- language controls centered at the top of each pane, rendered as borderless
  rows with a muted globe icon, language label, and chevron;
- input and output text begin well below the language rows, use larger type and
  generous line spacing, and retain ample empty space;
- swap control floats over the exact pane boundary near the vertical center,
  using a dark rounded square with a thick near-black outer ring;
- character count and clear action remain available at the lower edge of the
  input pane but are visually subdued;
- existing footer markup and styling remain unchanged.

## Component structure

`QuickTranslate` retains its existing state and behavior: debounced translation,
source and target language selection, language swap, input clearing, output
copying, closing, and dragging.

The current dedicated drag bar is removed. Dragging remains available from
non-interactive empty areas of the modal and panes. Pointer handling continues to
exclude selects, textareas, output text, and buttons so text selection and
controls behave normally.

The main area remains three logical layers rather than three width columns:

1. a two-column pane grid;
2. the swap control absolutely positioned over the center boundary;
3. the existing footer below the pane grid.

This prevents the swap button from consuming horizontal space and guarantees
equal pane widths.

## Responsive behavior

At wide desktop sizes the modal follows the reference's large floating-window
proportions. Its width and height use viewport units with fixed minimum margins.
The footer height is excluded from the main-pane height calculation.

On narrower screens the modal keeps two columns while reducing pane padding,
language/text sizes, and swap-button dimensions. It must remain entirely inside
the viewport and preserve usable text areas. No horizontal page overflow is
allowed.

## Accessibility and interaction

- The modal retains `role="dialog"` and its accessible label.
- Native select controls retain their input/output language labels.
- The swap and clear buttons retain accessible names and keyboard focus.
- Fixed dark colors meet readable foreground/background contrast.
- Loading, translation errors, and multiline output remain visible in the output
  pane without changing layout.

## Testing

Automated tests verify:

- the dedicated drag-bar markup is absent;
- the modal retains its dialog and language-control semantics;
- main panes use an equal two-column grid;
- the swap control is absolutely positioned over the center boundary;
- fixed dark input/output colors do not depend on theme variables;
- desktop viewport sizing and narrow-screen constraints are present;
- existing translation, swap, clear, copy, and close behavior remains wired;
- the footer structure and its existing classes remain unchanged.

Manual visual verification compares the built extension against the supplied
reference at desktop size and confirms the modal stays within a narrow viewport.

## Non-goals

- Restyling the model label, copy button, close button, or footer layout.
- Changing translation providers, debounce timing, language options, or response
  behavior.
- Rebuilding the window as a separate application or browser window.
