import type { OptionGroup, OptionItem } from '../torrent/torrent-options'

import { css } from '@emotion/react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A right-click menu.
 *
 * Built rather than borrowed because the route had no menu primitive at all, and a context menu
 * that only works with a mouse is not a menu, it is a trap: everything in it has to be reachable
 * some other way or the feature does not exist for anyone navigating by keyboard.
 *
 * So this implements the menu pattern properly. Roving focus with the arrow keys, Home and End,
 * Escape to close and return focus to whatever opened it, and `menuitemcheckbox` /
 * `menuitemradio` with real `aria-checked` rather than a tick drawn in a span.
 *
 * It is positioned at the pointer and flipped, not clamped, when it would cross an edge. Clamping
 * slides the menu under the cursor and puts a destructive item where the user is already
 * clicking.
 */

export type MenuPosition = { x: number, y: number }

const MARGIN = 8

export const menuStyle = css`
  position: fixed;
  z-index: 2000;
  min-width: 240px;
  max-width: 320px;
  max-height: min(70vh, 560px);
  overflow-y: auto;
  padding: 6px;
  border-radius: 14px;
  border: 1px solid rgba(68, 60, 86, 0.9);
  background: #1e1a28;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
  color: #f4f2f8;

  .group + .group {
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px solid rgba(44, 39, 55, 0.9);
  }

  .group > label {
    display: block;
    padding: 6px 10px 4px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b8499;
  }

  button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    border-radius: 9px;
    background: none;
    color: #f4f2f8;
    padding: 7px 10px;
    font-size: 0.82rem;
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

    &.danger:not(:disabled) {
      color: #f87171;
    }

    .tick {
      flex: none;
      width: 14px;
      text-align: center;
      color: #fbbf24;
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

const itemLabel = (item: OptionItem) => (item.disabled ? `${item.label} — ${item.disabled}` : item.hint)

export const MenuItems = ({
  groups, onChose, itemRef,
}: {
  groups: OptionGroup[]
  onChose: () => void
  itemRef: (el: HTMLButtonElement | null, index: number) => void
}) => {
  let index = -1
  return (
    <>
      {groups.map((group) => (
        <div className="group" key={group.id} role="group" aria-label={group.label}>
          <label>{group.label}</label>
          {group.items.map((item) => {
            index += 1
            const at = index
            const common = {
              type: 'button' as const,
              key: item.id,
              ref: (el: HTMLButtonElement | null) => itemRef(el, at),
              disabled: !!item.disabled,
              title: itemLabel(item),
              // a menu manages focus itself, so only the active item is in the tab order
              tabIndex: -1,
            }
            if (item.kind === 'toggle') {
              return (
                <button
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

export const ContextMenu = ({
  groups, at, label, onClose,
}: {
  groups: OptionGroup[]
  at: MenuPosition
  label: string
  onClose: () => void
}) => {
  const ref = useRef<HTMLDivElement | null>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const [pos, setPos] = useState(at)

  const itemRef = useCallback((el: HTMLButtonElement | null, index: number) => {
    items.current[index] = el
  }, [])

  // Before paint, so the menu is never seen at the unflipped position. useEffect would show one
  // frame in the wrong place, which on a menu that opens under the cursor is very visible.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = el.getBoundingClientRect()
    // Flipped rather than clamped: sliding it back into view would put it under the pointer, and
    // the pointer is about to be released on whatever ends up there.
    const x = at.x + box.width + MARGIN > window.innerWidth ? Math.max(MARGIN, at.x - box.width) : at.x
    const y = at.y + box.height + MARGIN > window.innerHeight ? Math.max(MARGIN, at.y - box.height) : at.y
    setPos({ x, y })
  }, [at.x, at.y])

  useEffect(() => {
    const enabled = () => items.current.filter((el): el is HTMLButtonElement => !!el && !el.disabled)
    enabled()[0]?.focus()

    const onKey = (e: KeyboardEvent) => {
      const list = enabled()
      const here = list.indexOf(document.activeElement as HTMLButtonElement)
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'Tab') { onClose(); return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (!list.length) return
        const step = e.key === 'ArrowDown' ? 1 : -1
        // wraps, which is what a menu does and what makes a long list usable from the bottom
        list[(here + step + list.length) % list.length]?.focus()
        return
      }
      if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); return }
      if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus() }
    }

    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    // A menu anchored to a viewport coordinate is wrong the moment anything scrolls, so it closes
    // rather than following. `true` for the capture phase: the scroll may be inside the panel the
    // menu was opened over, and a scroll event on an inner element does not bubble to window.
    const onScroll = () => onClose()

    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [onClose])

  return (
    <div
      css={menuStyle}
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      // the menu owns the right button too: a second right-click inside it should not stack
      // another menu on top of this one
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuItems groups={groups} onChose={onClose} itemRef={itemRef}/>
    </div>
  )
}
