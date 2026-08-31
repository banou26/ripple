import { css } from '@emotion/react'
import { Tooltip } from 'react-tooltip'

import { BORDER_STRONG, ELEVATED_BG, TEXT } from '../theme'

/**
 * The app's replacement for the native `title` attribute.
 *
 * `title` has two problems and neither is fixable from the page. It waits about a second before
 * appearing, which is long enough that people conclude a control is unlabelled and stop hovering;
 * and the browser draws it in its own chrome, in its own font, positioned wherever it likes, so it
 * can hang off the edge of the window with the text cut off. Neither is under Ripple's control.
 *
 * ONE tooltip for the whole app, not one per call site. `react-tooltip` matches anchors by id, so a
 * single instance mounted at the router root serves every hint on every route: no per-element
 * component, no extra DOM around the thing being described, and one place that decides how a hint
 * looks. A call site says what it means and nothing about how it is drawn.
 *
 * Reach for `hint()` wherever `title` would have gone. It spreads to nothing when the text is empty,
 * so a conditional hint stays one expression rather than a spread and a ternary.
 */

/** The one anchor id. Every hint in the app points at the single `<Hints/>` instance. */
export const HINT_ID = 'ripple-hint'

/**
 * The props that turn any element into a hint anchor, in place of `title`.
 *
 * ACCESSIBILITY IS NOT INHERITED FROM THIS. `title` doubles as an accessible name for a control that
 * has no text, and a data attribute does not, so a call site that was leaning on `title` for that
 * carries an `aria-label` of its own. Most already did, because a title alone was never a good
 * enough name for a screen reader either.
 */
export const hint = (text: string | null | undefined) =>
  (text ? { 'data-tooltip-id': HINT_ID, 'data-tooltip-content': text } : {})

/*
 * The chip.
 *
 * Colours come through react-tooltip's own custom properties rather than `background` and `color`.
 * It injects its stylesheet from a passive effect on the first mount, while emotion inserts through
 * `useInsertionEffect`, which runs earlier: react-tooltip's sheet therefore lands LAST in the head
 * at the same specificity, and wins every tie. Setting the variables on the element sidesteps that
 * entirely, since a custom property on the element beats the `:root` definition whatever the order.
 * `tooltip-display.tsx` learned this the same way and says so at more length.
 */
const style = css`
  --rt-color-dark: ${ELEVATED_BG};
  --rt-color-white: ${TEXT};
  --rt-opacity: 1;

  /*
   * Bounded to the page, which is half of what the native tooltip could not do.
   *
   * The width bound is in viewport units rather than pixels so a hint can never be wider than the window on
   * any screen, and normal wrapping so a long sentence becomes a paragraph instead of a line running
   * off the edge. react-tooltip keeps the chip inside the viewport horizontally and flips it when
   * there is no room below; without a width bound it would keep it inside the viewport by pushing a
   * very long single line sideways until the far end was unreachable.
   */
  max-width: min(320px, calc(100vw - 24px));
  white-space: normal;
  overflow-wrap: anywhere;

  padding: 6px 9px !important;
  border: 1px solid ${BORDER_STRONG};
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 400;
  line-height: 1.45;
  text-align: left;

  /* above the modal scrim, or a hint on a control inside a dialog is drawn behind it */
  z-index: 1000;
`

/**
 * Mounted ONCE, at the router root, so every route has it.
 *
 * At the root rather than per page for two reasons: it is outside every scrolling and clipping
 * container, which is what lets a hint near an edge escape rather than being cut off by an
 * `overflow: hidden` ancestor; and a route that forgot to mount its own would silently show no hints
 * at all, which looks exactly like hints not being wired up.
 */
export const Hints = () => (
  <Tooltip
    id={HINT_ID}
    css={style}
    /*
     * INSTANT, which is the other half. The native delay is around a second and is not adjustable;
     * this is the whole reason for replacing it, so it is stated rather than left to a default that
     * could change.
     */
    delayShow={0}
    delayHide={0}
    /*
     * Fixed positioning, so the chip is placed against the VIEWPORT rather than against whatever
     * positioned ancestor it happens to land in. Absolute positioning inside a transformed or
     * scrolled container puts the chip in the wrong place, and Ripple has both.
     */
    positionStrategy="fixed"
    place="top"
    /*
     * The anchors are named EXPLICITLY, rather than left to the id alone.
     *
     * Every hint in the app is rendered by a route, which mounts after this does and re-renders
     * constantly. The id on its own is enough for anchors that already exist; naming the selector is
     * what keeps a tooltip attached to anchors that arrive later, which here is all of them.
     */
    anchorSelect={`[data-tooltip-id='${HINT_ID}']`}
  />
)
