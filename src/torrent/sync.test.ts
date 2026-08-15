import { describe, expect, it } from 'vitest'

import { probeRanges, syncTorrentToDirectory } from './sync'
import type { TorrentClient } from './client'
import type { Torrent } from './types'

/**
 * The mirror decides something destructive.
 *
 * "This torrent is in your folder" is what unlocks "Remove and delete Ripple's copy", the one action
 * that deletes the last copy Ripple holds. It used to be decided by the byte count alone, so a file
 * of the right name and the right length that the person already had satisfied it with nothing
 * copied, and the app then offered to delete its own copy of something it had never written.
 */

const bytes = (size: number, fill: number) => new Uint8Array(size).fill(fill)

/** a File stand-in: only `size` and `slice().arrayBuffer()` are ever read */
const fakeFile = (data: Uint8Array) => ({
  size: data.length,
  slice: (start: number, end: number) => ({
    arrayBuffer: async () => data.slice(start, end).buffer,
  }),
})

const fakeRoot = (files: Map<string, Uint8Array>) => {
  const writes: { name: string, closed: boolean, aborted: boolean, bytes: number }[] = []
  const root = {
    writes,
    getDirectoryHandle: async () => root,
    getFileHandle: async (name: string) => ({
      getFile: async () => fakeFile(files.get(name) ?? new Uint8Array(0)),
      createWritable: async () => {
        const record = { name, closed: false, aborted: false, bytes: 0 }
        writes.push(record)
        const chunks: Uint8Array[] = []
        return {
          write: async (chunk: Uint8Array) => { chunks.push(chunk); record.bytes += chunk.length },
          close: async () => {
            record.closed = true
            const merged = new Uint8Array(record.bytes)
            let at = 0
            for (const chunk of chunks) { merged.set(chunk, at); at += chunk.length }
            files.set(name, merged)
          },
          abort: async () => { record.aborted = true },
        }
      },
    }),
  }
  return root
}

const torrentOf = (files: { name: string, size: number }[]): Torrent =>
  ({ id: 1, name: 'a torrent', files } as unknown as Torrent)

/** an engine holding `truth` for file 0, counting how many bytes the mirror asked it for */
const fakeClient = (truth: Uint8Array[]) => {
  let read = 0
  const client = {
    read: async (_h: number, index: number, offset: number, len: number) => {
      read += len
      return truth[index]!.slice(offset, offset + len)
    },
    readBytes: () => read,
  }
  return client as unknown as TorrentClient & { readBytes: () => number }
}

describe('deciding a file is already in the folder', () => {
  it('copies when nothing is there', async () => {
    const files = new Map<string, Uint8Array>()
    const root = fakeRoot(files)
    const written = await syncTorrentToDirectory(fakeClient([bytes(300_000, 7)]), torrentOf([{ name: 'a.bin', size: 300_000 }]), root as never)
    expect(written).toBe(1)
    expect(files.get('a.bin')).toEqual(bytes(300_000, 7))
  })

  it('skips a file that is genuinely the same, without writing anything', async () => {
    const files = new Map([['a.bin', bytes(300_000, 7)]])
    const root = fakeRoot(files)
    const written = await syncTorrentToDirectory(fakeClient([bytes(300_000, 7)]), torrentOf([{ name: 'a.bin', size: 300_000 }]), root as never)
    expect(written).toBe(0)
    expect(root.writes).toHaveLength(0)
  })

  /** the whole point: same name, same length, different bytes */
  it('copies over a different file that happens to be exactly the same length', async () => {
    const files = new Map([['a.bin', bytes(300_000, 3)]])
    const root = fakeRoot(files)
    const written = await syncTorrentToDirectory(fakeClient([bytes(300_000, 7)]), torrentOf([{ name: 'a.bin', size: 300_000 }]), root as never)
    expect(written).toBe(1)
    expect(files.get('a.bin')).toEqual(bytes(300_000, 7))
  })

  it('catches a file that differs only near its end', async () => {
    // a head-only check passes this, which is why the probe is spread across the file: an interrupted
    // writer leaves exactly this shape
    const theirs = bytes(4_000_000, 7)
    theirs.fill(0, 3_990_000)
    const files = new Map([['a.bin', theirs]])
    const root = fakeRoot(files)
    const written = await syncTorrentToDirectory(fakeClient([bytes(4_000_000, 7)]), torrentOf([{ name: 'a.bin', size: 4_000_000 }]), root as never)
    expect(written).toBe(1)
  })

  it('catches a file that differs only in the middle', async () => {
    const theirs = bytes(4_000_000, 7)
    theirs.fill(0, 1_990_000, 2_010_000)
    const files = new Map([['a.bin', theirs]])
    const root = fakeRoot(files)
    expect(await syncTorrentToDirectory(fakeClient([bytes(4_000_000, 7)]), torrentOf([{ name: 'a.bin', size: 4_000_000 }]), root as never)).toBe(1)
  })

  it('still copies when the length differs, without reading the engine to find out', async () => {
    const files = new Map([['a.bin', bytes(299_999, 7)]])
    const client = fakeClient([bytes(300_000, 7)])
    await syncTorrentToDirectory(client, torrentOf([{ name: 'a.bin', size: 300_000 }]), fakeRoot(files) as never)
    // exactly the copy, with no probe reads on top of it
    expect(client.readBytes()).toBe(300_000)
  })

  it('reads a bounded amount to check a file it then skips', async () => {
    const same = bytes(50_000_000, 7)
    const client = fakeClient([same])
    await syncTorrentToDirectory(client, torrentOf([{ name: 'a.bin', size: same.length }]), fakeRoot(new Map([['a.bin', same]])) as never)
    // five windows, not fifty megabytes
    expect(client.readBytes()).toBeLessThanOrEqual(5 * 16 * 1024)
    expect(client.readBytes()).toBeGreaterThan(0)
  })

  it('treats an unreadable file as not there rather than as matching', async () => {
    const files = new Map([['a.bin', bytes(300_000, 7)]])
    const failing = { read: async () => { throw new Error('read timed out') } } as unknown as TorrentClient
    await expect(syncTorrentToDirectory(failing, torrentOf([{ name: 'a.bin', size: 300_000 }]), fakeRoot(files) as never))
      .rejects.toThrow('read timed out')
  })

  it('handles an empty file, which has nothing to compare', async () => {
    const root = fakeRoot(new Map([['empty', new Uint8Array(0)]]))
    expect(await syncTorrentToDirectory(fakeClient([new Uint8Array(0)]), torrentOf([{ name: 'empty', size: 0 }]), root as never)).toBe(0)
  })

  it('checks every file of a pack, not only the first', async () => {
    const files = new Map([['a.bin', bytes(300_000, 7)], ['b.bin', bytes(300_000, 3)]])
    const root = fakeRoot(files)
    const written = await syncTorrentToDirectory(
      fakeClient([bytes(300_000, 7), bytes(300_000, 9)]),
      torrentOf([{ name: 'a.bin', size: 300_000 }, { name: 'b.bin', size: 300_000 }]),
      root as never,
    )
    expect(written).toBe(1)
    expect(files.get('b.bin')).toEqual(bytes(300_000, 9))
  })

  it('leaves a half-written file aborted rather than closed', async () => {
    const root = fakeRoot(new Map())
    const client = { read: async () => { throw new Error('engine gone') } } as unknown as TorrentClient
    await expect(syncTorrentToDirectory(client, torrentOf([{ name: 'a.bin', size: 300_000 }]), root as never)).rejects.toThrow('engine gone')
    expect(root.writes[0]).toMatchObject({ closed: false, aborted: true })
  })
})

describe('where the probe looks', () => {
  it('reads a small file whole rather than sampling it', () => {
    expect(probeRanges(1000)).toEqual([{ offset: 0, length: 1000 }])
  })

  it('spreads its windows across a large file and always covers the tail', () => {
    const ranges = probeRanges(1_000_000, 1000)
    expect(ranges).toHaveLength(5)
    expect(ranges[0]).toEqual({ offset: 0, length: 1000 })
    expect(ranges.at(-1)).toEqual({ offset: 999_000, length: 1000 })
  })

  it('never reads past the end', () => {
    for (const size of [1001, 4001, 5001, 123_457]) {
      for (const { offset, length } of probeRanges(size, 1000)) expect(offset + length).toBeLessThanOrEqual(size)
    }
  })

  it('has nothing to look at in an empty file', () => {
    expect(probeRanges(0)).toEqual([])
  })
})
