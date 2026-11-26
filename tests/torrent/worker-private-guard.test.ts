// A private torrent must NEVER fall back to bare addMagnet() (which carries no info dict and
// announces a private infohash onto the public DHT) during restore, relocate, startEntries, or
// add-magnet, and adding or importing a private torrent must persist `private: true` on its entry.
import type { Persisted } from '../../src/torrent/library'

import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import { isPrivateTorrent } from '../../src/torrent/torrent-file'
import { fakeDir, installWorkerGlobals } from '../utils/worker-rig'

const fixture = vi.hoisted(() => {
  const enc = new TextEncoder()
  const str = (v: string) => `${enc.encode(v).length}:${v}`
  const PRIV_INFO = `d6:lengthi11e4:name5:p.bin12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}7:privatei1ee`
  const KEPT_PRIV_INFO = `d6:lengthi11e4:name5:k.bin12:piece lengthi16384e6:pieces20:${'k'.repeat(20)}7:privatei1ee`
  const PRE92_PRIV_INFO = `d6:lengthi11e4:name5:o.bin12:piece lengthi16384e6:pieces20:${'o'.repeat(20)}7:privatei1ee`
  const RELOCATE_PRIV_INFO = `d6:lengthi11e4:name5:r.bin12:piece lengthi16384e6:pieces20:${'r'.repeat(20)}7:privatei1ee`
  const PUB_INFO = `d6:lengthi11e4:name5:u.bin12:piece lengthi16384e6:pieces20:${'u'.repeat(20)}e`
  const PRIV_TORRENT = enc.encode(`d8:announce${str('https://tracker.private/announce')}4:info${PRIV_INFO}e`)
  const KEPT_PRIV_TORRENT = enc.encode(`d8:announce${str('https://tracker.private/announce')}4:info${KEPT_PRIV_INFO}e`)
  const PRE92_PRIV_TORRENT = enc.encode(`d8:announce${str('https://tracker.private/announce')}4:info${PRE92_PRIV_INFO}e`)
  const RELOCATE_PRIV_RESUME = enc.encode(`d4:info${RELOCATE_PRIV_INFO}e`)
  const UNSAFE_RESUME = enc.encode('d4:spami1ee')
  const PUB_TORRENT = enc.encode(`d8:announce${str('http://tracker.pub/announce')}4:info${PUB_INFO}e`)
  return {
    PRIV_INFO,
    KEPT_PRIV_INFO,
    PRE92_PRIV_INFO,
    RELOCATE_PRIV_INFO,
    PUB_INFO,
    PRIV_TORRENT,
    KEPT_PRIV_TORRENT,
    PRE92_PRIV_TORRENT,
    RELOCATE_PRIV_RESUME,
    UNSAFE_RESUME,
    PUB_TORRENT,
    store: new Map<string, unknown>(),
    engine: {
      files: [] as Uint8Array[],
      magnets: [] as string[],
      resumes: [] as Uint8Array[],
      removed: [] as number[],
      privateHandles: new Set<number>(),
      infohashByHandle: new Map<number, string>(),
    },
  }
})

const hashOf = (info: string) => createHash('sha1').update(info).digest('hex')
const RESTORE_MISSING_HASH = '1'.repeat(40)
const START_MISSING_HASH = '2'.repeat(40)
const RELOCATE_MISSING_HASH = hashOf(fixture.RELOCATE_PRIV_INFO)
const UNSAFE_RESUME_HASH = '6'.repeat(40)
const PRE92_PRIV_HASH = hashOf(fixture.PRE92_PRIV_INFO)
const ADD_PRIV_HASH = hashOf(fixture.PRIV_INFO)
const KEPT_PRIV_HASH = hashOf(fixture.KEPT_PRIV_INFO)
const IMPORT_PRIV_HASH = '4'.repeat(40)
const START_PUBLIC_HASH = '5'.repeat(40)

const rig = installWorkerGlobals({
  estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
  root: fakeDir('', [fakeDir('dl', [fakeDir(RESTORE_MISSING_HASH), fakeDir(RELOCATE_MISSING_HASH), fakeDir(UNSAFE_RESUME_HASH), fakeDir(PRE92_PRIV_HASH)])]),
})

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  let next = 1
  return {
    createSession: async () => fakeSession({
      addTorrentWithResume: (resume: Uint8Array) => {
        const h = next++
        fixture.engine.resumes.push(resume)
        // RELOCATE_MISSING_HASH restores from valid private resume and is private
        fixture.engine.privateHandles.add(h)
        fixture.engine.infohashByHandle.set(h, RELOCATE_MISSING_HASH)
        return h
      },
      addTorrentFile: (bytes: Uint8Array) => {
        const h = next++
        fixture.engine.files.push(bytes)
        if (bytes === fixture.PRIV_TORRENT || bytes === fixture.KEPT_PRIV_TORRENT || bytes === fixture.PRE92_PRIV_TORRENT) {
          fixture.engine.privateHandles.add(h)
          const hash = bytes === fixture.PRIV_TORRENT ? ADD_PRIV_HASH : bytes === fixture.KEPT_PRIV_TORRENT ? KEPT_PRIV_HASH : PRE92_PRIV_HASH
          fixture.engine.infohashByHandle.set(h, hash)
        }
        return h
      },
      addMagnet: (magnet: string) => {
        fixture.engine.magnets.push(magnet)
        return next++
      },
      removeTorrent: (h: number) => {
        fixture.engine.removed.push(h)
        return true
      },
      isPrivate: (h: number) => fixture.engine.privateHandles.has(h),
      infohash: (h: number) => fixture.engine.infohashByHandle.get(h) ?? null,
      infohashV2: () => null,
      status: () => DOWNLOADING,
      saveResumeData: async () => new Uint8Array(),
      pauseTorrent: () => {},
      resumeTorrent: () => {},
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => fixture.store.get(key),
  set: async (key: string, value: unknown) => { fixture.store.set(key, value) },
  del: async (key: string) => { fixture.store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { fixture.store.set(key, fn(fixture.store.get(key))) },
}))

const entry = (infoHash: string, over: Partial<Persisted> = {}): Persisted => ({
  infoHash,
  magnet: `magnet:?xt=urn:btih:${infoHash}`,
  savePath: '/dl/' + infoHash,
  addedAt: 1000,
  started: true,
  paused: false,
  ...over,
})

describe('private torrent bare-magnet DHT fallback guard', () => {
  it('blocks addMagnet fallback in restore, startEntries, relocate, and add-magnet while stamping private on add and import', async () => {
    expect(isPrivateTorrent(fixture.PRIV_TORRENT)).toBe(true)
    expect(isPrivateTorrent(fixture.KEPT_PRIV_TORRENT)).toBe(true)
    expect(isPrivateTorrent(fixture.PUB_TORRENT)).toBe(false)

    fixture.store.set('ripple:torrents', [
      // 1. Restore case: private entry with NO resume blob and NO kept .torrent
      entry(RESTORE_MISSING_HASH, { private: true }),
      // 2. Relocate case: private entry restored from a valid private resume blob (files cleaned before relocate below)
      entry(RELOCATE_MISSING_HASH, { private: true }),
      // 3. Unsafe non-private resume blob on a private entry: blocked in restore (neither addTorrentWithResume nor addMagnet)
      entry(UNSAFE_RESUME_HASH, { private: true }),
      // 4. Pre-0.0.92 entry with kept private .torrent and no `private` field: backfills private: true during restore
      entry(PRE92_PRIV_HASH),
      // 5. startEntries / add-magnet missing case: synced private ghost with no kept .torrent yet
      entry(START_MISSING_HASH, { started: false, private: true }),
      // 6. add-magnet kept case: non-running private ghost whose kept .torrent IS stored
      entry(KEPT_PRIV_HASH, { started: false, private: true }),
      // 7. Control: public ghost with no kept .torrent MUST still fall back to addMagnet on start
      entry(START_PUBLIC_HASH, { started: false }),
    ])
    fixture.store.set('ripple:resume:' + RELOCATE_MISSING_HASH, fixture.RELOCATE_PRIV_RESUME)
    fixture.store.set('ripple:resume:' + UNSAFE_RESUME_HASH, fixture.UNSAFE_RESUME)
    fixture.store.set('ripple:torrent:' + PRE92_PRIV_HASH, fixture.PRE92_PRIV_TORRENT)
    fixture.store.set('ripple:torrent:' + KEPT_PRIV_HASH, fixture.KEPT_PRIV_TORRENT)

    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

    // Restore: never called addMagnet, only passed valid private resume to addTorrentWithResume (blocked UNSAFE_RESUME),
    // marked RESTORE_MISSING and UNSAFE_RESUME started: false, and backfilled PRE92_PRIV_HASH private: true.
    expect(fixture.engine.magnets).toEqual([])
    expect(fixture.engine.resumes).toEqual([fixture.RELOCATE_PRIV_RESUME])
    const afterRestore = fixture.store.get('ripple:torrents') as Persisted[]
    expect(afterRestore.find((e) => e.infoHash === RESTORE_MISSING_HASH)?.started).toBe(false)
    expect(afterRestore.find((e) => e.infoHash === UNSAFE_RESUME_HASH)?.started).toBe(false)
    expect(afterRestore.find((e) => e.infoHash === PRE92_PRIV_HASH)?.private).toBe(true)

    // startEntries on private ghost with no .torrent: refuses addMagnet and posts add-failed
    const failedBeforeStart = rig.of('add-failed').length
    rig.send({ type: 'start', infoHash: START_MISSING_HASH })
    await vi.waitFor(() => expect(rig.of('add-failed').length).toBe(failedBeforeStart + 1))
    expect(fixture.engine.magnets).toEqual([])

    // add-magnet on non-running private entry with NO kept .torrent: refuses addMagnet and answers add-failed
    rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${START_MISSING_HASH}`, addId: 'priv-miss' })
    await vi.waitFor(() => expect(rig.of('add-failed').some((m) => m.addId === 'priv-miss')).toBe(true))
    expect(fixture.engine.magnets).toEqual([])

    // add-magnet on non-running private entry WITH kept .torrent: uses addTorrentFile, never addMagnet
    const filesBeforeKept = fixture.engine.files.length
    rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${KEPT_PRIV_HASH}`, addId: 'priv-kept' })
    await vi.waitFor(() => expect(rig.of('added').some((m) => m.addId === 'priv-kept')).toBe(true))
    expect(fixture.engine.magnets).toEqual([])
    expect(fixture.engine.files.length).toBe(filesBeforeKept + 1)
    expect(fixture.engine.files.at(-1)).toBe(fixture.KEPT_PRIV_TORRENT)

    // Relocate on private running torrent with no .torrent (and unrecoverable/absent resume):
    // refuses addMagnet, posts add-failed, and NEVER removes the running handle!
    fixture.store.delete('ripple:torrent:' + RELOCATE_MISSING_HASH)
    fixture.store.delete('ripple:resume:' + RELOCATE_MISSING_HASH)
    const failedBeforeRelocate = rig.of('add-failed').length
    rig.send({ type: 'relocate', infoHash: RELOCATE_MISSING_HASH, to: 'folder' })
    await vi.waitFor(() => expect(rig.of('add-failed').length).toBe(failedBeforeRelocate + 1))
    expect(fixture.engine.magnets).toEqual([])
    expect(fixture.engine.removed).toEqual([])

    // Control: startEntries on PUBLIC ghost with no .torrent still uses addMagnet
    rig.send({ type: 'start', infoHash: START_PUBLIC_HASH })
    await vi.waitFor(() => expect(fixture.engine.magnets).toHaveLength(1))
    expect(fixture.engine.magnets[0]).toContain(START_PUBLIC_HASH)

    // add-torrent-file stamps private: true on persisted entry
    rig.send({ type: 'add-torrent-file', bytes: fixture.PRIV_TORRENT })
    await vi.waitFor(() => {
      const list = fixture.store.get('ripple:torrents') as Persisted[]
      expect(list.find((e) => e.infoHash === ADD_PRIV_HASH)?.private).toBe(true)
    })

    // import-list preserves private: true on new ghost entries AND tears down an already-running non-private handle
    const removedBeforeImport = fixture.engine.removed.length
    rig.send({
      type: 'import-list',
      list: [
        entry(IMPORT_PRIV_HASH, { private: true }),
        entry(START_PUBLIC_HASH, { private: true }),
      ],
      removed: [],
    })
    await vi.waitFor(() => {
      const list = fixture.store.get('ripple:torrents') as Persisted[]
      expect(list.find((e) => e.infoHash === IMPORT_PRIV_HASH)?.private).toBe(true)
      const stopped = list.find((e) => e.infoHash === START_PUBLIC_HASH)
      expect(stopped?.private).toBe(true)
      expect(stopped?.started).toBe(false)
    })
    expect(fixture.engine.removed.length).toBe(removedBeforeImport + 1)

    expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
  })
})
