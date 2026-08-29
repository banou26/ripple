// A confirmation the user cannot miss, for the actions that cannot be undone.
//
// Built on Ripple's own Modal shell rather than <dialog>.showModal(). showModal puts an element in
// the TOP LAYER, above the entire z-index system, which covered @fkn/lib's broker frame and made an
// FKN prompt raised during a confirmation impossible to answer. The shell keeps everything showModal
// was giving us (Esc, a backdrop, a focus trap, inertness behind, focus restored) and gives up only
// the one thing that was causing the problem. See components/modal.tsx.
//
// The API is a promise so a call site stays one line:
//
//   if (!await confirm({ title: 'Remove X?', ... })) return
//
// which matters because the alternative, threading pending-action state through the page, is how
// these end up half-wired to one call site and missing from the other.

import { css } from '@emotion/react'
import { useCallback, useRef, useState } from 'react'

import { Modal } from './modal'
import {
  BORDER,
  BORDER_STRONG,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  DANGER,
  EMPHASIS,
  FOCUS_RING,
  SURFACE_BG,
  TEXT,
  TEXT_MUTED,
} from '../theme'

export type ConfirmRequest = {
  title: string
  /** The consequence, stated plainly. This is the line that stops the mistake, so it must be specific. */
  body: string
  /** Label for the destructive action. Name the verb, never "OK". */
  confirmLabel: string
  cancelLabel?: string
  /** When set, offers "Don't ask again" and remembers the answer under this localStorage key. */
  rememberKey?: string
  tone?: 'danger' | 'normal'
}

const style = css`
  color: ${TEXT};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  max-width: min(460px, calc(100vw - 32px));
  width: 100%;

  .card {
    box-sizing: border-box;
    width: 100%;
    padding: 20px;
    border-radius: 8px;
    background: ${SURFACE_BG};
    /* The strong border, not the hairline every other surface takes. This card used to float on a
       60px drop shadow; with that gone the edge is the only thing left saying the card sits above
       the scrimmed page rather than in it. */
    border: 1px solid ${BORDER_STRONG};
  }

  h2 {
    margin: 0 0 8px;
    font-size: 1.05rem;
    font-weight: 700;
    /* the torrent name goes here and can be arbitrarily long with no spaces */
    overflow-wrap: anywhere;
  }

  p {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.5;
    color: ${TEXT_MUTED};
    overflow-wrap: anywhere;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    font-size: 0.82rem;
    color: ${TEXT_MUTED};
    cursor: pointer;
    user-select: none;

    input {
      cursor: pointer;
      /* Set, never dropped. This is a native checkbox, and with the property gone the UA paints the
         checked state in the platform accent, which under color-scheme: dark is blue. A near-white
         accent also gives the tick a dark-on-light rendering, the highest contrast the control has. */
      accent-color: ${EMPHASIS};
    }
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;

    button {
      font-family: inherit;
      font-size: 0.85rem;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 6px;
      cursor: pointer;
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT};
      transition: background 120ms ease, border-color 120ms ease;

      &:hover {
        background: ${CONTROL_HOVER_BG};
      }

      /**
       * A neutral button with a red label, rather than a red button with a pale one.
       *
       * The palette carries both DANGER and DANGER_SOLID and forbids using them together, so this
       * is a real choice and it goes this way for two reasons. DANGER was measured for exactly this
       * pairing: 4.9:1 sitting on a hovered control fill, which is precisely where a destructive
       * button lives. And a solid fill would have to hold still on hover, because there is no
       * second red to brighten into, leaving the one button in the dialog that most deserves
       * feedback as the only one without any. Falling through to the neutral hover above keeps it.
       *
       * What carries the weight instead is the label, which names the verb and never says "OK",
       * plus the red hairline, so the warning is not colour alone.
       */
      &.danger {
        border-color: ${DANGER};
        color: ${DANGER};
      }

      &:focus-visible {
        outline: 2px solid ${FOCUS_RING};
        outline-offset: 2px;
      }
    }
  }

  @media (max-width: 480px) {
    .actions {
      flex-direction: column-reverse;

      button {
        width: 100%;
      }
    }
  }
`

const remembered = (key?: string) => {
  if (!key) return false
  try { return localStorage.getItem(key) === 'skip' } catch { return false }
}

const remember = (key?: string) => {
  if (!key) return
  try { localStorage.setItem(key, 'skip') } catch {}
}

/**
 * Returns [confirm, element]. Render the element once; call confirm() from anywhere.
 *
 * `open` is deliberately exposed: the page has window-level handlers (paste, drag, keydown) that
 * must stand down while a modal is up, and <dialog> makes the page inert to POINTER events but not
 * to listeners bound on window.
 */
export const useConfirm = () => {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const [dontAsk, setDontAsk] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const settle = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmRequest) => {
    if (remembered(next.rememberKey)) return Promise.resolve(true)
    setDontAsk(false)
    setRequest(next)
    return new Promise<boolean>((resolve) => { settle.current = resolve })
  }, [])

  const close = useCallback((ok: boolean) => {
    if (ok && dontAsk) remember(request?.rememberKey)
    setRequest(null)
    // never leave a caller awaiting forever: every exit path runs through here
    settle.current?.(ok)
    settle.current = null
  }, [dontAsk, request])

  const element = request
    ? (
      <Modal
        labelledBy="confirm-title"
        onClose={() => close(false)}
        /**
         * The safe action EXPLICITLY, never the first focusable descendant.
         *
         * With a remember key present the first one is the "Don't ask again" checkbox, not a button.
         * Found live: the dialog shipped with focus on the checkbox while the test asserting "focus
         * is on Cancel" passed, because that test rendered the variant with no checkbox in the tree.
         * One ref removes the dependence on DOM order entirely.
         */
        initialFocus={cancelRef}
      >
        <div css={style}>
        <div className="card">
          <h2 id="confirm-title">{request.title}</h2>
          <p>{request.body}</p>
          {!!request.rememberKey && (
            <label>
              <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
              Don't ask again
            </label>
          )}
          <div className="actions">
            {/* Focus lands here, never on the destructive button, so a stray Enter cannot become the
                very mis-click this exists to prevent. Driven by the ref in the effect above. */}
            <button type="button" ref={cancelRef} onClick={() => close(false)}>
              {request.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="button"
              className={request.tone === 'danger' ? 'danger' : ''}
              onClick={() => close(true)}
            >
              {request.confirmLabel}
            </button>
          </div>
        </div>
        </div>
      </Modal>
    )
    : null

  return { confirm, confirmElement: element, confirmOpen: request != null }
}
