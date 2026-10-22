import type { MemoryDir, MemoryFile } from '../utils/memory-opfs'

import { STORAGE_NEED_FULL_CHECK, STORAGE_NO_ERROR } from 'libtorrent-wasm/opfs'
import { describe, expect, it } from 'vitest'

import { createChunkedStorage } from '../../src/torrent/chunked-storage'
import { installOpfs, memoryDir, memoryFile } from '../utils/memory-opfs'

const C = 1024
const HASH = 'a'.repeat(40)
const SAVE_PATH = '/cache/' + HASH
const FILES = [{ path: 'Pack/film.mkv', size: 40 * C }, { path: 'Pack/extras.mkv', size: 3 * C }]

const bytes = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed) % 251)

// the chunks sit in a directory named by their size, inside the torrent's own
const mounted = async (chunks: MemoryFile[] = [], room = { bytes: Infinity }, { written = C, size = C } = {}) => {
  const dir = memoryDir(String(written), chunks, room)
  const root = memoryDir('', [memoryDir('cache', [memoryDir(HASH, [dir], room)], room)], room)
  installOpfs(root)
  const storage = createChunkedStorage(size)
  await storage.onNewStorage(1, SAVE_PATH, FILES)
  return { storage, dir, root }
}

const chunk = (dir: MemoryDir, name: string) => dir.children.get(name) as MemoryFile | undefined

describe('the chunked storage', () => {
  it('splits a write across a chunk edge into two chunk files and reads it back whole', async () => {
    const { storage, dir } = await mounted()
    const data = bytes(600)
    await storage.write(1, 0, 700, data)
    expect([...dir.children.keys()].sort()).toEqual(['0-0', '0-1'])
    expect(chunk(dir, '0-0')!.bytes.subarray(700)).toEqual(data.subarray(0, C - 700))
    expect(chunk(dir, '0-1')!.bytes).toEqual(data.subarray(C - 700))
    expect(await storage.read(1, 0, 700, 600)).toEqual(data)
    // the second file of the torrent is its own set of chunks
    await storage.write(1, 1, 0, bytes(10))
    expect(dir.children.has('1-0')).toBe(true)
  })

  it('reads a chunk that does not exist as zeros, without creating it', async () => {
    const { storage, dir } = await mounted()
    await storage.write(1, 0, 0, bytes(16))
    const read = await storage.read(1, 0, 5 * C + 10, 2 * C)
    expect(read).toEqual(new Uint8Array(2 * C))
    expect([...dir.children.keys()]).toEqual(['0-0'])
  })

  it('is charged per chunk, not for the file up to the furthest write', async () => {
    const { storage } = await mounted()
    await storage.write(1, 0, 30 * C - 8, bytes(8))
    expect(await storage.usageOf(SAVE_PATH, 0)).toBe(C)
    expect(storage.chunksOf(SAVE_PATH, 0)).toEqual([29])
    await storage.write(1, 1, 0, bytes(100))
    expect(await storage.usageOf(SAVE_PATH)).toBe(C + 100)
    expect(storage.footprint()).toBe(C + 100)
  })

  it('drops a chunk: zeros at once, its room back, and a later write creates it again', async () => {
    const { storage, dir } = await mounted()
    await storage.write(1, 0, 0, bytes(C))
    await storage.write(1, 0, C, bytes(C, 7))
    // the open handle is what a delete would be refused for, so it must be closed first
    expect(chunk(dir, '0-0')!.open).toBe(true)

    const removal = storage.drop(SAVE_PATH, 0, 0)
    expect(await storage.read(1, 0, 0, 16)).toEqual(new Uint8Array(16))
    expect(storage.chunksOf(SAVE_PATH, 0)).toEqual([1])
    expect(storage.footprint()).toBe(C)
    // a write that arrives while the delete runs waits for it, and lands in a new chunk
    const rewrite = storage.write(1, 0, 0, bytes(32, 3))
    await removal
    await rewrite
    expect(chunk(dir, '0-0')!.bytes).toEqual(bytes(32, 3))
    expect(await storage.read(1, 0, C, 16)).toEqual(bytes(C, 7).subarray(0, 16))
  })

  it('reads a whole chunk file back for a handover, and nothing for one it does not hold', async () => {
    const { storage } = await mounted()
    await storage.write(1, 0, C, bytes(C, 5))
    await storage.write(1, 0, 2 * C, bytes(100, 9))
    expect(await storage.readChunk(SAVE_PATH, 0, 1)).toEqual(bytes(C, 5))
    expect(await storage.readChunk(SAVE_PATH, 0, 2)).toEqual(bytes(100, 9))
    expect(await storage.readChunk(SAVE_PATH, 0, 0)).toEqual(new Uint8Array(0))
    expect(await storage.readChunk('/cache/' + 'b'.repeat(40), 0, 1)).toEqual(new Uint8Array(0))
  })

  it('finds the chunks already on disk when mounted, and asks for a check only when one holds bytes', async () => {
    const empty = await mounted()
    expect(await empty.storage.check!(1)).toBe(STORAGE_NO_ERROR)

    const { storage } = await mounted([memoryFile('0-3', bytes(C)), memoryFile('0-7', bytes(40)), memoryFile('stray.tmp', bytes(9))])
    expect(await storage.usageOf(SAVE_PATH, 0)).toBe(C + 40)
    expect(storage.chunksOf(SAVE_PATH, 0)).toEqual([3, 7])
    expect(await storage.check!(1)).toBe(STORAGE_NEED_FULL_CHECK)
    expect(await storage.read(1, 0, 3 * C, 8)).toEqual(bytes(C).subarray(0, 8))
  })

  it('reads a torrent in the chunk size it was written with, whatever size new ones get', async () => {
    const data = bytes(64, 5)
    const { storage, dir } = await mounted([memoryFile('0-3', data)], undefined, { written: C, size: 4 * C })
    expect(storage.chunkBytesOf(SAVE_PATH)).toBe(C)
    expect(storage.chunksOf(SAVE_PATH, 0)).toEqual([3])
    expect(await storage.read(1, 0, 3 * C, 64)).toEqual(data)
    await storage.write(1, 0, 5 * C, bytes(8))
    expect(dir.children.has('0-5')).toBe(true)
    // THE CONTROL: a new torrent is written in the size asked for
    const fresh = memoryDir('', [memoryDir('cache')])
    installOpfs(fresh)
    const other = createChunkedStorage(4 * C)
    await other.onNewStorage(2, '/cache/' + 'b'.repeat(40), FILES)
    expect(other.chunkBytesOf('/cache/' + 'b'.repeat(40))).toBe(4 * C)
    await other.write(2, 0, 5 * C, bytes(8))
    const made = ((fresh.children.get('cache') as MemoryDir).children.get('b'.repeat(40)) as MemoryDir).children.get(String(4 * C)) as MemoryDir
    expect([...made.children.keys()]).toEqual(['0-1'])
  })

  it('drops a chunk a read is still opening, closing the handle it lands', async () => {
    const { storage, dir } = await mounted([memoryFile('0-3', bytes(C))])
    // the chunk is on disk but not open yet, so the read opens it
    const read = Promise.resolve(storage.read(1, 0, 3 * C, 16)).catch(() => null)
    await storage.drop(SAVE_PATH, 0, 3)
    await read
    expect(dir.children.has('0-3')).toBe(false)
    expect(storage.chunksOf(SAVE_PATH, 0)).toEqual([])
  })

  it('counts what a write the browser cut short left on disk', async () => {
    const room = { bytes: 100 }
    const { storage } = await mounted([], room)
    await expect(Promise.resolve().then(() => storage.write(1, 0, 0, bytes(300)))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(storage.footprint()).toBe(100)
    expect(await storage.usageOf(SAVE_PATH, 0)).toBe(100)
  })

  it('deletes the torrent directory, open chunks and all', async () => {
    const { storage, root } = await mounted()
    await storage.write(1, 0, 0, bytes(16))
    await storage.deleteFiles!(1, 0)
    expect([...(root.children.get('cache') as MemoryDir).children.keys()]).toEqual([])
    expect(storage.footprint()).toBe(0)
  })

  it('names the file whose write was refused for want of room, at once and without retrying', async () => {
    const room = { bytes: 0 }
    const { storage } = await mounted([], room)
    const started = Date.now()
    await expect(Promise.resolve().then(() => storage.write(1, 1, 0, bytes(64)))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(storage.refusedFile(SAVE_PATH)).toBe(1)
  })
})

describe('a read behind a write still landing', () => {
  it('waits for it, since libtorrent hashes a piece before its last write completes', async () => {
    const { storage } = await mounted()
    const data = bytes(64, 9)
    // the chunk is new, so the write lands only once its handle opens
    const landing = storage.write(1, 0, 5 * C + 100, data)
    expect(landing).toBeInstanceOf(Promise)
    const read = storage.read(1, 0, 5 * C + 100, 64)
    expect(await read).toEqual(data)
    await landing
  })
})
