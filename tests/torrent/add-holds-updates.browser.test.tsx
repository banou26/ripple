import type { UseTorrents } from '../../src/torrent/use-torrents'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { ENGINE_STORE_MS, pageWorkRunning } from '../../src/utils/page-work'

/** A client that answers every subscription with nothing and every command at once. */
const client = new Proxy({}, {
  get: (_, key) => (typeof key === 'string' && key.startsWith('on') ? () => () => {} : key === 'owns' ? () => false : () => Promise.resolve()),
})
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

const { useTorrents } = await import('../../src/torrent/use-torrents')

let hook: UseTorrents | undefined
const Probe = () => { hook = useTorrents(); return null }

// the engine stores a handed torrent only once libtorrent reports its infohash, and an update's reload
// before that loses the torrent from the library (page-work.ts, ENGINE_STORE_MS)
it.each([
  ['a .torrent', () => hook!.addTorrentFile(new Uint8Array([1]))],
  ['a magnet', () => hook!.addMagnet('magnet:?xt=urn:btih:' + 'a'.repeat(40))],
])('holds updates while the engine stores %s it was just handed', async (_, add) => {
  await render(<Probe/>)
  await expect.poll(async () => (await pageWorkRunning()) || hook !== undefined).toBe(true)
  expect(await pageWorkRunning(), 'the control: nothing held before the add').toBe(false)
  vi.useFakeTimers({ toFake: ['setTimeout'] })
  try {
    void add()
    expect(await pageWorkRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(ENGINE_STORE_MS - 1)
    expect(await pageWorkRunning(), 'still storing').toBe(true)
    await vi.advanceTimersByTimeAsync(1)
  } finally {
    vi.useRealTimers()
  }
  await expect.poll(pageWorkRunning, { timeout: 2000 }).toBe(false)
})
