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
  justify-content: flex-end;

  border-radius: 6px;
  user-select: none;

  z-index: 3;

  * {
    font-weight: 400;
    font-size: 1.2rem;
    line-height: 1.7rem;
    @media (min-width: 960px) {
      font-size: 1.4rem;
      line-height: 2rem;
    }
  }

  ${size === buttonSize.sm && css`
    padding: 0.4rem!important;
  `}
  ${size === buttonSize.md && css`
    padding: 0.6rem!important;
  `}
  ${size === buttonSize.lg && css`
    padding: 1.2rem!important;
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
  offset = 27.5,
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
