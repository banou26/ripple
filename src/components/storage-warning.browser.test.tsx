import type { PersistState } from '../torrent/storage-permission'
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

/**
 * The default is the state with NOTHING to ask for, so every test written before the persistence
 * offer existed still measures the folder route: `button()` below reads the first button in the
 * notice, and an ask offered by default would silently become the button all of those assert on.
 */
const settled = (over: Partial<PersistState> = {}): PersistState => ({
  persisted: true,
  permission: 'granted',
  attempted: false,
  granted: null,
  ...over,
})

const mount = (
  relief: StorageRelief,
  onAct = () => {},
  persist: PersistState = settled(),
  onAskPersist = () => {},
) =>
  render(
    <StorageWarning
      storage={usage({ persisted: persist.persisted })}
      relief={relief}
      onAct={onAct}
      persist={persist}
      onAskPersist={onAskPersist}
    />,
  )

const button = (c: HTMLElement) => c.querySelector('button')

const labels = (c: HTMLElement) => [...c.querySelectorAll('button')].map((b) => b.textContent)

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
    const persisted = await mount({ kind: 'choose' }, () => {}, settled())
    const best = await mount({ kind: 'choose' }, () => {}, settled({ persisted: false, permission: 'denied' }))
    expect(persisted.container.textContent).not.toContain('best effort')
    expect(best.container.textContent).toContain('best effort')
  })
})

/**
 * The second route, added 2026-09-01: asking the browser for persistent storage.
 *
 * It is not a smaller version of the folder route, it is a different one. On Firefox granting the
 * doorhanger moved the reported quota from 12 GB to 3.97 TB on an 8.03 TB device, which is the only
 * thing anywhere in Ripple that moves the LIMIT rather than moving bytes out from under it. On
 * Chromium the identical call is refused with no prompt shown to anybody.
 *
 * That split is what these pin. Three failures are worth catching and none of them would throw:
 * offering a button that provably cannot do anything, letting the two routes read as one action, and
 * spending two prompts on one question.
 */
const asking = (over: Partial<PersistState> = {}): PersistState => ({
  persisted: false,
  permission: 'prompt',
  attempted: false,
  granted: null,
  ...over,
})

describe('the persistent-storage offer inside that notice', () => {
  it('offers the ask first and the folder second, as two plainly different actions', async () => {
    const { container } = await mount({ kind: 'choose' }, () => {}, asking())
    // order matters: the ask is the only route that can raise the number in the sentence above it
    expect(labels(container)).toEqual([
      'Ask for more room',
      'Choose a folder and move finished downloads there',
    ])
  })

  /**
   * The Chromium path. persist() resolves false without a prompt ever being raised, so the sentence
   * has to say the browser answered rather than read as though the person refused, and the button
   * must not come back to be pressed into the same refusal.
   */
  it('says what the browser answered, in place of the ask, once it has answered', async () => {
    const { container } = await mount(
      { kind: 'choose' },
      () => {},
      asking({ attempted: true, granted: false }),
    )
    expect(container.textContent).toContain('the browser answered no by itself')
    expect(labels(container)).toEqual(['Choose a folder and move finished downloads there'])
  })

  /** already persistent, and denied: pressing anything here would be a control with no effect */
  it('offers nothing to press where there is nothing to ask for', async () => {
    const persisted = await mount({ kind: 'choose' }, () => {}, settled({ persisted: true }))
    const denied = await mount({ kind: 'choose' }, () => {}, asking({ permission: 'denied' }))
    for (const { container } of [persisted, denied]) {
      expect(labels(container)).toEqual(['Choose a folder and move finished downloads there'])
      expect(container.textContent).not.toContain('Ask for more room')
    }
  })

  /** no number is promised, because the same press is worth nothing at all on Chromium */
  it('promises no amount of room', async () => {
    const { container } = await mount({ kind: 'choose' }, () => {}, asking())
    expect(container.textContent).toContain('Your browser')
    expect(container.textContent).not.toMatch(/\bTB\b/)
  })

  it('calls back exactly once when the ask is pressed', async () => {
    const onAskPersist = vi.fn()
    const screen = await mount({ kind: 'choose' }, () => {}, asking(), onAskPersist)
    await screen.getByRole('button', { name: 'Ask for more room' }).click()
    expect(onAskPersist).toHaveBeenCalledTimes(1)
  })

  /**
   * Pressed twice before anything has come back. On Firefox a second persist() is a second
   * doorhanger for a question already on screen, so the latch has to hold within the tick rather
   * than waiting for the measurement to arrive and change the copy.
   *
   * Clicked through the element rather than through the locator on purpose: a locator click waits
   * for the control to be actionable, and the whole point of the second press is that it finds one
   * that is not.
   *
   * MEASURED, and it is why the latch is a ref and not only state: with two clicks in one tick the
   * second still reaches the handler, because React has not re-rendered the button as disabled by
   * the time it arrives. The disable is polled below rather than read straight for the same reason.
   */
  it('asks once however fast the ask is pressed twice', async () => {
    const onAskPersist = vi.fn()
    const { container } = await mount({ kind: 'choose' }, () => {}, asking(), onAskPersist)
    const ask = container.querySelector('button') as HTMLButtonElement
    expect(ask.textContent).toBe('Ask for more room')
    ask.click()
    ask.click()
    expect(onAskPersist).toHaveBeenCalledTimes(1)
    await expect.poll(() => ask.disabled).toBe(true)
  })
})
