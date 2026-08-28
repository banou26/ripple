import { describe, expect, it } from 'vitest'

import type { Persisted } from './library'
import { ghostToTorrent } from './use-torrents'

/**
 * The row for a torrent this device does not have.
 *
 * This is what a second device signed into the same account renders for everything in the library,
 * and it used to read:
 *
 *     f00dface
 *     Files aren't on this device · download to fetch them
 *
 * Eight characters of infohash where a title belongs, which reads as some other torrent rather than
 * as this one waiting, and no size at all. The metadata now travels with the entry, so the row can
 * say what the torrent IS while still being honest that none of it is here.
 */

const HASH = 'f00dfacef00dfacef00dfacef00dfacef00dface'

const entry = (over: Partial<Persisted> = {}): Persisted => ({
  infoHash: HASH,
  // deliberately bare, which is the usual case: a magnet built from a .torrent carries no `dn`
  magnet: `magnet:?xt=urn:btih:${HASH}`,
  savePath: '/downloads',
  addedAt: 1_755_000_000,
  ...over,
})

describe('a library row for a torrent that is not on this device', () => {
  it('shows the synced name and size instead of the infohash', () => {
    const t = ghostToTorrent(entry({ name: 'Single File 13.mkv', size: 1_780_000_000 }))
    expect(t.name).toBe('Single File 13.mkv')
    expect(t.size).toBe(1_780_000_000)
  })

  it('carries the synced file list, with nothing downloaded', () => {
    const t = ghostToTorrent(entry({ files: [{ name: 'a.mkv', size: 10 }, { name: 'b.srt', size: 2 }] }))
    expect(t.files).toEqual([{ name: 'a.mkv', size: 10, progress: 0 }, { name: 'b.srt', size: 2, progress: 0 }])
  })

  /** the regression, stated as the thing that was on screen */
  it('no longer falls back to eight hex characters when metadata is present', () => {
    expect(ghostToTorrent(entry({ name: 'Single File 13.mkv' })).name).not.toBe(HASH.slice(0, 8))
  })

  it('still falls back for an entry written before metadata was synced', () => {
    expect(ghostToTorrent(entry()).name).toBe(HASH.slice(0, 8))
    expect(ghostToTorrent(entry()).size).toBe(0)
    expect(ghostToTorrent(entry()).files).toBeUndefined()
  })

  /**
   * The order matters and is not arbitrary. A synced name was read off the torrent itself; a
   * magnet's `dn` is whatever whoever built the link typed; `rootEntry` is the directory on disk.
   */
  it('prefers the synced name over the magnet display name', () => {
    const t = ghostToTorrent(entry({ name: 'real name', magnet: `magnet:?xt=urn:btih:${HASH}&dn=whatever` }))
    expect(t.name).toBe('real name')
  })

  it('uses the magnet display name when nothing was synced', () => {
    expect(ghostToTorrent(entry({ magnet: `magnet:?xt=urn:btih:${HASH}&dn=from+the+magnet` })).name)
      .toBe('from the magnet')
  })

  it('uses rootEntry ahead of the hash, for entries that predate the synced name', () => {
    expect(ghostToTorrent(entry({ rootEntry: 'on disk' })).name).toBe('on disk')
  })

  /**
   * The safety property the whole ghost shape rests on: every control does `Number(t.id)`, so the
   * prefix makes that NaN and a command can never name a real handle.
   */
  it('keeps an id no control can turn into a handle', () => {
    const t = ghostToTorrent(entry({ name: 'anything' }))
    expect(t.id).toBe(`missing:${HASH}`)
    expect(Number.isNaN(Number(t.id))).toBe(true)
    expect(t.state).toBe('missing')
  })

  it('reports nothing downloaded however much metadata it has', () => {
    const t = ghostToTorrent(entry({ name: 'x', size: 999, files: [{ name: 'a', size: 999 }] }))
    expect(t.downloaded).toBe(0)
    expect(t.progress).toBe(0)
    expect(t.stats).toBeNull()
  })
})
