import type { PickedFile } from '../../src/torrent/walk-source'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_TRACKERS, buildTorrent } from '../../src/torrent/create-source'
import { MIN_FREE_BYTES } from '../../src/torrent/storage-budget'
import { PIECE_HASH_BYTES, contentFiles, plan } from '../../src/torrent/make-torrent'
import { MAX_PATH_ELEMENT_BYTES, layoutFor, measureRoomForCopy, roomForCopy, unsafePathElement } from '../../src/torrent/copy-source'

/**
 * A browser handle tree, small enough to state inline and real enough for `measureOpfsBytes` to walk.
 *
 * `values()` and `getFile()` are the whole of what the walk touches, so the fakes carry those two and
 * nothing else. A directory that THROWS from `values()` is one of the cases below, and it is the
 * reason this is hand written rather than a mock library: the failure shapes are the point.
 */
type FakeHandle = { kind: 'file' | 'directory' }

const opfsFile = (size: number): FakeHandle =>
  ({ kind: 'file', getFile: async () => ({ size }) } as FakeHandle)

const opfsDir = (children: FakeHandle[]): FakeHandle =>
  ({ kind: 'directory', values: async function * () { for (const child of children) yield child } } as FakeHandle)

const stubStorage = (over: { estimate?: unknown, getDirectory?: () => Promise<unknown> }) => {
  vi.stubGlobal('navigator', {
    storage: {
      estimate: async () => over.estimate,
      getDirectory: over.getDirectory ?? (async () => opfsDir([])),
    },
  })
}

/**
 * Where a copied pick's bytes have to land, and whether they will fit.
 *
 * The layout is the half that can be wrong in a way nothing reports. Put a file at the wrong path
 * and the engine's check finds nothing, so it downloads the whole torrent back off the swarm that
 * the person was trying to seed to. Join the wrong picked file to a path and it serves one file's
 * bytes for another: every piece fails its hash, which reads as a network fault and is not one.
 */

const GB = 1_000_000_000

const handle = (name: string) => ({ kind: 'file', name } as unknown as FileSystemFileHandle)

const picked = (path: string[], size: number): PickedFile =>
  ({ path, size, lastModified: 1_000, handle: handle(path.join('/')) })

const build = async (files: PickedFile[], name: string, over: { single?: boolean, format?: 'v1' | 'hybrid' | 'v2' } = {}) => {
  const single = over.single ?? false
  const format = over.format ?? 'v1'
  const planned = plan({ name, files: files.map(({ path, size }) => ({ path, size })), single, format })
  const pieces = new Uint8Array(planned.pieceCount * PIECE_HASH_BYTES).fill(3)
  // one merkle tree per CONTENT file, which is what the v2 half of the encoder insists on. Stand-ins
  // rather than real trees: nothing here reads them, and every assertion is about paths and pairing.
  const fileHashes = contentFiles(planned).map(() => ({ root: new Uint8Array(32).fill(9), layer: [] }))
  return buildTorrent({
    picked: files,
    hashed: { pieces, fileHashes },
    options: { name, trackers: [...DEFAULT_TRACKERS], private: false, format },
    single,
  })
}

describe('whether the copy fits', () => {
  it('leaves the eviction floor free rather than filling the origin to the brim', () => {
    /*
     * 100 GB quota, nothing used, so 99 GB is usable and the last 1 GB is the floor.
     *
     * Filling an origin to the brim would leave the budget pass trying to reclaim a torrent it is
     * not allowed to touch, because a created one is not a cache entry. So the boundary is exactly
     * at the floor, and both sides of it are pinned rather than only the comfortable one.
     */
    expect(roomForCopy({ totalBytes: 99 * GB, usedBytes: 0, limitBytes: 100 * GB })).toEqual({ kind: 'fits' })
    expect(roomForCopy({ totalBytes: 99 * GB + 1, usedBytes: 0, limitBytes: 100 * GB }))
      .toEqual({ kind: 'short', shortBy: 1 })
    expect(100 * GB - MIN_FREE_BYTES, 'the boundary above IS the floor').toBe(99 * GB)
  })

  it('counts what is already there', () => {
    expect(roomForCopy({ totalBytes: 5 * GB, usedBytes: 0, limitBytes: 100 * GB })).toEqual({ kind: 'fits' })
    expect(roomForCopy({ totalBytes: 5 * GB, usedBytes: 96 * GB, limitBytes: 100 * GB }).kind).toBe('short')
  })

  it('says how far short it is, because the dialog quotes the number', () => {
    const room = roomForCopy({ totalBytes: 10 * GB, usedBytes: 95 * GB, limitBytes: 100 * GB })
    // 100 - 95 = 5 GB spare, less the 1 GB floor, so 4 GB usable against a 10 GB pick
    expect(room).toEqual({ kind: 'short', shortBy: 6 * GB })
  })

  /**
   * A browser that will not report its quota is not a browser known to have room.
   *
   * Refusing rather than trying is the whole point: this is the largest copy the app can make, and a
   * failure lands after minutes of writing, with a torrent half copied and nothing added.
   */
  it('refuses to promise a copy against a quota nobody will state', () => {
    expect(roomForCopy({ totalBytes: 1, usedBytes: 0, limitBytes: 0 })).toEqual({ kind: 'unknown' })
    expect(roomForCopy({ totalBytes: 1, usedBytes: 0, limitBytes: Number.NaN })).toEqual({ kind: 'unknown' })
    expect(roomForCopy({ totalBytes: 1, usedBytes: -1, limitBytes: 100 * GB })).toEqual({ kind: 'unknown' })
  })

  it('takes a pick of nothing as fitting, since it asks for nothing', () => {
    expect(roomForCopy({ totalBytes: 0, usedBytes: 0, limitBytes: 100 * GB })).toEqual({ kind: 'fits' })
  })
})

describe('where each file has to be written', () => {
  it('puts a multi-file torrent under a directory named after the torrent', async () => {
    const files = [picked(['E01.mkv'], 700_000_000), picked(['Subs', 'E01.ass'], 40_000)]
    const layout = await layoutFor(await build(files, 'Pack'))
    expect(layout.map((f) => f.path)).toEqual(['Pack/E01.mkv', 'Pack/Subs/E01.ass'])
  })

  /**
   * The single-file trap, and the reason this is read back out of the torrent rather than derived
   * from the pick.
   *
   * libtorrent writes a single-file torrent at `savePath/<name>` with NO directory, and `name` is
   * whatever the dialog was left showing, which the person is free to edit. So the path on disk is
   * the torrent's name and has nothing to do with what the file was called when it was picked.
   * Deriving it from `plan.files[0].path`, which is the obvious thing to do, gives the old name and
   * a check that finds nothing.
   */
  it('puts a single-file torrent at its own name, not the name the file was picked under', async () => {
    const layout = await layoutFor(await build([picked(['original.mkv'], 5_000)], 'Renamed', { single: true }))
    expect(layout.map((f) => f.path)).toEqual(['Renamed'])
    // and the file it is paired with is still the one that was picked, under its own old name
    expect((layout[0]!.ref as FileSystemFileHandle).name).toBe('original.mkv')
  })

  it('hands each path the file the torrent actually orders it with, not the walk order', async () => {
    // `plan()` sorts, the walk did not, and reads are served by position in the TORRENT
    const walked = [picked(['z.mkv'], 10), picked(['a.mkv'], 10)]
    const layout = await layoutFor(await build(walked, 'Pack'))
    expect(layout.map((f) => f.path)).toEqual(['Pack/a.mkv', 'Pack/z.mkv'])
    expect(layout.map((f) => (f.ref as FileSystemFileHandle).name)).toEqual(['a.mkv', 'z.mkv'])
  })

  /**
   * The join has to survive pads, which is why it is by ENGINE INDEX and not by position.
   *
   * A hybrid torrent has libtorrent insert a pad after every file that does not end on a piece
   * boundary. Those pads occupy indices, `Built.handles` carries a `null` in each of them, and the
   * list `readTorrentFile` returns drops them while keeping the index they were numbered against.
   * Walking the two lists in step would therefore pair the second real file with a pad's `null` and
   * throw, or worse, pair it with the wrong handle.
   */
  it('skips the pads a hybrid torrent inserts, and still pairs every file with its own bytes', async () => {
    const files = [picked(['a.mkv'], 40_001), picked(['b.mkv'], 40_002), picked(['c.mkv'], 40_003)]
    const built = await build(files, 'Pack', { format: 'hybrid' })
    // the premise: there really are pads in here, or this proves nothing
    expect(built.plan.files.some((f) => f.pad), 'a hybrid torrent of unaligned files has pads').toBe(true)
    expect(built.handles.some((h) => h === null), 'and Built.handles holds a null at each').toBe(true)

    const layout = await layoutFor(built)
    expect(layout.map((f) => f.path)).toEqual(['Pack/a.mkv', 'Pack/b.mkv', 'Pack/c.mkv'])
    expect(layout.map((f) => (f.ref as FileSystemFileHandle).name)).toEqual(['a.mkv', 'b.mkv', 'c.mkv'])
    // and every size is the real file's, so nothing was paired with a pad
    expect(layout.map((f) => f.size)).toEqual([40_001, 40_002, 40_003])
  })

  it('describes the same total the plan does, so the room check and the copy agree', async () => {
    const files = [picked(['E01.mkv'], 700_000_000), picked(['Subs', 'E01.ass'], 40_000)]
    const built = await build(files, 'Pack')
    const layout = await layoutFor(built)
    expect(layout.reduce((sum, f) => sum + f.size, 0)).toBe(built.plan.totalBytes)
  })
})

/**
 * A name the engine will not keep as written, which is a copy that must not be attempted.
 *
 * MEASURED 2026-09-03: a torrent whose files were named at 100 through 250 characters came back with
 * everything to 240 untouched, and a SECOND shorter file beside each of the 241 and the 250. That is
 * libtorrent renaming what it cannot use, and the copy had written to the original name, so the
 * check found nothing and the torrent sat at 0% downloading what its own author had just made.
 */
describe('a name the engine would rename', () => {
  const long = (n: number) => 'x'.repeat(n - 4) + '.mkv'

  it('accepts everything up to the measured boundary', () => {
    expect(unsafePathElement([`Pack/${long(240)}`])).toBeNull()
    expect(unsafePathElement(['Pack/a.mkv', 'Pack/Subs/b.ass'])).toBeNull()
    expect(unsafePathElement([])).toBeNull()
  })

  it('refuses one byte past it, and says which element', () => {
    expect(unsafePathElement([`Pack/${long(241)}`])).toBe(long(241))
    expect(MAX_PATH_ELEMENT_BYTES).toBe(240)
  })

  it('measures BYTES, not characters, because the limit is in bytes', () => {
    // 121 three-byte characters is 363 bytes and only 121 code units, so a length check would pass it
    const wide = '漢'.repeat(121)
    expect(wide.length).toBeLessThan(MAX_PATH_ELEMENT_BYTES)
    expect(unsafePathElement([wide])).toBe(wide)
  })

  it('checks the torrent NAME too, which is a path element for every file under it', () => {
    expect(unsafePathElement([`${long(300)}/a.mkv`])).toBe(long(300))
  })

  it('is what measureRoomForCopy answers with, before it ever looks at the quota', async () => {
    // no browser storage in this environment at all, so reaching the estimate would throw: getting
    // `unsafe` back proves the check runs first rather than as a fallback
    await expect(measureRoomForCopy(1_000, [long(241)])).resolves.toEqual({ kind: 'unsafe', element: long(241) })
  })
})

/**
 * Whose usage figure the room check believes, which is not the browser's.
 *
 * `opfs-usage.ts` exists because Chrome 151 reported `usageDetails.fileSystem` as 752 bytes against a
 * VERIFIED 1.78 GB of torrent data, and the numbers below are that measurement rather than invented
 * ones. This started out believing `estimate().usage`, which means promising a copy there is no room
 * for and then failing partway through the largest write the app ever makes.
 *
 * The control in the first case is what makes it a test rather than an assertion: the same figures
 * put through `roomForCopy` with the browser's own usage answer "fits", so the two paths are
 * distinguishable and this is measuring which one is taken.
 */
describe('measuring the room before promising a copy', () => {
  const REPORTED = {
    usage: 1_813_502,
    quota: 10_739_231_742,
    usageDetails: { fileSystem: 752, indexedDB: 1_809_581, serviceWorkerRegistrations: 3_169 },
  }
  const ON_DISK = 1_783_407_077
  const ORIGIN = opfsDir([opfsDir([opfsFile(1_783_406_077), opfsDir([opfsFile(1_000)])])])

  afterEach(() => { vi.unstubAllGlobals() })

  it('walks the origin rather than believing a usage figure that is six orders short', async () => {
    expect(REPORTED.usageDetails.fileSystem, 'the premise').toBeLessThan(ON_DISK / 1_000_000)
    stubStorage({ estimate: REPORTED, getDirectory: async () => ORIGIN })

    const room = await measureRoomForCopy(9 * GB)
    expect(room).toEqual({ kind: 'short', shortBy: 1_045_988_085 })

    // THE CONTROL: the same numbers, believing the browser, say there is room for all nine gigabytes
    expect(
      roomForCopy({ totalBytes: 9 * GB, usedBytes: REPORTED.usage, limitBytes: REPORTED.quota }),
      'without the walk this pick reads as fitting, which is the bug',
    ).toEqual({ kind: 'fits' })
  })

  /** A walk that cannot finish is not a reason to refuse; the browser's figure is still a floor. */
  it('falls back to the browser figure when the walk cannot be completed', async () => {
    const unreadable = { kind: 'directory', values: () => { throw new Error('nope') } } as unknown as FakeHandle
    stubStorage({ estimate: REPORTED, getDirectory: async () => unreadable })
    await expect(measureRoomForCopy(GB)).resolves.toEqual({ kind: 'fits' })
  })

  it('refuses when there is no origin to ask at all', async () => {
    stubStorage({ estimate: REPORTED, getDirectory: async () => { throw new Error('no opfs') } })
    await expect(measureRoomForCopy(GB)).resolves.toEqual({ kind: 'unknown' })
  })

  it('refuses when the browser will not state a quota', async () => {
    stubStorage({ estimate: { usage: 0 }, getDirectory: async () => ORIGIN })
    await expect(measureRoomForCopy(GB)).resolves.toEqual({ kind: 'unknown' })
  })
})
