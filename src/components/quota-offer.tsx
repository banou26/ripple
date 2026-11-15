import { css } from '@emotion/react'
import { useIntl } from 'react-intl'
import { Tooltip } from 'react-tooltip'

import { BORDER, BORDER_STRONG, CONTROL_BG, CONTROL_HOVER_BG, ELEVATED_BG, FOCUS_RING, TEXT } from '../theme'

/*
 * The chip of a hint, with its arrow. The colours are react-tooltip's own variables and the padding and radius carry
 * !important for the reason hint.tsx gives: its sheet lands after emotion's and wins every tie. The words take their
 * size on the box inside for the same reason, as the chip's own font-size is react-tooltip's 90%.
 */
const style = css`
  --rt-color-dark: ${ELEVATED_BG};
  --rt-color-white: ${TEXT};
  --rt-opacity: 1;

  box-sizing: border-box;
  max-width: min(320px, calc(100vw - 24px));
  padding: 10px 12px !important;
  border-radius: 6px !important;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: start;
  text-shadow: none;
  z-index: 1000;

  .offer {
    font-size: 0.8rem;
    font-weight: 400;
    line-height: 1.45;
  }

  p {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }

  button {
    font: inherit;
    font-weight: 600;
    padding: 5px 10px;
    border: 1px solid ${BORDER};
    border-radius: 6px;
    background: ${CONTROL_BG};
    color: ${TEXT};
    cursor: pointer;
    transition: background 120ms ease;

    &:hover {
      background: ${CONTROL_HOVER_BG};
    }

    &:focus-visible {
      outline: 2px solid ${FOCUS_RING};
      outline-offset: 2px;
    }
  }
`

/* Inside the player every size is in its own unit, as the rest of its chrome is: rem belongs to the page framing it. */
const playerStyle = css`
  max-width: min(calc(32 * var(--mp-unit)), calc(100vw - calc(2.4 * var(--mp-unit))));
  padding: calc(0.8 * var(--mp-unit)) calc(1 * var(--mp-unit)) !important;
  border-radius: calc(0.6 * var(--mp-unit)) !important;
  z-index: 3;

  .offer {
    font-size: calc(1.2 * var(--mp-unit));
    line-height: calc(1.7 * var(--mp-unit));
    @media (min-width: 960px) {
      font-size: calc(1.4 * var(--mp-unit));
      line-height: calc(2 * var(--mp-unit));
    }
  }

  .actions {
    gap: calc(0.8 * var(--mp-unit));
    margin-top: calc(0.6 * var(--mp-unit));
  }

  button {
    padding: calc(0.3 * var(--mp-unit)) calc(0.8 * var(--mp-unit));
    border-radius: calc(0.4 * var(--mp-unit));
  }
`

/**
 * What the VPN's switch offers once the FKN quota is used up: to switch the VPN off, which nothing meters. Drawn under
 * the element whose id is `anchor`, with an arrow to it, and open until answered. `onAnswer(true)` is Turn off VPN.
 * `inPlayer` draws it in the player's top row, at its end and in its unit.
 */
export const QuotaOffer = ({ anchor, onAnswer, inPlayer }: { anchor: string, onAnswer: (off: boolean) => void, inPlayer?: boolean }) => {
  const intl = useIntl()
  return (
    <Tooltip
      css={[style, inPlayer && playerStyle]}
      anchorSelect={`#${CSS.escape(anchor)}`}
      isOpen
      imperativeModeOnly
      clickable
      role="status"
      /* Aligned to an edge of the switch rather than centred on it: floating-ui moves a centred box that runs past the
         window to the switch's SIDE, where an aligned one is first tried against the other edge. */
      place={inPlayer ? 'bottom-end' : 'bottom-start'}
      positionStrategy={inPlayer ? 'absolute' : 'fixed'}
      border={`1px solid ${BORDER_STRONG}`}
    >
      <div
        className="offer"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onAnswer(false)
          }
          // a button is pressed with Space, which must not also reach the player, which pauses on it
          if (event.key === ' ') event.stopPropagation()
        }}
      >
        <p>{intl.formatMessage({ id: 'Your daily FKN quota is used up.', defaultMessage: 'Your daily FKN quota is used up.' })}</p>
        <div className="actions">
          <button type="button" onClick={() => onAnswer(true)}>
            {intl.formatMessage({ id: 'Turn off VPN', defaultMessage: 'Turn off VPN' })}
          </button>
          <button type="button" onClick={() => onAnswer(false)}>
            {intl.formatMessage({ id: 'No thanks', defaultMessage: 'No thanks' })}
          </button>
        </div>
      </div>
    </Tooltip>
  )
}
