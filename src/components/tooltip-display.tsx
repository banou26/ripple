import { ReactNode, useEffect, useRef } from 'react'
import { css } from '@emotion/react'
import { PlacesType, Tooltip, TooltipRefProps } from 'react-tooltip'

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

/**
 * Where the pointer is, shared by every anchor rather than tracked once per tooltip.
 *
 * Installed on the first mount rather than at module scope, so importing this does nothing to the
 * document on its own.
 */
const pointer = { x: -1, y: -1, anchors: 0 }
const trackPointer = (event: PointerEvent) => { pointer.x = event.clientX; pointer.y = event.clientY }

const watchPointer = () => {
  if (pointer.anchors++ === 0) {
    window.addEventListener('pointermove', trackPointer, { capture: true, passive: true })
  }
  return () => {
    if (--pointer.anchors === 0) window.removeEventListener('pointermove', trackPointer, { capture: true })
  }
}

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
}: TooltipDisplayProps) => {
  const anchor = useRef<HTMLDivElement>(null)
  const tooltip = useRef<TooltipRefProps>(null)

  /**
   * Close on a fullscreen transition, unless the pointer really is still on the anchor.
   *
   * Going fullscreen relays the whole row out from under a pointer that never moved, and the browser
   * recomputes the hover chain for that silently: the hover flag flips a frame later, but no
   * boundary event is dispatched at all. react-tooltip closes on mouseout and on nothing else, so it
   * never learns the pointer left and the chip stays painted for the rest of the session, surviving
   * both pointer movement and the player hiding its own controls.
   *
   * Tested against the anchor's rect rather than closed outright, because a player that already
   * fills the window moves nothing, and the tooltip under the pointer is then legitimately open.
   * The rect is already the post-transition one when fullscreenchange fires.
   *
   * The player carries the same fix for its own chips, in @banou/media-player's TooltipDisplay. This
   * one is a separate component drawing the overlay row, so it needs its own.
   */
  useEffect(() => {
    const untrack = watchPointer()
    const closeIfPointerLeft = () => {
      const element = anchor.current
      if (!element) return
      const { left, right, top, bottom } = element.getBoundingClientRect()
      if (pointer.x >= left && pointer.x < right && pointer.y >= top && pointer.y < bottom) return
      tooltip.current?.close()
    }
    const changeEvents: string[] = ['fullscreenchange', 'webkitfullscreenchange']
    for (const type of changeEvents) document.addEventListener(type, closeIfPointerLeft)
    return () => {
      untrack()
      for (const type of changeEvents) document.removeEventListener(type, closeIfPointerLeft)
    }
  }, [])

  return (
    <>
      <div
        ref={anchor}
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
            ref={tooltip}
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
}
