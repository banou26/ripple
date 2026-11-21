// Popup pages: packages.mount in Ripple's Modal, sandbox & no delegated allow, remote.page, same switches, sizes and
// phone sheet, 30 s mount timeout, every close path, gesture window, focus guards, and two stacked Modals.
import type { Button, ClickContext, PageSize, Switch } from '../../src/plugins/contract'

import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page as browserPage, userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { Modal } from '../../src/components/modal'
import { IntlRoot } from '../../src/i18n'
import { entry } from './engine-double'
import { fkn } from './packages-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const engine = vi.hoisted(() => ({ double: undefined as unknown as import('./engine-double').EngineDouble }))

vi.mock('@fkn/lib/packages', () => import('./packages-double'))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => false }))
vi.mock('idb-keyval', async () => {
  const made = (await import('./engine-double')).memoryStore()
  memory.store = made.store
  return made.module
})
vi.mock('../../src/torrent/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/torrent/client')>()
  engine.double = (await import('./engine-double')).engineDouble(real)
  return { ...real, getTorrentClient: () => engine.double.client, runningTorrentClient: () => (engine.double.running ? engine.double.client : null) }
})

const { GESTURE_MS, MOUNT_MS, closePage, removePlugin } = await import('../../src/plugins/host')
const { HeaderButtons } = await import('../../src/plugins/plugin-buttons')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { PAGE_SANDBOX } = await import('../../src/plugins/plugin-page')
const { answer } = await import('../../src/plugins/switches')

const A = 'a'.repeat(40)
let seq = 0

type Fake = { uri: string, name: string, clicks: [string, ClickContext][] }
const plugin = async ({
  asks = [],
  buttons,
  answers = {},
  click,
  mountHangs,
  mountFails,
  pageHtml,
}: {
  asks?: Switch[]
  buttons?: () => Button[]
  answers?: Partial<Record<Switch, boolean>>
  click?: (id: string, context: ClickContext) => void | Promise<void>
  mountHangs?: boolean
  mountFails?: boolean
  pageHtml?: string
} = {}): Promise<Fake> => {
  const n = ++seq
  const made: Fake = { uri: `npm:page-plugin-${n}`, name: `Page plugin ${n}`, clicks: [] }
  fkn.plugins.set(made.uri, {
    name: made.name,
    version: '1.0.0',
    mountHangs,
    mountFails,
    pageHtml,
    payload: {
      asks,
      ...(buttons && { buttons }),
      click: (id: string, context: ClickContext) => { made.clicks.push([id, context]); return click?.(id, context) },
    },
  })
  fkn.installed.push({ uri: made.uri, name: made.name, version: '1.0.0', installedAt: n })
  await answer(made.uri, answers)
  return made
}

const withHost = (children: React.ReactNode) => render(<IntlRoot><MemoryRouter>{children}<PluginHost/></MemoryRouter></IntlRoot>)
const dialogCard = () => document.querySelector<HTMLElement>('.plugin-page')
const refusal = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message)

beforeEach(async () => {
  fkn.reset()
  memory.store.clear()
  closePage()
  engine.double.running = true
  engine.double.start([entry(A)], [{ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }])
  await browserPage.viewport(1280, 900)
})

afterEach(async () => {
  vi.useRealTimers()
  closePage()
  for (const uri of [...fkn.plugins.keys()]) await removePlugin(uri)
  await browserPage.viewport(1280, 900)
})

describe('popup pages', () => {
  it('mounts with exact sandbox, no allow attribute, remote.page set on page only, and enforces switches', async () => {
    const made = await plugin({
      asks: ['read'],
      answers: { read: false },
      buttons: () => [{ id: 'open', place: 'header', label: 'Search', page: { id: 'search', size: 'medium' } }],
    })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    const bgRipple = await fkn.rippleOf(made.uri)
    expect(bgRipple.page).toBeNull()

    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(fkn.mountedOf(made.uri)).toBeDefined())
    const mounted = fkn.mountedOf(made.uri)!
    expect(mounted.protocol).toBe('ripple-plugin@1')
    expect(mounted.sandbox).toBe(PAGE_SANDBOX)
    expect(mounted.sandbox).not.toContain('allow-top-navigation')
    expect(mounted.allow).toBeNull()
    const pageRipple = await mounted.ripple
    expect(pageRipple.page).toEqual({ id: 'search', context: {} })
    // switches apply on the mounted page connection too
    expect(await refusal(pageRipple.torrents())).toBe('not-allowed')
    await answer(made.uri, { read: true })
    expect((await pageRipple.torrents()).map((t) => t.infoHash)).toEqual([A])
  })

  it('sizes small (480x360), medium (760x560), large (1100x800), viewport cap, and <600px full-screen 100dvh sheet', async () => {
    const sizes: [PageSize, number, number][] = [['small', 480, 360], ['medium', 760, 560], ['large', 1100, 800]]
    const made = await plugin({ buttons: () => [{ id: 'go', place: 'header', label: 'Go' }] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    const ripple = await fkn.rippleOf(made.uri)

    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(made.clicks).toHaveLength(1))

    for (const [size, w, h] of sizes) {
      await ripple.ui.open({ id: size, size })
      await vi.waitFor(() => expect(dialogCard()?.getAttribute('data-size')).toBe(size))
      const box = dialogCard()!.getBoundingClientRect()
      expect(Math.round(box.width)).toBe(w)
      expect(Math.round(box.height)).toBe(h)
    }

    // capped at viewport less 32x48 px when viewport is smaller than large
    await browserPage.viewport(700, 500)
    await vi.waitFor(() => expect(Math.round(dialogCard()!.getBoundingClientRect().width)).toBe(700 - 32))
    expect(Math.round(dialogCard()!.getBoundingClientRect().height)).toBe(500 - 48)

    // below 600 px wide: full-screen sheet sized in 100dvh
    await browserPage.viewport(390, 740)
    await vi.waitFor(() => expect(Math.round(dialogCard()!.getBoundingClientRect().width)).toBe(390))
    expect(Math.round(dialogCard()!.getBoundingClientRect().height)).toBe(740)
  })

  it('shows Not responding when the page frame does not load within 30 s', async () => {
    vi.useFakeTimers()
    const made = await plugin({
      mountHangs: true,
      buttons: () => [{ id: 'go', place: 'header', label: 'Open', page: { id: 'slow' } }],
    })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    document.querySelector<HTMLButtonElement>('header .plugin')!.click()
    await vi.waitFor(() => expect(dialogCard()).not.toBeNull())
    expect(fkn.calls).toContain(`mount ${made.uri}`)
    await vi.advanceTimersByTimeAsync(MOUNT_MS + 100)
    await vi.waitFor(() => expect(dialogCard()?.querySelector('[role="alert"]')?.textContent).toBe('Not responding'))
  })

  it('closes via Close, backdrop, Escape, ui.close() (own plugin only), and background connection close', async () => {
    const one = await plugin({ buttons: () => [{ id: 'go', place: 'header', label: 'One', page: { id: 'p1' } }] })
    const two = await plugin({ buttons: () => [{ id: 'go', place: 'header', label: 'Two' }] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(document.querySelectorAll('header .plugin')).toHaveLength(2))
    const open = async () => {
      await userEvent.click(document.querySelectorAll('header .plugin')[0]!)
      await vi.waitFor(() => expect(fkn.mountedOf(one.uri)?.unmounted).toBe(false))
    }

    // 1. Close button
    await open()
    await userEvent.click(dialogCard()!.querySelector('button.close')!)
    await vi.waitFor(() => expect(dialogCard()).toBeNull())
    expect(fkn.mountedOf(one.uri)!.unmounted).toBe(true)

    // 2. Backdrop click
    await open()
    const overlay = document.querySelector<HTMLElement>('[role="dialog"]')!
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await vi.waitFor(() => expect(dialogCard()).toBeNull())

    // 3. Escape on Ripple's header
    await open()
    dialogCard()!.querySelector<HTMLButtonElement>('button.close')!.focus()
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(dialogCard()).toBeNull())

    // 4. ui.close() from own plugin closes it; another plugin's ui.close() does not
    await open()
    const otherRipple = await fkn.rippleOf(two.uri)
    await otherRipple.ui.close()
    expect(dialogCard()).not.toBeNull()
    const pageRipple = await fkn.mountedOf(one.uri)!.ripple
    await pageRipple.ui.close()
    await vi.waitFor(() => expect(dialogCard()).toBeNull())

    // 5. Background connection closing closes the mounted page and calls unmount()
    await open()
    const mounted = fkn.mountedOf(one.uri)!
    fkn.closeFrames(one.uri)
    await vi.waitFor(() => expect(dialogCard()).toBeNull())
    expect(mounted.unmounted).toBe(true)
  })

  it('allows ui.open only inside the gesture window (10 s after click or while page open), and ends on close', async () => {
    vi.useFakeTimers()
    const one = await plugin({ buttons: () => [{ id: 'go', place: 'header', label: 'One' }] })
    const two = await plugin({ buttons: () => [{ id: 'go', place: 'header', label: 'Two' }] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(document.querySelectorAll('header .plugin')).toHaveLength(2))
    const r1 = await fkn.rippleOf(one.uri)
    const r2 = await fkn.rippleOf(two.uri)

    // outside gesture window: refused
    expect(await refusal(r1.ui.open({ id: 'sneaky' }))).toBe('not-allowed')
    // invalid args: invalid
    expect(await refusal(r1.ui.open({ id: '   ' }))).toBe('invalid')
    expect(await refusal(r1.ui.open({ id: 'ok', size: 'huge' as PageSize }))).toBe('invalid')

    // click opens 10 s window
    document.querySelectorAll<HTMLButtonElement>('header .plugin')[0]!.click()
    await vi.waitFor(() => expect(one.clicks).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(GESTURE_MS - 1_000)
    await r1.ui.open({ id: 'first', context: { text: 'hello' } })
    await vi.waitFor(() => expect(fkn.mountedOf(one.uri)?.unmounted).toBe(false))
    expect((await fkn.mountedOf(one.uri)!.ripple).page).toEqual({ id: 'first', context: { text: 'hello' } })

    // while page is open, even past 10 s, same plugin may open another page, other plugin may not
    await vi.advanceTimersByTimeAsync(GESTURE_MS + 5_000)
    expect(await refusal(r2.ui.open({ id: 'hijack' }))).toBe('not-allowed')
    await r1.ui.open({ id: 'second', size: 'small' })
    await vi.waitFor(() => expect(dialogCard()?.getAttribute('data-size')).toBe('small'))

    // closing a page even immediately after a fresh click ends the gesture window so it cannot reopen in a loop
    dialogCard()!.querySelector<HTMLButtonElement>('button.close')!.click()
    await vi.waitFor(() => expect(dialogCard()).toBeNull())
    document.querySelectorAll<HTMLButtonElement>('header .plugin')[0]!.click()
    await vi.waitFor(() => expect(one.clicks).toHaveLength(2))
    await r1.ui.open({ id: 'fresh' })
    await vi.waitFor(() => expect(dialogCard()).not.toBeNull())
    dialogCard()!.querySelector<HTMLButtonElement>('button.close')!.click()
    await vi.waitFor(() => expect(dialogCard()).toBeNull())
    expect(await refusal(r1.ui.open({ id: 'loop' }))).toBe('not-allowed')

    // click without opening a page expires after GESTURE_MS
    document.querySelectorAll<HTMLButtonElement>('header .plugin')[0]!.click()
    await vi.waitFor(() => expect(one.clicks).toHaveLength(3))
    await vi.advanceTimersByTimeAsync(GESTURE_MS + 100)
    expect(await refusal(r1.ui.open({ id: 'late' }))).toBe('not-allowed')
  })

  it('traps Tab inside the card with focus guards, leaves FKN frame non-inert, and restores focus on close', async () => {
    const fknFrame = document.createElement('iframe')
    fknFrame.title = 'FKN'
    document.body.appendChild(fknFrame)
    try {
      const made = await plugin({
        pageHtml: '<!doctype html><button id="inside">Inside</button>',
        buttons: () => [{ id: 'go', place: 'header', label: 'Search', page: { id: 'search' } }],
      })
      await withHost(<header><HeaderButtons/></header>)
      await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
      const trigger = document.querySelector<HTMLButtonElement>('header .plugin')!
      trigger.focus()
      await userEvent.click(trigger)
      await vi.waitFor(() => expect(fkn.mountedOf(made.uri)).toBeDefined())
      const iframe = fkn.mountedOf(made.uri)!.iframe
      const closeBtn = dialogCard()!.querySelector<HTMLButtonElement>('button.close')!

      // initialFocus pointed at iframe; page behind is inert; FKN iframe is not inert
      expect(document.activeElement).toBe(iframe)
      expect(fknFrame.inert).toBe(false)
      expect(trigger.closest<HTMLElement>('[inert]')).not.toBeNull()

      // after-guard wraps focus from the end of the iframe back to Close
      const guards = dialogCard()!.querySelectorAll<HTMLElement>('[data-focus-guard]')
      expect(guards).toHaveLength(2)
      guards[1]!.focus()
      expect(document.activeElement).toBe(closeBtn)

      // Shift+Tab from Close wraps to iframe (never leaves modal)
      await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
      expect(document.activeElement).toBe(iframe)

      // before-guard sends focus to iframe
      guards[0]!.focus()
      expect(document.activeElement).toBe(iframe)

      // closing restores focus to trigger and removes inertness
      await userEvent.click(closeBtn)
      await vi.waitFor(() => expect(dialogCard()).toBeNull())
      expect(trigger.closest('[inert]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      fknFrame.remove()
    }
  })

  it('stacks two Modals cleanly in both close orders (upper first, and lower first)', async () => {
    const Harness = () => {
      const [lower, setLower] = useState(false)
      const [upper, setUpper] = useState(false)
      return (
        <div className="page-shell">
          <button type="button" className="open-lower" onClick={() => setLower(true)}>Open lower</button>
          <button type="button" className="drop-lower" onClick={() => setLower(false)}>Drop lower</button>
          {lower && (
            <Modal labelledBy="lower-h" onClose={() => setLower(false)}>
              <div className="lower-card">
                <h2 id="lower-h">Lower</h2>
                <button type="button" className="open-upper" onClick={() => setUpper(true)}>Open upper</button>
              </div>
            </Modal>
          )}
          {upper && (
            <Modal labelledBy="upper-h" onClose={() => setUpper(false)}>
              <div className="upper-card">
                <h2 id="upper-h">Upper</h2>
                <button type="button" className="close-upper" onClick={() => setUpper(false)}>Close upper</button>
                <button type="button" className="close-lower-under" onClick={() => setLower(false)}>Close lower underneath</button>
              </div>
            </Modal>
          )}
        </div>
      )
    }

    const view = await render(<Harness/>)
    const rootShell = view.container
    const openLower = rootShell.querySelector<HTMLButtonElement>('.open-lower')!
    openLower.focus()
    await userEvent.click(openLower)
    await vi.waitFor(() => expect(document.querySelector('.lower-card')).not.toBeNull())
    expect(rootShell.inert).toBe(true)

    // open upper modal above lower modal
    const openUpper = document.querySelector<HTMLButtonElement>('.open-upper')!
    await userEvent.click(openUpper)
    await vi.waitFor(() => expect(document.querySelector('.upper-card')).not.toBeNull())
    const [lowerOverlay, upperOverlay] = document.querySelectorAll<HTMLElement>('[role="dialog"]')
    expect(lowerOverlay!.inert).toBe(true)
    expect(upperOverlay!.inert).toBe(false)
    expect(rootShell.inert).toBe(true)

    // Order A: close upper first -> lower becomes active again, root stays inert, focus returns to lower
    await userEvent.click(document.querySelector('.close-upper')!)
    await vi.waitFor(() => expect(document.querySelector('.upper-card')).toBeNull())
    expect(lowerOverlay!.inert).toBe(false)
    expect(rootShell.inert).toBe(true)
    expect(document.activeElement).toBe(openUpper)

    // Order B: open upper again, close LOWER first underneath -> root stays inert, focus stays in upper!
    await userEvent.click(openUpper)
    await vi.waitFor(() => expect(document.querySelector('.upper-card')).not.toBeNull())
    const closeUnder = document.querySelector<HTMLButtonElement>('.close-lower-under')!
    await userEvent.click(closeUnder)
    await vi.waitFor(() => expect(document.querySelector('.lower-card')).toBeNull())
    expect(rootShell.inert).toBe(true)
    expect(document.querySelector('[role="dialog"]')!.contains(document.activeElement)).toBe(true)

    // Closing upper now un-inerts root and returns focus all the way back to openLower
    await userEvent.click(document.querySelector('.close-upper')!)
    await vi.waitFor(() => expect(document.querySelector('.upper-card')).toBeNull())
    expect(rootShell.inert).toBe(false)
    expect(document.activeElement).toBe(openLower)
  })
})
