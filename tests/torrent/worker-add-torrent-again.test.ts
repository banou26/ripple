import type { Persisted } from '../../src/torrent/library'

import { readFileSync } from 'node:fs'

import { expect, it, vi } from 'vitest'

import { LIST_KEY } from '../../src/torrent/library'
import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A .torrent added for a torrent the library already holds leaves its entry alone. The real engine answers it with
 * the handle it already has (one id per infohash); taken as a new add, the entry is written over as started and
 * unpaused, with a magnet of the bare hash in place of the one it was added with.
 */

const GiB = 1024 ** 3
const SINTEL = readFileSync(new URL('../../src/assets/sintel.torrent', import.meta.url))
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`

const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * GiB }) })

// an offline network: the magnet names no tracker, and nothing else dials
vi.mock('@fkn/lib/net', () => ({ connect: () => { throw new Error('offline') }, createServer: () => ({ on () {}, listen () {}, close () {} }) }))
vi.mock('@fkn/lib/dgram', () => ({ createSocket: () => ({ on () {}, bind () {}, send () {}, close () {} }) }))
vi.mock('libtorrent-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('libtorrent-wasm')>()
  return {
    ...real,
    createSession: async (options: Parameters<typeof real.createSession>[0]) =>
      real.createSession({ ...options, reserveListenPort: false, enableDht: false }),
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value) },
  del: async (key: string) => { store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
}))

const entry = () => ((store.get(LIST_KEY) as Persisted[] | undefined) ?? []).find((e) => e.infoHash === HASH)

it('leaves a paused torrent paused, with its magnet and save path, when its .torrent is added again', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state')).toHaveLength(1), { timeout: 10_000 })

  rig.send({ type: 'add-magnet', magnet: MAGNET })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1), { timeout: 5_000 })
  const handle = rig.of('added')[0]!.handle as number
  rig.send({ type: 'pause', handle })
  await vi.waitFor(() => expect(entry()?.paused).toBe(true), { timeout: 5_000 })
  const { magnet, savePath, started, paused } = entry()!

  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array(SINTEL) })
  await vi.waitFor(() => expect(rig.of('added').length + rig.of('add-failed').length).toBe(2), { timeout: 15_000 })

  // the same handle is the control: it is the engine saying these bytes are the torrent already listed
  expect(rig.of('added')[1]).toEqual({ type: 'added', handle, magnet: MAGNET })
  expect(entry()).toMatchObject({ magnet, savePath, started, paused })
  expect(magnet).toBe(MAGNET)
}, 60_000)
