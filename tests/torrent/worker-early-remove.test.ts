import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * Every command that gives a torrent up reaches the REAL engine before its first alert pump, and the engine removes it.
 *
 * libtorrent-wasm 0.3.22 and older dropped a remove for a torrent its alert pump had not registered yet, and said
 * nothing, so a remove, a clear, a remove of missing files or a move sent in that first half second left the torrent
 * running with its files. Needs the engine that removes it anyway: on 0.3.22 none of the five lands.
 */

// libtorrent's torrent_removed_alert
const TORRENT_REMOVED = 4
const GiB = 1024 ** 3
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

const engine = vi.hoisted(() => ({ pumps: 0, removed: 0, removesAfterAPump: 0 }))

const entry = (infoHash: string): Persisted => ({
  infoHash,
  magnet: 'magnet:?xt=urn:btih:' + infoHash,
  savePath: '/dl/' + infoHash,
  addedAt: 1,
  lastUsedAt: 1,
  started: true,
})

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * GiB }) })

// an offline network: nothing here names a tracker or a peer, so nothing dials
vi.mock('@fkn/lib/net', () => ({ connect: () => { throw new Error('offline') }, createServer: () => ({ on () {}, listen () {}, close () {} }) }))
vi.mock('@fkn/lib/dgram', () => ({ createSocket: () => ({ on () {}, bind () {}, send () {}, close () {} }) }))
vi.mock('libtorrent-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('libtorrent-wasm')>()
  return {
    ...real,
    createSession: async (options: Parameters<typeof real.createSession>[0]) => {
      const session = await real.createSession({ ...options, reserveListenPort: false, enableDht: false })
      const pop = session.popAlerts.bind(session)
      session.popAlerts = () => {
        engine.pumps++
        const alerts = pop()
        engine.removed += alerts.filter((alert) => alert.type === TORRENT_REMOVED).length
        return alerts
      }
      const remove = session.removeTorrent.bind(session)
      session.removeTorrent = (handle: number, deleteFiles?: boolean) => {
        if (engine.pumps) engine.removesAfterAPump++
        return remove(handle, deleteFiles)
      }
      return session
    },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>([['ripple:torrents', [A, B, C, D].map(entry)]])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('removes what a remove, a remove of missing files, a move and a clear give up before the first alert pump', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state')).toHaveLength(1), { timeout: 10_000 })
  const torrents = rig.of('state')[0]!.torrents as { handle: number, magnet: string }[]
  const handleOf = (hash: string) => torrents.find((t) => t.magnet.endsWith(hash))!.handle

  rig.send({ type: 'remove', handle: handleOf(A), deleteFiles: true })
  rig.send({ type: 'remove-missing', infoHash: B })
  rig.send({ type: 'relocate', infoHash: C, to: 'folder' })
  rig.send({ type: 'clear-list' })

  // C twice: moved, then added again and cleared. An engine that removed it after the re-add would hold one C, not two.
  await vi.waitFor(() => expect(engine.removed, 'a torrent given up stayed in the engine').toBe(5), { timeout: 5_000 })
  expect(engine.removesAfterAPump, 'a command ran after the first alert pump').toBe(0)
  expect(rig.of('worker-error')).toEqual([])
}, 20_000)
