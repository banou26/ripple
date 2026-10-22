import type { MeasurableStorage } from './opfs-storage'

import { STORAGE_NEED_FULL_CHECK, STORAGE_NO_ERROR } from 'libtorrent-wasm/opfs'
import { write } from '@banou/ponyfill/file-system'

import { isFatal, retrying } from './opfs-storage'

/**
 * The size of one chunk file of a cache torrent.
 *
 * OPFS charges a file its extent, so a file the length of the torrent's file is charged all of it
 * once the demuxer reads the index at its end, and only the end of a file can ever be given back. A
 * chunk is charged on its own and deleting one gives its room back at once (measured in the stub
 * frame, 2026-10-19: Firefox 157 at the first poll, Chromium 149 within 1 ms). Delete, never
 * truncate: Chromium had not given a truncate's room back 5 s later.
 */
export const CHUNK_BYTES = 64 * 1024 * 1024

/** What the window over a cache torrent needs from its storage, on top of the engine's own calls. */
export type ChunkedStorage = MeasurableStorage & {
  /** The chunk size the torrent under `savePath` was written with, or the default when it is not mounted. */
  chunkBytesOf: (savePath: string) => number
  /** The chunks of one file that hold bytes, ascending; empty when the storage is not mounted. */
  chunksOf: (savePath: string, fileIndex: number) => number[]
  /** Bytes every storage mounted here is charged, from its own count, so it costs no estimate(). */
  footprint: () => number
  /**
   * Close one chunk and delete it. Synchronous up to the delete: from the call on, a read of the
   * chunk answers zeros and a write waits for the delete, then creates the chunk again. The caller
   * makes sure the engine holds no piece in it and has no write of one in flight.
   */
  drop: (savePath: string, fileIndex: number, chunk: number) => Promise<void>
  /** One chunk file's bytes as they are now, through the handle the engine writes with; empty when it holds none. */
  readChunk: (savePath: string, fileIndex: number, chunk: number) => Promise<Uint8Array>
}

type Mount = {
  parent: FileSystemDirectoryHandle
  name: string
  chunkBytes: number
  dir: FileSystemDirectoryHandle
  /** chunk name to the bytes it is charged */
  extents: Map<string, number>
  handles: Map<string, FileSystemSyncAccessHandle>
  opening: Map<string, Promise<FileSystemSyncAccessHandle>>
  dropping: Map<string, Promise<void>>
}

type Segment = { name: string, at: number, from: number, to: number }

// a worker-only call the DOM typings do not carry
type SyncAccessible = { createSyncAccessHandle: () => Promise<FileSystemSyncAccessHandle> }

const CHUNK_NAME = /^(\d+)-(\d+)$/
const SIZE_NAME = /^\d+$/

/**
 * A storage backend that keeps each file of a torrent as chunk files: `<savePath>/<size>/<fileIndex>-<k>`
 * holds the file's bytes `[k * size, (k + 1) * size)`. A chunk that does not exist reads as zeros, so
 * a dropped range hashes wrong and is simply not had.
 *
 * New torrents are written in chunks of `chunkBytes`. One already on disk is read in the size it was
 * written with, which its directory names: a restore trusts the resume blob without reading the
 * files, so chunks read at another size would be served as the pieces they claim to be.
 */
export const createChunkedStorage = (chunkBytes = CHUNK_BYTES): ChunkedStorage => {
  const mounts = new Map<number, Mount>()
  const mounting = new Map<number, Promise<Mount>>()
  const idBySavePath = new Map<string, number>()
  const refused = new Map<number, number>()
  const dying = new Set<number>()
  const retry = retrying(dying)
  /*
   * Writes still landing, by storage and chunk. libtorrent hashes a piece as soon as its last block
   * is handed over, before that write completes (`peer_connection::incoming_piece`), and a write to
   * a chunk being opened completes later, so a read has to wait for them or it hashes zeros.
   */
  const landing = new Map<string, Set<Promise<unknown>>>()
  const track = (id: number, name: string, write: Promise<unknown>) => {
    const key = `${id}/${name}`
    let set = landing.get(key)
    if (!set) landing.set(key, set = new Set())
    set.add(write)
    const settle = () => { set.delete(write); if (!set.size && landing.get(key) === set) landing.delete(key) }
    void write.then(settle, settle)
  }

  const nameOf = (fileIndex: number, chunk: number) => `${fileIndex}-${chunk}`

  const mountOf = (savePath: string) => {
    const id = idBySavePath.get(savePath)
    return id === undefined ? undefined : mounts.get(id)
  }

  const withMount = <T>(id: number, op: (m: Mount) => T | Promise<T>): T | Promise<T> => {
    const m = mounts.get(id)
    if (m) return op(m)
    const pending = mounting.get(id)
    if (!pending) throw new Error(`unknown storage ${id}`)
    return pending.then(op)
  }

  const segments = (m: Mount, fileIndex: number, offset: number, len: number): Segment[] => {
    const out: Segment[] = []
    for (let from = 0; from < len;) {
      const chunk = Math.floor((offset + from) / m.chunkBytes)
      const at = offset + from - chunk * m.chunkBytes
      const to = Math.min(len, from + m.chunkBytes - at)
      out.push({ name: nameOf(fileIndex, chunk), at, from, to })
      from = to
    }
    return out
  }

  // one sync access handle per file is all OPFS allows, so concurrent callers share one open
  const open = (m: Mount, name: string): FileSystemSyncAccessHandle | Promise<FileSystemSyncAccessHandle> => {
    const cached = m.handles.get(name)
    if (cached) return cached
    const pending = m.opening.get(name)
    if (pending) return pending
    const gate = m.dropping.get(name)
    const opened = (async () => {
      if (gate) await gate
      const file = await m.dir.getFileHandle(name, { create: true })
      const handle = await (file as unknown as SyncAccessible).createSyncAccessHandle()
      m.handles.set(name, handle)
      return handle
    })()
    m.opening.set(name, opened)
    const settle = () => { if (m.opening.get(name) === opened) m.opening.delete(name) }
    void opened.then(settle, settle)
    return opened
  }

  const evict = (id: number, fileIndex: number, offset: number, len: number) => {
    const m = mounts.get(id)
    if (!m) return
    for (const { name } of segments(m, fileIndex, offset, len)) {
      const handle = m.handles.get(name)
      m.handles.delete(name)
      try { handle?.close() } catch { }
    }
  }

  const closeAll = (m: Mount) => {
    for (const handle of m.handles.values()) {
      try { handle.flush(); handle.close() } catch { }
    }
    m.handles.clear()
  }

  const usage = (m: Mount, fileIndex?: number) => {
    let total = 0
    for (const [name, bytes] of m.extents) if (fileIndex === undefined || name.startsWith(`${fileIndex}-`)) total += bytes
    return total
  }

  const mount = async (savePath: string): Promise<Mount> => {
    const segs = savePath.split('/').filter(Boolean)
    const name = segs.pop() ?? ''
    let parent = await navigator.storage.getDirectory()
    for (const seg of segs) parent = await parent.getDirectoryHandle(seg, { create: true })
    const root = await parent.getDirectoryHandle(name, { create: true })
    const entries = (dir: FileSystemDirectoryHandle) => (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
    let size = chunkBytes
    for await (const entry of entries(root)) if (entry.kind === 'directory' && SIZE_NAME.test(entry.name)) size = Number(entry.name)
    const dir = await root.getDirectoryHandle(String(size), { create: true })
    const extents = new Map<string, number>()
    for await (const entry of entries(dir)) {
      if (entry.kind !== 'file') continue
      // a lock another worker still holds hides the size, and a whole chunk is the safe guess
      extents.set(entry.name, await (entry as FileSystemFileHandle).getFile().then((f) => f.size, () => size))
    }
    return { parent, name, chunkBytes: size, dir, extents, handles: new Map(), opening: new Map(), dropping: new Map() }
  }

  return {
    chunkBytesOf: (savePath) => mountOf(savePath)?.chunkBytes ?? chunkBytes,

    chunksOf: (savePath, fileIndex) => {
      const m = mountOf(savePath)
      if (!m) return []
      const out: number[] = []
      for (const [name, bytes] of m.extents) {
        const match = CHUNK_NAME.exec(name)
        if (match && Number(match[1]) === fileIndex && bytes > 0) out.push(Number(match[2]))
      }
      return out.sort((a, b) => a - b)
    },

    footprint: () => {
      let total = 0
      for (const m of mounts.values()) total += usage(m)
      return total
    },

    usageOf: async (savePath, fileIndex) => {
      const id = idBySavePath.get(savePath)
      if (id === undefined) return null
      const m = mounts.get(id) ?? await mounting.get(id)?.catch(() => undefined)
      return m ? usage(m, fileIndex) : null
    },

    refusedFile: (savePath) => {
      const id = idBySavePath.get(savePath)
      return id === undefined ? undefined : refused.get(id)
    },

    drop: (savePath, fileIndex, chunk) => {
      const m = mountOf(savePath)
      if (!m) return Promise.resolve()
      const name = nameOf(fileIndex, chunk)
      const already = m.dropping.get(name)
      if (already) return already
      m.extents.delete(name)
      const handle = m.handles.get(name)
      m.handles.delete(name)
      try { handle?.close() } catch { }
      const opening = m.opening.get(name)
      const removal = (async () => {
        // an open already under way lands its handle after the close above
        if (opening) {
          await opening.then((late) => {
            if (m.handles.get(name) === late) m.handles.delete(name)
            try { late.close() } catch { }
          }, () => {})
        }
        await m.dir.removeEntry(name).catch(() => {})
      })()
      m.dropping.set(name, removal)
      void removal.then(() => { if (m.dropping.get(name) === removal) m.dropping.delete(name) })
      return removal
    },

    readChunk: async (savePath, fileIndex, chunk) => {
      const m = mountOf(savePath)
      const name = nameOf(fileIndex, chunk)
      if (!m?.extents.has(name)) return new Uint8Array(0)
      const handle = await open(m, name)
      const out = new Uint8Array(handle.getSize())
      handle.read(out, { at: 0 })
      return out
    },

    onNewStorage: (id, savePath) => {
      dying.delete(id)
      refused.delete(id)
      idBySavePath.set(savePath, id)
      const pending = Promise.resolve(retry(id, () => {}, () => mount(savePath)))
      mounting.set(id, pending)
      // a failed mount stays in `mounting`, so check() can tell it from an empty one
      return pending.then((m) => {
        if (mounting.get(id) !== pending) return
        mounting.delete(id)
        mounts.set(id, m)
      })
    },

    onRemoveStorage: (id) => {
      dying.add(id)
      mounting.delete(id)
      const m = mounts.get(id)
      mounts.delete(id)
      for (const [savePath, mounted] of idBySavePath) if (mounted === id) idBySavePath.delete(savePath)
      if (m) closeAll(m)
    },

    read: (id, fileIndex, offset, len) => retry(id, () => evict(id, fileIndex, offset, len), () => withMount(id, (m) => {
      const out = new Uint8Array(len)
      const waits: Promise<void>[] = []
      for (const seg of segments(m, fileIndex, offset, len)) {
        const fill = (): void | Promise<void> => {
          if (!m.extents.has(seg.name)) return
          const put = (handle: FileSystemSyncAccessHandle) => { handle.read(out.subarray(seg.from, seg.to), { at: seg.at }) }
          const handle = open(m, seg.name)
          if (handle instanceof Promise) return handle.then(put)
          put(handle)
        }
        const pending = landing.get(`${id}/${seg.name}`)
        if (pending) waits.push(Promise.allSettled([...pending]).then(fill))
        else {
          const filled = fill()
          if (filled) waits.push(filled)
        }
      }
      return waits.length ? Promise.all(waits).then(() => out) : out
    })),

    write: (id, fileIndex, offset, bytes) => {
      const written = retry(id, () => evict(id, fileIndex, offset, bytes.length), () => withMount(id, (m) => {
        const waits: Promise<void>[] = []
        for (const seg of segments(m, fileIndex, offset, bytes.length)) {
          const put = (handle: FileSystemSyncAccessHandle) => {
            try {
              write(handle, bytes.subarray(seg.from, seg.to), { at: seg.at })
            } catch (error) {
              if (isFatal(error)) refused.set(id, fileIndex)
              // a short write on Firefox leaves what it wrote charged
              try { m.extents.set(seg.name, handle.getSize()) } catch { }
              throw error
            }
            const end = seg.at + seg.to - seg.from
            if ((m.extents.get(seg.name) ?? 0) < end) m.extents.set(seg.name, end)
          }
          const handle = open(m, seg.name)
          if (handle instanceof Promise) waits.push(handle.then(put)); else put(handle)
        }
        return waits.length ? Promise.all(waits).then(() => {}) : undefined
      }))
      if (written instanceof Promise) {
        const tracked = (m: Mount) => { for (const { name } of segments(m, fileIndex, offset, bytes.length)) track(id, name, written) }
        const m = mounts.get(id)
        if (m) tracked(m); else void mounting.get(id)?.then(tracked, () => {})
      }
      return written
    },

    // a rejection reaches the engine as a disk error and stops the torrent
    check: async (id) => {
      try {
        const m = mounts.get(id) ?? await mounting.get(id)
        return m && usage(m) > 0 ? STORAGE_NEED_FULL_CHECK : STORAGE_NO_ERROR
      } catch {
        return STORAGE_NEED_FULL_CHECK
      }
    },

    release: async (id) => { const m = mounts.get(id); if (m) closeAll(m) },
    stop: async (id) => { const m = mounts.get(id); if (m) closeAll(m) },

    deleteFiles: async (id) => {
      dying.add(id)
      const m = mounts.get(id) ?? await mounting.get(id)?.catch(() => undefined)
      if (!m) return
      await Promise.all([...m.opening.values()].map((p) => p.catch(() => {})))
      closeAll(m)
      m.extents.clear()
      await m.parent.removeEntry(m.name, { recursive: true }).catch(() => {})
    },
  }
}
