import type { TorrentSnapshot } from '../../src/torrent/client'

import { describe, expect, it } from 'vitest'

import { snapshotToTorrent } from '../../src/torrent/use-torrents'
import { CHOSEN, E02_PIECES, E03_LAST_PIECE, paddedPack } from './padded-pack'

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

  it('reads a finished selection of a padded torrent as 100%, with nothing remaining', () => {
    const t = snapshotToTorrent(paddedPack({ state: 4, progress: 301_000 / 344_064, totalDone: 301_000, totalWanted: 344_064, totalWantedDone: 301_000 }, E02_PIECES), undefined, undefined, CHOSEN)
    expect([t.progress, t.stats!.remaining]).toEqual([1, 0])
  })

  it('counts what a padded selection still needs without its padding, and the time left from that', () => {
    const downloading = paddedPack({
      state: 3, progress: 299_304 / 344_064, totalDone: 299_304, totalWanted: 344_064, totalWantedDone: 299_304, downloadRate: 1000,
    }, [...E02_PIECES, E03_LAST_PIECE])
    const t = snapshotToTorrent(downloading, undefined, undefined, CHOSEN)
    expect([t.progress, t.stats!.remaining, t.etaSeconds, t.eta]).toEqual([299_304 / 301_000, 1_696, 2, '2s'])
    // a selection stored with its pads, as the add dialog wrote one before it left them out
    expect(snapshotToTorrent(downloading, undefined, undefined, [0, 1, 4, 5, 6, 7, 8]).stats!.remaining).toBe(1_696)
  })

  it('reads a padded selection of nothing but an empty file as whole', () => {
    expect(snapshotToTorrent(paddedPack({ state: 3, progress: 0, totalWanted: 0, totalWantedDone: 0 }, E02_PIECES), undefined, undefined, [8]).progress).toBe(1)
  })

  it('goes by the engine with every file chosen, during a check, and on a torrent with no padding', () => {
    const missing = [...E02_PIECES, E03_LAST_PIECE]
    const all = snapshotToTorrent(paddedPack({ state: 3, progress: 0.5, totalWanted: 451_000, totalWantedDone: 225_500 }, missing))
    expect([all.progress, all.stats!.remaining]).toEqual([0.5, 225_500])
    for (const state of [1, 7]) expect(snapshotToTorrent(paddedPack({ state, progress: 0.3, totalWanted: 344_064, totalWantedDone: 0 }, missing), undefined, undefined, CHOSEN).progress).toBe(0.3)
    expect(snapshotToTorrent(pack({ state: 3, progress: 0.75, totalWantedDone: 1.5 * GB }), undefined, undefined, [0, 1]).stats!.remaining).toBe(0.5 * GB)
  })

  it('carries the pieces held and where each file starts, for the details to share out', () => {
    const snapshot = pack({})
    const t = snapshotToTorrent(snapshot)
    expect(t.bitfield).toBe(snapshot.bitfield)
    expect(t.files!.slice(0, 3).map((f) => [f.index, f.offset])).toEqual([[0, 0], [1, GB], [2, 2 * GB]])
  })
})
