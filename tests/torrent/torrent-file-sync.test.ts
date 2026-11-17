import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Carrying each torrent's .torrent between a person's own devices: uploaded once by a device that keeps it, downloaded
 * only by a device that needs it, deleted with the torrent, and never carried from one account into another. Every
 * storage call is counted, and every failure must leave this device's files as they were.
 */

const store = new Map<string, unknown>()
const cloudFiles = new Map<string, Uint8Array>()
const reads: string[] = []
const writes: string[] = []
const unlinks: string[] = []
const listings: string[] = []
let readFails: (path: string) => boolean = () => false
let readHangs: (path: string) => boolean = () => false
let writeFails = false
let listFails = false
let unlinkFails = false
let onWrite: () => void = () => {}
let onRead: () => void = () => {}

const notFound = () => Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })

vi.mock('idb-keyval', () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => { store.set(k, v) },
  del: async (k: string) => { store.delete(k) },
  update: async (k: string, fn: (prev: unknown) => unknown) => { store.set(k, fn(store.get(k))) },
}))

vi.mock('@fkn/lib', () => ({
  cloud: {
    fs: {
      isNotFound: (err: unknown) => (err as { code?: string })?.code === 'FKN_STORAGE_NOT_FOUND',
      promises: {
        readFile: async (path: string) => {
          reads.push(String(path))
          if (readFails(String(path))) throw new Error('broker said no')
          if (readHangs(String(path))) return new Promise(() => {})
          onRead()
          const hit = cloudFiles.get(String(path))
          if (!hit) throw notFound()
          return hit
        },
        writeFile: async (path: string, data: Uint8Array) => {
          writes.push(String(path))
          if (writeFails) throw new Error('broker said no')
          cloudFiles.set(String(path), data)
          onWrite()
        },
        unlink: async (path: string) => {
          unlinks.push(String(path))
          if (unlinkFails) throw new Error('broker said no')
          if (!cloudFiles.delete(String(path))) throw notFound()
        },
        readdir: async (dir: string) => {
          listings.push(String(dir))
          if (listFails) throw new Error('broker said no')
          const prefix = String(dir) + '/'
          return [...cloudFiles.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
        },
      },
    },
  },
}))

vi.mock('../../src/torrent/thumbnail-store', () => ({ thumbnailFor: () => null, loadCachedThumbnails: async () => {} }))

// whether Save .torrent found a file kept here when it ran
vi.mock('../../src/torrent/torrent-export', () => ({
  saveTorrentFile: async ({ infoHash }: { infoHash: string }) => (store.has('ripple:torrent:' + infoHash) ? 'saved' : 'no-metadata'),
}))

const { NAME_KEY_PATH, resetThumbnailSync } = await import('../../src/torrent/thumbnail-sync')
const { followAccount, forgetSyncedTorrentFiles, keepSyncedTorrentFile, saveSyncedTorrentFile, syncTorrentFiles, torrentFilePath } =
  await import('../../src/torrent/torrent-file-sync')

const KEY = new Uint8Array(32).fill(1)
const OTHER_KEY = new Uint8Array(32).fill(2)

const hmac = async (text: string, key: Uint8Array) => {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('')
}
/** Where a torrent's file should be, worked out here rather than asked of the code under test. */
const pathOf = async (infoHash: string, key: Uint8Array = KEY) => torrentFilePath(await hmac('torrent:' + infoHash, key))
const fileReads = () => reads.filter((p) => p !== NAME_KEY_PATH)
const fileWrites = () => writes.filter((p) => p !== NAME_KEY_PATH)
const kept = (infoHash: string) => store.get('ripple:torrent:' + infoHash) as Uint8Array | undefined

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const bytes = (fill: number, n = 64) => new Uint8Array(n).fill(fill)

let switched = false

beforeEach(() => {
  store.clear(); cloudFiles.clear()
  reads.length = 0; writes.length = 0; unlinks.length = 0; listings.length = 0
  readFails = () => false; readHangs = () => false; writeFails = false; listFails = false; unlinkFails = false
  onWrite = () => {}; onRead = () => {}
  switched = false
  cloudFiles.set(NAME_KEY_PATH, KEY)
  resetThumbnailSync()
  followAccount(() => !switched)
})

afterEach(() => { followAccount(null); vi.useRealTimers() })

describe('carrying .torrent files between devices', () => {
  it('uploads a file this device keeps once, not once per pass', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    await syncTorrentFiles([A])
    await syncTorrentFiles([A])
    await syncTorrentFiles([A])
    expect(fileWrites()).toEqual([await pathOf(A)])
    expect(cloudFiles.get(await pathOf(A))).toEqual(bytes(7))
  })

  it('downloads nothing in a pass, even what the account holds and this device lacks', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    await syncTorrentFiles([B])
    await syncTorrentFiles([B])
    expect(fileReads()).toEqual([])
    expect(kept(B)).toBeUndefined()
  })

  it('downloads one when this device needs it, once, keeps it, and never uploads it back', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    await keepSyncedTorrentFile(B)
    expect(kept(B)).toEqual(bytes(2))
    await keepSyncedTorrentFile(B)
    await syncTorrentFiles([B])
    expect(fileReads()).toEqual([await pathOf(B)])
    expect(fileWrites()).toEqual([])
    expect(listings, 'a pass asked the account for a file this device took from it').toEqual([])
  })

  it('keeps nothing, after one read, for a torrent the account holds no file of', async () => {
    await expect(keepSyncedTorrentFile(C)).resolves.toBeUndefined()
    expect(kept(C)).toBeUndefined()
    expect(fileReads()).toEqual([await pathOf(C)])
  })

  it('reads nothing for a torrent this device already keeps a file of', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    cloudFiles.set(await pathOf(A), bytes(8))
    await keepSyncedTorrentFile(A)
    expect(reads).toEqual([])
    expect(kept(A)).toEqual(bytes(7))
  })

  it('never writes over a file the account holds, which may be the one the torrent was added from', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    cloudFiles.set(await pathOf(A), bytes(9))
    await syncTorrentFiles([A])
    await syncTorrentFiles([A])
    expect(fileWrites()).toEqual([])
    expect(cloudFiles.get(await pathOf(A))).toEqual(bytes(9))
    // and once it is known to be there, a pass does not ask again
    expect(listings).toHaveLength(1)
  })

  it('asks the account nothing for torrents this device keeps no file of', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    await syncTorrentFiles([A, B])
    expect(writes).toEqual([])
    expect(listings).toEqual([])
  })

  it('bounds how many files one pass uploads, and gets through them over several', async () => {
    const many = Array.from({ length: 40 }, (_, i) => String(i).padStart(40, 'f'))
    for (const h of many) store.set('ripple:torrent:' + h, bytes(1))
    await syncTorrentFiles(many)
    expect(fileWrites().length).toBeLessThanOrEqual(6)
    for (let pass = 0; pass < 7; pass++) await syncTorrentFiles(many)
    expect(new Set(fileWrites()).size).toBe(40)
    expect(fileWrites()).toHaveLength(40)
  })

  it('does nothing at all for an empty library', async () => {
    await syncTorrentFiles([])
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })
})

/** A file's name is visible to FKN, so it must not be the torrent's info hash, nor pair up with its picture's name. */
describe('naming a .torrent file', () => {
  it('by a keyed hash under the pictures\' key, never by the info hash, and not as its picture is named', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    await syncTorrentFiles([A])
    expect(fileWrites()).toEqual([await pathOf(A)])
    expect(writes.join(' ')).not.toContain(A)
    expect(fileWrites()[0]).not.toContain(await hmac(A, KEY))
  })
})

describe('Save .torrent', () => {
  it('keeps the account\'s file first, so a row with no file here saves one', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    expect(await saveSyncedTorrentFile({ infoHash: B, magnet: 'magnet:?xt=urn:btih:' + B, name: 'b', flush: () => {} })).toBe('saved')
  })
})

describe('a removed torrent\'s file', () => {
  it('is deleted from the account', async () => {
    cloudFiles.set(await pathOf(A), bytes(7))
    await forgetSyncedTorrentFiles([A])
    expect(cloudFiles.has(await pathOf(A))).toBe(false)
  })

  it('is uploaded again when the torrent is added again', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    await syncTorrentFiles([A])
    await forgetSyncedTorrentFiles([A])
    await syncTorrentFiles([A])
    expect(fileWrites()).toEqual([await pathOf(A), await pathOf(A)])
    expect(cloudFiles.has(await pathOf(A))).toBe(true)
  })
})

describe('an account switch', () => {
  it('reads and writes nothing while no account is followed', async () => {
    store.set('ripple:torrent:' + A, bytes(7))
    cloudFiles.set(await pathOf(B), bytes(2))
    for (const check of [null, () => false]) {
      followAccount(check)
      await syncTorrentFiles([A, B])
      await keepSyncedTorrentFile(B)
    }
    expect(reads).toEqual([])
    expect(writes).toEqual([])
    expect(kept(B)).toBeUndefined()
  })

  it('stops a pass at the switch, so no more of this device\'s files reach the other account', async () => {
    for (const h of [A, B, C]) store.set('ripple:torrent:' + h, bytes(3))
    onWrite = () => { switched = true }
    await syncTorrentFiles([A, B, C])
    expect(fileWrites()).toEqual([await pathOf(A)])
  })

  it('reads nothing once the switch lands while a download is on its way', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    // the switch is noticed between naming the file and asking for it
    const pending = keepSyncedTorrentFile(B)
    switched = true
    await pending
    expect(fileReads()).toEqual([])
    expect(kept(B)).toBeUndefined()
  })

  it('names files with the key of the account now signed in, so the last account\'s names are never read', async () => {
    await keepSyncedTorrentFile(B)
    resetThumbnailSync()
    cloudFiles.set(NAME_KEY_PATH, OTHER_KEY)
    await keepSyncedTorrentFile(B)
    expect(fileReads()).toEqual([await pathOf(B), await pathOf(B, OTHER_KEY)])
  })
})

describe('a failed storage call leaves this device as it was', () => {
  it('a read that fails keeps nothing', async () => {
    readFails = (path) => path !== NAME_KEY_PATH
    cloudFiles.set(await pathOf(B), bytes(2))
    await expect(keepSyncedTorrentFile(B)).resolves.toBeUndefined()
    expect(kept(B)).toBeUndefined()
    expect(store.has('ripple:torrent-file-pushed')).toBe(false)
  })

  it('a read that never answers lets the caller go on, and keeps nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    readHangs = (path) => path !== NAME_KEY_PATH
    cloudFiles.set(await pathOf(B), bytes(2))
    let done = false
    const pending = keepSyncedTorrentFile(B).then(() => { done = true })
    // the key is real crypto, which settles on turns of the event loop rather than on a timer, slowly under load
    const until = performance.now() + 4_000
    while (!fileReads().length && performance.now() < until) await new Promise((resolve) => setImmediate(resolve))
    expect(fileReads()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(done, 'went on before the account had its time').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(kept(B)).toBeUndefined()
  })

  it('a naming key that never answers lets the caller go on in the same time, and keeps nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    readHangs = (path) => path === NAME_KEY_PATH
    cloudFiles.set(await pathOf(B), bytes(2))
    let done = false
    const pending = keepSyncedTorrentFile(B).then(() => { done = true })
    await vi.advanceTimersByTimeAsync(9_999)
    expect(done, 'went on before the account had its time').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(done, 'Download, a move or Save .torrent waited past the bound for the naming key').toBe(true)
    await pending
    expect(fileReads()).toEqual([])
    expect(kept(B)).toBeUndefined()
  })

  it('a write that fails is tried again on the next pass', async () => {
    writeFails = true
    store.set('ripple:torrent:' + A, bytes(7))
    await expect(syncTorrentFiles([A])).resolves.toBeUndefined()
    expect(kept(A)).toEqual(bytes(7))
    writeFails = false
    await syncTorrentFiles([A])
    expect(cloudFiles.get(await pathOf(A))).toEqual(bytes(7))
  })

  it('a listing that fails sends nothing, and the next pass does', async () => {
    listFails = true
    store.set('ripple:torrent:' + A, bytes(7))
    await expect(syncTorrentFiles([A])).resolves.toBeUndefined()
    expect(fileWrites()).toEqual([])
    expect(kept(A)).toEqual(bytes(7))
    listFails = false
    await syncTorrentFiles([A])
    expect(fileWrites()).toEqual([await pathOf(A)])
  })

  it('a key that cannot be read writes nothing and keeps nothing', async () => {
    readFails = (path) => path === NAME_KEY_PATH
    store.set('ripple:torrent:' + A, bytes(7))
    cloudFiles.set(await pathOf(B), bytes(2))
    await expect(syncTorrentFiles([A])).resolves.toBeUndefined()
    await expect(keepSyncedTorrentFile(B)).resolves.toBeUndefined()
    expect(writes).toEqual([])
    expect(kept(B)).toBeUndefined()
    expect(kept(A)).toEqual(bytes(7))
  })

  it('a delete that fails does not throw', async () => {
    unlinkFails = true
    cloudFiles.set(await pathOf(A), bytes(7))
    await expect(forgetSyncedTorrentFiles([A])).resolves.toBeUndefined()
  })

  it('a download never writes over a file this device kept meanwhile', async () => {
    cloudFiles.set(await pathOf(B), bytes(2))
    onRead = () => { store.set('ripple:torrent:' + B, bytes(5)) }
    await keepSyncedTorrentFile(B)
    expect(kept(B)).toEqual(bytes(5))
  })
})
