// A plugin's add is answered once, by its add id, with the real engine: `added` only when the library keeps the torrent
// because of it, and `already` when the library kept it before.
import type { Persisted } from '../../src/torrent/library'

import { readFileSync } from 'node:fs'

import { expect, it, vi } from 'vitest'

import { LIST_KEY } from '../../src/torrent/library'
import { installWorkerGlobals } from '../utils/worker-rig'

const GiB = 1024 ** 3
const SINTEL = readFileSync(new URL('../../src/assets/sintel.torrent', import.meta.url))
const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=Sintel`

const store = vi.hoisted(() => new Map<string, unknown>())
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * GiB }) })

// an offline network: the magnets name no tracker, and nothing else dials
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

const entryOf = (hash: string) => ((store.get(LIST_KEY) as Persisted[] | undefined) ?? []).find((e) => e.infoHash === hash)
const answersTo = (addId: string) => rig.posted.filter((m) => m.addId === addId).map(({ type, already }) => ({ type, already }))
const settle = () => new Promise((resolve) => setTimeout(resolve, 500))

it('keeps a torrent the player holds when a plugin adds its .torrent, and answers the next one already', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state')).toHaveLength(1), { timeout: 10_000 })
  rig.send({ type: 'add-magnet', magnet: MAGNET, ephemeral: true })
  await vi.waitFor(() => expect(entryOf(HASH)?.ephemeral).toBe(true), { timeout: 5_000 })

  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array(SINTEL), addId: 'plugin-1' })
  await vi.waitFor(() => expect(answersTo('plugin-1')).toHaveLength(1), { timeout: 15_000 })
  await settle()
  expect(answersTo('plugin-1')).toEqual([{ type: 'added', already: undefined }])
  expect(entryOf(HASH)?.ephemeral).toBe(false)

  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array(SINTEL), addId: 'plugin-2' })
  await vi.waitFor(() => expect(answersTo('plugin-2')).toHaveLength(1), { timeout: 15_000 })
  await settle()
  expect(answersTo('plugin-2')).toEqual([{ type: 'added', already: true }])
  expect(rig.of('add-failed'), 'nothing said to the person').toEqual([])
}, 60_000)

it('answers already to the second of two adds of one torrent made at once', async () => {
  const hash = '1'.repeat(40)
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash}`, addId: 'plugin-3' })
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${hash}`, addId: 'plugin-4' })
  await vi.waitFor(() => expect(answersTo('plugin-4')).toHaveLength(1), { timeout: 15_000 })
  expect([...answersTo('plugin-3'), ...answersTo('plugin-4')]).toEqual([{ type: 'added', already: undefined }, { type: 'added', already: true }])
  expect(entryOf(hash)?.ephemeral).toBe(false)
}, 60_000)
