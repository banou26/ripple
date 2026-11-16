import type { NavigateFunction } from 'react-router-dom'

import type { Persisted, TorrentClient, TorrentSnapshot } from '../../src/torrent/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter, useNavigate } from 'react-router-dom'

/** The runner puts every test in a frame, which the hook reads as fkn.app's. */
const framed = { value: false }
vi.mock('../../src/utils/framed', () => ({ isFramed: () => framed.value }))

/** The client this page made, which none has until a page asks for one. */
const running = { client: null as TorrentClient | null }
vi.mock('../../src/torrent/client', async (actual) => ({ ...await actual<object>(), runningTorrentClient: () => running.client }))

const { useLeavePrompt } = await import('../../src/router/leave-prompt')

/** A client that replays what it last said to each new listener, as the real one does. */
const engine = ({ owns = true }: { owns?: boolean } = {}) => {
  const heard = { state: new Set<(s: TorrentSnapshot[]) => void>(), list: new Set<(l: Persisted[]) => void>(), owns: new Set<(o: boolean) => void>() }
  const last = { state: null as TorrentSnapshot[] | null, list: null as Persisted[] | null, owns }
  const on = <T, >(set: Set<(value: T) => void>, latest: () => T | null) => (cb: (value: T) => void) => {
    set.add(cb)
    const value = latest()
    if (value !== null) cb(value)
    return () => { set.delete(cb) }
  }
  const client = {
    onState: on(heard.state, () => last.state),
    onList: on(heard.list, () => last.list),
    onOwnership: on(heard.owns, () => last.owns),
  } as unknown as TorrentClient
  return {
    client,
    state: (...rows: TorrentSnapshot[]) => { last.state = rows; for (const cb of heard.state) cb(rows) },
    list: (...entries: Persisted[]) => { last.list = entries; for (const cb of heard.list) cb(entries) },
    owns: (owned: boolean) => { last.owns = owned; for (const cb of heard.owns) cb(owned) },
  }
}

const hash = (name: string) => name.repeat(40)
// libtorrent's state_t: 1 checking, 3 downloading, 5 seeding
const snap = (name: string, status: object | null = {}, over: object = {}): TorrentSnapshot => ({
  handle: 1, magnet: `magnet:?xt=urn:btih:${hash(name)}`, files: null, status: status && { state: 3, paused: false, autoManaged: true, ...status },
  bitfield: null, recovery: null, userPaused: false, displayDownloadRate: 0, ...over,
} as unknown as TorrentSnapshot)
const entry = (name: string, over: Partial<Persisted> = {}): Persisted => ({ infoHash: hash(name), magnet: `magnet:?xt=urn:btih:${hash(name)}`, name, ...over } as Persisted)

const go = { to: null as NavigateFunction | null }
const Probe = () => {
  useLeavePrompt()
  go.to = useNavigate()
  return null
}
const page = () => render(<MemoryRouter><Probe/></MemoryRouter>)

let add: ReturnType<typeof vi.spyOn>
let remove: ReturnType<typeof vi.spyOn>

/** The beforeunload listeners the hook holds now. */
const holding = () => {
  const of = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.filter(([type]) => type === 'beforeunload').map(([, listener]) => listener)
  const removed = of(remove)
  return of(add).filter((listener) => !removed.includes(listener)) as ((event: Event) => void)[]
}

beforeEach(() => {
  framed.value = false
  running.client = null
  add = vi.spyOn(window, 'addEventListener')
  remove = vi.spyOn(window, 'removeEventListener')
})

afterEach(() => { vi.restoreAllMocks() })

describe('the prompt before the tab closes', () => {
  it('asks while a torrent the person added downloads, and lets go of its listener once none does', async () => {
    const tab = engine()
    running.client = tab.client
    tab.state(snap('a'), snap('b', { state: 5 }))
    await page()
    await expect.poll(holding).toHaveLength(1)
    const leaving = new Event('beforeunload', { cancelable: true })
    holding()[0]!(leaving)
    expect(leaving.defaultPrevented, 'the browser is asked to confirm').toBe(true)

    tab.state(snap('a', { state: 5 }))
    await expect.poll(holding).toHaveLength(0)
    tab.state(snap('a', {}, { recovery: { reason: 'stalled', attempt: 1, retryAt: 0 } }))
    await expect.poll(holding, { message: 'a download waiting out a retry still downloads' }).toHaveLength(1)
    tab.state(snap('a', { state: 5 }))
    await expect.poll(holding).toHaveLength(0)
    tab.state(snap('a', null))
    await expect.poll(holding, { message: 'a magnet still finding its files downloads' }).toHaveLength(1)
  })

  it('does not ask for seeding, stopped or checking torrents', async () => {
    const tab = engine()
    running.client = tab.client
    tab.state(snap('a', { state: 5 }), snap('b', { state: 5, paused: true }), snap('c', { paused: true }, { userPaused: true }), snap('d', { paused: true }), snap('e', { state: 1 }))
    await page()
    expect(holding()).toHaveLength(0)
  })

  it('does not ask for a temporary torrent, which the person did not add', async () => {
    const tab = engine()
    running.client = tab.client
    tab.list(entry('a', { ephemeral: true }), entry('b'))
    tab.state(snap('a'), snap('b', { state: 5 }))
    await page()
    tab.owns(true)
    expect(holding()).toHaveLength(0)
    tab.list(entry('a'), entry('b'))
    await expect.poll(holding, { message: 'once added for good, it counts' }).toHaveLength(1)
  })

  it('asks only in the tab that runs the engine, whose closing stops it', async () => {
    const tab = engine({ owns: false })
    running.client = tab.client
    tab.state(snap('a'))
    await page()
    expect(holding()).toHaveLength(0)
    tab.owns(true)
    await expect.poll(holding, { message: 'this tab took the engine over' }).toHaveLength(1)
  })

  it('holds on whichever page made the client, once one has', async () => {
    const tab = engine()
    tab.state(snap('a'))
    await page()
    expect(holding(), 'no page asked for the engine yet').toHaveLength(0)
    running.client = tab.client
    go.to!('/watch')
    await expect.poll(holding).toHaveLength(1)
  })

  it('does not ask inside a frame', async () => {
    framed.value = true
    const tab = engine()
    running.client = tab.client
    tab.state(snap('a'))
    await page()
    expect(holding()).toHaveLength(0)
  })
})
