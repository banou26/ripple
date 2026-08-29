import type { OptionGroup, OptionItem } from '../torrent/torrent-options'
import type { ReactNode, RefObject } from 'react'

import { css } from '@emotion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  BORDER, BORDER_STRONG, CONTROL_HOVER_BG, DANGER, ELEVATED_BG, FOCUS_RING, TEXT, TEXT_MUTED,
} from '../theme'

/**
 * The menu pattern, and the two surfaces built on it.
 *
 * Built rather than borrowed because the route had no menu primitive at all, and a context menu
 * that only works with a mouse is not a menu, it is a trap: everything in it has to be reachable
 * some other way or the feature does not exist for anyone navigating by keyboard.
 *
 * So this implements the menu pattern properly. Roving focus with the arrow keys, Home and End,
 * Escape to close and return focus to whatever opened it, and `menuitemcheckbox` /
 * `menuitemradio` with real `aria-checked` rather than a tick drawn in a span.
 *
 * `MenuSurface` is that behaviour with nothing in it. `ContextMenu` is the right-click menu, which
 * is what the file was originally, and its shape is deliberately unchanged.
 */

export type MenuPosition = { x: number, y: number }

/**
 * Where a menu goes, and it is not one question.
 *
 * A POINTER menu is pinned to a coordinate the page can move out from under, so it flips at an edge
 * rather than clamping (clamping slides it under the cursor that is about to be released) and it
 * closes when anything scrolls.
 *
 * A menu UNDER a control is pinned to the control: it end-aligns with it, flips across it rather
 * than over it, slides sideways to stay on screen, and repositions rather than closing, because
 * there is no pointer for it to land under.
 */
export type MenuPlacement =
  | { kind: 'pointer', at: MenuPosition }
  /**
   * The control this hangs from, read live rather than measured once by the caller.
   *
   * A ref, not a rect. The broker's docked header mode writes an important margin-top on <html>
   * plus a matching --fkn-inset-top, which moves every in-flow box down and emits no event at all.
   * A rect captured at open would leave the menu floating where the trigger used to be.
   */
  | { kind: 'under', of: RefObject<HTMLElement | null> }

const MARGIN = 8
/** The gap between a trigger and the menu it opens, so the two read as separate surfaces. */
const GAP = 6

/**
 * Where to put a menu of this size, or null when the trigger has gone.
 *
 * Pure and exported so the arithmetic can be checked without a browser, a menu or a pointer.
 */
export const place = (placement: MenuPlacement, box: { width: number, height: number }): MenuPosition | null => {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (placement.kind === 'pointer') {
    const { at } = placement
    return {
      x: at.x + box.width + MARGIN > vw ? Math.max(MARGIN, at.x - box.width) : at.x,
      y: at.y + box.height + MARGIN > vh ? Math.max(MARGIN, at.y - box.height) : at.y,
    }
  }
  const anchor = placement.of.current?.getBoundingClientRect()
  if (!anchor) return null
  // End-aligned with the trigger, then slid back inside the viewport. Sliding is safe here and is
  // not safe for a pointer menu: nothing is hovering the place it slides to. The header wraps at
  // narrow widths, so the trigger is not reliably flush right and the clamp is not decoration.
  const x = Math.min(Math.max(MARGIN, anchor.right - box.width), Math.max(MARGIN, vw - box.width - MARGIN))
  const below = anchor.bottom + GAP
  // ACROSS the trigger, never over it. The pointer branch subtracts the height from a POINT, which
  // for a control lands the menu on top of the thing that opened it.
  const above = anchor.top - GAP - box.height
  const y = below + box.height + MARGIN > vh && above >= MARGIN ? above : below
  return { x, y }
}

export const menuStyle = css`
  position: fixed;
  z-index: 2000;
  min-width: 240px;
  max-width: 320px;
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 6px;
  border-radius: 8px;
  /* The border is the whole elevation now, and it has to be, because ELEVATED_BG is barely a step
     above the panels this opens over: on its own the menu would read as part of the page. The 48px
     drop shadow that used to do the lifting is gone with the rest of the soft effects, and a
     hairline that holds at any contrast setting is the honest trade. */
  border: 1px solid ${BORDER_STRONG};
  background: ${ELEVATED_BG};
  color: ${TEXT};

  .group + .group {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid ${BORDER};
  }

  .group > label {
    display: block;
    padding: 6px 10px 4px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: ${TEXT_MUTED};
  }

  &:focus {
    /* the container takes focus on open, and a ring around the whole menu is noise */
    outline: none;
  }

  .passthrough {
    margin: 4px 0 0;
    padding: 7px 10px 3px;
    border-top: 1px solid ${BORDER};
    /* A footnote about an affordance the browser normally offers, not an item in the list, so it
       should read quieter than the group headings. Not by going darker, though: TEXT_FAINT lands at
       4.4:1 on ELEVATED_BG, which is why theme.ts holds it to PAGE_BG and SURFACE_BG. TEXT_MUTED is
       5.8:1 here, and the tier still reads, because the headings are 0.65rem uppercase bold with
       0.08em tracking against this 0.7rem sentence case. */
    color: ${TEXT_MUTED};
    font-size: 0.7rem;
    line-height: 1.35;
  }

  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    border-radius: 4px;
    background: none;
    color: ${TEXT};
    padding: 7px 10px;
    font-size: 0.82rem;
    text-align: left;

    &:hover:not(:disabled),
    &:focus-visible {
      background: ${CONTROL_HOVER_BG};
      outline: none;
    }

    &:focus-visible {
      /* The only thing that says "the arrow keys are on this row" rather than "the mouse happens to
         be over it": the rule above hands both states the same fill and kills the outline for both.
         Brightness is all that is left to carry it, so the ring is the loudest value in the palette
         and its width is not up for negotiation. */
      box-shadow: inset 0 0 0 2px ${FOCUS_RING};
    }

    &:disabled {
      /* Still opacity rather than a disabled text colour, because it dims the tick and the label
         together. A colour set here would only reach the tick by inheritance, and the .tick rule
         below declares its own, so the glyph would stay fully lit on a row nobody can press. Not a
         cascade tie: the two rules match different elements, so specificity and source order never
         come into it. Opacity applies to the rendered subtree and cannot be opted out of that way. */
      opacity: 0.45;
      cursor: default;
    }

    &.danger:not(:disabled) {
      color: ${DANGER};
    }

    .tick {
      flex: none;
      width: 14px;
      text-align: center;
      /* The glyph's presence is the whole signal, so it only has to be as bright as the label beside
         it. It used to be amber, which made an unchecked row's neighbour look like the loud thing on
         screen; matching the label puts the emphasis back on the row. */
      color: ${TEXT};
    }

    .text {
      flex: 1;
      min-width: 0;
    }
  }
`

const Tick = ({ on, radio }: { on: boolean, radio?: boolean }) => (
  // decorative: aria-checked on the button is what a screen reader reads, and a second
  // announcement of the same fact is worse than none
  <span className="tick" aria-hidden="true">{on ? (radio ? '●' : '✓') : ''}</span>
)

const itemLabel = (item: OptionItem) => (item.disabled ? `${item.label}. ${item.disabled}` : item.hint)

export const MenuItems = ({
  groups, onChose,
}: {
  groups: OptionGroup[]
  onChose: () => void
}) => {
  return (
    <>
      {groups.map((group) => (
        <div className="group" key={group.id} role="group" aria-label={group.label}>
          <label>{group.label}</label>
          {group.items.map((item) => {
            // `key` is deliberately NOT in here. React warns when a key arrives by spread, and the
            // reconciliation it drives is what keeps each row's DOM node, and therefore the focus
            // on it, alive across the re-render the page performs twice a second.
            const common = {
              type: 'button' as const,
              disabled: !!item.disabled,
              title: itemLabel(item),
              // a menu manages focus itself, so only the active item is in the tab order
              tabIndex: -1,
            }
            if (item.kind === 'toggle') {
              return (
                <button
                  key={item.id}
                  {...common}
                  role="menuitemcheckbox"
                  aria-checked={item.checked}
                  onClick={() => { item.apply(!item.checked); onChose() }}
                >
                  <Tick on={item.checked}/>
                  <span className="text">{item.label}</span>
                </button>
              )
            }
            if (item.kind === 'radio') {
              return (
                <button
                  key={item.id}
                  {...common}
                  role="menuitemradio"
                  aria-checked={item.selected}
                  onClick={() => { item.apply(); onChose() }}
                >
                  <Tick on={item.selected} radio/>
                  <span className="text">{item.label}</span>
                </button>
              )
            }
            return (
              <button
                key={item.id}
                {...common}
                role="menuitem"
                className={item.danger ? 'danger' : undefined}
                onClick={() => { item.run(); onChose() }}
              >
                <Tick on={false}/>
                <span className="text">{item.label}</span>
              </button>
            )
          })}
        </div>
      ))}
    </>
  )
}

export const MenuSurface = ({
  placement, label, onClose, children,
}: {
  placement: MenuPlacement
  label: string
  onClose: () => void
  children: ReactNode
}) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<MenuPosition>(
    // the pointer has somewhere to start; a control's menu is placed before paint by the effect
    // below, so where it sits for that one un-painted frame does not matter
    placement.kind === 'pointer' ? placement.at : { x: -9999, y: -9999 },
  )

  // Read through a ref so the listeners below can be attached once and still see the current value.
  // Written during render rather than in an effect: the placement is read by a LAYOUT effect, which
  // runs before passive effects, so mirroring it passively leaves that read one render stale and a
  // menu moved to a new anchor is placed at the previous one.
  const placementRef = useRef(placement)
  placementRef.current = placement
  // a mounted surface never changes kind, so this can be read inside listeners attached once
  const pinned = useRef(placement.kind === 'pointer').current

  const reposition = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = place(placementRef.current, el.getBoundingClientRect())
    if (next) setPos(next)
  }, [])

  // Before paint, so the menu is never seen at the unplaced position. useEffect would show one
  // frame in the wrong place, which on a menu that opens under the cursor is very visible.
  useLayoutEffect(
    reposition,
    // the numbers, never the object: the page hands this component a fresh literal twice a second
    [reposition, placement.kind === 'pointer' ? placement.at.x : 0, placement.kind === 'pointer' ? placement.at.y : 0],
  )

  /**
   * A control's menu follows its control instead of closing.
   *
   * The case this exists for emits no event of its own: the broker's docked header writes an
   * important margin-top on <html> plus --fkn-inset-top, and every in-flow box moves down. What it
   * DOES do is change <html>'s height, which is `calc(100% - var(--fkn-inset-top))`, and <body> is
   * `height: 100%` of that, so observing the body catches it. A window resize resizes the body too,
   * which is why there is no separate resize handler on this path.
   */
  useEffect(() => {
    if (pinned) return
    const observer = new ResizeObserver(() => reposition())
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [pinned, reposition])

  /**
   * ONCE, on mount, and never again.
   *
   * This is the whole reason the effects here are split up. The engine broadcasts state twice a
   * second, which re-renders the page, which hands this component a fresh `onClose` closure and a
   * freshly built `groups` array every time. An effect that focuses and lists `onClose` in its
   * deps therefore re-runs twice a second and drags focus back, so a user arrowing down the menu
   * watches their selection snap back to the top about once a second. Reported from the live site,
   * and invisible to a test that never re-renders.
   *
   * The CONTAINER, not the first item: a ring on the first usable row reads as a choice the user
   * did not make, and the arrow keys move into the list from here anyway.
   *
   * preventScroll, or focusing scrolls the element into view, that scroll reaches the close handler
   * below, and the menu shuts itself in the frame it opened.
   *
   * The cleanup hands focus BACK, which this file's docblock has claimed since it shipped and the
   * code never did: without it, closing a menu drops focus on the body and the next Tab starts from
   * the top of the document. Same shape as modal.tsx, with two guards it does not need. The opener
   * can be GONE by the time the menu closes, because disconnecting replaces the account tag with
   * the connect button, and focusing a detached node drops focus on the floor rather than leaving
   * it be. And something else may have claimed focus in the same commit, which is not ours to take.
   */
  useEffect(() => {
    const el = ref.current
    const opener = document.activeElement
    el?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      if (active !== document.body && !el?.contains(active)) return
      if (opener instanceof HTMLElement && opener.isConnected && opener !== document.body) {
        opener.focus({ preventScroll: true })
      }
    }
  }, [])

  // read through a ref so the listeners below can be attached once and still call the current one
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose })

  useEffect(() => {
    const onClose = () => onCloseRef.current()
    /*
     * Read off the DOM rather than a registry, so a hand-written row counts exactly as much as one
     * MenuItems built. `[role^="menuitem"]` covers menuitem, menuitemcheckbox and menuitemradio.
     */
    const enabled = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
      .filter((el) => !el.matches(':disabled, [aria-disabled="true"]'))

    /**
     * Focus a row without letting the browser scroll it into view.
     *
     * The menu scrolls internally once the list is long, and a scroll inside it would otherwise
     * reach the close handler below, so arrowing past the visible rows would shut the menu.
     * `scrollIntoView` with `block: 'nearest'` does the same job without emitting a scroll the
     * window hears.
     */
    const focusItem = (el: HTMLElement | undefined) => {
      if (!el) return
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }

    const onKey = (e: KeyboardEvent) => {
      const list = enabled()
      const here = list.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Tab') { onClose(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!list.length) return
        // -1 is the container still holding focus, where down means the first row and up means the
        // last. Falling through to the wrap arithmetic would send up to the second-to-last instead.
        if (here < 0) { focusItem(e.key === 'ArrowDown' ? list[0] : list[list.length - 1]); return }
        const step = e.key === 'ArrowDown' ? 1 : -1
        // wraps, which is what a menu does and what makes a long list usable from the bottom
        focusItem(list[(here + step + list.length) % list.length])
        return
      }
      if (e.key === 'Home') { e.preventDefault(); focusItem(list[0]); return }
      if (e.key === 'End') { e.preventDefault(); focusItem(list[list.length - 1]); return }
      /*
       * Space, on whatever row holds focus.
       *
       * A button does this for free, so it was invisible while every row was one. A row can now be
       * an anchor, and an anchor takes Enter only, so two rows that look identical would answer
       * differently to the same key with nothing on screen to explain it. Routed through click() so
       * the row's own handler and href do the work.
       */
      if (e.key === ' ') {
        const el = document.activeElement
        if (el instanceof HTMLElement && ref.current?.contains(el) && el.matches('[role^="menuitem"]')) {
          e.preventDefault()
          el.click()
        }
      }
    }

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      /*
       * The trigger's own press is not "outside".
       *
       * This listener is on the CAPTURE phase, so without the clause the press closes the menu and
       * the click that follows reopens it, and the control that opens the menu can never close it.
       * A pointer menu never hit this: its opener is a coordinate, not an element anyone presses a
       * second time.
       */
      const placement = placementRef.current
      if (placement.kind === 'under' && placement.of.current?.contains(target)) return
      onClose()
    }
    /**
     * A menu anchored to a viewport coordinate is wrong the moment the page under it scrolls, so it
     * closes rather than following. `true` for the capture phase: the scroll may be inside the
     * panel the menu was opened over, and a scroll event on an inner element does not bubble.
     *
     * Its OWN scrolling is not that. The list scrolls internally once it is long enough, and
     * closing on that would make a long menu impossible to reach the bottom of.
     *
     * A control's menu does neither. It follows its control instead (see the ResizeObserver above),
     * and the header it hangs from sits outside the scrolling list anyway.
     */
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      onClose()
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    if (pinned) {
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onScroll)
    }
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
    // attached once: re-attaching on every render is what re-ran the focus above, and these
    // listeners have no reason to churn either
  }, [pinned])

  return (
    <div
      css={menuStyle}
      ref={ref}
      role="menu"
      aria-label={label}
      // focusable so the menu itself can hold focus without any row looking chosen
      tabIndex={-1}
      style={{ left: pos.x, top: pos.y }}
      // the menu owns the right button too: a second right-click inside it should not stack
      // another menu on top of this one
      onContextMenu={pinned ? (e) => e.preventDefault() : undefined}
    >
      {children}
    </div>
  )
}

/**
 * The right-click menu, which is what this file was before anything else needed the behaviour.
 *
 * Its props and the DOM it renders are deliberately unchanged.
 */
export const ContextMenu = ({
  groups, at, label, onClose,
}: {
  groups: OptionGroup[]
  at: MenuPosition
  label: string
  onClose: () => void
}) => (
  <MenuSurface placement={{ kind: 'pointer', at }} label={label} onClose={onClose}>
    <MenuItems groups={groups} onChose={onClose}/>
    {/* Taking over the right button removes something the browser normally offers, so the way
        back is stated rather than left to be discovered. Both modifiers are accepted: Ctrl is
        the secondary click on macOS, where Shift is the one that reads naturally. */}
    <p className="passthrough">Shift or Ctrl + right-click for the browser menu</p>
  </MenuSurface>
)
