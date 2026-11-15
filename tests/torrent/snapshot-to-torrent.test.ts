import type { TorrentSnapshot } from '../../src/torrent/client'

import { describe, expect, it } from 'vitest'

import { snapshotToTorrent } from '../../src/torrent/use-torrents'

const GB = 1_000_000_000

// a pack of 12 episodes of 1 GB with the first two chosen and on disk, and half of the third held from before it was left out
const pack = (status: object): TorrentSnapshot => ({
  handle: 1,
  magnet: 'magnet:?xt=urn:btih:abc',
  files: {
    storageIndex: 0, pieceLength: 1 << 20, numPieces: 11_445, totalSize: 12 * GB, contentSize: 12 * GB,
    files: Array.from({ length: 12 }, (_, i) => ({ path: `Pack/E${i + 1}.mkv`, size: GB, offset: i * GB, pad: false })),
  },
  status: { state: 4, paused: false, progress: 1, totalDone: 2.5 * GB, totalWanted: 2 * GB, totalWantedDone: 2 * GB, ...status },
  bitfield: { pieces: new Uint8Array([0xff]), numPieces: 11_445, pieceLength: 1 << 20, length: 12 * GB },
  recovery: null,
  userPaused: false,
  displayDownloadRate: 0,
} as unknown as TorrentSnapshot)

describe('a row built from the engine', () => {
  it('counts as remaining only what the chosen files still need', () => {
    expect(snapshotToTorrent(pack({})).stats!.remaining).toBe(0)
    expect(snapshotToTorrent(pack({ state: 3, totalWantedDone: 1.5 * GB })).stats!.remaining).toBe(0.5 * GB)
  })

  // an engine from before totalWantedDone, which a tab can borrow during a rollout
  it('falls back to what is held when the engine does not say what of it was chosen', () => {
    expect(snapshotToTorrent(pack({ state: 3, totalWantedDone: undefined, totalDone: 1.5 * GB })).stats!.remaining).toBe(0.5 * GB)
  })

  // measured on a hybrid torrent of 16 KiB pieces with one file left out: the engine counts the pads inside the chosen
  // pieces as wanted and never as done, so the 43 064 bytes of them are still there once it says finished
  it('counts nothing as remaining once the engine says the chosen files are all here', () => {
    for (const state of [4, 5]) {
      expect(snapshotToTorrent(pack({ state, totalDone: 301_000, totalWanted: 344_064, totalWantedDone: 301_000 })).stats!.remaining).toBe(0)
    }
  })

  it('carries the pieces held and where each file starts, for the details to share out', () => {
    const snapshot = pack({})
    const t = snapshotToTorrent(snapshot)
    expect(t.bitfield).toBe(snapshot.bitfield)
    expect(t.files!.slice(0, 3).map((f) => [f.index, f.offset])).toEqual([[0, 0], [1, GB], [2, 2 * GB]])
  })
})
