import type { TorrentSnapshot } from '../../src/torrent/client'

import { describe, expect, it } from 'vitest'

import { isActive, snapshotState } from '../../src/torrent/use-torrents'

/**
 * What a row CALLS a torrent, which is the only description of it most people ever read.
 *
 * The case this file was written for: a torrent that finished downloading showed QUEUED. Nothing was
 * wrong with the transfer, and nothing in the app said otherwise, so the row was the entire evidence
 * and it was describing the session rather than the torrent. Two ordinary paths reach it, and both
 * arrive with every byte already on disk:
 *
 *  - libtorrent parks a finished torrent past its own `active_seeds` limit. Paused, auto-managed,
 *    no error: queued in libtorrent's sense, done in the person's.
 *  - `applyViewing` idle-parks an ephemeral cache torrent the moment its last viewer leaves, which
 *    is what happens the instant somebody closes a download page or a player.
 *
 * libtorrent state_t, for the numbers below: 1 checking_files, 2 downloading_metadata,
 * 3 downloading, 4 finished, 5 seeding, 7 checking_resume_data.
 */

const snap = (status: Partial<NonNullable<TorrentSnapshot['status']>> | null, over: Partial<TorrentSnapshot> = {}): TorrentSnapshot => ({
  handle: 1,
  magnet: 'magnet:?xt=urn:btih:abc',
  files: { storageIndex: 0, pieceLength: 1 << 18, numPieces: 10, totalSize: 100, files: [] },
  status: status && { state: 3, paused: false, ...status },
  bitfield: null,
  recovery: null,
  userPaused: false,
  displayDownloadRate: 0,
  ...over,
} as unknown as TorrentSnapshot)

describe('the state a torrent row shows', () => {
  it('says Done for a finished torrent the ENGINE stopped, not Queued', () => {
    expect(snapshotState(snap({ state: 4, paused: true }))).toBe('done')
  })

  it('says Done for a seeding torrent parked by the session queue', () => {
    expect(snapshotState(snap({ state: 5, paused: true }))).toBe('done')
  })

  /**
   * The control for the two above. If completion were being read from something that is true of
   * every stopped torrent, this would say Done as well, and the assertions above would pass for a
   * reason that has nothing to do with the torrent having its bytes.
   */
  it('still says Queued for an UNFINISHED torrent the engine stopped', () => {
    expect(snapshotState(snap({ state: 3, paused: true }))).toBe('queued')
  })

  /**
   * A pause the person chose is a decision, and the row is the only place it is reflected back at
   * them. Done would be true and would also lose the one thing they need to see to undo it.
   */
  it('says Paused rather than Done when the person stopped it themselves', () => {
    expect(snapshotState(snap({ state: 5, paused: true }, { userPaused: true }))).toBe('paused')
  })

  it('reads checking before pause, since libtorrent holds a checking torrent paused', () => {
    expect(snapshotState(snap({ state: 7, paused: true }))).toBe('checking')
    expect(snapshotState(snap({ state: 1, paused: true }))).toBe('checking')
  })

  it('leaves a running torrent alone', () => {
    expect(snapshotState(snap({ state: 3 }))).toBe('downloading')
    expect(snapshotState(snap({ state: 5 }))).toBe('seeding')
    expect(snapshotState(snap({ state: 4 }))).toBe('done')
  })

  it('reports a retry over everything except the person\'s own pause', () => {
    const recovery = { reason: 'stalled', attempt: 1, retryAt: 0 }
    expect(snapshotState(snap({ state: 4, paused: true }, { recovery } as Partial<TorrentSnapshot>))).toBe('retrying')
    expect(snapshotState(snap({ state: 4, paused: true }, { recovery, userPaused: true } as Partial<TorrentSnapshot>))).toBe('paused')
  })

  it('waits rather than guessing when the engine has said nothing yet', () => {
    // layout but no status: known to exist, not known to be doing anything
    expect(snapshotState(snap(null))).toBe('queued')
    expect(snapshotState(snap(null, { files: null }))).toBe('downloading')
  })
})

/**
 * What the strip's ACTIVE counts.
 *
 * Measured against a real library on 2026-08-30: one torrent, complete, uploading at 264 kB/s to
 * more than forty peers that had dialled in, and the readout said `Active 0 / 1`. Seeding was not
 * counted. Next to `Download 0 B/s` and a `Peak` that samples download alone, all three of the first
 * numbers a person reads agreed that nothing was happening.
 */
describe('which torrents count as active', () => {
  it('counts seeding, which is the whole point of the fix', () => {
    expect(isActive('seeding')).toBe(true)
  })

  it('counts downloading, as it always did', () => {
    expect(isActive('downloading')).toBe(true)
  })

  /** the control: if this counted everything, the readout would be a torrent count with extra steps */
  it('does not count states that move no bytes', () => {
    for (const state of ['paused', 'queued', 'done', 'error', 'missing', 'retrying', 'checking', 'starting'] as const) {
      expect(isActive(state), `${state} should not be active`).toBe(false)
    }
  })

  /** the two readouts have to agree: a snapshot that reads as seeding must also count as active */
  it('agrees with snapshotState, so a seeding row is never counted idle', () => {
    expect(isActive(snapshotState(snap({ state: 5 })))).toBe(true)
    expect(isActive(snapshotState(snap({ state: 3 })))).toBe(true)
    // and a complete torrent the engine parked is genuinely not transferring
    expect(isActive(snapshotState(snap({ state: 5, paused: true })))).toBe(false)
  })
})
