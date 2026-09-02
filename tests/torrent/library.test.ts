import { describe, expect, it } from 'vitest'

import { SHARED_ROOT, SYNCED_FILE_CAP, mergeEntry, ownsItsDirectory, savePathFor, staysEphemeral, syncedMetadata } from '../../src/torrent/library'
import { DEMO_MAGNET } from '../../src/torrent/constants'
import { magnetInfoHash } from '../../src/torrent/magnet'
import type { Persisted } from '../../src/torrent/library'

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

  /**
   * The same rule for the three fields that travel between devices.
   *
   * An add is written before the swarm has said anything, so it never carries metadata. Letting it
   * through would erase what a previous session already learned, and since the erased list is what
   * the next cloud write uploads, the loss follows the account onto every other device: the second
   * device goes back to eight hex characters and a size of zero for a torrent it was showing
   * properly a moment earlier.
   */
  it('keeps the synced metadata through a re-add that carries none', () => {
    const known = entry({ name: 'Sintel', size: 129_300_000, files: [{ name: 'Sintel.mp4', size: 129_200_000 }] })
    const merged = mergeEntry(known, anAdd())
    expect(merged.name).toBe('Sintel')
    expect(merged.size).toBe(129_300_000)
    expect(merged.files).toEqual([{ name: 'Sintel.mp4', size: 129_200_000 }])
  })

  it('takes fresher metadata when the add has it, the way rootEntry does', () => {
    const known = entry({ name: 'old', size: 1, files: [{ name: 'old.mkv', size: 1 }] })
    const merged = mergeEntry(known, anAdd({ name: 'new', size: 2, files: [{ name: 'new.mkv', size: 2 }] }))
    expect(merged.name).toBe('new')
    expect(merged.size).toBe(2)
    expect(merged.files).toEqual([{ name: 'new.mkv', size: 2 }])
  })

  it('leaves them absent when neither side ever knew', () => {
    const merged = mergeEntry(entry(), anAdd())
    expect(merged.name).toBeUndefined()
    expect(merged.size).toBeUndefined()
    expect(merged.files).toBeUndefined()
  })

  /** a zero-byte torrent is a real thing, and `??` is what keeps it from reading as unknown */
  it('keeps a size of zero rather than treating it as nothing known', () => {
    expect(mergeEntry(entry({ size: 0 }), anAdd()).size).toBe(0)
  })
})

/**
 * The metadata that travels between devices.
 *
 * A second device signed into the same account restores the library from one json blob and has the
 * magnet and nothing else, so these three fields are the only thing standing between a real row and
 * eight characters of infohash with a size of zero. That blob has been round-tripped through cloud
 * storage and written by whatever version of ripple touched it last, so nothing in it is trusted.
 */
describe('the metadata carried between devices', () => {
  it('takes a well formed entry whole', () => {
    expect(syncedMetadata({ name: 'Sintel', size: 129_300_000, files: [{ name: 'Sintel.mp4', size: 129_200_000 }] }))
      .toEqual({ name: 'Sintel', size: 129_300_000, files: [{ name: 'Sintel.mp4', size: 129_200_000 }] })
  })

  it('leaves every field undefined when the entry carries none', () => {
    expect(syncedMetadata({ infoHash: 'a', magnet: 'm' })).toEqual({ name: undefined, size: undefined, files: undefined })
  })

  /** a string size would render as `NaN B`, which looks like a bug in the size formatter */
  it('refuses a size that is not a usable number', () => {
    for (const size of ['129300000', NaN, Infinity, -1, null, {}] as unknown[]) {
      expect(syncedMetadata({ size: size as number }).size, String(size)).toBeUndefined()
    }
  })

  it('refuses an empty or non-string name rather than rendering nothing', () => {
    for (const name of ['', 0, null, {}, []] as unknown[]) {
      expect(syncedMetadata({ name: name as string }).name, JSON.stringify(name)).toBeUndefined()
    }
  })

  it('drops malformed file entries and keeps the rest', () => {
    const files = [
      { name: 'good.mkv', size: 10 },
      { name: 'no size' },
      { size: 5 },
      null,
      'nope',
      { name: 'bad size', size: 'big' },
      { name: 'also good.srt', size: 2 },
    ] as unknown as { name: string, size: number }[]
    expect(syncedMetadata({ files })).toMatchObject({
      files: [{ name: 'good.mkv', size: 10 }, { name: 'also good.srt', size: 2 }],
    })
  })

  /**
   * Capped on the way IN as well as on the way out. The writer's promise is not a property of the
   * reader's input: the blob may have been written by an older ripple, or by a newer one with a
   * larger cap, and one torrent must not decide how much memory the whole list costs.
   */
  it('caps the file list on read, not only on write', () => {
    const files = Array.from({ length: SYNCED_FILE_CAP + 250 }, (_, i) => ({ name: `f${i}`, size: 1 }))
    expect(syncedMetadata({ files }).files).toHaveLength(SYNCED_FILE_CAP)
  })

  it('refuses a files value that is not an array', () => {
    for (const files of ['[]', 3, {}, null] as unknown[]) {
      expect(syncedMetadata({ files: files as { name: string, size: number }[] }).files, String(files)).toBeUndefined()
    }
  })
})

/**
 * The rule the ENGINE has to apply, and the reason it is a named export rather than an expression
 * inside mergeEntry.
 *
 * The list side above was already correct, and tested, and it did not help: the engine's add path
 * decided from the incoming flag alone, so opening a torrent the user owns through a watch link put
 * its handle in `ephemeralHandles` while the list kept `ephemeral: false`. `applyViewing` reads the
 * engine's set, so it idle-parked a torrent out of the user's own library the moment the player
 * closed. It stopped seeding and the row went on saying it was finished and fine.
 *
 * So the property worth pinning is not the rule on its own, it is that ONE rule serves both.
 */
describe('staysEphemeral', () => {
  it('agrees with mergeEntry on every combination, which is the whole point of it existing', () => {
    for (const was of [undefined, null, entry({ ephemeral: true }), entry({ ephemeral: false }), entry({ ephemeral: undefined })]) {
      for (const adding of [true, false]) {
        const merged = mergeEntry(was, anAdd({ ephemeral: adding })).ephemeral === true
        expect(staysEphemeral(was, adding), `was=${JSON.stringify(was?.ephemeral)} adding=${adding}`).toBe(merged)
      }
    }
  })

  /** the bug, stated directly: a watch link on a torrent you own must not make it cache */
  it('keeps a torrent the user owns out of the cache when a page opens it', () => {
    expect(staysEphemeral(entry({ ephemeral: false }), true)).toBe(false)
    expect(staysEphemeral(entry({ ephemeral: undefined }), true)).toBe(false)
  })

  it('leaves a torrent nothing knows about as whatever the add says', () => {
    expect(staysEphemeral(undefined, true)).toBe(true)
    expect(staysEphemeral(undefined, false)).toBe(false)
  })

  it('keeps cache as cache while both sides agree', () => {
    expect(staysEphemeral(entry({ ephemeral: true }), true)).toBe(true)
    expect(staysEphemeral(entry({ ephemeral: true }), false)).toBe(false)
  })
})

/**
 * Run time survives a re-add.
 *
 * `mergeEntry` spreads the incoming entry, and an add carries no run time at all, so without a rule
 * here every re-add would silently reset a torrent's accumulated hours to nothing. Exactly the trap
 * the metadata fields above are guarded against, on a field added later.
 */
describe('accumulated run time', () => {
  const stored = (over: Partial<Persisted> = {}): Persisted =>
    ({ infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', savePath: '/dl/abc', addedAt: 1, ...over })

  it('keeps what was stored when an add carries none', () => {
    const merged = mergeEntry(stored({ activeSeconds: 900, seedingSeconds: 300 }), stored())
    expect(merged.activeSeconds).toBe(900)
    expect(merged.seedingSeconds).toBe(300)
  })

  it('takes the incoming value when there is one, which is how it is ever written', () => {
    const merged = mergeEntry(stored({ activeSeconds: 900 }), stored({ activeSeconds: 960 }))
    expect(merged.activeSeconds).toBe(960)
  })

  it('is absent for a torrent that has never run', () => {
    expect(mergeEntry(stored(), stored()).activeSeconds).toBeUndefined()
  })

  /*
   * The byte counters take the same guard as the seconds, and the trap is the same one.
   *
   * An add carries no counters at all, so without naming them here the spread puts `undefined` over
   * a torrent's whole upload history every time it is re-added, and the erased version is what the
   * next cloud write publishes. That is a silent loss of the exact thing this feature exists to keep.
   */
  it('keeps the byte counters an add does not carry', () => {
    const merged = mergeEntry(stored({ downloaded: 3_000, uploaded: 9_000, wasted: 12 }), stored())
    expect(merged.downloaded).toBe(3_000)
    expect(merged.uploaded).toBe(9_000)
    expect(merged.wasted).toBe(12)
  })

  it('takes an incoming byte counter, which is how the persist loop writes one', () => {
    const merged = mergeEntry(stored({ uploaded: 9_000 }), stored({ uploaded: 9_500 }))
    expect(merged.uploaded).toBe(9_500)
  })
})

/**
 * The three DECISIONS survive a re-add, which is the same trap as the counters above.
 *
 * An add carries no file selection, no first-and-last flag and no save location, because none of
 * them is knowable before the metadata is. Opening a link for a torrent that is in the library but
 * NOT in the session, which is what a synced or evicted torrent is, re-adds it, and the spread put
 * `undefined` over all three: back to every file, in the default place, with nothing on screen
 * saying so. The engine keeps the selection for that one session, because add-magnet seeds its plan
 * from the entry before this runs, so the loss only showed up on the NEXT load.
 */
describe('a re-add does not undo what was decided', () => {
  const stored = (over: Partial<Persisted> = {}): Persisted =>
    ({ infoHash: 'abc', magnet: 'magnet:?xt=urn:btih:abc', savePath: '/dl/abc', addedAt: 1, ...over })

  it('keeps a file selection an add does not carry', () => {
    const merged = mergeEntry(stored({ wantedFiles: [2, 5], firstLast: true, saveTo: 'folder' }), stored())
    expect(merged.wantedFiles).toEqual([2, 5])
    expect(merged.firstLast).toBe(true)
    expect(merged.saveTo).toBe('folder')
  })

  it('takes an incoming selection, which is how set-plan ever changes one', () => {
    const merged = mergeEntry(stored({ wantedFiles: [2, 5], firstLast: true }), stored({ wantedFiles: [0], firstLast: false }))
    expect(merged.wantedFiles).toEqual([0])
    // false is a decision and not an absence, so it has to win over a stored true
    expect(merged.firstLast).toBe(false)
  })

  it('stays absent for a torrent that has never chosen anything, which means all of it', () => {
    const merged = mergeEntry(stored(), stored())
    expect(merged.wantedFiles).toBeUndefined()
    expect(merged.firstLast).toBeUndefined()
    expect(merged.saveTo).toBeUndefined()
  })
})

/*
 * A torrent marked TEMPORARY has to be one the budget pass can actually reclaim.
 *
 * These two rules are written in different files and only agree by construction: `worker.ts` roots a
 * `.torrent` add at the SHARED_ROOT, because an infohash only appears after the add, while
 * `collectCandidates` refuses any candidate failing `ownsItsDirectory`, which demands exactly
 * `/dl/<infoHash>`. So marking a shared-root add `ephemeral: true` produces a row labelled temporary
 * that nothing can ever take back: the label promises what the pass cannot deliver. That shipped for
 * the demo torrent and is the reason this test exists.
 */
describe('a temporary torrent owns the directory it can be reclaimed from', () => {
  it('refuses the shared root, which is where a .torrent add lands by default', () => {
    expect(ownsItsDirectory(SHARED_ROOT, 'aabbccddeeff00112233445566778899aabbccdd')).toBe(false)
  })

  it('accepts the per-torrent directory the demo is now given', () => {
    const infoHash = magnetInfoHash(DEMO_MAGNET)!
    expect(infoHash, 'the demo magnet must carry a readable infohash').toMatch(/^[0-9a-f]{40}$/)
    expect(ownsItsDirectory(savePathFor(infoHash), infoHash)).toBe(true)
  })
})
