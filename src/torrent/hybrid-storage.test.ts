import { describe, expect, it, vi } from 'vitest'

import { createHybridStorage, isNativeSavePath, nativeSavePathFor, NATIVE_ROOT } from './hybrid-storage'
import type { MeasurableStorage } from './opfs-storage'

/**
 * Serving a torrent out of the user's own folder.
 *
 * The reason this exists: libtorrent uploads by reading the file back, so dropping Ripple's OPFS
 * copy used to mean the torrent could no longer be shared. Reading is the only thing sharing needs,
 * and reading a granted folder is perfectly possible, so the cost was a property of the backend
 * rather than of the browser.
 *
 * Writing is NOT possible, and that is not an omission. `createSyncAccessHandle` on a picker-granted
 * file throws `InvalidStateError: Access Handles may only be created on temporary file systems`,
 * measured against an OPFS control that succeeded in the same worker, so the only write path is
 * `createWritable`, which publishes by renaming over the user's file. Hence read only, and hence the
 * two tests below that pin what happens when something asks this to write or to delete.
 */

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill)

/** the two methods this backend uses on a directory: walk into it, and open a file for reading */
const fakeFolder = (files: Record<string, Uint8Array>) => {
  const make = (prefix: string): FileSystemDirectoryHandle => ({
    getDirectoryHandle: async (name: string) => {
      const under = prefix + name + '/'
      if (!Object.keys(files).some((p) => p.startsWith(under))) throw new Error('NotFoundError: ' + under)
      return make(under)
    },
    getFileHandle: async (name: string) => {
      const data = files[prefix + name]
      if (!data) throw new Error('NotFoundError: ' + prefix + name)
      return {
        getFile: async () => ({
          size: data.length,
          slice: (start: number, end: number) => ({ arrayBuffer: async () => data.slice(start, end).buffer }),
        }),
      }
    },
  } as unknown as FileSystemDirectoryHandle)
  return make('')
}

const fakeOpfs = () => ({
  usageOf: vi.fn(async () => 1234),
  onNewStorage: vi.fn(),
  onRemoveStorage: vi.fn(),
  read: vi.fn(async () => bytes(4, 9)),
  write: vi.fn(),
  release: vi.fn(async () => {}),
  check: vi.fn(async () => 0),
  deleteFiles: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}) as unknown as MeasurableStorage & Record<string, ReturnType<typeof vi.fn>>

const mounted = (files: Record<string, Uint8Array>, meta: Array<{ path: string, size: number }>) => {
  const opfs = fakeOpfs()
  const storage = createHybridStorage(opfs, () => fakeFolder(files))
  storage.onNewStorage(1, nativeSavePathFor('abc'), meta)
  return { opfs, storage }
}

describe('telling the two storages apart', () => {
  it('recognises a native save path', () => {
    expect(isNativeSavePath(nativeSavePathFor('abc'))).toBe(true)
    expect(isNativeSavePath(NATIVE_ROOT)).toBe(true)
  })

  it('leaves every OPFS path alone, including one that merely looks similar', () => {
    for (const path of ['/dl', '/dl/abc', '/nativeish/abc', undefined]) expect(isNativeSavePath(path)).toBe(false)
  })

  it('passes an OPFS torrent through untouched', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(7, '/dl/abc', [{ path: 'a.bin', size: 4 }])
    await storage.read(7, 0, 0, 4)
    expect(opfs.onNewStorage).toHaveBeenCalled()
    expect(opfs.read).toHaveBeenCalledWith(7, 0, 0, 4)
  })
})

describe('reading out of the user folder', () => {
  const data = bytes(1000, 5)

  it('answers a read from the file on their disk', async () => {
    const { storage, opfs } = mounted({ 'a.bin': data }, [{ path: 'a.bin', size: 1000 }])
    expect(await storage.read(1, 0, 100, 16)).toEqual(bytes(16, 5))
    expect(opfs.read).not.toHaveBeenCalled()
  })

  it('walks into subdirectories, which is how a multi-file torrent is laid out', async () => {
    const { storage } = mounted({ 'pack/season/ep1.mkv': data }, [{ path: 'pack/season/ep1.mkv', size: 1000 }])
    expect(await storage.read(1, 0, 0, 8)).toEqual(bytes(8, 5))
  })

  /**
   * The direction that would get us dropped by peers. A short read means their file is not what the
   * torrent describes, and zero-filling it hands a peer bytes that fail its hash check.
   */
  it('errors on a short read rather than padding it with zeros', async () => {
    const { storage } = mounted({ 'a.bin': bytes(500, 5) }, [{ path: 'a.bin', size: 1000 }])
    await expect(storage.read(1, 0, 400, 200)).rejects.toThrow(/ended early/)
  })

  it('errors when the file is gone, rather than creating an empty one', async () => {
    const { storage } = mounted({}, [{ path: 'a.bin', size: 1000 }])
    await expect(storage.read(1, 0, 0, 16)).rejects.toThrow(/NotFoundError/)
  })

  it('errors while the grant is missing, which is an ordinary state after a reload', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(1, nativeSavePathFor('abc'), [{ path: 'a.bin', size: 4 }])
    await expect(storage.read(1, 0, 0, 4)).rejects.toThrow(/no folder granted/)
  })

  it('rejects a file index the torrent does not have', () => {
    const { storage } = mounted({ 'a.bin': data }, [{ path: 'a.bin', size: 1000 }])
    expect(() => storage.read(1, 4, 0, 16)).toThrow(/no file 4/)
  })
})

describe('what must never happen to the user files', () => {
  /**
   * `removeTorrent(handle, true)` means "delete the download" and does exactly that on every other
   * storage. Here the download IS the user's own copy, and the whole reason the torrent points at
   * this folder is that Ripple stopped keeping a second one.
   */
  it('deletes nothing, and does not pass the delete down to OPFS either', async () => {
    const files = { 'a.bin': bytes(1000, 5) }
    const { storage, opfs } = mounted(files, [{ path: 'a.bin', size: 1000 }])
    await storage.deleteFiles!(1, 0)
    expect(opfs.deleteFiles).not.toHaveBeenCalled()
    expect(files['a.bin']).toEqual(bytes(1000, 5))
    // and it stays readable afterwards, so the delete really did nothing at all
    expect(await storage.read(1, 0, 0, 4)).toEqual(bytes(4, 5))
  })

  it('still deletes an ordinary OPFS torrent', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(2, '/dl/abc', [{ path: 'a.bin', size: 4 }])
    await storage.deleteFiles!(2, 0)
    expect(opfs.deleteFiles).toHaveBeenCalledWith(2, 0)
  })

  it('refuses a write loudly rather than touching anything', () => {
    const { storage, opfs } = mounted({ 'a.bin': bytes(1000, 5) }, [{ path: 'a.bin', size: 1000 }])
    expect(() => storage.write(1, 0, 0, bytes(16, 1))).toThrow(/read only/)
    expect(opfs.write).not.toHaveBeenCalled()
  })

  it('still writes an ordinary OPFS torrent', () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(2, '/dl/abc', [{ path: 'a.bin', size: 4 }])
    storage.write(2, 0, 0, bytes(4, 1))
    expect(opfs.write).toHaveBeenCalled()
  })
})

describe('the quota the origin is charged', () => {
  it('reports nothing for files that are not in browser storage at all', async () => {
    const { storage, opfs } = mounted({ 'a.bin': bytes(1000, 5) }, [{ path: 'a.bin', size: 1000 }])
    expect(await storage.usageOf(nativeSavePathFor('abc'))).toBe(0)
    expect(opfs.usageOf).not.toHaveBeenCalled()
  })

  it('still asks OPFS about an OPFS path', async () => {
    const { storage } = mounted({}, [])
    expect(await storage.usageOf('/dl/abc')).toBe(1234)
  })
})

/**
 * `no_error` here means "there is nothing to verify", not "everything is fine", and getting that
 * backwards is silent: the torrent starts with an EMPTY have-set, believes it holds nothing, and
 * seeds nothing. A torrent is pointed at this backend precisely because the files ARE there, and it
 * arrives with no resume data, so hashing them is the only way it learns what it has.
 */
describe('the check on startup', () => {
  it('asks for a full check when the files are there, which is what builds the have-set', async () => {
    const { storage } = mounted({ 'a.bin': bytes(1000, 5), 'b.bin': bytes(20, 5) }, [
      { path: 'a.bin', size: 1000 },
      { path: 'b.bin', size: 20 },
    ])
    expect(await storage.check!(1)).toBe(2)
  })

  it('asks for one when only some of the files are there', async () => {
    const { storage } = mounted({ 'a.bin': bytes(1000, 5) }, [
      { path: 'a.bin', size: 1000 },
      { path: 'b.bin', size: 20 },
    ])
    expect(await storage.check!(1)).toBe(2)
  })

  it('reports an empty folder as nothing to check', async () => {
    const { storage } = mounted({}, [{ path: 'a.bin', size: 1000 }])
    expect(await storage.check!(1)).toBe(0)
  })

  it('asks for a full check when the grant is missing, rather than claiming emptiness', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(1, nativeSavePathFor('abc'), [{ path: 'a.bin', size: 4 }])
    expect(await storage.check!(1)).toBe(2)
  })

  it('still asks OPFS about an OPFS torrent', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(2, '/dl/abc', [])
    await storage.check!(2)
    expect(opfs.check).toHaveBeenCalledWith(2)
  })
})

describe('unmounting', () => {
  it('forgets a native storage without telling OPFS about it', async () => {
    const { storage, opfs } = mounted({ 'a.bin': bytes(4, 5) }, [{ path: 'a.bin', size: 4 }])
    await storage.onRemoveStorage(1)
    expect(opfs.onRemoveStorage).not.toHaveBeenCalled()
    // it is no longer native, so the next read falls through to OPFS rather than the folder
    await storage.read(1, 0, 0, 4)
    expect(opfs.read).toHaveBeenCalled()
  })

  it('passes an OPFS unmount down', async () => {
    const opfs = fakeOpfs()
    const storage = createHybridStorage(opfs, () => null)
    storage.onNewStorage(3, '/dl/abc', [])
    await storage.onRemoveStorage(3)
    expect(opfs.onRemoveStorage).toHaveBeenCalledWith(3)
  })
})
