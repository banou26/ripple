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
let readFails = false
let writeFails = false

vi.mock('idb-keyval', () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => { store.set(k, v) },
  del: async (k: string) => { store.delete(k) },
}))

vi.mock('@fkn/lib', () => ({
  cloud: {
    fs: {
      promises: {
        readFile: async (path: string) => {
          reads.push(String(path))
          if (readFails) throw new Error('broker said no')
          const hit = cloudFiles.get(String(path))
          if (!hit) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: Uint8Array) => {
          writes.push(String(path))
          if (writeFails) throw new Error('broker said no')
          cloudFiles.set(String(path), data)
        },
      },
    },
  },
}))

const local = new Set<string>()
const loaded: string[][] = []
vi.mock('./thumbnail-store', () => ({
  thumbnailFor: (infoHash: string) => (local.has(infoHash) ? 'blob:' + infoHash : null),
  loadCachedThumbnails: async (hashes: string[]) => { loaded.push(hashes) },
}))

const { retryMissedThumbnails, syncThumbnails, thumbPath } = await import('./thumbnail-sync')

const blob = (bytes = 3) => new Blob([new Uint8Array(bytes).fill(9)], { type: 'image/webp' })

beforeEach(() => {
  store.clear(); cloudFiles.clear(); local.clear()
  reads.length = 0; writes.length = 0; loaded.length = 0
  readFails = false; writeFails = false
  retryMissedThumbnails()
})

afterEach(() => { retryMissedThumbnails() })

describe('carrying thumbnails between devices', () => {
  it('uploads a picture this device has and the account does not', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob())
    await syncThumbnails(['aa'])
    expect(writes).toEqual([thumbPath('aa')])
    expect(cloudFiles.has(thumbPath('aa'))).toBe(true)
  })

  it('uploads each picture once, not once per pass', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob())
    await syncThumbnails(['aa'])
    await syncThumbnails(['aa'])
    await syncThumbnails(['aa'])
    expect(writes).toHaveLength(1)
  })

  /** the case the whole file exists for: a device holding a library it has no files for */
  it('downloads a picture this device cannot make', async () => {
    cloudFiles.set(thumbPath('bb'), new Uint8Array([1, 2, 3]))
    await syncThumbnails(['bb'])
    expect(store.get('ripple:thumb:bb')).toBeInstanceOf(Blob)
    // and told the store, or the row would not show it until the next reload
    expect(loaded).toEqual([['bb']])
  })

  it('never downloads over a picture this device already has', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', blob(5))
    cloudFiles.set(thumbPath('aa'), new Uint8Array(99))
    await syncThumbnails(['aa'])
    expect(reads).toEqual([])
    expect((store.get('ripple:thumb:aa') as Blob).size).toBe(5)
  })

  it('asks once for a picture nobody has uploaded, rather than every pass', async () => {
    await syncThumbnails(['cc'])
    await syncThumbnails(['cc'])
    await syncThumbnails(['cc'])
    expect(reads).toHaveLength(1)
  })

  /**
   * A miss is "not there YET". Remembering it across a restore would turn a torrent whose owner
   * device simply has not uploaded into one this device never asks about again.
   */
  it('asks again after a restore says something changed', async () => {
    await syncThumbnails(['cc'])
    retryMissedThumbnails()
    cloudFiles.set(thumbPath('cc'), new Uint8Array([7]))
    await syncThumbnails(['cc'])
    expect(reads).toHaveLength(2)
    expect(store.get('ripple:thumb:cc')).toBeInstanceOf(Blob)
  })

  it('bounds how many objects one pass touches', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 'h' + i)
    for (const h of many) cloudFiles.set(thumbPath(h), new Uint8Array([1]))
    await syncThumbnails(many)
    expect(reads.length).toBeLessThanOrEqual(6)
  })

  it('bounds uploads the same way', async () => {
    const many = Array.from({ length: 40 }, (_, i) => 'h' + i)
    for (const h of many) { local.add(h); store.set('ripple:thumb:' + h, blob()) }
    await syncThumbnails(many)
    expect(writes.length).toBeLessThanOrEqual(6)
  })

  it('sends nothing for a hash whose local blob is empty', async () => {
    local.add('aa')
    store.set('ripple:thumb:aa', new Blob([], { type: 'image/webp' }))
    await syncThumbnails(['aa'])
    expect(writes).toEqual([])
  })

  it('survives a broker that refuses to read, leaving the local picture alone', async () => {
    readFails = true
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
    expect(cloudFiles.has(thumbPath('aa'))).toBe(true)
  })

  it('does nothing at all for an empty library', async () => {
    await expect(syncThumbnails([])).resolves.toBeUndefined()
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })
})
