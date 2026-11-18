import type { Torrent, TorrentState } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { chosenFiles, leavesFilesOut, queueHolds, stopped } from '../../src/torrent/types'

describe('the chosen files', () => {
  // the page asks this of every torrent on every state tick, twice a second; a pack of 80,000 files took 1.7 s when
  // each file looked through the whole choice (2026-11-17)
  it('are found in one pass over a pack of 80,000 files', () => {
    const files = Array.from({ length: 80_000 }, (_, index) => ({ name: `${index}.bin`, size: 1, index }))
    const wantedFiles = files.slice(1).map((file) => file.index)
    const started = performance.now()
    const chosen = chosenFiles({ files, wantedFiles })
    expect(performance.now() - started, 'must not scale with the files times the choice').toBeLessThan(250)
    expect(chosen.length).toBe(79_999)
    expect(leavesFilesOut({ files, wantedFiles })).toBe(true)
  })
})

describe('a torrent libtorrent\'s queue holds', () => {
  const held = TORRENT_FLAG.paused | TORRENT_FLAG.autoManaged
  const row = (state: TorrentState, flags: number) => ({ state, flags }) as Torrent

  it('is not stopped, so its row, its options and the bar offer to pause it', () => {
    expect(queueHolds(row('queued', held))).toBe(true)
    expect(stopped(row('queued', held))).toBe(false)
  })

  it('leaves stopped what the queue does not hold: a pause, a parked temporary torrent, a finished one, no status yet', () => {
    for (const [state, flags] of [['paused', TORRENT_FLAG.paused], ['queued', TORRENT_FLAG.paused], ['completed', held], ['queued', 0]] as const) {
      expect(stopped(row(state, flags)), `${state} ${flags}`).toBe(true)
    }
  })

  it('is not a retrying torrent, whose error keeps auto-management on', () => {
    expect(queueHolds(row('retrying', held))).toBe(false)
  })
})
