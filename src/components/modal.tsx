import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { css } from '@emotion/react'

import { OVERLAY_BG } from '../theme'

/**
 * Ripple's own modal shell, deliberately NOT `<dialog>.showModal()`.
 *
 * showModal moves an element into the TOP LAYER, which is a separate painting surface above the
 * whole z-index system. That is why it cannot be arranged around: `@fkn/lib` mounts its broker frame
 * at `z-index: 2147483647`, and while a top-layer dialog was open the frame was covered whatever
 * number it carried. Measured, along with everything else that does not work: a popover promoted
 * before the dialog still lost, re-promoting it still lost, and the frame was inert underneath even
 * when visible. Nothing outside a modal dialog can paint above one.
 *
 * So this stays in ordinary stacking, one step below the broker, and the frame renders over it. That
 * costs nothing in practice because the frame is clipped to its own surfaces: above a modal it
 * occupies only the few pixels FKN is actually drawing, and clicks pass through everywhere else.
 * What it buys is that an FKN consent prompt raised while a modal is open can still be answered,
 * which is the thing that matters and which the top layer made impossible.
 *
 * Everything showModal was doing for free is done here instead, because dropping the API is not a
 * reason to drop the behaviour: Esc, a backdrop, a focus trap, inertness behind, and focus restored
 * on close.
 */

/**
 * One below `@fkn/lib`'s frame, which is the whole point of the number.
 *
 * Above everything ripple draws (the context menu is at 2000) and below the broker, so the only
 * thing that can cover a modal is the one surface that should be able to.
 */
export const MODAL_Z_INDEX = 2147483646

const style = css`
  position: fixed;
  inset: 0;
  z-index: ${MODAL_Z_INDEX};
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  outline: none;
  /* The scrim is the entire separation from the page: this element draws no border and no shadow.
     It used to be 62% over a 2px backdrop blur, and the blur was doing less than it looked, mostly
     softening the hairlines of the torrent table underneath. OVERLAY_BG is 75% for that reason, and
     alpha alone turns out to be enough to stop the list behind competing with the dialog. */
  background: ${OVERLAY_BG};
`

/*
 * Over the player it is rendered in rather than over the page: a player in fullscreen shows nothing outside
 * itself. One above the player's own layers, which sit at 2, its controls among them. The player hides the
 * pointer with its controls, and a card taller than a small player scrolls.
 */
const inlineStyle = css`
  position: absolute;
  z-index: 3;
  padding: 12px;
  overflow-y: auto;
  cursor: default;

  > * {
    margin: auto;
  }
`

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',')

const focusable = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetWidth > 0 || el.offsetHeight > 0)

/**
 * Make the rest of the page unreachable, the way showModal did, EXCEPT for the broker frame.
 *
 * Skipping that frame is the point of the exercise rather than an oversight. Inerting it would put
 * back exactly what the top layer was doing: FKN's prompt visible above the modal and impossible to
 * answer. `@fkn/lib` titles its iframe "FKN", which is the only handle it offers from out here.
 *
 * Returns the undo, and only for elements this actually changed, so a page that had already marked
 * something inert for its own reasons gets it back.
 */
const inertBehind = (except: HTMLElement): (() => void) => {
  const changed: HTMLElement[] = []
  for (const node of [...document.body.children]) {
    if (!(node instanceof HTMLElement)) continue
    if (node === except || node.contains(except)) continue
    if (node.matches('iframe[title="FKN"]')) continue
    if (node.inert) continue
    node.inert = true
    changed.push(node)
  }
  return () => { for (const node of changed) node.inert = false }
}

export const Modal = ({
  labelledBy, onClose, children, initialFocus, inline = false,
}: {
  /** id of the element naming this modal, for screen readers */
  labelledBy?: string
  onClose: () => void
  children: React.ReactNode
  /** what to focus on open. Point it at the SAFE control, never the destructive one. */
  initialFocus?: React.RefObject<HTMLElement | null>
  /**
   * Draws it where it is rendered, as the player's child and over all of it, in place of over the whole page.
   * Nothing behind it is made inert, and no key or click in it reaches the player, which reads both.
   */
  inline?: boolean
}) => {
  const overlay = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const trap = useCallback((event: React.KeyboardEvent) => {
    // the player takes its shortcuts from keys that reach the window: Space on a button here would pause it
    if (inline) event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return }
    if (event.key !== 'Tab' || !overlay.current) return
    const items = focusable(overlay.current)
    if (items.length === 0) { event.preventDefault(); return }
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    // wrapping by hand, because without it Tab walks out of the modal and into a page that looks
    // interactive and is inert, which reads as the keyboard having stopped working
    if (event.shiftKey && (active === first || active === overlay.current || !overlay.current.contains(active))) {
      event.preventDefault(); last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault(); first.focus()
    }
  }, [inline])

  useEffect(() => {
    const root = overlay.current
    if (!root) return
    const previous = document.activeElement as HTMLElement | null
    const undo = inline ? () => {} : inertBehind(root)
    const target = initialFocus?.current ?? focusable(root)[0]
    // a card taller than its player opens at its first line, not scrolled to the control that has the focus
    target?.focus({ preventScroll: inline })
    return () => {
      undo()
      // back where they were, or the next Tab starts from the top of the document
      previous?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shell = (
    <div
      ref={overlay}
      css={inline ? [style, inlineStyle] : style}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      // a click on its text leaves the focus here rather than on the page, so Escape and Tab are still its own
      tabIndex={-1}
      onKeyDown={trap}
      onClick={(event) => {
        // a click on the picture pauses it, and a second one takes it fullscreen
        if (inline) event.stopPropagation()
        if (event.target === overlay.current) onCloseRef.current()
      }}
      onDoubleClick={inline ? (event) => event.stopPropagation() : undefined}
    >
      {children}
    </div>
  )
  // A portal to the body, not an inline render: a modal inside an ancestor with a transform, filter
  // or opacity gets that ancestor as its containing block, so `position: fixed` stops meaning the
  // viewport and the z-index stops competing with the page at all.
  return inline ? shell : createPortal(shell, document.body)
}

export default Modal
