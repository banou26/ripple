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

const style = css`
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  max-width: min(460px, calc(100vw - 32px));
  width: 100%;

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
    margin: 0 0 4px;
    font-size: 1.05rem;
    font-weight: 700;
  }

  .subject {
    margin: 0 0 14px;
    font-size: 0.82rem;
    color: #8f88a0;
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
      border-radius: 9px;
      border: 1px solid rgba(68, 60, 86, 0.9);
      background: #171320;
      color: #f4f2f8;

      &:disabled {
        opacity: 0.45;
      }

      &:focus-visible {
        outline: 2px solid #fbbf24;
        outline-offset: 1px;
      }
    }

    .unit {
      font-size: 0.85rem;
      color: #b9b2c8;
    }
  }

  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 0.82rem;
    color: #b9b2c8;
    cursor: pointer;
    user-select: none;

    input {
      cursor: pointer;
      accent-color: #fbbf24;
    }
  }

  .note {
    margin: 12px 0 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: #fbbf24;
  }

  .problem {
    margin: 12px 0 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: #f87171;
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

      &.primary {
        background: #f97316;
        border-color: #f97316;
        color: #1a1420;

        &:hover {
          background: #fb923c;
        }
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
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
