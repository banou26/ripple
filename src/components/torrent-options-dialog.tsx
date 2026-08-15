import type { OptionGroup } from '../torrent/torrent-options'

import { css } from '@emotion/react'

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
  color: #f4f2f8;
  width: 100%;
  max-width: min(560px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);

  .card {
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 64px);
    border-radius: 14px;
    border: 1px solid rgba(68, 60, 86, 0.9);
    background: #1e1a28;
  }

  header {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid rgba(44, 39, 55, 0.9);

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
      color: #8b8499;
    }
  }

  .opt {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    width: 100%;
    border: none;
    border-radius: 10px;
    background: none;
    color: inherit;
    padding: 9px 10px;
    text-align: left;

    &:hover:not(:disabled),
    &:focus-visible {
      background: #2a2338;
      outline: none;
    }

    &:focus-visible {
      box-shadow: inset 0 0 0 2px #fbbf24;
    }

    &:disabled {
      opacity: 0.45;
      cursor: default;
    }

    &.danger:not(:disabled) .label {
      color: #f87171;
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
      color: #8b8499;
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
    background: #3a3447;
    position: relative;
    transition: background 120ms ease;

    &::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: #f4f2f8;
      transition: transform 120ms ease;
    }

    &[data-on] {
      background: #f97316;

      &::after {
        transform: translateX(14px);
      }
    }
  }

  .dot {
    flex: none;
    margin-top: 3px;
    width: 15px;
    height: 15px;
    border-radius: 999px;
    border: 2px solid #3a3447;

    &[data-on] {
      border-color: #f97316;
      background:
        radial-gradient(circle at 50% 50%, #f97316 0 3.5px, transparent 3.5px);
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
    border-top: 1px solid rgba(44, 39, 55, 0.9);

    button {
      border: 1px solid #3a3447;
      border-radius: 999px;
      background: none;
      color: #f4f2f8;
      padding: 6px 18px;
      font-size: 0.85rem;
      font-weight: 700;

      &:hover {
        background: #241e30;
        border-color: rgba(249, 115, 22, 0.35);
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
                const common = {
                  type: 'button' as const,
                  key: item.id,
                  className: 'opt' + (item.kind === 'action' && item.danger ? ' danger' : ''),
                  disabled: !!item.disabled,
                }
                const hint = item.disabled ?? item.hint
                if (item.kind === 'toggle') {
                  return (
                    <button
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
