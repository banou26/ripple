import type { Torrent } from '../../src/torrent/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { useLeavePrompt } from '../../src/router/leave-prompt'

/** The runner puts every test in a frame, which the hook reads as fkn.app's. */
const framed = { value: false }
vi.mock('../../src/utils/framed', () => ({ isFramed: () => framed.value }))

const row = (name: string, state: Torrent['state'], over: Partial<Torrent> = {}): Torrent => ({
  id: name, magnet: `magnet:?xt=urn:btih:${name}`, infoHash: name, name, size: 1, downloaded: 0, progress: 0.5,
  state, down: 0, up: 0, peers: 0, seeds: 0, eta: '-', flags: 0, queuePosition: -1, stats: null, ...over,
})

const Probe = ({ torrents, runsEngine = true }: { torrents: Torrent[], runsEngine?: boolean }) => {
  useLeavePrompt(torrents, runsEngine)
  return null
}

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
  add = vi.spyOn(window, 'addEventListener')
  remove = vi.spyOn(window, 'removeEventListener')
})

afterEach(() => { vi.restoreAllMocks() })

describe('the prompt before the tab closes', () => {
  it('asks while a torrent the person added downloads, and lets go of its listener once none does', async () => {
    const screen = await render(<Probe torrents={[row('a', 'downloading'), row('b', 'seeding')]}/>)
    expect(holding()).toHaveLength(1)
    const leaving = new Event('beforeunload', { cancelable: true })
    holding()[0]!(leaving)
    expect(leaving.defaultPrevented, 'the browser is asked to confirm').toBe(true)

    await screen.rerender(<Probe torrents={[row('a', 'retrying'), row('b', 'seeding')]}/>)
    expect(holding(), 'a download waiting out a retry still downloads').toHaveLength(1)

    await screen.rerender(<Probe torrents={[row('a', 'seeding'), row('b', 'seeding')]}/>)
    expect(holding()).toHaveLength(0)
  })

  it('does not ask for seeding, stopped or checking torrents', async () => {
    await render(<Probe torrents={['seeding', 'completed', 'paused', 'queued', 'checking', 'starting', 'missing'].map((state, i) => row(String(i), state as Torrent['state']))}/>)
    expect(holding()).toHaveLength(0)
  })

  it('does not ask for a temporary torrent, which the person did not add', async () => {
    await render(<Probe torrents={[row('a', 'downloading', { ephemeral: true })]}/>)
    expect(holding()).toHaveLength(0)
  })

  it('does not ask in a tab whose closing leaves the engine running in another', async () => {
    await render(<Probe torrents={[row('a', 'downloading')]} runsEngine={false}/>)
    expect(holding()).toHaveLength(0)
  })

  it('does not ask inside a frame', async () => {
    framed.value = true
    await render(<Probe torrents={[row('a', 'downloading')]}/>)
    expect(holding()).toHaveLength(0)
  })
})
