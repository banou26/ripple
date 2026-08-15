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
/**
 * The label of the focused ITEM, or undefined when no item has focus.
 *
 * Scoped to a menuitem on purpose. Reading `.text` off whatever holds focus finds the first label
 * in the subtree when that is the menu container, so "nothing is selected" and "the first row is
 * selected" both answer 'Rarest first' and the assertion that separates them cannot fail.
 */
const active = () => {
  const el = document.activeElement
  return el?.matches('[role^="menuitem"]') ? labelOf(el) : undefined
}

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

  /**
   * Nothing is pre-selected. Focusing the first usable row draws a ring on it, which reads as a
   * choice the user did not make, and because the first usable row rarely changes it reads that
   * way on every single open. Reported from the live site: the menu always looked stuck on
   * "Use the DHT", which is simply the first row that is not disabled for a finished torrent.
   */
  it('opens with no item selected', async () => {
    await mount()
    expect(active()).toBeUndefined()
    expect(document.activeElement).toBe(menu())
    expect(items().some((el) => el.matches(':focus'))).toBe(false)
  })

  it('walks with the arrow keys and wraps at both ends', async () => {
    await mount()
    // down from the container enters at the top
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('Rarest first')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('In order')
    // up from the top wraps to the bottom, which is how a long menu is reached from above
    await userEvent.keyboard('{ArrowUp}{ArrowUp}')
    expect(active()).toBe('Remove')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('Rarest first')
  })

  /** Up from the container is the LAST row, not the second-to-last the wrap arithmetic would give. */
  it('enters at the bottom when the first move is upward', async () => {
    await mount()
    await userEvent.keyboard('{ArrowUp}')
    expect(active()).toBe('Remove')
  })

  it('tells the user how to reach the browser menu instead', async () => {
    await mount()
    const note = menu().querySelector('.passthrough')?.textContent ?? ''
    expect(note).toMatch(/right-click/i)
    expect(note).toMatch(/shift/i)
    expect(note).toMatch(/ctrl/i)
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
    // container -> Rarest first -> In order -> Use the DHT
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
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

  /** It is placed against viewport coordinates, so it is wrong the instant the page scrolls. */
  it('closes rather than following the page when something scrolls', async () => {
    const { onClose } = await mount()
    window.dispatchEvent(new Event('scroll'))
    expect(onClose).toHaveBeenCalled()
  })

  /**
   * Its OWN scrolling is not the page moving. The list scrolls internally once it is long, and
   * closing on that makes the bottom of a long menu unreachable.
   *
   * This is the same hazard that made the menu invisible on first release: focusing the container
   * scrolled it into view, that scroll reached this handler, and the menu shut itself in the same
   * frame it opened. Every focus() in the component now passes `preventScroll`.
   */
  it('survives scrolling inside itself', async () => {
    const { onClose } = await mount()
    menu().dispatchEvent(new Event('scroll', { bubbles: false }))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not shut itself while arrowing through a list longer than it is', async () => {
    const long: OptionGroup[] = [{
      id: 'many',
      label: 'Many',
      items: Array.from({ length: 40 }, (_, i) => ({
        kind: 'action' as const, id: `i${i}`, label: `Item ${i}`, hint: 'h', run: vi.fn(),
      })),
    }]
    const { onClose } = await mount({ g: long })
    for (let i = 0; i < 40; i++) await userEvent.keyboard('{ArrowDown}')
    expect(onClose).not.toHaveBeenCalled()
    // and it actually walked, rather than never leaving the container
    expect(active()).toBeDefined()
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
