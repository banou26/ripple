import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals, sessions } from '../utils/worker-rig'

/**
 * A Files missing row has no directory in browser storage, so the restore's check for storage the browser cleared
 * must not count it. Beside a library kept wholly in the person's folder, it read as a cleared browser, and the
 * restore deleted every started torrent's saved state.
 */

const GHOST = 'a'.repeat(40)
const KEPT = 'b'.repeat(40)
const store = vi.hoisted(() => new Map<string, unknown>())

// no directory in OPFS at all, as after a Files missing row whose files were in the folder
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return { createSession: async () => fakeSession(), PRIORITY: { skip: 0 }, TORRENT_FLAG: { uploadMode: 1 } }
})
vi.mock('idb-keyval', () => {
  const entry = (infoHash: string, savePath: string, started: boolean): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath, saveTo: 'folder',
    addedAt: 1, lastUsedAt: 1, started, paused: false, ephemeral: false,
  })
  store.set('ripple:torrents', [entry(GHOST, '/dl/' + GHOST, false), entry(KEPT, '/native/' + KEPT, true)])
  store.set('ripple:resume:' + KEPT, new Uint8Array([1]))
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entryOf = (infoHash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === infoHash)

it('keeps the saved state of a folder torrent beside a Files missing row', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  expect(store.get('ripple:resume:' + KEPT)).toEqual(new Uint8Array([1]))
  expect(entryOf(KEPT)).toMatchObject({ started: true, savePath: '/native/' + KEPT })
  expect(entryOf(GHOST)).toMatchObject({ started: false, savePath: '/dl/' + GHOST })
  expect(sessions[0]!.removed).toEqual([])
})
