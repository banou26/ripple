import type { OptionGroup } from '../torrent/torrent-options'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'

import { TorrentOptionsDialog } from './torrent-options-dialog'

/**
 * The options dialog, which is the same option list as the context menu with room to explain it.
 *
 * The behaviour that separates it from the menu is that it STAYS OPEN when a setting is changed.
 * A menu closing on the first choice is right for a menu and wrong here: this is the surface for
 * someone changing three things, and closing after each one would mean opening it three times.
 * Actions still close it, because an action is a thing that happens rather than a state.
 *
 * Focus starting on Done rather than on the first option is the other deliberate one. `showModal`
 * would otherwise focus whatever option comes first, which arms Enter to change a setting the user
 * has not read yet.
 */

const groups = (): OptionGroup[] => [
  {
    id: 'order',
    label: 'Piece order',
    items: [
      { kind: 'radio', id: 'rarest', group: 'order', label: 'Rarest first', hint: 'Fewest peers have it', selected: true, apply: vi.fn() },
      { kind: 'radio', id: 'seq', group: 'order', label: 'In order', hint: 'Watch while it arrives', selected: false, apply: vi.fn() },
    ],
  },
  {
    id: 'peers',
    label: 'Finding peers',
    items: [
      { kind: 'toggle', id: 'dht', label: 'Use the DHT', hint: 'The global peer directory', checked: true, apply: vi.fn() },
      { kind: 'toggle', id: 'off', label: 'Super seeding', hint: 'For rare torrents', checked: false, disabled: 'Only once finished.', apply: vi.fn() },
      { kind: 'action', id: 'wipe', label: 'Remove', hint: 'Forgets the torrent', danger: true, run: vi.fn() },
    ],
  },
]

const mount = async (g: OptionGroup[] = groups()) => {
  const onClose = vi.fn()
  render(<TorrentOptionsDialog title="Big Buck Bunny" groups={g} onClose={onClose}/>)
  // showModal and the focus move both live in an effect, so nothing here is true on the first turn
  await expect.poll(() => document.querySelector('dialog[open]')).not.toBeNull()
  return { onClose, g }
}

const byLabel = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.opt')]
    .find((el) => el.querySelector('.label')?.textContent === label)!

describe('the torrent options dialog', () => {
  it('names the torrent it is about', async () => {
    await mount()
    const dialog = document.querySelector('dialog')!
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Big Buck Bunny')
  })

  it('explains every option rather than only naming it', async () => {
    await mount()
    expect(byLabel('Use the DHT').querySelector('.hint')?.textContent).toBe('The global peer directory')
    expect(byLabel('Rarest first').querySelector('.hint')?.textContent).toBe('Fewest peers have it')
  })

  /** A disabled option's reason replaces its hint: "why can't I use this" is the live question. */
  it('says why a disabled option cannot be used, in place of its description', async () => {
    await mount()
    const off = byLabel('Super seeding')
    expect(off.disabled).toBe(true)
    expect(off.querySelector('.hint')?.textContent).toBe('Only once finished.')
  })

  it('exposes toggles as switches and choices as radios', async () => {
    await mount()
    expect(byLabel('Use the DHT').getAttribute('role')).toBe('switch')
    expect(byLabel('Use the DHT').getAttribute('aria-checked')).toBe('true')
    expect(byLabel('Rarest first').getAttribute('role')).toBe('radio')
    expect(byLabel('Rarest first').getAttribute('aria-checked')).toBe('true')
    expect(byLabel('In order').getAttribute('aria-checked')).toBe('false')
  })

  it('starts with focus on Done, not on the first setting', async () => {
    await mount()
    await expect.poll(() => document.activeElement?.textContent).toBe('Done')
  })

  /** The behaviour that makes this a different surface from the menu, rather than a wider one. */
  it('stays open after a setting is changed', async () => {
    const { onClose, g } = await mount()
    byLabel('Use the DHT').click()
    const dht = g[1]!.items[0]!
    if (dht.kind !== 'toggle') throw new Error('not a toggle')
    expect(dht.apply).toHaveBeenCalledWith(false)
    expect(onClose).not.toHaveBeenCalled()

    byLabel('In order').click()
    const seq = g[0]!.items[1]!
    if (seq.kind !== 'radio') throw new Error('not a radio')
    expect(seq.apply).toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  /** An action is something that happens, so leaving the dialog up over it would be strange. */
  it('closes after an action is run', async () => {
    const { onClose, g } = await mount()
    byLabel('Remove').click()
    const wipe = g[1]!.items[2]!
    if (wipe.kind !== 'action') throw new Error('not an action')
    expect(wipe.run).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('does nothing when a disabled option is clicked', async () => {
    const { g } = await mount()
    byLabel('Super seeding').click()
    const off = g[1]!.items[1]!
    if (off.kind !== 'toggle') throw new Error('not a toggle')
    expect(off.apply).not.toHaveBeenCalled()
  })

  it('closes on Escape', async () => {
    const { onClose } = await mount()
    await userEvent.keyboard('{Escape}')
    await expect.poll(() => onClose.mock.calls.length).toBeGreaterThan(0)
  })

  it('closes on Done', async () => {
    const { onClose } = await mount()
    ;[...document.querySelectorAll<HTMLButtonElement>('footer button')]
      .find((b) => b.textContent === 'Done')!
      .click()
    expect(onClose).toHaveBeenCalled()
  })
})
