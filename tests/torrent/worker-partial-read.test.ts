// A partial read, which a player makes, is answered with the pieces already in from its offset, or with the rest of the
// first piece while that one is missing, so the demuxer starts on the first piece in. Any other read gets every byte.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1_048_576
const engine = vi.hoisted(() => ({ read: vi.fn() }))
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10_000_000_000 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      // the second torrent's film starts at its byte 1,500,000, after a small file
      files: (h: number) => ({
        storageIndex: 0, pieceLength: MiB, numPieces: 10, totalSize: 10_000_000, contentSize: 10_000_000,
        files: h === 1
          ? [{ path: 'film.mkv', offset: 0, size: 10_000_000, pad: false }]
          : [{ path: 'film.nfo', offset: 0, size: 1_500_000, pad: false }, { path: 'film.mkv', offset: 1_500_000, size: 8_500_000, pad: false }],
      }),
      // pieces 0, 1, 2 and 4 are in, 3 is not
      bitfield: () => ({ numPieces: 10, pieceLength: MiB, length: 10, pieces: new Uint8Array([0b1110_1000, 0]) }),
      read: engine.read,
      setStreamWindow: () => true,
      clearStreamWindow: () => {},
      cancelPieceRequests: () => {},
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

let id = 0
/** The length the engine was asked to read for one read message, and the bytes the reader got back. */
const read = async (message: { handle?: number, fileIndex?: number, viewer?: string, partial?: boolean, offset: number, len: number }) => {
  engine.read.mockClear()
  const mine = ++id
  rig.send({ type: 'read', id: mine, handle: 1, fileIndex: 0, ...message })
  await vi.waitFor(() => expect(rig.of('read-result').filter((m) => m.id === mine)).toHaveLength(1))
  return { asked: engine.read.mock.calls.map((call) => call[3]), got: (rig.of('read-result').find((m) => m.id === mine)!.data as Uint8Array).byteLength }
}

it('a partial read is answered with the run of pieces in from its offset', async () => {
  engine.read.mockImplementation(async (_h: number, _f: number, _offset: number, len: number) => new Uint8Array(len))
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))

  // inside pieces 1 and 2, up to where piece 3 is missing
  expect(await read({ viewer: 'player', partial: true, offset: 2_000_000, len: 2_500_000 })).toEqual({ asked: [3 * MiB - 2_000_000], got: 3 * MiB - 2_000_000 })
  // all of it is in
  expect(await read({ viewer: 'player', partial: true, offset: 100, len: 2_500_000 })).toEqual({ asked: [2_500_000], got: 2_500_000 })
})

it('a partial read whose first piece is missing waits for that piece alone, though the next one is in', async () => {
  expect(await read({ viewer: 'player', partial: true, offset: 3_200_000, len: 2_500_000 })).toEqual({ asked: [4 * MiB - 3_200_000], got: 4 * MiB - 3_200_000 })
  // the end of the file ends the piece
  expect(await read({ viewer: 'player', partial: true, offset: 9_500_000, len: 2_500_000 })).toMatchObject({ asked: [500_000] })
})

it('any other read gets every byte it asked for, whoever its viewer is', async () => {
  expect(await read({ viewer: 'save', offset: 2_000_000, len: 2_500_000 })).toEqual({ asked: [2_500_000], got: 2_500_000 })
  expect(await read({ offset: 3_200_000, len: 2_500_000 })).toEqual({ asked: [2_500_000], got: 2_500_000 })
  expect(rig.of('worker-error')).toEqual([])
})

it('a partial read of a file that starts inside a piece counts its pieces from where the file starts', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  const film = { viewer: 'player', partial: true, handle: 2, fileIndex: 1, len: 2_500_000 }

  // the film's byte 0 is in piece 1, and pieces 1 and 2 are in, so the answer ends where piece 3 starts
  expect(await read({ ...film, offset: 0 })).toEqual({ asked: [3 * MiB - 1_500_000], got: 3 * MiB - 1_500_000 })
  // inside missing piece 3, the rest of that piece alone
  expect(await read({ ...film, offset: 2_000_000 })).toEqual({ asked: [4 * MiB - 1_500_000 - 2_000_000], got: 4 * MiB - 1_500_000 - 2_000_000 })
  expect(rig.of('worker-error')).toEqual([])
})
