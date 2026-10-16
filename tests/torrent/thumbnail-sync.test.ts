import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Carrying one picture per torrent between a person's own devices.
 *
 * The asymmetry is the whole design: a thumbnail is made from bytes on disk, so a device that never
 * downloaded a torrent cannot make one and can only be handed one. Every case below is really the
 * same question asked from one side or the other.
 *
 * Everything here is an improvement rather than a requirement, so the properties that matter most
 * are the negative ones: a failure must not throw, must not lose the local picture, and must not
 * turn "nobody has uploaded this yet" into "never ask again".
 */

const store = new Map<string, unknown>()
const cloudFiles = new Map<string, Uint8Array>()
const reads: string[] = []
const writes: string[] = []
const unlinks: string[] = []
const listings: string[] = []
let readFails: (path: string) => boolean = () => false
let writeFails = false
/** Bytes another device's key write lands with, after this device's own. */
let theirKey: Uint8Array | null = null

const notFound = () => Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })

vi.mock('idb-keyval', () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => { store.set(k, v) },
  del: async (k: string) => { store.delete(k) },
}))

vi.mock('@fkn/lib', () => ({
  cloud: {
    fs: {
      isNotFound: (err: unknown) => (err as { code?: string })?.code === 'FKN_STORAGE_NOT_FOUND',
      promises: {
        readFile: async (path: string) => {
          reads.push(String(path))
          if (readFails(String(path))) throw new Error('broker said no')
          const hit = cloudFiles.get(String(path))
          if (!hit) throw notFound()
          return hit
        },
        writeFile: async (path: string, data: Uint8Array) => {
          writes.push(String(path))
          if (writeFails) throw new Error('broker said no')
          cloudFiles.set(String(path), path === NAME_KEY_PATH && theirKey ? theirKey : data)
        },
        unlink: async (path: string) => {
          unlinks.push(String(path))
          if (!cloudFiles.delete(String(path))) throw notFound()
        },
        readdir: async (dir: string) => {
          listings.push(String(dir))
          const prefix = String(dir) + '/'
          return [...cloudFiles.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length))
        },
      },
    },
  },
}))

const local = new Set<string>()
const loaded: string[][] = []
vi.mock('../../src/torrent/thumbnail-store', () => ({
  thumbnailFor: (infoHash: string) => (local.has(infoHash) ? 'blob:' + infoHash : null),
  loadCachedThumbnails: async (hashes: string[]) => { loaded.push(hashes) },
}))

const { LEGACY_DIR, NAME_KEY_PATH, forgetSyncedThumbnails, resetThumbnailSync, syncThumbnails, thumbPath } =
  await import('../../src/torrent/thumbnail-sync')

const KEY = new Uint8Array(32).fill(1)
const OTHER_KEY = new Uint8Array(32).fill(2)

/** Where a picture should be, worked out here rather than asked of the code under test. */
const pathOf = async (infoHash: string, key: Uint8Array = KEY) => {
  const hmac = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(infoHash)))
  return thumbPath([...mac].map((b) => b.toString(16).padStart(2, '0')).join(''))
}
const pictureReads = () => reads.filter((p) => p !== NAME_KEY_PATH)
const pictureWrites = () => writes.filter((p) => p !== NAME_KEY_PATH)
const legacyPath = (infoHash: string) => `${LEGACY_DIR}/${infoHash}.webp`

const blob = (bytes = 3) => new Blob([new Uint8Array(bytes).fill(9)], { type: 'image/webp' })

const HASH = 'a'.repeat(40)

beforeEach(() => {
  store.clear(); cloudFiles.clear(); local.clear()
  reads.length = 0; writes.length = 0; unlinks.length = 0; listings.length = 0; loaded.length = 0
  readFails = () => false; writeFails = false; theirKey = null
  cloudFiles.set(NAME_KEY_PATH, KEY)
  resetThumbnailSync()
})

afterEach(() => { resetThumbnailSync() })

describe('carrying thumbnails between devices', () => {
  it('uploads a picture this device has and the account does not', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob())
    await syncThumbnails(['aa'])
    expect(pictureWrites()).toEqual([await pathOf('aa')])
    expect(cloudFiles.has(await pathOf('aa'))).toBe(true)
  })

  it('uploads each picture once, not once per pass', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob())
    await syncThumbnails(['aa'])
    await syncThumbnails(['aa'])
    await syncThumbnails(['aa'])
    expect(pictureWrites()).toHaveLength(1)
  })

  /** the case the whole file exists for: a device holding a library it has no files for */
  it('downloads a picture this device cannot make', async () => {
    cloudFiles.set(await pathOf('bb'), new Uint8Array([1, 2, 3]))
    await syncThumbnails(['bb'])
    expect(store.get('ripple:thumb:bb')).toBeInstanceOf(Blob)
    // and told the store, or the row would not show it until the next reload
    expect(loaded).toEqual([['bb']])
  })

  it('never downloads over a picture this device already has', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob(5))
    cloudFiles.set(await pathOf('aa'), new Uint8Array(99))
    await syncThumbnails(['aa'])
    expect(pictureReads()).toEqual([])
    expect((store.get('ripple:thumb:aa') as Blob).size).toBe(5)
  })

  it('asks once for a picture nobody has uploaded, rather than every pass', async () => {
    await syncThumbnails(['cc'])
    await syncThumbnails(['cc'])
    await syncThumbnails(['cc'])
    expect(pictureReads()).toHaveLength(1)
  })

  /**
   * A miss is "not there YET". Remembering it across a restore would turn a torrent whose owner
   * device simply has not uploaded into one this device never asks about again.
   */
  it('asks again after a restore says something changed', async () => {
    await syncThumbnails(['cc'])
    resetThumbnailSync()
    cloudFiles.set(await pathOf('cc'), new Uint8Array([7]))
    await syncThumbnails(['cc'])
    expect(pictureReads()).toHaveLength(2)
    expect(store.get('ripple:thumb:cc')).toBeInstanceOf(Blob)
  })

  it('bounds how many objects one pass touches', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 'h' + i)
    for (const h of many) cloudFiles.set(await pathOf(h), new Uint8Array([1]))
    await syncThumbnails(many)
    expect(pictureReads().length).toBeLessThanOrEqual(6)
  })

  it('bounds uploads the same way', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 'h' + i)
    for (const h of many) { local.add(h); store.set('ripple:thumb:' + h, blob()) }
    await syncThumbnails(many)
    expect(pictureWrites().length).toBeLessThanOrEqual(6)
  })

  it('sends nothing for a hash whose local blob is empty', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', new Blob([], { type: 'image/webp' }))
    await syncThumbnails(['aa'])
    expect(writes).toEqual([])
  })

  it('survives a broker that refuses to read, leaving the local picture alone', async () => {
    readFails = () => true
    local.add('aa')
    store.set('ripple:thumb:aa', blob(5))
    await expect(syncThumbnails(['aa', 'bb'])).resolves.toBeUndefined()
    expect((store.get('ripple:thumb:aa') as Blob).size).toBe(5)
  })

  it('survives a broker that refuses to write, and tries again next pass', async () => {
    writeFails = true
    local.add('aa')
    store.set('ripple:thumb:aa', blob())
    await expect(syncThumbnails(['aa'])).resolves.toBeUndefined()
    writeFails = false
    await syncThumbnails(['aa'])
    expect(cloudFiles.has(await pathOf('aa'))).toBe(true)
  })

  it('does nothing at all for an empty library', async () => {
    await expect(syncThumbnails([])).resolves.toBeUndefined()
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })
})

/** HOR-535: a file's name is visible to FKN, so it must not be the torrent's info hash. */
describe('naming a picture so the account cannot tell which torrent it is', () => {
  it('names the picture by a keyed hash, never by the info hash', async () => {
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    expect(pictureWrites()).toEqual([await pathOf(HASH)])
    expect(writes.join(' ')).not.toContain(HASH)
  })

  it('makes the key once, sealed in the account, when the account has none', async () => {
    cloudFiles.delete(NAME_KEY_PATH)
    local.add(HASH); local.add('bb')
    store.set('ripple:thumb:' + HASH, blob()); store.set('ripple:thumb:bb', blob())
    await syncThumbnails([HASH])
    await syncThumbnails([HASH, 'bb'])
    const made = cloudFiles.get(NAME_KEY_PATH)!
    expect(made.byteLength).toBe(32)
    expect(writes.filter((p) => p === NAME_KEY_PATH)).toHaveLength(1)
    expect(pictureWrites()).toEqual([await pathOf(HASH, made), await pathOf('bb', made)])
  })

  it('keeps an existing key', async () => {
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    expect(writes).not.toContain(NAME_KEY_PATH)
    expect(cloudFiles.get(NAME_KEY_PATH)).toBe(KEY)
  })

  it('never replaces a key it could not read', async () => {
    readFails = (path) => path === NAME_KEY_PATH
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    expect(writes).toEqual([])
    expect(cloudFiles.get(NAME_KEY_PATH)).toBe(KEY)
  })

  it('ends on the key that landed when two devices make one at once', async () => {
    cloudFiles.delete(NAME_KEY_PATH)
    theirKey = OTHER_KEY
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    expect(pictureWrites()).toEqual([await pathOf(HASH, OTHER_KEY)])
  })

  it('keeps the key out of this device\'s storage', async () => {
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    for (const value of store.values()) expect(value).not.toEqual(KEY)
  })

  it('reads the key again after a restore, for the account now signed in', async () => {
    local.add(HASH); local.add('bb')
    store.set('ripple:thumb:' + HASH, blob()); store.set('ripple:thumb:bb', blob())
    await syncThumbnails([HASH])
    resetThumbnailSync()
    cloudFiles.set(NAME_KEY_PATH, OTHER_KEY)
    await syncThumbnails(['bb'])
    expect(pictureWrites()).toEqual([await pathOf(HASH), await pathOf('bb', OTHER_KEY)])
  })
})

describe('pictures stored under their info hash', () => {
  it('moves one still in the library to its new name and deletes the old one', async () => {
    cloudFiles.set(legacyPath(HASH), new Uint8Array([4, 5, 6]))
    await syncThumbnails([HASH])
    expect(cloudFiles.has(legacyPath(HASH))).toBe(false)
    expect([...cloudFiles.get(await pathOf(HASH))!]).toEqual([4, 5, 6])
  })

  it('does not upload a moved picture again from this device', async () => {
    cloudFiles.set(legacyPath(HASH), new Uint8Array([4, 5, 6]))
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    await syncThumbnails([HASH])
    expect(pictureWrites()).toEqual([await pathOf(HASH)])
  })

  it('deletes one whose torrent is no longer in the library', async () => {
    const gone = 'b'.repeat(40)
    cloudFiles.set(legacyPath(gone), new Uint8Array([1]))
    await syncThumbnails([HASH])
    expect(cloudFiles.has(legacyPath(gone))).toBe(false)
    expect(pictureWrites()).toEqual([])
  })

  it('deletes them even when the library is empty', async () => {
    cloudFiles.set(legacyPath(HASH), new Uint8Array([1]))
    await syncThumbnails([])
    expect(cloudFiles.has(legacyPath(HASH))).toBe(false)
  })

  it('keeps one it could not read, for a later session', async () => {
    cloudFiles.set(legacyPath(HASH), new Uint8Array([1]))
    readFails = (path) => path === legacyPath(HASH)
    await syncThumbnails([HASH])
    expect(cloudFiles.has(legacyPath(HASH))).toBe(true)
    expect(cloudFiles.has(await pathOf(HASH))).toBe(false)
  })

  it('moves a few per pass, and stops asking once none are left', async () => {
    const many = Array.from({ length: 10 }, (_, i) => String(i).repeat(40))
    for (const h of many) cloudFiles.set(legacyPath(h), new Uint8Array([1]))
    await syncThumbnails(many)
    expect(unlinks.length).toBeLessThanOrEqual(6)
    await syncThumbnails(many)
    await syncThumbnails(many)
    await syncThumbnails(many)
    expect([...cloudFiles.keys()].filter((p) => p.startsWith(LEGACY_DIR + '/'))).toEqual([])
    expect(listings).toHaveLength(2)
    for (const h of many) expect(cloudFiles.has(await pathOf(h))).toBe(true)
  })

  it('never reads an old name except to move it', async () => {
    cloudFiles.set(await pathOf(HASH), new Uint8Array([1]))
    await syncThumbnails([HASH])
    expect(reads.filter((p) => p.startsWith(LEGACY_DIR + '/'))).toEqual([])
  })
})

describe('a removed torrent\'s picture', () => {
  it('is deleted from the account', async () => {
    cloudFiles.set(await pathOf(HASH), new Uint8Array([1]))
    await forgetSyncedThumbnails([HASH])
    expect(cloudFiles.has(await pathOf(HASH))).toBe(false)
  })

  it('is uploaded again when the torrent is added again', async () => {
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    await forgetSyncedThumbnails([HASH])
    await syncThumbnails([HASH])
    expect(pictureWrites()).toEqual([await pathOf(HASH), await pathOf(HASH)])
    expect(cloudFiles.has(await pathOf(HASH))).toBe(true)
  })

  /** removed on another device, which deleted the picture: this one only sees it leave the list */
  it('is uploaded again after leaving the list and coming back', async () => {
    local.add(HASH)
    store.set('ripple:thumb:' + HASH, blob())
    await syncThumbnails([HASH])
    cloudFiles.delete(await pathOf(HASH))
    await syncThumbnails(['bb'])
    await syncThumbnails([HASH])
    expect(cloudFiles.has(await pathOf(HASH))).toBe(true)
  })
})
