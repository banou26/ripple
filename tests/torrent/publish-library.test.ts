import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Persisted } from '../../src/torrent/library'

/** HOR-535: a torrent's synced picture goes with the removal record that syncs. */

const store = new Map<string, unknown>()
const cloudText = new Map<string, string>()
const forgotten: string[][] = []
let removalsUnreadable = false

vi.mock('idb-keyval', () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => { store.set(k, v) },
}))

vi.mock('@fkn/lib', () => ({
  account: {},
  cloud: {
    fs: {
      promises: {
        readFile: async (path: string) => {
          if (path === 'ripple/removed.json' && removalsUnreadable) throw new Error('broker said no')
          const hit = cloudText.get(path)
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => { cloudText.set(path, data) },
      },
    },
  },
}))

vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => ({}) }))

vi.mock('../../src/torrent/thumbnail-sync', () => ({
  forgetSyncedThumbnails: async (hashes: string[]) => { forgotten.push(hashes) },
  resetThumbnailSync: () => {},
  syncThumbnails: async () => {},
}))

const { BACKUP_PATH, REMOVALS_PATH, publishLibrary } = await import('../../src/torrent/use-cloud-backup')

const HASH = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const entry = (infoHash: string, addedAt = 1_000): Persisted =>
  ({ infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt })

beforeEach(() => {
  store.clear(); cloudText.clear(); forgotten.length = 0
  removalsUnreadable = false
})

describe('publishing the library', () => {
  it('deletes the picture of a torrent whose removal it publishes first', async () => {
    store.set('ripple:removed', [{ infoHash: HASH, removedAt: 2_000 }])
    cloudText.set(BACKUP_PATH, JSON.stringify([entry(HASH), entry(OTHER)]))
    await publishLibrary([entry(OTHER)])
    expect(JSON.parse(cloudText.get(REMOVALS_PATH)!)).toEqual([{ infoHash: HASH, removedAt: 2_000 }])
    expect(forgotten.flat()).toEqual([HASH])
  })

  it('leaves alone a removal the account already has', async () => {
    store.set('ripple:removed', [{ infoHash: HASH, removedAt: 2_000 }])
    cloudText.set(REMOVALS_PATH, JSON.stringify([{ infoHash: HASH, removedAt: 2_000 }]))
    await publishLibrary([entry(OTHER)])
    expect(forgotten.flat()).toEqual([])
  })

  it('keeps the picture of a torrent added again after its removal', async () => {
    store.set('ripple:removed', [{ infoHash: HASH, removedAt: 2_000 }])
    await publishLibrary([entry(HASH, 3_000)])
    expect(forgotten.flat()).toEqual([])
  })

  it('deletes nothing when the account\'s removals could not be read', async () => {
    removalsUnreadable = true
    store.set('ripple:removed', [{ infoHash: HASH, removedAt: 2_000 }])
    await publishLibrary([])
    expect(forgotten.flat()).toEqual([])
  })

  it('answers with the list it wrote, which the pictures follow', async () => {
    store.set('ripple:removed', [{ infoHash: HASH, removedAt: 2_000 }])
    const published = await publishLibrary([entry(HASH), entry(OTHER)])
    expect(published.map((e) => e.infoHash)).toEqual([OTHER])
    expect(JSON.parse(cloudText.get(BACKUP_PATH)!)).toEqual(published)
  })
})
