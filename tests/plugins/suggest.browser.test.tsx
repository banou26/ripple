// `suggest`: no switch needed, opens Ripple's add dialog naming the plugin, settles on confirm/cancel/already/unmount,
// collapses duplicate hashes in the queue, enforces gesture window and 10-per-window cap, and stacks over PluginPage.
import type { Button, ClickContext } from '../../src/plugins/contract'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'
import { entry, snapshot } from './engine-double'
import { fkn } from './packages-double'

const SINTEL_URL = new URL('../../src/assets/sintel.torrent', import.meta.url)

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
vi.mock('../../src/torrent/use-thumbnails', () => ({ useThumbnail: () => null, useThumbnailGeneration: () => {} }))

const { default: Home } = await import('../../src/router/home')
const { SUGGEST_LIMIT, closePage, removePlugin } = await import('../../src/plugins/host')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { answer } = await import('../../src/plugins/switches')

const HELD = 'a'.repeat(40)
const M1 = '1'.repeat(40)
const M2 = '2'.repeat(40)
const magnet = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name)}`
const refusal = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message)

let seq = 0
const plugin = async (buttons: () => Button[] = () => [{ id: 'go', place: 'header', label: 'Find' }]) => {
  const n = ++seq
  const uri = `npm:suggest-plugin-${n}`
  const name = `Finder ${n}`
  const clicks: [string, ClickContext][] = []
  fkn.plugins.set(uri, {
    name,
    version: '1.0.0',
    payload: { asks: [], buttons, click: (id: string, ctx: ClickContext) => { clicks.push([id, ctx]) } },
  })
  fkn.installed.push({ uri, name, version: '1.0.0', installedAt: n })
  await answer(uri, {})
  return { uri, name, clicks }
}

const addDialog = () => document.querySelector<HTMLElement>('[aria-labelledby="add-torrent-title"]')
const buttonNamed = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)

const feedMetadata = (hash: string, handle: number, name: string) => {
  const list = [entry(HELD), entry(hash, { name, ephemeral: true })]
  const live = [
    snapshot({ handle: 1, magnet: magnet(HELD, 'Held') }),
    { ...snapshot({ handle, magnet: magnet(hash, name) }), files: { files: [{ path: `${name}.mkv`, size: 1024, offset: 0, pad: false }] } },
  ]
  engine.double.say({ type: 'list', list })
  engine.double.say({ type: 'state', torrents: live })
}

beforeEach(() => {
  fkn.reset()
  memory.store.clear()
  closePage()
  engine.double.running = true
  engine.double.posted.length = 0
  engine.double.start([entry(HELD)], [{ handle: 1, magnet: magnet(HELD, 'Held') }])
})

afterEach(async () => {
  closePage()
  for (const uri of [...fkn.plugins.keys()]) await removePlugin(uri)
})

describe('suggest', () => {
  it('needs no switch, names the plugin in the add dialog without "Don\'t ask again", and settles added / declined / already / failed', async () => {
    const made = await plugin()
    await render(<IntlRoot><MemoryRouter><Home/><PluginHost/></MemoryRouter></IntlRoot>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    const ripple = await fkn.rippleOf(made.uri)

    // outside gesture window -> not-allowed
    expect(await refusal(ripple.suggest({ magnet: magnet(M1, 'Film 1') }))).toBe('not-allowed')

    // click opens gesture window
    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(made.clicks).toHaveLength(1))

    // already in library -> already, no dialog
    expect(await ripple.suggest({ magnet: magnet(HELD, 'Held') })).toEqual({ infoHash: HELD, outcome: 'already' })
    expect(addDialog()).toBeNull()

    // unreadable -> failed
    expect(await ripple.suggest({ magnet: 'not-a-magnet' })).toEqual({ infoHash: null, outcome: 'failed' })

    // magnet confirmed -> added
    const p1 = ripple.suggest({ magnet: magnet(M1, 'Film 1') })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    expect(addDialog()!.textContent).toContain(`Sent here by ${made.name}`)
    expect(addDialog()!.textContent).not.toContain('Do not ask again')
    feedMetadata(M1, 2, 'Film 1')
    await vi.waitFor(() => expect(buttonNamed(addDialog()!, 'Add torrent')?.disabled).toBe(false))
    await userEvent.click(buttonNamed(addDialog()!, 'Add torrent')!)
    expect(await p1).toEqual({ infoHash: M1, outcome: 'added' })

    // .torrent cancelled -> declined
    const bytes = new Uint8Array(await (await fetch(SINTEL_URL)).arrayBuffer())
    const p2 = ripple.suggest({ torrentFile: bytes })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    expect(addDialog()!.textContent).toContain(`Sent here by ${made.name}`)
    await userEvent.click(buttonNamed(addDialog()!, 'Cancel')!)
    expect((await p2).outcome).toBe('declined')

    // .torrent confirmed -> added
    const p3 = ripple.suggest({ torrentFile: bytes })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    await vi.waitFor(() => expect(buttonNamed(addDialog()!, 'Add torrent')?.disabled).toBe(false))
    await userEvent.click(buttonNamed(addDialog()!, 'Add torrent')!)
    expect((await p3).outcome).toBe('added')
    expect(engine.double.posted.some((m) => m.type === 'add-torrent-file')).toBe(true)
  })

  it('settles duplicate queued copies with the same outcome, queues concurrent calls, and declines all on library unmount', async () => {
    const made = await plugin()
    const view = await render(<IntlRoot><MemoryRouter><Home/><PluginHost/></MemoryRouter></IntlRoot>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    const ripple = await fkn.rippleOf(made.uri)
    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(made.clicks).toHaveLength(1))

    // two copies of M1 + one M2 queued concurrently in the same tick
    const a1 = ripple.suggest({ magnet: magnet(M1, 'First') })
    const a2 = ripple.suggest({ magnet: magnet(M1, 'First dup') })
    const b1 = ripple.suggest({ magnet: magnet(M2, 'Second') })

    await vi.waitFor(() => expect(addDialog()?.textContent).toContain('First'))
    await userEvent.click(buttonNamed(addDialog()!, 'Cancel')!)
    expect(await Promise.all([a1, a2])).toEqual([
      { infoHash: M1, outcome: 'declined' },
      { infoHash: M1, outcome: 'declined' },
    ])

    // M2 is now showing; unmounting Home settles M2 as declined, and further suggests fail unavailable
    await vi.waitFor(() => expect(addDialog()?.textContent).toContain('Second'))
    await view.unmount()
    expect(await b1).toEqual({ infoHash: M2, outcome: 'declined' })
    expect(await refusal(ripple.suggest({ magnet: magnet(M1, 'After close') }))).toBe('unavailable')
  })

  it('caps suggest at 10 per gesture window and resets on the next click; stacks AddTorrentDialog above PluginPage', async () => {
    const made = await plugin(() => [{ id: 'open', place: 'header', label: 'Search', page: { id: 'search' } }])
    await render(<IntlRoot><MemoryRouter><Home/><PluginHost/></MemoryRouter></IntlRoot>)
    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())

    // open popup page via button.page
    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(fkn.mountedOf(made.uri)).toBeDefined())
    const pageRipple = await fkn.mountedOf(made.uri)!.ripple

    // suggest from inside popup page opens AddTorrentDialog ABOVE PluginPage (two Modals!)
    const bytes = new Uint8Array(await (await fetch(SINTEL_URL)).arrayBuffer())
    const fromPage = pageRipple.suggest({ torrentFile: bytes })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]')
    expect(dialogs).toHaveLength(2)
    expect(dialogs[0]!.inert).toBe(true)
    expect(dialogs[1]!.inert).toBe(false)
    await userEvent.click(buttonNamed(addDialog()!, 'Cancel')!)
    expect((await fromPage).outcome).toBe('declined')
    await vi.waitFor(() => expect(addDialog()).toBeNull())
    expect(dialogs[0]!.inert).toBe(false)

    // 9 more suggests (total 10 in this window) succeed; 11th rejects not-allowed
    for (let i = 1; i < SUGGEST_LIMIT; i++) {
      expect((await pageRipple.suggest({ magnet: magnet(HELD, 'Held') })).outcome).toBe('already')
    }
    expect(await refusal(pageRipple.suggest({ magnet: magnet(HELD, 'Held') }))).toBe('not-allowed')

    // closing and clicking again starts a fresh gesture window
    closePage()
    await vi.waitFor(() => expect(document.querySelector('.plugin-page')).toBeNull())
    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(fkn.mountedOf(made.uri)?.unmounted).toBe(false))
    const fresh = await fkn.mountedOf(made.uri)!.ripple
    expect((await fresh.suggest({ magnet: magnet(HELD, 'Held') })).outcome).toBe('already')
  })

  it('cleans up pending ephemeral magnets on cancel and on unmount, fails corrupt .torrent, and handles queued already', async () => {
    const p = await plugin()
    const view = await render(
      <IntlRoot>
        <MemoryRouter>
          <Home/>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )

    await vi.waitFor(() => expect(document.querySelector('header .plugin')).not.toBeNull())
    await userEvent.click(document.querySelector('header .plugin')!)
    await vi.waitFor(() => expect(fkn.opened.some((o) => o.uri === p.uri)).toBe(true))
    const remote = await fkn.rippleOf(p.uri)

    // 1. Corrupt .torrent returns failed rather than sticking AddTorrentDialog
    expect(await remote.suggest({ torrentFile: new Uint8Array([1, 2, 3]) })).toEqual({ infoHash: null, outcome: 'failed' })

    // 2. Cancel BEFORE first list broadcast still removes the pending ephemeral magnet
    const M3 = '3'.repeat(40)
    const M4 = '4'.repeat(40)
    const p3 = remote.suggest({ magnet: magnet(M3, 'FastCancel') })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    await userEvent.click(buttonNamed(addDialog()!, 'Cancel')!)
    expect(await p3).toEqual({ infoHash: M3, outcome: 'declined' })
    expect(engine.double.posted.some((m) => m.type === 'remove-missing' && m.infoHash === M3)).toBe(true)

    // 3. Unmounting Home with a pending suggested magnet also removes its ephemeral entry and declines queued items
    const p4 = remote.suggest({ magnet: magnet(M4, 'UnmountDrop') })
    const p5 = remote.suggest({ magnet: magnet('5'.repeat(40), 'QueuedDrop') })
    await vi.waitFor(() => expect(addDialog()).not.toBeNull())
    await view.unmount()
    expect(await p4).toEqual({ infoHash: M4, outcome: 'declined' })
    expect(await p5).toEqual({ infoHash: '5'.repeat(40), outcome: 'declined' })
    expect(engine.double.posted.some((m) => m.type === 'remove-missing' && m.infoHash === M4)).toBe(true)
  })
})
