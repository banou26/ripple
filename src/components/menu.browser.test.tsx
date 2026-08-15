import type { OptionGroup } from '../torrent/torrent-options'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { ContextMenu } from './menu'

/**
 * The right-click menu.
 *
 * Most of what is asserted here is keyboard behaviour, and that is the point. A context menu that
 * only opens on right-click and only responds to a mouse is not an alternative route to a feature,
 * it is the feature being unavailable to anyone not using a mouse. This route had no menu
 * primitive before, so none of this could be inherited.
 *
 * The positioning tests cover the other half: a menu opened near an edge must FLIP rather than
 * slide back into view, because sliding puts it under the pointer that is about to be released,
 * and one of the items is "Remove and delete the files".
 */

const groups = (over: Partial<OptionGroup>[] = []): OptionGroup[] => over.length ? over as OptionGroup[] : [
  {
    id: 'order',
    label: 'Piece order',
    items: [
      { kind: 'radio', id: 'rarest', group: 'order', label: 'Rarest first', hint: 'h', selected: true, apply: vi.fn() },
      { kind: 'radio', id: 'seq', group: 'order', label: 'In order', hint: 'h', selected: false, apply: vi.fn() },
    ],
  },
  {
    id: 'peers',
    label: 'Finding peers',
    items: [
      { kind: 'toggle', id: 'dht', label: 'Use the DHT', hint: 'h', checked: true, apply: vi.fn() },
      { kind: 'toggle', id: 'pex', label: 'Exchange peers', hint: 'h', checked: false, apply: vi.fn() },
      { kind: 'action', id: 'nope', label: 'Unavailable', hint: 'h', disabled: 'Not here', run: vi.fn() },
      { kind: 'action', id: 'wipe', label: 'Remove', hint: 'h', danger: true, run: vi.fn() },
    ],
  },
]

/**
 * Awaited, because the menu's effects are what place it, focus it and attach its listeners, and
 * none of that has happened on the turn render() returns. Every test here depends on at least one
 * of the three.
 */
const mount = async (opts: { at?: { x: number, y: number }, onClose?: () => void, g?: OptionGroup[] } = {}) => {
  const onClose = opts.onClose ?? vi.fn()
  const screen = render(
    <ContextMenu
      groups={opts.g ?? groups()}
      at={opts.at ?? { x: 40, y: 40 }}
      label="Options for Big Buck Bunny"
      onClose={onClose}
    />,
  )
  await expect.poll(() => document.activeElement?.closest('[role="menu"]')).not.toBeNull()
  return { screen, onClose }
}

const menu = () => document.querySelector('[role="menu"]') as HTMLElement
const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]
// the label only: every item also carries a decorative tick span, which is part of textContent
const labelOf = (el: Element | null | undefined) => el?.querySelector('.text')?.textContent?.trim()
const byLabel = (label: string) => items().find((el) => labelOf(el) === label)!
const active = () => labelOf(document.activeElement as HTMLElement)

describe('the torrent context menu', () => {
  it('is a menu, with each item typed for what it does', async () => {
    await mount()
    expect(menu().getAttribute('aria-label')).toBe('Options for Big Buck Bunny')
    expect(byLabel('Rarest first').getAttribute('role')).toBe('menuitemradio')
    expect(byLabel('Use the DHT').getAttribute('role')).toBe('menuitemcheckbox')
    expect(byLabel('Remove').getAttribute('role')).toBe('menuitem')
  })

  /** A tick drawn in a span is invisible to a screen reader; aria-checked is the actual state. */
  it('reports checked state through aria rather than only through a glyph', async () => {
    await mount()
    expect(byLabel('Rarest first').getAttribute('aria-checked')).toBe('true')
    expect(byLabel('In order').getAttribute('aria-checked')).toBe('false')
    expect(byLabel('Use the DHT').getAttribute('aria-checked')).toBe('true')
    expect(byLabel('Exchange peers').getAttribute('aria-checked')).toBe('false')
  })

  it('puts focus on the first usable item when it opens', async () => {
    await mount()
    expect(active()).toBe('Rarest first')
  })

  it('walks with the arrow keys and wraps at both ends', async () => {
    await mount()
    expect(active()).toBe('Rarest first')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('In order')
    // up from the top wraps to the bottom, which is how a long menu is reached from above
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(active()).toBe('Remove')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('Rarest first')
  })

  /** A disabled item that can be focused is a dead end the user has to arrow past. */
  it('skips over items that cannot be used', async () => {
    await mount()
    await userEvent.keyboard('{End}')
    expect(active()).toBe('Remove')
    await userEvent.keyboard('{ArrowUp}')
    // 'Unavailable' sits between them and must not receive focus
    expect(active()).toBe('Exchange peers')
  })

  it('jumps to either end with Home and End', async () => {
    await mount()
    await userEvent.keyboard('{End}')
    expect(active()).toBe('Remove')
    await userEvent.keyboard('{Home}')
    expect(active()).toBe('Rarest first')
  })

  it('closes on Escape', async () => {
    const { onClose } = await mount()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })

  it('applies a toggle with its opposite value and then closes', async () => {
    const g = groups()
    const dht = g[1]!.items[0]!
    const { onClose } = await mount({ g })
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    if (dht.kind !== 'toggle') throw new Error('not a toggle')
    expect(dht.apply).toHaveBeenCalledWith(false)
    expect(onClose).toHaveBeenCalled()
  })

  it('does nothing when a disabled item is activated', async () => {
    const g = groups()
    const dead = g[1]!.items[2]!
    await mount({ g })
    const el = byLabel('Unavailable')
    expect(el.disabled).toBe(true)
    el.click()
    if (dead.kind !== 'action') throw new Error('not an action')
    expect(dead.run).not.toHaveBeenCalled()
  })

  it('closes when something outside it is pressed', async () => {
    const { onClose } = await mount()
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onClose).toHaveBeenCalled()
  })

  it('stays open when something inside it is pressed', async () => {
    const { onClose } = await mount()
    menu().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(onClose).not.toHaveBeenCalled()
  })

  /** It is placed against viewport coordinates, so it is wrong the instant anything scrolls. */
  it('closes rather than following the page when something scrolls', async () => {
    const { onClose } = await mount()
    window.dispatchEvent(new Event('scroll'))
    expect(onClose).toHaveBeenCalled()
  })

  describe('placement', () => {
    it('opens at the pointer when there is room', async () => {
      await mount({ at: { x: 40, y: 40 } })
      await expect.poll(() => menu().getBoundingClientRect().left).toBeCloseTo(40, 0)
      expect(menu().getBoundingClientRect().top).toBeCloseTo(40, 0)
    })

    /**
     * Flipped, not clamped. Clamping would slide the menu back under the cursor, putting whatever
     * item lands there directly beneath a button that is about to be released.
     */
    it('flips above and left of the pointer near the bottom right corner', async () => {
      const at = { x: window.innerWidth - 4, y: window.innerHeight - 4 }
      await mount({ at })
      await expect.poll(() => menu().getBoundingClientRect().right).toBeLessThanOrEqual(at.x + 1)
      const box = menu().getBoundingClientRect()
      expect(box.bottom).toBeLessThanOrEqual(at.y + 1)
      // and it is still fully on screen after flipping
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.top).toBeGreaterThanOrEqual(0)
    })

    it('never leaves the viewport even when the pointer is at the very corner', async () => {
      await mount({ at: { x: 0, y: 0 } })
      await expect.poll(() => menu().getBoundingClientRect().left).toBeGreaterThanOrEqual(0)
      expect(menu().getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
    })
  })
})
