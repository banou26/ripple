import type { StorageRelief } from '../torrent/storage-relief'
import type { StorageUsage } from '../torrent/use-storage-usage'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { StorageWarning } from './storage-warning'

/**
 * The notice a person actually reads when their downloads stop.
 *
 * storage-relief.test.ts already pins WHICH relief each situation resolves to. This pins the other
 * half, which is the half that would be wrong in a way no unit test could see: that the chosen
 * relief reaches the screen as a button, that the button is absent in the two states where there is
 * nothing to press, and that pressing it calls back exactly once.
 *
 * Deliberately mounted without home's stylesheet. `.storage-warning` lives there and is shared with
 * another notice, so this component carries no styles; what is being measured is which control
 * exists, not what it looks like.
 */

const usage = (over: Partial<StorageUsage> = {}): StorageUsage => ({
  usedBytes: 1_780_000_000,
  limitBytes: 2_150_000_000,
  persisted: true,
  ...over,
})

const mount = (relief: StorageRelief, onAct = () => {}) =>
  render(<StorageWarning storage={usage()} relief={relief} onAct={onAct}/>)

const button = (c: HTMLElement) => c.querySelector('button')

describe('the running-out-of-room notice', () => {
  it('always reports the figures, whatever it can offer', async () => {
    const { container } = await mount({ kind: 'none' })
    expect(container.textContent).toContain('1.78 GB')
    expect(container.textContent).toContain('2.15 GB')
  })

  /**
   * The case this was written for. A folder is live and the mirror is copying into it, so usage is
   * not falling, and nothing on screen said that copying is not moving.
   */
  it('offers to move finished downloads when a folder is only being copied to', async () => {
    const { container } = await mount({ kind: 'move', folderName: 'downloads' })
    expect(button(container)?.textContent).toBe('Move finished downloads to downloads')
    expect(container.textContent).toContain('copying')
  })

  it('offers to choose a folder when there is none, and says it will move things there', async () => {
    const { container } = await mount({ kind: 'choose' })
    // the label has to carry BOTH halves: choosing a folder alone would only add a second copy
    expect(button(container)?.textContent).toBe('Choose a folder and move finished downloads there')
  })

  it('asks for a lapsed folder back rather than offering a move that cannot happen', async () => {
    const { container } = await mount({ kind: 'allow', folderName: 'downloads' })
    expect(button(container)?.textContent).toBe('Allow downloads')
  })

  /**
   * The two dead ends. A button here would be a control that provably does nothing: `settled` is
   * already moving files out, and `none` is a browser with no directory picker at all.
   */
  it('shows no button where there is nothing to press', async () => {
    expect(button((await mount({ kind: 'settled', folderName: 'd' })).container)).toBeNull()
    expect(button((await mount({ kind: 'none' })).container)).toBeNull()
  })

  it('keeps the old advice on a browser that cannot grant a folder', async () => {
    const { container } = await mount({ kind: 'none' })
    expect(container.textContent).toContain('Removing a torrent frees its files')
  })

  it('calls back exactly once when the action is pressed', async () => {
    const onAct = vi.fn()
    const screen = await mount({ kind: 'move', folderName: 'downloads' }, onAct)
    await screen.getByRole('button', { name: 'Move finished downloads to downloads' }).click()
    expect(onAct).toHaveBeenCalledTimes(1)
  })

  /** best-effort storage can be cleared out from under the user, and only then is that said */
  it('mentions eviction only when the origin is not persisted', async () => {
    const persisted = await render(<StorageWarning storage={usage({ persisted: true })} relief={{ kind: 'choose' }} onAct={() => {}}/>)
    const best = await render(<StorageWarning storage={usage({ persisted: false })} relief={{ kind: 'choose' }} onAct={() => {}}/>)
    expect(persisted.container.textContent).not.toContain('best effort')
    expect(best.container.textContent).toContain('best effort')
  })
})
