import type { OptionGroup } from '../torrent/torrent-options'

import { css } from '@emotion/react'

import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG, CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  DANGER, EMPHASIS, FOCUS_RING, SUNKEN_BG, SURFACE_BG, TEXT, TEXT_MUTED,
} from '../theme'

import { Modal } from './modal'
import { useRef } from 'react'

/**
 * The same options as the right-click menu, with room to explain them.
 *
 * A context menu is for someone who knows what they are looking for; this is for someone who does
 * not. Every option carries its one-line description here, where a menu can only afford a tooltip,
 * and the switches stay put after being used instead of the surface closing on the first choice.
 * That difference is the reason for two surfaces rather than one: changing three settings in a
 * menu means opening it three times.
 *
 * Ripple's own Modal shell, matching confirm-dialog, which buys Esc, a backdrop, focus containment
 * and inertness behind without reimplementing any of it.
 */

const style = css`
  color: ${TEXT};
  width: 100%;
  max-width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);

  .card {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 64px);
    border-radius: 8px;
    /* The stronger edge, matching add-torrent-dialog: a dialog floats, and now that neither card
       carries a drop shadow the border is the only thing separating it from the scrim. */
    border: 1px solid ${BORDER_STRONG};
    background: ${SURFACE_BG};
  }

  header {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid ${BORDER};

    h2 {
      flex: 1;
      min-width: 0;
      margin: 0;
      font-size: 1.05rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 18px 16px;
  }

  .group {
    padding-top: 14px;

    > label {
      display: block;
      padding-bottom: 4px;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: ${TEXT_MUTED};
    }
  }

  .opt {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    border: none;
    border-radius: 6px;
    background: none;
    color: inherit;
    padding: 9px 10px;
    text-align: left;

    &:hover:not(:disabled),
    &:focus-visible {
      background: ${CONTROL_HOVER_BG};
      outline: none;
    }

    &:focus-visible {
      /* The rule above kills the UA outline, so this inset ring is the whole keyboard affordance
         for these rows. It is inset because the row is a full-bleed button inside a scrolling body,
         where an outset outline clips, and it has to out-contrast the hover fill that the very same
         selector paints underneath it. FOCUS_RING is the brightest value in the palette for exactly
         that reason: at 12.1:1 on the hover fill it cannot be lost. */
      box-shadow: inset 0 0 0 2px ${FOCUS_RING};
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
    }

    &.danger:not(:disabled) .label {
      color: ${DANGER};
    }

    .text {
      flex: 1;
      min-width: 0;
    }

    .label {
      display: block;
      font-size: 0.88rem;
    }

    .hint {
      display: block;
      margin-top: 2px;
      color: ${TEXT_MUTED};
      font-size: 0.78rem;
      line-height: 1.35;
    }
  }

  /* a switch, not a checkbox: these apply the moment they are flipped, with no OK button to press */
  .switch {
    flex: none;
    margin-top: 2px;
    width: 32px;
    height: 18px;
    border-radius: 999px;
    /* Nothing but this outline says a control is here, so the track takes the interactive border
       value, 3.89:1 on the card, the same one the radio ring below takes. The fill on its own is
       1.07:1 off and 1.53:1 on, so without the outline there is no track for the knob to travel in.
       The fill is the groove value rather than a button value for the same reason a progress track
       is: off should read as a recess in the card, and it doubles the on/off step on the way.
       border-box keeps the outer box at 32x18 and shrinks the padding box the knob is positioned
       against to 30x16, which is why the knob offsets below are 1px rather than 2px. */
    border: 1px solid ${BORDER_INTERACTIVE};
    background: ${SUNKEN_BG};
    position: relative;
    transition: background 120ms ease;

    &::after {
      content: '';
      position: absolute;
      top: 1px;
      left: 1px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: ${EMPHASIS};
      transition: transform 120ms ease;
    }

    /*
     * On used to be a saturated orange track, which carried the state on its own. Without an accent
     * the fill can only step from SUNKEN_BG to CONTROL_ACTIVE_BG, which measures 1.63:1: readable
     * as a step inside a track the outline already draws, but well under the 3:1 WCAG 1.4.11 wants
     * of a state cue standing alone. So the knob sliding the full width of the track carries the
     * state, and the transform below is load bearing rather than decoration.
     */
    &[data-on] {
      background: ${CONTROL_ACTIVE_BG};

      &::after {
        transform: translateX(14px);
      }
    }
  }

  /*
   * A hand-rolled radio, and the selected pip is the only thing that says which option is live.
   *
   * It used to be a single-stop radial-gradient painted into the background, which cannot simply be
   * flattened: a plain background fills the whole padding box, so the pip grows into a blob touching
   * the ring and the control reads as a filled checkbox. A centred pseudo-element draws the same
   * 7px disc and keeps the same 2px of card showing between disc and ring, and it is a shape rather
   * than a paint trick, so there is no gradient left to remove.
   */
  .dot {
    flex: none;
    position: relative;
    margin-top: 3px;
    width: 15px;
    height: 15px;
    border-radius: 999px;
    /* Nothing but this ring says a control is here, so it takes the interactive border weight
       rather than the hairline one. */
    border: 2px solid ${BORDER_INTERACTIVE};

    &[data-on] {
      border-color: ${EMPHASIS};
    }

    &[data-on]::after {
      content: '';
      position: absolute;
      inset: 0;
      margin: auto;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: ${EMPHASIS};
    }
  }

  .spacer {
    flex: none;
    width: 32px;
  }

  footer {
    flex: none;
    display: flex;
    justify-content: flex-end;
    padding: 12px 18px;
    border-top: 1px solid ${BORDER};

    button {
      border: 1px solid ${BORDER};
      border-radius: 6px;
      background: ${CONTROL_BG};
      color: ${TEXT};
      padding: 6px 18px;
      font-size: 0.85rem;
      font-weight: 700;

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: ${BORDER_STRONG};
      }
    }
  }
`

export const TorrentOptionsDialog = ({
  title, groups, onClose,
}: {
  title: string
  groups: OptionGroup[]
  onClose: () => void
}) => {
  const closeRef = useRef<HTMLButtonElement>(null)


  return (
    <Modal labelledBy="torrent-options-title" onClose={onClose} initialFocus={closeRef}>
      <div css={style}>
      <div className="card">
        <header>
          <h2 id="torrent-options-title">{title}</h2>
        </header>
        <div className="body">
          {groups.map((group) => (
            <div className="group" key={group.id} role="group" aria-label={group.label}>
              <label>{group.label}</label>
              {group.items.map((item) => {
                /*
                 * `key` is NOT in here, and that is the point.
                 *
                 * React 19 deprecates reaching an element's key through a spread and warns about it
                 * at runtime, so it is passed directly on each element below. It also cannot be seen
                 * by a static check from inside a spread, which is what `react(jsx-key)` was
                 * reporting: three elements in an iterator with no visible key.
                 */
                const common = {
                  type: 'button' as const,
                  className: 'opt' + (item.kind === 'action' && item.danger ? ' danger' : ''),
                  disabled: !!item.disabled,
                }
                const hint = item.disabled ?? item.hint
                if (item.kind === 'toggle') {
                  return (
                    <button
                      key={item.id}
                    {...common}
                      role="switch"
                      aria-checked={item.checked}
                      onClick={() => item.apply(!item.checked)}
                    >
                      <span className="switch" data-on={item.checked || undefined} aria-hidden="true"/>
                      <span className="text">
                        <span className="label">{item.label}</span>
                        <span className="hint">{hint}</span>
                      </span>
                    </button>
                  )
                }
                if (item.kind === 'radio') {
                  return (
                    <button
                      key={item.id}
                    {...common}
                      role="radio"
                      aria-checked={item.selected}
                      onClick={item.apply}
                    >
                      <span className="dot" data-on={item.selected || undefined} aria-hidden="true"/>
                      <span className="text">
                        <span className="label">{item.label}</span>
                        <span className="hint">{hint}</span>
                      </span>
                    </button>
                  )
                }
                return (
                  <button
                    key={item.id}
                    {...common}
                    onClick={() => { item.run(); onClose() }}
                  >
                    <span className="spacer" aria-hidden="true"/>
                    <span className="text">
                      <span className="label">{item.label}</span>
                      <span className="hint">{hint}</span>
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        <footer>
          {/* Everything here applies as it is chosen, so this says Done rather than OK: there is no
              pending state to accept, and a Cancel would promise an undo that does not exist. */}
          <button type="button" ref={closeRef} onClick={onClose}>Done</button>
        </footer>
      </div>
      </div>
    </Modal>
  )
}
