import type { Torrent, TorrentState } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { chosenFiles, leavesFilesOut, stopped } from '../../src/torrent/types'

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

describe('a Queued torrent', () => {
  const row = (state: TorrentState, flags: number) => ({ state, flags }) as Torrent

  it('is not stopped while libtorrent\'s queue holds it, or before the engine reports on it, so it offers Pause', () => {
    expect(stopped(row('queued', TORRENT_FLAG.paused | TORRENT_FLAG.autoManaged))).toBe(false)
    expect(stopped(row('queued', 0))).toBe(false)
  })

  it('is stopped where Ripple parked it, as a paused or a finished one is', () => {
    for (const [state, flags] of [['queued', TORRENT_FLAG.paused], ['paused', TORRENT_FLAG.paused], ['completed', TORRENT_FLAG.paused | TORRENT_FLAG.autoManaged]] as const) {
      expect(stopped(row(state, flags)), `${state} ${flags}`).toBe(true)
    }
  })
})
