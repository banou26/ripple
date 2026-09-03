import { describe, expect, it } from 'vitest'

import type { Persisted } from '../../src/torrent/library'
import { ghostToTorrent, rowsForEntriesNotInTheEngine, waitsForItsSource } from '../../src/torrent/use-torrents'

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
    expect(t.files).toEqual([{ name: 'a.mkv', size: 10, progress: 0, index: 0 }, { name: 'b.srt', size: 2, progress: 0, index: 1 }])
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

/**
 * Which created sources get a row, which is the difference between a torrent somebody can remove and
 * one stuck in their library forever.
 *
 * A source entry is normally left out of every row on purpose: the waiting list carries it and
 * offers the button that asks for access again. That list reads the handle the page stored, so an
 * entry with no handle falls out of it too, and an entry in NO list has no row and no way to be
 * removed. `started: false` is what the publish path writes when it could not keep a handle, and it
 * is what sends the entry here instead of nowhere.
 */
describe('which created sources need a row of their own', () => {
  const source = (over: Partial<Persisted> = {}): Persisted =>
    entry({ saveTo: 'source', started: true, name: 'Pack', size: 10, ...over })

  it('leaves a re-openable source to the waiting list, which has a button for it', () => {
    expect(waitsForItsSource(source())).toBe(true)
    // absent means started, which is what a page that predates the flag writes
    expect(waitsForItsSource(source({ started: undefined }))).toBe(true)
  })

  it('gives a source that can never be re-opened a row, so it can be removed', () => {
    expect(
      waitsForItsSource(source({ started: false })),
      'an entry in no list at all cannot be seen or deleted',
    ).toBe(false)
  })

  /** and the control: nothing about an ordinary download goes through this at all */
  it('says nothing about an entry that is not a created source', () => {
    expect(waitsForItsSource(entry({ saveTo: 'browser', started: false }))).toBe(false)
    expect(waitsForItsSource(entry({ started: true }))).toBe(false)
  })

  /** the ghost row it then becomes is one somebody can actually act on */
  it('builds a ghost that names the torrent rather than its hash', () => {
    const ghost = ghostToTorrent(source({ started: false }))
    expect(ghost.name).toBe('Pack')
    expect(ghost.state).toBe('missing')
  })
})

/**
 * The selection itself, not just the predicate under it.
 *
 * `waitsForItsSource` being right is worth nothing if the caller stops asking it, and the caller
 * used to be three statements inside a `useMemo` that no test could reach: reverting the wiring left
 * the whole suite green while an entry went back to rendering nowhere. This drives the same function
 * the memo calls.
 */
describe('rows for entries the engine does not have', () => {
  const hash = (n: number) => String(n).repeat(40)
  const at = (n: number, over: Partial<Persisted> = {}): Persisted =>
    entry({ infoHash: hash(n), magnet: `magnet:?xt=urn:btih:${hash(n)}`, addedAt: n, ...over })

  const ids = (list: Persisted[], live: string[] = []) =>
    rowsForEntriesNotInTheEngine(list, new Set(live)).map((t) => t.id)

  it('gives a created source with no way back a ghost row, so it can be removed', () => {
    expect(ids([at(1, { saveTo: 'source', started: false })])).toEqual([`missing:${hash(1)}`])
  })

  it('leaves a re-openable created source to the waiting list, with no row here', () => {
    expect(ids([at(1, { saveTo: 'source', started: true })]), 'a duplicate of the waiting entry').toEqual([])
    expect(ids([at(1, { saveTo: 'source' })])).toEqual([])
  })

  it('still separates ordinary ghosts from ordinary starting rows', () => {
    const rows = ids([at(1, { started: false }), at(2, { started: true })])
    // starting first, then ghosts, which is the order the list renders them in
    expect(rows).toEqual([`starting:${hash(2)}`, `missing:${hash(1)}`])
  })

  it('says nothing about an entry the engine already has', () => {
    expect(ids([at(1, { started: false })], [hash(1)])).toEqual([])
  })

  it('orders each kind oldest first, so nothing jumps around between renders', () => {
    const rows = ids([at(3, { started: false }), at(1, { started: false }), at(2, { started: false })])
    expect(rows).toEqual([`missing:${hash(1)}`, `missing:${hash(2)}`, `missing:${hash(3)}`])
  })
})
