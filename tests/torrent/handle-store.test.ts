import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The memory-first contract, against a mocked IndexedDB. Reading a stored handle back is what kills
 * Chrome 153 off the record, so what is pinned here is WHEN the store is read at all. The hooks
 * that use this are pinned in a real browser by handle-read-back.browser.test.tsx.
 */
const idb = vi.hoisted(() => ({
  get: vi.fn(async (_key: string): Promise<unknown> => undefined),
  set: vi.fn(async (_key: string, _value: unknown) => {}),
  del: vi.fn(async (_key: string) => {}),
}))
vi.mock('idb-keyval', () => idb)

const { forgetHandle, loadHandle, storeHandle } = await import('../../src/torrent/handle-store')

const handle = (name: string) => ({ kind: 'directory', name }) as unknown as FileSystemDirectoryHandle

beforeEach(() => {
  idb.get.mockClear()
  idb.set.mockClear()
  idb.del.mockClear()
})

describe('a handle this page stored', () => {
  it('is answered from memory, and IndexedDB is never read for it', async () => {
    const root = handle('Pack')
    await storeHandle('k:stored', root)
    expect(idb.set).toHaveBeenCalledWith('k:stored', root)

    expect(await loadHandle('k:stored')).toBe(root)
    expect(await loadHandle('k:stored')).toBe(root)
    expect(idb.get, 'a read of a stored handle is the one that crashes').not.toHaveBeenCalled()
  })

  it('is replaced by the next store under the same key', async () => {
    await storeHandle('k:replaced', handle('first'))
    const second = handle('second')
    await storeHandle('k:replaced', second)
    expect(await loadHandle('k:replaced')).toBe(second)
    expect(idb.get).not.toHaveBeenCalled()
  })

  it('is not remembered when IndexedDB refused it, so the load falls through to the store', async () => {
    idb.set.mockRejectedValueOnce(new DOMException('no', 'DataCloneError'))
    await expect(storeHandle('k:refused', handle('Wrapped'))).rejects.toThrow('no')

    expect(await loadHandle('k:refused')).toBeUndefined()
    expect(idb.get).toHaveBeenCalledWith('k:refused')
  })

  it('is forgotten in memory and in IndexedDB', async () => {
    await storeHandle('k:forgotten', handle('Gone'))
    await forgetHandle('k:forgotten')
    expect(idb.del).toHaveBeenCalledWith('k:forgotten')

    expect(await loadHandle('k:forgotten')).toBeUndefined()
    expect(idb.get).toHaveBeenCalledWith('k:forgotten')
  })
})

describe('a handle this page did not store', () => {
  it('is read from IndexedDB, which is the reload and the other tab', async () => {
    const elsewhere = handle('From another tab')
    idb.get.mockResolvedValueOnce(elsewhere)
    expect(await loadHandle('k:elsewhere')).toBe(elsewhere)
    expect(idb.get).toHaveBeenCalledWith('k:elsewhere')
  })

  it('is not taken from another key held in memory', async () => {
    await storeHandle('k:one', handle('One'))
    expect(await loadHandle('k:two')).toBeUndefined()
    expect(idb.get).toHaveBeenCalledWith('k:two')
  })
})
