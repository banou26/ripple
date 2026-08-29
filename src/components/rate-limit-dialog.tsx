// Setting one speed ceiling, used for both the session-wide pair and a single torrent's.
//
// One direction at a time, which is qBittorrent's shape ("Limit download rate...", "Limit upload
// rate...") and keeps the component honest: a form editing two independent numbers has to decide
// what a half-filled second field means, and there is no good answer.
//
// The unlimited checkbox exists because the alternative is asking someone to type 0 and hope they
// read it as "no limit" rather than "no transfer". 0 IS how unlimited is stored, so the checkbox is
// a label on a value rather than a separate mode.
//
// Built on Ripple's own Modal shell rather than <dialog>.showModal(), for the reason in
// components/modal.tsx: showModal promotes to the top layer, which covered @fkn/lib's broker frame.

import { css } from '@emotion/react'
import { useMemo, useRef, useState } from 'react'

import { Modal } from './modal'
import { UNLIMITED, formatLimit, limitInputValue, parseLimit } from '../torrent/rate-limits'
import {
  BORDER,
  BORDER_INTERACTIVE,
  BORDER_STRONG,
  CONTROL_BG,
  CONTROL_HOVER_BG,
  DANGER,
  EMPHASIS,
  EMPHASIS_HOVER,
  FOCUS_RING,
  SUNKEN_BG,
  SURFACE_BG,
  TEXT,
  TEXT_MUTED,
  TEXT_ON_LIGHT,
  WARN,
} from '../theme'

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
    margin: 0 0 4px;
    font-size: 1.05rem;
    font-weight: 700;
  }

  .subject {
    margin: 0 0 14px;
    font-size: 0.82rem;
    /* Muted rather than faint, even though this is the quietest line on the card: it names WHICH
       torrent is about to be capped, so it is content, not a footnote. */
    color: ${TEXT_MUTED};
    /* a torrent name can be arbitrarily long with no spaces in it */
    overflow-wrap: anywhere;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 8px;

    input[type='number'] {
      font-family: inherit;
      font-size: 0.9rem;
      width: 9rem;
      padding: 8px 10px;
      border-radius: 6px;
      /* The interactive border, not the hairline. Nothing but its outline says a text field is
         here, and the hairline is 1.2:1 on this card, which is a decoration rather than an edge. */
      border: 1px solid ${BORDER_INTERACTIVE};
      background: ${SUNKEN_BG};
      color: ${TEXT};

      &:disabled {
        opacity: 0.45;
      }

      &:focus-visible {
        outline: 2px solid ${FOCUS_RING};
        outline-offset: 1px;
      }
    }

    .unit {
      font-size: 0.85rem;
      color: ${TEXT_MUTED};
    }
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
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

  /* Hue is restricted to status, and this is a caution ("the session limit will override what you
     type here") sitting directly above an error line with the same size, weight and margins, so
     amber against the red below it is what keeps "this may not take effect" from reading as "this
     is wrong". Amber is safe to reuse here despite having been the brand colour, because nothing on
     this card is coloured DECORATIVELY any more: the only two hues left on it are this caution and
     the error below, so a warm value now reads as a status rather than as a logo. */
  .note {
    margin: 12px 0 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: ${WARN};
  }

  .problem {
    margin: 12px 0 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: ${DANGER};
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
       * Inverted rather than tinted: a near-white fill with a near-black label.
       *
       * It used to be an orange fill beside a dark Cancel, and the emphasis has to survive losing
       * the orange, because these two buttons sit side by side and only one of them applies the
       * number that was just typed. Brightness is the only tool left, so the primary takes the
       * loudest fill in the palette and keeps the dark-text-on-bright-fill relationship it had.
       *
       * The hover steps DOWN, to EMPHASIS_HOVER, because nothing in the palette is brighter than
       * EMPHASIS to step up into. It needs its own hover: this block and the neutral button:hover
       * above have equal specificity, so the primary keeps its resting fill under the cursor purely
       * by sitting later in the file, and the button that applies the number the user just typed
       * was the one control on the card answering the cursor with nothing at all.
       *
       * :not(:disabled) so a disabled primary stays at its resting fill, and the label colour is
       * repeated so the hover states its own pairing rather than leaning on the block above it.
       */
      &.primary {
        background: ${EMPHASIS};
        border-color: ${EMPHASIS};
        color: ${TEXT_ON_LIGHT};

        &:hover:not(:disabled) {
          background: ${EMPHASIS_HOVER};
          border-color: ${EMPHASIS_HOVER};
          color: ${TEXT_ON_LIGHT};
        }
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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

export type RateLimitRequest = {
  title: string
  /** What is being limited, when it is one torrent rather than everything. */
  subject?: string
  /** The ceiling in force now, absent or 0 meaning unlimited. */
  value?: number
  /** Said when the session limit will override whatever is chosen here. */
  note?: string | null
}

export const RateLimitDialog = (
  { title, subject, value, note, onCancel, onApply }: RateLimitRequest & {
    onCancel: () => void
    onApply: (bytesPerSecond: number) => void
  },
) => {
  const [text, setText] = useState(() => limitInputValue(value))
  // seeded from the value rather than from the text, so a torrent already at unlimited opens with the
  // box ticked instead of with an empty field that looks unfilled
  const [unlimited, setUnlimited] = useState(() => !(typeof value === 'number' && value > UNLIMITED))
  const input = useRef<HTMLInputElement>(null)

  const parsed = useMemo(() => (unlimited ? UNLIMITED : parseLimit(text)), [unlimited, text])
  // null is "not a usable number", which includes an empty field: emptiness must never be read as a
  // decision to remove the limit, since that is what the checkbox is for
  const problem = parsed === null ? 'Enter a speed in kB/s, or tick Unlimited.' : null

  const apply = () => {
    if (parsed === null) return
    onApply(parsed)
  }

  return (
    <Modal labelledBy="rate-limit-title" onClose={onCancel} initialFocus={input}>
      <div css={style}>
        <div className="card">
          <h2 id="rate-limit-title">{title}</h2>
          {!!subject && <p className="subject">{subject}</p>}

          <form
            onSubmit={(event) => { event.preventDefault(); apply() }}
          >
            <div className="field">
              <input
                ref={input}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                value={unlimited ? '' : text}
                disabled={unlimited}
                aria-label={`${title}, in kilobytes per second`}
                onChange={(event) => setText(event.target.value)}
              />
              <span className="unit">kB/s</span>
            </div>

            <label className="check">
              <input
                type="checkbox"
                checked={unlimited}
                onChange={(event) => {
                  setUnlimited(event.target.checked)
                  // unticking puts the field back where it was rather than leaving it blank and
                  // immediately invalid, so the dialog never opens its own error
                  if (!event.target.checked && text.trim() === '') setText(limitInputValue(value) || '1000')
                }}
              />
              Unlimited
            </label>

            {!!note && !unlimited && <p className="note">{note}</p>}
            {!!problem && <p className="problem">{problem}</p>}

            <div className="actions">
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="submit" className="primary" disabled={parsed === null}>
                {parsed === UNLIMITED ? 'Remove limit' : `Limit to ${formatLimit(parsed ?? undefined)}`}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Modal>
  )
}

export default RateLimitDialog
