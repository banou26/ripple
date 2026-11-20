// A plugin's add carries an id the engine names in its answer, so the tab that asked can settle it and no tab takes it
// for one of its own; and a list the account's sync wrote says so, so it is not read as adds and removals.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  let next = 1
  // an engine that throws on one torrent, as a handler can fail on its way
  const addMagnet = (magnet: string) => { if (magnet.includes('d'.repeat(40))) throw new Error('refused'); return next++ }
  return {
    createSession: async () => fakeSession({ addMagnet }),
    offlineHost: () => ({ net: {}, dgram: {} }),
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

const magnet = (c: string) => `magnet:?xt=urn:btih:${c.repeat(40)}`

it('names the add id in its answer, and leaves an add without one as it was', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'add-magnet', magnet: magnet('a'), addId: 'plugin-1' })
  rig.send({ type: 'add-magnet', magnet: 'magnet:?dn=no-hash', addId: 'plugin-2' })
  rig.send({ type: 'add-magnet', magnet: magnet('b') })
  rig.send({ type: 'add-magnet', magnet: 'magnet:?dn=still-no-hash' })
  await vi.waitFor(() => expect(rig.of('added').length + rig.of('add-failed').length).toBe(4))
  expect(rig.of('added').map((m) => m.addId)).toEqual(['plugin-1', undefined])
  expect(rig.of('add-failed').map((m) => m.addId)).toEqual(['plugin-2', undefined])
  expect(rig.of('added').every((m) => typeof m.handle === 'number')).toBe(true)

  rig.send({ type: 'add-magnet', magnet: magnet('d'), addId: 'plugin-3' })
  await vi.waitFor(() => expect(rig.of('add-failed').map((m) => m.addId)).toContain('plugin-3'))
  rig.send({ type: 'add-magnet', magnet: `${magnet('d')}&dn=again` })
  await vi.waitFor(() => expect(rig.of('error').length, 'one without an id fails as before (control)').toBeGreaterThan(0))

  rig.send({ type: 'import-list', list: [{ infoHash: 'c'.repeat(40), magnet: magnet('c'), savePath: '/dl', addedAt: 1 }], removed: [] })
  await vi.waitFor(() => expect(rig.of('list').some((m) => m.synced === true)).toBe(true))
  const synced = rig.of('list').filter((m) => m.synced === true)
  expect((synced.at(-1)!.list as { infoHash: string }[]).map((e) => e.infoHash)).toContain('c'.repeat(40))
  const edits = rig.of('list').filter((m) => m.synced !== true)
  expect(edits.length, 'an add\'s own list is an edit (control)').toBeGreaterThan(0)

  rig.send({ type: 'clear-list' })
  await vi.waitFor(() => expect(rig.of('list').filter((m) => m.synced === true).at(-1)?.list).toEqual([]))
  expect(rig.of('worker-error')).toEqual([])
})
