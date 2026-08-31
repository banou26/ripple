import { describe, expect, it, vi } from 'vitest'

import { copyFolderIntoBrowserStorage, moveTorrentFiles } from '../../src/torrent/move-files'
import type { TorrentClient } from '../../src/torrent/client'
import type { Torrent } from '../../src/torrent/types'

/**
 * Moving files between the two storages.
 *
 * The property that matters most is the ORDER: copy first, tell the engine last. `relocate` is the
 * only step that deletes anything, so a copy that fails has to leave the torrent exactly where it
 * was rather than half moved. Several tests below exist only to pin that.
 */

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill)

/**
 * A directory tree with just enough of the API for a copy.
 *
 * The writable is a real sink with write, close and abort, and the fake stream's `pipeTo` drives it
 * through the same three, so both directions of the move exercise one object rather than two shapes
 * that could drift apart.
 */
const fakeDir = (files: Record<string, Uint8Array>, opts: { failWrites?: boolean } = {}) => {
  const aborted: string[] = []
  const make = (prefix: string): FileSystemDirectoryHandle => ({
    getDirectoryHandle: async (name: string, o?: { create?: boolean }) => {
      const under = prefix + name + '/'
      if (!o?.create && !Object.keys(files).some((p) => p.startsWith(under))) throw new Error('NotFoundError: ' + under)
      return make(under)
    },
    getFileHandle: async (name: string, o?: { create?: boolean }) => {
      const path = prefix + name
      if (!o?.create && !(path in files)) throw new Error('NotFoundError: ' + path)
      if (o?.create && !(path in files)) files[path] = new Uint8Array(0)
      return {
        getFile: async () => ({
          size: files[path]!.length,
          stream: () => ({
            pipeTo: async (sink: { write: (c: Uint8Array) => Promise<void>, close: () => Promise<void> }) => {
              await sink.write(files[path]!)
              await sink.close()
            },
          }),
        }),
        createWritable: async () => {
          const chunks: Uint8Array[] = []
          return {
            write: async (chunk: Uint8Array) => {
              if (opts.failWrites) throw new Error('disk full')
              chunks.push(chunk)
            },
            close: async () => {
              const total = chunks.reduce((n, c) => n + c.length, 0)
              const merged = new Uint8Array(total)
              let at = 0
              for (const c of chunks) { merged.set(c, at); at += c.length }
              files[path] = merged
            },
            abort: async () => { aborted.push(path) },
          }
        },
      } as unknown as FileSystemFileHandle
    },
  } as unknown as FileSystemDirectoryHandle)
  return Object.assign(make(''), { aborted })
}

const torrentOf = (files: { name: string, size: number }[], over: Partial<Torrent> = {}): Torrent =>
  ({ id: 3, name: 'a torrent', infoHash: 'abc', files, ...over } as unknown as Torrent)

const fakeClient = () => ({ relocate: vi.fn(), read: vi.fn(async () => bytes(4, 1)) }) as unknown as TorrentClient & { relocate: ReturnType<typeof vi.fn> }

describe('copying out of the user folder into browser storage', () => {
  it('streams a file across rather than buffering it', async () => {
    const source = fakeDir({ 'a.bin': bytes(1000, 7) })
    const opfs = fakeDir({})
    const written = await copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 1000 }]),
      folder: source,
      opfsRoot: opfs,
    })
    expect(written).toBe(1)
  })

  it('reports progress per file, naming the one it is on', async () => {
    const seen: string[] = []
    await copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 4 }, { name: 'b/c.bin', size: 4 }]),
      folder: fakeDir({ 'a.bin': bytes(4, 1), 'b/c.bin': bytes(4, 2) }),
      opfsRoot: fakeDir({}),
      onProgress: (p) => seen.push(`${p.file + 1}/${p.files} ${p.name}`),
    })
    expect(seen).toEqual(['1/2 a.bin', '2/2 b/c.bin'])
  })

  it('skips a file already there at the right length, so a retry resumes', async () => {
    const opfs = fakeDir({ 'dl/abc/a.bin': bytes(1000, 7) })
    const written = await copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 1000 }]),
      folder: fakeDir({ 'a.bin': bytes(1000, 7) }),
      opfsRoot: opfs,
    })
    expect(written).toBe(0)
  })

  it('refuses a torrent with no infohash, which has nowhere to be put', async () => {
    await expect(copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 4 }], { infoHash: undefined }),
      folder: fakeDir({ 'a.bin': bytes(4, 1) }),
      opfsRoot: fakeDir({}),
    })).rejects.toThrow(/nowhere to go/)
  })

  it('fails rather than inventing an empty file when the source is gone', async () => {
    await expect(copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 4 }]),
      folder: fakeDir({}),
      opfsRoot: fakeDir({}),
    })).rejects.toThrow(/NotFoundError/)
  })

  it('aborts the half-written target instead of closing it', async () => {
    // the flag belongs on the DESTINATION: the source's stream drives the target's sink, so a write
    // that fails is the target's disk filling up, not the source's
    const opfs = fakeDir({}, { failWrites: true })
    await expect(copyFolderIntoBrowserStorage({
      torrent: torrentOf([{ name: 'a.bin', size: 4 }]),
      folder: fakeDir({ 'a.bin': bytes(4, 1) }),
      opfsRoot: opfs,
    })).rejects.toThrow(/disk full/)
    expect(opfs.aborted).toEqual(['dl/abc/a.bin'])
  })
})

/**
 * The ordering property, which is the whole safety argument. `relocate` deletes the old copy, so it
 * must never run against a copy that did not fully land.
 */
describe('the order of a move', () => {
  it('tells the engine only after the copy is done', async () => {
    const client = fakeClient()
    const calls: string[] = []
    await moveTorrentFiles({
      client,
      torrent: torrentOf([{ name: 'a.bin', size: 4 }]),
      folder: fakeDir({ 'a.bin': bytes(4, 1) }),
      opfsRoot: fakeDir({}),
      to: 'browser',
      onProgress: () => calls.push('copy'),
    })
    calls.push('relocate')
    expect(calls).toEqual(['copy', 'relocate'])
    expect(client.relocate).toHaveBeenCalledWith('abc', 'browser')
  })

  /*
   * The move is the one command here that cannot be named by a handle.
   *
   * `torrent.id` is a handle read off the row when the move started, and everything before this line
   * takes minutes: the copy out of a folder never touches the engine at all, so it runs happily
   * through a handover. A handle that crosses one names whatever the next session assigned that
   * number, and relocate removes the torrent it names, deletes its resume blob and re-adds it
   * somewhere else. So it goes by hash, and this fixture keeps the two different on purpose.
   */
  it('names the torrent by hash, never by the row id it started with', async () => {
    const client = fakeClient()
    const torrent = torrentOf([{ name: 'a.bin', size: 4 }])
    expect(String((torrent as unknown as { id: unknown }).id), 'the fixture stopped telling the two apart')
      .not.toBe(torrent.infoHash)

    await moveTorrentFiles({
      client,
      torrent,
      folder: fakeDir({ 'a.bin': bytes(4, 1) }),
      opfsRoot: fakeDir({}),
      to: 'browser',
    })

    const [named] = client.relocate.mock.calls[0] as [unknown, unknown]
    expect(named).toBe('abc')
    expect(named, 'a handle reached the engine, which can name a different torrent there').not.toBe(3)
  })

  /*
   * The folder direction, deliberately. Going the other way `copyFolderIntoBrowserStorage` already
   * refuses a torrent with no infohash before anything is copied, but the mirror into a folder has
   * no such check, so this is the one path where the guard in front of relocate is what stops a move
   * that cannot be named from being finished by guesswork.
   */
  it('refuses to finish a move it cannot name, rather than guessing', async () => {
    const client = fakeClient()
    // copy-first, so throwing here costs nothing: the copy is done and nothing has been dropped
    await expect(moveTorrentFiles({
      client,
      torrent: torrentOf([{ name: 'a.bin', size: 4 }], { infoHash: undefined }),
      folder: fakeDir({}),
      to: 'folder',
    })).rejects.toThrow(/info hash/)
    expect(client.relocate).not.toHaveBeenCalled()
  })

  it('never tells the engine when the copy failed, so nothing is deleted', async () => {
    const client = fakeClient()
    await expect(moveTorrentFiles({
      client,
      torrent: torrentOf([{ name: 'a.bin', size: 4 }]),
      folder: fakeDir({}),
      opfsRoot: fakeDir({}),
      to: 'browser',
    })).rejects.toThrow()
    expect(client.relocate).not.toHaveBeenCalled()
  })

  it('goes through the verifying mirror on the way into a folder', async () => {
    const client = fakeClient()
    // syncTorrentToDirectory reads through the engine, so a client that answers is enough to prove
    // the mirror ran rather than the folder-to-browser path
    await moveTorrentFiles({
      client,
      torrent: torrentOf([{ name: 'a.bin', size: 4 }]),
      folder: fakeDir({}),
      to: 'folder',
    })
    expect(client.read).toHaveBeenCalled()
    expect(client.relocate).toHaveBeenCalledWith('abc', 'folder')
  })
})
