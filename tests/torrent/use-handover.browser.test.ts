import type { TorrentClient } from '../../src/torrent/client'
import type { Chunk, Offer } from '../../src/torrent/handover'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { ACK, CHUNK, GIVE, STOP, TAKE } from '../../src/torrent/handover'
import { LIST_KEY } from '../../src/torrent/library'
import { bencode, infoHashOf, raw } from '../../src/torrent/make-torrent'
import { decode } from '../../src/torrent/torrent-file'
import { giveToRipple, takeFromPlayer, useGiveToRipple, useTakeFromPlayer } from '../../src/torrent/use-handover'

// what the two hooks reach for: the page's engine, the stored library, and whether the page is framed
const page = vi.hoisted(() => ({ client: {} as Record<string, unknown>, store: new Map<string, unknown>() }))
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => page.client }))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => false }))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => page.store.get(key),
  set: async (key: string, value: unknown) => { page.store.set(key, value) },
  del: async (key: string) => { page.store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { page.store.set(key, fn(page.store.get(key))) },
}))

/**
 * Both halves of the handover in one page, each talking to a window of its own: two same-origin
 * frames stand in for the player and the Ripple tab, and a message posted to one arrives here, from
 * the other, a task later and with its buffers transferred, as `postMessage` delivers it. The tab's
 * half writes into a directory of this origin's real OPFS.
 */

const PIECE = 1024
const CHUNK_BYTES = 4096
const SIZES = [10_000, 3_000]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// the other spelling a magnet may name a v1 infohash in: 160 bits, 32 base32 letters
const base32Of = (hex: string) => {
  const bits = hex.match(/../g)!.map((byte) => parseInt(byte, 16).toString(2).padStart(8, '0')).join('')
  return bits.match(/.{5}/g)!.map((five) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(five, 2)]).join('')
}

const pattern = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, i) => (i * 13 + seed * 101) & 0xff)
const sha1 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes).buffer))

const film = async () => {
  const files = SIZES.map((size, i) => pattern(size, i))
  const stream = new Uint8Array(SIZES.reduce((a, b) => a + b, 0))
  files.reduce((at, f) => { stream.set(f, at); return at + f.length }, 0)
  const hashes = new Uint8Array(Math.ceil(stream.length / PIECE) * 20)
  for (let p = 0; p * PIECE < stream.length; p++) hashes.set(await sha1(stream.subarray(p * PIECE, (p + 1) * PIECE)), p * 20)
  const info = bencode({ files: SIZES.map((length, i) => ({ length, path: [`f${i}`] })), name: 'film', 'piece length': PIECE, pieces: hashes })
  const infoHash = await infoHashOf(info)
  const resume = bencode({
    'file-format': 'libtorrent resume file', 'file-version': 1, info: raw(info), paused: 1,
    pieces: new Uint8Array(hashes.length / 20).fill(1),
  })
  const chunks: Chunk[] = SIZES.flatMap((size, fileIndex) =>
    Array.from({ length: Math.ceil(size / CHUNK_BYTES) }, (_, chunk) => ({ fileIndex, chunk })))
  const bytesOf = ({ fileIndex, chunk }: Chunk) => files[fileIndex]!.slice(chunk * CHUNK_BYTES, (chunk + 1) * CHUNK_BYTES)
  return { infoHash, resume, chunks, bytesOf, pieces: hashes.length / 20 }
}

type Film = Awaited<ReturnType<typeof film>>

const frames: HTMLIFrameElement[] = []
const windowOf = () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frames.push(frame)
  return { frame, win: frame.contentWindow! }
}

// what `postMessage` to `to` looks like here: from `from`, a task later, transfers detached, and from
// the origin it was posted to unless `as` says otherwise
const wire = (to: Window, from: Window, seen: { type: string }[], as?: string) => {
  Object.assign(to, {
    postMessage: (data: { type: string }, origin: string, transfer: Transferable[] = []) => {
      seen.push(data)
      const copy = structuredClone(data, { transfer })
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: copy, origin: as ?? origin, source: from })), 0)
    },
  })
}

// every export the player ended, by infohash
const ended: string[] = []

const playerClient = (f: Film, over: Partial<TorrentClient> = {}) => ({
  exportStart: async (): Promise<Offer | null> => ({ magnet: `magnet:?xt=urn:btih:${f.infoHash}`, resume: f.resume, chunkBytes: CHUNK_BYTES, chunks: f.chunks }),
  exportChunk: async (_: string, chunk: Chunk) => f.bytesOf(chunk),
  exportEnd: (infoHash: string) => { ended.push(infoHash) },
  ...over,
}) as unknown as TorrentClient

// `listed` false is an engine that never answers, which the client turns into a rejection
const tabClient = (listed = true) => {
  const calls: { type: string, infoHash: string, magnet: string, resume?: Uint8Array }[] = []
  const client = {
    importStart: async (infoHash: string, magnet: string) => {
      calls.push({ type: 'start', infoHash, magnet })
      if (!listed) throw new Error('import-start timed out after 30000ms')
    },
    importTorrent: (infoHash: string, magnet: string, resume: Uint8Array) => calls.push({ type: 'import', infoHash, magnet, resume }),
  } as unknown as TorrentClient
  return { client, calls }
}

// this origin's OPFS, except that writing the chunk file `refused` is refused, as a full origin does
const refusing = (dir: FileSystemDirectoryHandle, refused: string): FileSystemDirectoryHandle => ({
  getDirectoryHandle: async (name: string, options?: FileSystemGetDirectoryOptions) =>
    refusing(await dir.getDirectoryHandle(name, options), refused),
  getFileHandle: async (name: string, options?: FileSystemGetFileOptions) => {
    const file = await dir.getFileHandle(name, options)
    if (name !== refused) return file
    return { getFile: () => file.getFile(), createWritable: async () => { throw new DOMException('refused', 'QuotaExceededError') } }
  },
}) as unknown as FileSystemDirectoryHandle

const claimed = (resume: Uint8Array) => {
  const [dict] = decode(resume, 0) as [Map<string, unknown>, number]
  return [...dict.get('pieces') as Uint8Array].map((b) => b & 1)
}

let root: FileSystemDirectoryHandle
let name: string
beforeEach(async () => {
  ended.length = 0
  name = `handover-${crypto.randomUUID()}`
  root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true })
})
afterEach(async () => {
  for (const frame of frames.splice(0)) frame.remove()
  await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }).catch(() => {})
})

const chunkOnDisk = async (f: Film, { fileIndex, chunk }: Chunk) => {
  const dir = await (await (await root.getDirectoryHandle('cache')).getDirectoryHandle(f.infoHash)).getDirectoryHandle(String(CHUNK_BYTES))
  return new Uint8Array(await (await (await dir.getFileHandle(`${fileIndex}-${chunk}`)).getFile()).arrayBuffer())
}

const run = (
  f: Film, player: TorrentClient,
  { into = root, listed = true, playerOrigin }: { into?: FileSystemDirectoryHandle, listed?: boolean, playerOrigin?: string } = {},
) => {
  const tab = windowOf()
  const embed = windowOf()
  const seen: { type: string }[] = []
  wire(tab.win, embed.win, seen, playerOrigin)
  wire(embed.win, tab.win, seen)
  const { client, calls } = tabClient(listed)
  const giving = giveToRipple({ client: player, infoHash: f.infoHash, tab: tab.win, origin: location.origin })
  const taking = takeFromPlayer({ client, infoHash: f.infoHash, player: embed.win, origin: location.origin, root: into })
  return { giving, taking, calls, seen, embed }
}

describe('the player hands a torrent to the Ripple tab', () => {
  it('copies every chunk, checks every piece, and adds it claiming them all', async () => {
    const f = await film()
    const { giving, taking, calls, seen } = run(f, playerClient(f))
    expect(await taking).toBe(true)
    await giving
    expect(calls.map((c) => c.type)).toEqual(['start', 'import'])
    expect(calls[0]!.magnet).toBe(`magnet:?xt=urn:btih:${f.infoHash}`)
    expect(claimed(calls[1]!.resume!)).toEqual(new Array(f.pieces).fill(1))
    for (const chunk of f.chunks) expect(await chunkOnDisk(f, chunk)).toEqual(f.bytesOf(chunk))
    // never more than two chunks unanswered
    let unanswered = 0
    let most = 0
    for (const m of seen) {
      if (m.type === CHUNK) most = Math.max(most, ++unanswered)
      if (m.type === ACK) unanswered--
    }
    expect(most).toBe(2)
    expect(ended).toEqual([f.infoHash])
  })

  it('claims none of the pieces of a chunk whose bytes are wrong, and says how many it kept', async () => {
    const f = await film()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { taking, calls } = run(f, playerClient(f, {
      exportChunk: async (_: string, chunk: Chunk) => {
        const bytes = f.bytesOf(chunk)
        if (chunk.fileIndex === 0 && chunk.chunk === 1) bytes[100]! ^= 1
        return bytes
      },
    }))
    expect(await taking).toBe(true)
    // bytes 4096 to 8192 of the first file hold pieces 4 to 7, and byte 4196 is in piece 4
    expect(claimed(calls[1]!.resume!)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1])
    expect(info).toHaveBeenCalledWith('[handover] pieces kept', 12, 'of', 13)
    info.mockRestore()
  })

  it('keeps what landed when the player goes away mid-copy', async () => {
    const f = await film()
    let gone = () => {}
    const { taking, calls, embed } = run(f, playerClient(f, {
      exportChunk: async (_: string, chunk: Chunk) => {
        if (chunk.fileIndex === 0 && chunk.chunk === 2) { gone(); return new Promise<Uint8Array>(() => {}) }
        return f.bytesOf(chunk)
      },
    }))
    gone = () => embed.frame.remove()
    const started = performance.now()
    expect(await taking).toBe(true)
    expect(performance.now() - started, 'the tab waited out the silence instead of seeing the player go').toBeLessThan(5_000)
    // the first 8192 bytes are pieces 0 to 7; piece 8 runs into the chunk that never came
    expect(claimed(calls[1]!.resume!)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0])
  })

  it('claims what passed when the tab closes mid-copy', async () => {
    const f = await film()
    const { calls, seen } = run(f, playerClient(f, {
      exportChunk: async (_: string, chunk: Chunk) => (chunk.fileIndex === 1 ? new Promise<Uint8Array>(() => {}) : f.bytesOf(chunk)),
    }))
    // a chunk is acknowledged once the one before it is checked, so pieces 0 to 7 have been
    await expect.poll(() => seen.filter((m) => m.type === ACK).length).toBe(3)
    window.dispatchEvent(new Event('pagehide'))
    await expect.poll(() => calls.map((c) => c.type)).toEqual(['start', 'import'])
    const kept = claimed(calls[1]!.resume!)
    expect(kept.slice(0, 8)).toEqual(new Array(8).fill(1))
    // piece 9 on runs into the second file's chunk, which never came
    expect(kept.slice(9)).toEqual([0, 0, 0, 0])
  })

  it('keeps what landed and stops the player when a write is refused', async () => {
    const f = await film()
    const { giving, taking, calls, seen } = run(f, playerClient(f), { into: refusing(root, '0-1') })
    expect(await taking).toBe(true)
    await giving
    expect(seen.filter((m) => m.type === STOP)).toHaveLength(1)
    expect(calls.map((c) => c.type)).toEqual(['start', 'import'])
    expect(claimed(calls[1]!.resume!)).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(ended).toEqual([f.infoHash])
  })

  it('takes nothing when the player has nothing to give', async () => {
    const f = await film()
    const { giving, taking, calls } = run(f, playerClient(f, { exportStart: async () => null }))
    expect(await taking).toBe(false)
    await giving
    expect(calls).toEqual([])
    expect(ended).toEqual([f.infoHash])
  })

  it('takes nothing when what the player offers is another torrent', async () => {
    const f = await film()
    const other = await film()
    const { giving, taking, calls } = run({ ...f, infoHash: 'a'.repeat(40) }, playerClient(other))
    expect(await taking).toBe(false)
    await giving
    expect(calls).toEqual([])
    expect(ended).toEqual(['a'.repeat(40)])
  })

  it('takes nothing when its engine never lists the torrent', async () => {
    const f = await film()
    const { giving, taking, calls, seen } = run(f, playerClient(f), { listed: false })
    expect(await taking).toBe(false)
    await giving
    expect(calls.map((c) => c.type)).toEqual(['start'])
    expect(seen.filter((m) => m.type === STOP)).toHaveLength(1)
    await expect(root.getDirectoryHandle('cache'), 'a copy nothing lists was written').rejects.toThrow()
    expect(ended).toEqual([f.infoHash])
  })

  it('takes nothing that another origin posts from the player\'s window', async () => {
    const f = await film()
    const { taking, calls, seen, embed } = run(f, playerClient(f), { playerOrigin: 'https://other.example' })
    await expect.poll(() => seen.some((m) => m.type === GIVE)).toBe(true)
    await sleep(200)
    embed.frame.remove()
    expect(await taking).toBe(false)
    expect(calls).toEqual([])
  })

  it('takes a torrent its link names in base32', async () => {
    const f = await film()
    const id = base32Of(f.infoHash)
    const { taking, calls } = run({ ...f, infoHash: id }, playerClient(f))
    expect(await taking).toBe(true)
    expect(calls.map((c) => [c.type, c.infoHash])).toEqual([['start', id], ['import', id]])
    expect(claimed(calls[1]!.resume!)).toEqual(new Array(f.pieces).fill(1))
  })
})

describe('the player answers a Ripple tab', () => {
  it('on its own origin only', async () => {
    const hash = 'd'.repeat(40)
    const started: string[] = []
    page.client = { exportStart: async (infoHash: string) => { started.push(infoHash); return null }, exportEnd: () => {} }
    const { win } = windowOf()
    Object.assign(win, { postMessage: () => {} })
    const take = (origin: string) =>
      window.dispatchEvent(new MessageEvent('message', { data: { type: TAKE, infoHash: hash }, origin, source: win }))
    renderHook(() => useGiveToRipple(hash))
    // THE CONTROL, which also waits for the listener the effect adds
    await expect.poll(() => { take(location.origin); return started.length }).toBeGreaterThan(0)
    await sleep(100)
    started.length = 0
    take('https://other.example')
    await sleep(200)
    expect(started, 'answered a tab on another origin').toEqual([])
    take(location.origin)
    await expect.poll(() => started).toEqual([hash])
  })
})

describe('the Ripple tab opened from the player', () => {
  let was: PropertyDescriptor | undefined
  const openedBy = (win: Window) => Object.defineProperty(window, 'opener', { configurable: true, value: win })
  beforeEach(() => {
    was = Object.getOwnPropertyDescriptor(window, 'opener')
    page.store.clear()
  })
  afterEach(() => { if (was) Object.defineProperty(window, 'opener', was) })

  // the player's window, which records what the tab posts it and answers nothing
  const player = () => {
    const opened = windowOf()
    const asked: unknown[] = []
    Object.assign(opened.win, { postMessage: (data: unknown) => { asked.push(data) } })
    openedBy(opened.win)
    return { ...opened, asked }
  }

  it('asks the player for a torrent the library does not have, and nothing for one it has', async () => {
    const hash = 'b'.repeat(40)
    let offered = 0
    // THE CONTROL: not listed, so the player is asked, and with no answer the add dialog is offered
    const unlisted = player()
    renderHook(() => useTakeFromPlayer(hash, () => { offered++ }))
    await expect.poll(() => unlisted.asked).toEqual([{ type: TAKE, infoHash: hash }])
    unlisted.frame.remove()
    await expect.poll(() => offered).toBe(1)

    page.store.set(LIST_KEY, [{ infoHash: hash }])
    const listed = player()
    renderHook(() => useTakeFromPlayer(hash, () => { offered++ }))
    await sleep(300)
    expect(listed.asked, 'a torrent already listed was copied again').toEqual([])
    expect(offered).toBe(1)
  })

  it('offers the add dialog when this origin\'s storage cannot be opened', async () => {
    player()
    const refused = vi.spyOn(navigator.storage, 'getDirectory').mockRejectedValue(new DOMException('refused', 'SecurityError'))
    try {
      let offered = 0
      renderHook(() => useTakeFromPlayer('c'.repeat(40), () => { offered++ }))
      await expect.poll(() => offered).toBe(1)
    } finally {
      refused.mockRestore()
    }
  })
})
