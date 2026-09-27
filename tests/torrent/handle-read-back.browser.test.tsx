import type { TorrentClient } from '../../src/torrent/client'
import type { Persisted } from '../../src/torrent/library'

import { describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

/**
 * The two hooks that store a FileSystemHandle use the one they hold, and never read it back.
 *
 * Reading a stored handle out of IndexedDB kills Chrome 153 in an off-the-record profile (see
 * src/torrent/handle-store.ts), and this project's context is one. So the spy below records every
 * read and never performs one for a handle key: it answers `undefined`, as an empty store would. A
 * hook that reads its handle back then fails here on any engine, on the missing handle, rather than
 * taking the whole browser down on 153 and passing everywhere else.
 *
 * Real OPFS handles throughout, so the store, the clone to the worker and the re-walk are real.
 */
const HANDLE_KEYS = /^ripple:(source:|folder$)/
const reads = vi.hoisted(() => [] as string[])
vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>()
  return {
    ...real,
    // every key ripple reads is a string
    get: async (key: string) => {
      reads.push(key)
      return HANDLE_KEYS.test(key) ? undefined : await real.get(key)
    },
  }
})
// the runner puts every test in a frame, where the folder control refuses to offer itself
vi.mock('../../src/utils/framed', () => ({ isFramed: () => false }))

const { DEFAULT_TRACKERS, useCreateTorrent, useCreatedSources } = await import('../../src/torrent/use-create-torrent')
const { useFolder } = await import('../../src/torrent/use-folder')

const directory = async (name: string, files: { name: string, bytes: number }[] = []) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
  for (const file of files) {
    const writable = await (await dir.getFileHandle(file.name, { create: true })).createWritable()
    await writable.write(new Uint8Array(file.bytes).fill(0x5a))
    await writable.close()
  }
  return dir
}

const stubPicker = (dir: FileSystemDirectoryHandle) => {
  (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = async () => dir
}

type Created = { infoHash: string, magnet: string, name: string, size: number, format: Persisted['format'], pieceLength: number, reopenable: boolean }

const fakeClient = () => {
  const created: Created[] = []
  const started: { infoHash: string, handles: unknown[] }[] = []
  const client = {
    createSource: (torrent: Created) => { created.push(structuredClone(torrent)) },
    startSource: (infoHash: string, handles: unknown[]) => { started.push({ infoHash, handles }) },
    addTorrentFile: () => {},
    reserveStorage: () => {},
    setLocation: () => {},
  } as unknown as TorrentClient
  return { client, created, started }
}

/** The entry the worker writes for a `create-source`, as the list then carries it. */
const entryFor = (c: Created): Persisted => ({
  infoHash: c.infoHash,
  magnet: c.magnet,
  savePath: `/source/${c.infoHash}`,
  addedAt: Date.now(),
  started: c.reopenable,
  saveTo: 'source',
  format: c.format,
  pieceLength: c.pieceLength,
  name: c.name,
  size: c.size,
})

describe('a created torrent\'s source', () => {
  it('starts from the pick this page holds, on the list update and after a remount', async () => {
    const { client, created, started } = fakeClient()
    stubPicker(await directory('read-back-source', [{ name: 'a.mkv', bytes: 40_000 }, { name: 'b.mkv', bytes: 9_000 }]))

    const use = (props?: { list: Persisted[] }) => ({
      create: useCreateTorrent(client),
      sources: useCreatedSources(client, props?.list ?? [], true),
    })
    const first = await renderHook(use, { initialProps: { list: [] as Persisted[] } })
    await first.result.current.create.pickFolder()
    await expect.poll(() => first.result.current.create.state.stage).toBe('ready')
    await first.result.current.create.publish({ name: 'read-back-source', trackers: [...DEFAULT_TRACKERS], private: false, format: 'v1' })
    await expect.poll(() => first.result.current.create.state.stage).toBe('done')
    expect(created).toHaveLength(1)
    expect(created[0]!.reopenable, 'a real handle should have been stored').toBe(true)
    const key = `ripple:source:${created[0]!.infoHash}`

    // what the worker's list message does next, and where the read-back used to be
    const list = [entryFor(created[0]!)]
    await first.rerender({ list })
    await expect.poll(() => started.length, { timeout: 10_000 }).toBe(1)
    expect(started[0]!.infoHash).toBe(created[0]!.infoHash)
    expect(started[0]!.handles.filter(Boolean)).toHaveLength(2)
    expect(first.result.current.sources.waiting).toEqual([])

    // the library route coming back, which starts the hook over with nothing in its refs
    await first.unmount()
    const second = await renderHook(use, { initialProps: { list } })
    await expect.poll(() => started.length, { timeout: 10_000 }).toBe(2)
    expect(await second.result.current.sources.allow(created[0]!.infoHash)).toBe(true)
    await second.unmount()

    expect(reads, 'the hook read its own handle back out of IndexedDB').not.toContain(key)
  })
})

describe('the auto-save folder', () => {
  it('comes back from memory when the hook remounts, and from the store once it is cleared', async () => {
    const first = await renderHook(() => useFolder())
    // the control: nothing is held yet, so the mount asks the store, and the spy sees that read
    await expect.poll(() => reads.filter((key) => key === 'ripple:folder').length).toBe(1)

    stubPicker(await directory('read-back-downloads'))
    expect(await first.result.current.pick()).toBe(true)
    await first.unmount()

    const second = await renderHook(() => useFolder())
    await expect.poll(() => second.result.current.folder?.name).toBe('read-back-downloads')
    await expect.poll(() => second.result.current.permitted).toBe(true)
    expect(reads.filter((key) => key === 'ripple:folder'), 'the remount read the folder back').toHaveLength(1)

    await second.result.current.clear()
    await second.unmount()
    const third = await renderHook(() => useFolder())
    await expect.poll(() => reads.filter((key) => key === 'ripple:folder').length).toBe(2)
    expect(third.result.current.folder).toBeNull()
    await third.unmount()
  })
})
