import { describe, expect, it } from 'vitest'

import { SHARED_ROOT, mergeEntry, ownsItsDirectory, savePathFor } from './library'
import type { Persisted } from './library'

const HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'

const entry = (over: Partial<Persisted> = {}): Persisted => ({
  infoHash: HASH,
  magnet: 'magnet:?xt=urn:btih:' + HASH,
  savePath: savePathFor(HASH),
  addedAt: 1_000,
  started: true,
  paused: false,
  ...over,
})

/** What every add path writes: this torrent is live here, now. */
const anAdd = (over: Partial<Persisted> = {}) =>
  entry({ addedAt: 5_000, lastUsedAt: 5_000, started: true, paused: false, ...over })

describe('savePathFor', () => {
  it('gives a torrent a directory of its own', () => {
    expect(savePathFor(HASH)).toBe('/dl/' + HASH)
    expect(ownsItsDirectory(savePathFor(HASH), HASH)).toBe(true)
  })

  it('falls back to the shared root when there is no infohash to name it with', () => {
    // a .torrent only reveals its hash after the add, so that path cannot be given its own directory
    expect(savePathFor(null)).toBe(SHARED_ROOT)
    expect(ownsItsDirectory(SHARED_ROOT, HASH)).toBe(false)
  })

  it('refuses a directory that belongs to a different torrent', () => {
    expect(ownsItsDirectory('/dl/' + 'b'.repeat(40), HASH)).toBe(false)
    expect(ownsItsDirectory(undefined, HASH)).toBe(false)
  })
})

describe('mergeEntry', () => {
  it('passes a first add through untouched', () => {
    const fresh = anAdd()
    expect(mergeEntry(null, fresh)).toEqual(fresh)
    expect(mergeEntry(undefined, fresh)).toEqual(fresh)
  })

  it('clears the tombstone an eviction left behind', () => {
    // The one that matters most. After an eviction the row says started:false, and re-watching adds
    // the torrent back. Keeping that flag leaves it live and downloading now, but skipped by the
    // next reload's restore: a full copy of a video on disk attached to nothing.
    const evicted = entry({ started: false, paused: false, ephemeral: true, lastUsedAt: 2_000 })
    expect(mergeEntry(evicted, anAdd({ ephemeral: true })).started).toBe(true)
  })

  it('takes started and paused from the add, never from history', () => {
    const stopped = entry({ started: false, paused: true })
    const merged = mergeEntry(stopped, anAdd())
    expect(merged.started).toBe(true)
    expect(merged.paused).toBe(false)
  })

  it('lets a deliberate add claim a torrent out of the cache for good', () => {
    const cached = entry({ ephemeral: true })
    expect(mergeEntry(cached, anAdd({ ephemeral: false })).ephemeral).toBe(false)
  })

  it('does not let the player put a claimed torrent back into the cache', () => {
    // /embed adds with ephemeral on every mount, including for a torrent the user added by hand
    const mine = entry({ ephemeral: false })
    expect(mergeEntry(mine, anAdd({ ephemeral: true })).ephemeral).toBe(false)
  })

  it('stays cache only while both sides agree', () => {
    const cached = entry({ ephemeral: true })
    expect(mergeEntry(cached, anAdd({ ephemeral: true })).ephemeral).toBe(true)
  })

  it('treats a missing ephemeral flag as a claimed torrent', () => {
    // every entry written before the cache tier existed reads this way, and none of them may be
    // auto-deleted
    expect(mergeEntry(entry({ ephemeral: undefined }), anAdd({ ephemeral: true })).ephemeral).toBe(false)
    expect(mergeEntry(entry({ ephemeral: true }), anAdd({ ephemeral: undefined })).ephemeral).toBe(false)
  })

  it('never moves a torrent that already has bytes somewhere', () => {
    // a re-add into a fresh directory would strand everything already written in the old one
    const legacy = entry({ savePath: SHARED_ROOT })
    expect(mergeEntry(legacy, anAdd({ savePath: savePathFor(HASH) })).savePath).toBe(SHARED_ROOT)
  })

  it('adopts a save path when the old entry never had one', () => {
    const merged = mergeEntry(entry({ savePath: '' }), anAdd({ savePath: savePathFor(HASH) }))
    expect(merged.savePath).toBe(savePathFor(HASH))
  })

  it('keeps the earliest addedAt and the latest lastUsedAt', () => {
    const old = entry({ addedAt: 1_000, lastUsedAt: 9_000 })
    const merged = mergeEntry(old, anAdd({ addedAt: 5_000, lastUsedAt: 5_000 }))
    expect(merged.addedAt).toBe(1_000)
    expect(merged.lastUsedAt).toBe(9_000)
  })

  it('falls back to the add time when neither side recorded a use', () => {
    // the cache is ordered by this, and an undefined would sort as the oldest thing on disk
    const merged = mergeEntry(entry({ lastUsedAt: undefined }), anAdd({ lastUsedAt: undefined, addedAt: 5_000 }))
    expect(merged.lastUsedAt).toBe(5_000)
  })

  it('remembers what the torrent occupies when the add does not say', () => {
    // the orphan sweep reads this to tell a release folder from data nothing owns
    expect(mergeEntry(entry({ rootEntry: 'Sintel' }), anAdd()).rootEntry).toBe('Sintel')
    expect(mergeEntry(entry({ rootEntry: 'Sintel' }), anAdd({ rootEntry: 'Renamed' })).rootEntry).toBe('Renamed')
  })
})
