import { ReactNode } from 'react'
import { css } from '@emotion/react'
import { PlacesType, Tooltip } from 'react-tooltip'

import { CONTROL_BG, TEXT } from '../theme'

const style = (size: buttonSize) => css`
  /*
   * The chip's colours, set as react-tooltip's own variables rather than as background and color.
   *
   * react-tooltip paints the chip from these three, and injects the stylesheet carrying them from a
   * passive effect on the first tooltip mount. Emotion inserts through useInsertionEffect, which
   * runs earlier, so react-tooltip's sheet is the one that goes into <head> last, and its rules land
   * at exactly the same specificity as the class emotion generates here. Later sheet wins the tie,
   * which is the reason the padding below needs !important; assigning the variables on the element
   * sidesteps the fight instead, because a custom property set on the element beats the :root
   * definition every time.
   *
   * Left alone the defaults are a near-black chip in pure white at 0.9 opacity: the only pure white
   * left in the app, with whatever is behind it bleeding through its own text. Over video, which is
   * where this is actually used, the bleed is the one that hurts.
   */
  --rt-color-dark: ${CONTROL_BG};
  --rt-color-white: ${TEXT};
  --rt-opacity: 1;

  display: flex;
  justify-content: flex-start;

  /*
   * Bounded, and allowed to wrap. Two rules, and BOTH are load bearing.
   *
   * react-tooltip's own chip rule carries width of max-content, so with nothing opposing it the chip
   * grows to the widest UNWRAPPED line of its content: measured at 1884px for the VPN explainer, in
   * a 1920px window, and at 1618px in a 720px one with 903px of it off screen. The chip is drawn in
   * place rather than portaled, so it is a descendant of the overlay row and inherits that row's
   * nowrap as well, which is why a bound on its own would only move the overflow inside a narrow
   * box instead of wrapping in it.
   */
  max-width: min(calc(32 * var(--mp-unit)), calc(100vw - calc(2.4 * var(--mp-unit))));
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;

  /*
   * The radius carries !important for exactly the reason the padding below does, and the note above
   * explains: react-tooltip's sheet lands after emotion's at equal specificity, so its own 3px wins
   * every tie and the chip was drawn square.
   */
  border-radius: calc(0.6 * var(--mp-unit))!important;
  user-select: none;

  z-index: 3;

  /*
   * Sized in the player's own unit, not in rem.
   *
   * This chip only ever appears inside the player, whose whole chrome scales from that variable,
   * while rem is root relative and belongs to whatever page is embedding this. At ripple's 16px root
   * the rem version drew 22.4px of tooltip text against a row drawn at 14px.
   */
  * {
    font-weight: 400;
    font-size: calc(1.2 * var(--mp-unit));
    line-height: calc(1.7 * var(--mp-unit));
    @media (min-width: 960px) {
      font-size: calc(1.4 * var(--mp-unit));
      line-height: calc(2 * var(--mp-unit));
    }
  }

  ${size === buttonSize.sm && css`
    padding: calc(0.4 * var(--mp-unit))!important;
  `}
  ${size === buttonSize.md && css`
    padding: calc(0.6 * var(--mp-unit))!important;
  `}
  ${size === buttonSize.lg && css`
    padding: calc(1.2 * var(--mp-unit))!important;
  `}
`

interface TooltipDisplayProps {
  id: string
  toolTipText: ReactNode
  text: ReactNode
  delayShow?: number
  closeDelay?: number
  offset?: number
  tooltipPlace?: PlacesType
  size?: buttonSize
  disabled?: boolean
}

export enum buttonSize {
  sm = 'sm',
  md = 'md',
  lg = 'lg'
}

export const TooltipDisplay = ({
  id,
  toolTipText,
  text,
  delayShow = 0,
  closeDelay = 0,
  offset = 10,
  tooltipPlace = 'top',
  disabled = false,
  size = buttonSize.md
}: TooltipDisplayProps) => (
  <>
    <div
      data-tooltip-id={id}
      data-open={true}
      data-tooltip-offset={offset}
      data-tooltip-delay-show={delayShow}
      data-tooltip-delay-hide={closeDelay}
      data-tooltip-place={tooltipPlace}
    >
      {text}
    </div>
    {
      !disabled && (
        <Tooltip
          css={style(size)}
          id={id}
          noArrow={true}
        >
          {toolTipText}
        </Tooltip>
      )
    }
  </>
)
