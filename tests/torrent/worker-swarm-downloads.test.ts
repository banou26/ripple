// The player's download count comes from the trackers of the torrents being watched, and from no others.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const state = vi.hoisted(() => ({
  // what each torrent's trackers would say if asked
  trackers: new Map<number, { downloaded: number }[]>(),
  // what the engine last answered, which is all `lastTrackers` can read
  answered: new Map<number, { downloaded: number }[]>(),
}))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      trackers: async (h: number) => {
        const list = state.trackers.get(h) ?? []
        state.answered.set(h, list)
        return list
      },
      lastTrackers: (h: number) => state.answered.get(h) ?? [],
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const downloadsOf = (h: number) =>
  (rig.of('state').at(-1)?.torrents as { handle: number, swarmDownloads: number }[] | undefined)
    ?.find((t) => t.handle === h)?.swarmDownloads

it('asks only the watched torrents\' trackers, and reports the highest download count any gives', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  for (const c of 'abc') rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${c.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(3))
  // a UDP tracker, which never sends the count, an older answer, and the freshest
  state.trackers.set(1, [{ downloaded: -1 }, { downloaded: 7645 }, { downloaded: 8054 }])
  // a magnet with no trackers at all
  state.trackers.set(2, [])
  state.trackers.set(3, [{ downloaded: 120 }])

  // two ticks with nobody watching: nothing is asked
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  expect([...state.answered.keys()]).toEqual([])
  expect([downloadsOf(1), downloadsOf(2), downloadsOf(3)]).toEqual([-1, -1, -1])

  rig.send({ type: 'watch', viewer: 'player', handle: 1, fileIndex: 0, fromOffset: 0 })
  rig.send({ type: 'watch', viewer: 'download-page', handle: 2, fileIndex: 0, fromOffset: 0 })
  await vi.waitFor(() => expect(downloadsOf(1)).toBe(8054))
  expect(downloadsOf(2)).toBe(-1)
  // THE CONTROL: the same answer is there for a torrent nobody watches, and it is never asked for
  expect(state.answered.has(3)).toBe(false)
  expect(downloadsOf(3)).toBe(-1)
  expect(rig.of('worker-error')).toEqual([])
})
