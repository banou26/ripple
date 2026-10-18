import { describe, expect, it } from 'vitest'

import { createResilientStorage } from '../../src/torrent/opfs-storage'
import { fakeDir } from '../utils/worker-rig'

const HASH = 'a'.repeat(40)
const SAVE_PATH = '/dl/' + HASH
const PIECE = 8 * 1024 * 1024

/**
 * A sync access handle that lands at most `room.bytes` of any write and throws nothing, which is how
 * Firefox meets its quota (measured on Firefox 157, 2026-10-19: 0 when none of it fits, 78,643,200
 * for 200 MiB into about 75 MiB of room).
 */
const syncHandle = (room: { bytes: number }) => {
  let size = 0
  return {
    write: (buffer: Uint8Array, options?: { at?: number }) => {
      const wrote = Math.min(room.bytes, buffer.byteLength)
      if (wrote) size = Math.max(size, (options?.at ?? 0) + wrote)
      return wrote
    },
    read: () => 0,
    getSize: () => size,
    truncate: () => {},
    flush: () => {},
    close: () => {},
  }
}

const file = (name: string, handle: ReturnType<typeof syncHandle>) => ({
  kind: 'file' as const,
  name,
  size: 0,
  getFile: async () => ({ size: handle.getSize() }),
  createSyncAccessHandle: async () => handle,
})

// the real OPFSStorage from libtorrent-wasm runs underneath, against this tree
const mount = (files: ReturnType<typeof file>[]) => {
  const root = fakeDir('', [fakeDir('dl', [fakeDir(HASH, files)])])
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: { storage: { getDirectory: async () => root } },
  })
}

describe('a write the browser refuses for want of room', () => {
  it('stops at once as QuotaExceededError, and says which file it was until the torrent is mounted again', async () => {
    const room = { bytes: 0 }
    mount([file('extras.mkv', syncHandle(room)), file('film.mkv', syncHandle(room))])
    const storage = createResilientStorage()
    const files = [{ path: 'extras.mkv', size: 4_000 }, { path: 'film.mkv', size: 10_624_058_159 }]
    await storage.onNewStorage(1, SAVE_PATH, files)
    expect(storage.refusedFile(SAVE_PATH)).toBeUndefined()

    const started = Date.now()
    await expect(Promise.resolve().then(() => storage.write(1, 1, 10_624_058_159 - PIECE, new Uint8Array(PIECE))))
      .rejects.toMatchObject({ name: 'QuotaExceededError' })
    // the retries wait 3 s in all, for a lock a full origin is not holding
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(storage.refusedFile(SAVE_PATH)).toBe(1)

    // the head of a file too big to fit still lands, and must not hide that its tail never will
    room.bytes = Infinity
    await storage.write(1, 1, 0, new Uint8Array(16))
    expect(storage.refusedFile(SAVE_PATH)).toBe(1)

    await storage.onNewStorage(1, SAVE_PATH, files)
    expect(storage.refusedFile(SAVE_PATH)).toBeUndefined()
  })
})

describe('usageOf', () => {
  it('measures one file of a torrent when asked for one', async () => {
    const room = { bytes: Infinity }
    mount([file('e01.mkv', syncHandle(room)), file('e02.mkv', syncHandle(room))])
    const storage = createResilientStorage()
    await storage.onNewStorage(2, SAVE_PATH, [{ path: 'e01.mkv', size: 4_000 }, { path: 'e02.mkv', size: 6_000 }])
    await storage.write(2, 0, 0, new Uint8Array(4_000))
    await storage.write(2, 1, 5_999, new Uint8Array(1))

    expect(await storage.usageOf(SAVE_PATH)).toBe(10_000)
    expect(await storage.usageOf(SAVE_PATH, 1)).toBe(6_000)
  })
})
