// A confirmation the user cannot miss, for the actions that cannot be undone.
//
// Built on the native <dialog> with showModal(), which brings the focus trap, Esc to dismiss, the
// top layer (so no z-index competition with the drop overlay or the embed panel) and inertness of
// everything behind it. None of that is worth reimplementing.
//
// The API is a promise so a call site stays one line:
//
//   if (!await confirm({ title: 'Remove X?', ... })) return
//
// which matters because the alternative, threading pending-action state through the page, is how
// these end up half-wired to one call site and missing from the other.

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

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
  border: none;
  padding: 0;
  background: transparent;
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  max-width: min(460px, calc(100vw - 32px));

  &::backdrop {
    background: rgba(10, 8, 14, 0.62);
    backdrop-filter: blur(2px);
  }

  .card {
    box-sizing: border-box;
    width: 100%;
    padding: 20px;
    border-radius: 14px;
    background: #1e1a28;
    border: 1px solid rgba(68, 60, 86, 0.9);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
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
    color: #b9b2c8;
    overflow-wrap: anywhere;
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
    font-size: 0.82rem;
    color: #b9b2c8;
    cursor: pointer;
    user-select: none;

    input {
      cursor: pointer;
      accent-color: #fbbf24;
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
      border-radius: 9px;
      cursor: pointer;
      border: 1px solid rgba(68, 60, 86, 0.9);
      background: #2a2436;
      color: #f4f2f8;
      transition: background 120ms ease, border-color 120ms ease;

      &:hover {
        background: #332c42;
      }

      &.danger {
        background: #b91c1c;
        border-color: #dc2626;

        &:hover {
          background: #dc2626;
        }
      }

      &:focus-visible {
        outline: 2px solid #fbbf24;
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
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const settle = useRef<((ok: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmRequest) => {
    if (remembered(next.rememberKey)) return Promise.resolve(true)
    setDontAsk(false)
    setRequest(next)
    return new Promise<boolean>((resolve) => { settle.current = resolve })
  }, [])

  // showModal has to run after the node is in the DOM, and calling it twice throws
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !request) return
    if (!dialog.open) dialog.showModal()
    /**
     * Focus the safe action EXPLICITLY, rather than relying on autofocus placement.
     *
     * showModal's focusing steps take the first focusable descendant when nothing carries the
     * autofocus attribute, and with a remember key present that is the "Don't ask again" checkbox,
     * not a button. Found live: the dialog shipped with focus on the checkbox while the test
     * asserting "focus is on Cancel" passed, because that test rendered the variant with no
     * checkbox in the tree. One ref removes the dependence on DOM order entirely.
     */
    cancelRef.current?.focus()
  }, [request])

  const close = useCallback((ok: boolean) => {
    if (ok && dontAsk) remember(request?.rememberKey)
    dialogRef.current?.close()
    setRequest(null)
    // never leave a caller awaiting forever: every exit path runs through here
    settle.current?.(ok)
    settle.current = null
  }, [dontAsk, request])

  const element = request
    ? (
      <dialog
        ref={dialogRef}
        css={style}
        aria-labelledby="confirm-title"
        // Esc fires 'cancel' rather than a click, so without this the promise never settles
        onCancel={(e) => { e.preventDefault(); close(false) }}
        // the backdrop is part of the dialog's own box, so a click outside the card lands here
        onClick={(e) => { if (e.target === dialogRef.current) close(false) }}
      >
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
      </dialog>
    )
    : null

  return { confirm, confirmElement: element, confirmOpen: request != null }
}
