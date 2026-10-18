/**
 * How much torrent data Ripple is allowed to keep, and which torrents give theirs up first.
 *
 * Torrent payload is a CACHE: every byte of it can be fetched again from the swarm. The library
 * index is not, so nothing here ever proposes removing a list entry, only the bytes behind one.
 *
 * Pure on purpose. The engine owns `navigator.storage.estimate()`, the session and the deletes;
 * what lives here is the arithmetic, which is the part that can be wrong in a way no browser test
 * would catch. It is also the part that was wrong first: an earlier version credited each candidate
 * with libtorrent's `totalDone`, and OPFS charges a file's EXTENT, not its downloaded bytes. A
 * 4 byte write 512 MiB into a file is charged 536,871,080 bytes, measured in Chromium, and a
 * streamed video has its tail written within seconds of opening because the demuxer reads the
 * container index there. So a barely watched episode costs its full size on disk while `totalDone`
 * says a few hundred MB, and a planner fed that number deletes the entire cache to reclaim space
 * one eviction had already provided. `bytesOnDisk` here means the measured footprint, and the
 * caller re-measures between evictions rather than trusting this arithmetic to be complete.
 */

/** Free space kept in hand beyond what the torrents being watched still have to write. */
export const MIN_FREE_BYTES = 1_000_000_000

/**
 * The least free space kept beyond what the watched files owe, when {@link MIN_FREE_BYTES} cannot be.
 *
 * Firefox holds a frame partitioned under another site to a fixed 10 GiB, and a 9.9 GiB film fits
 * there with 108 MiB to spare (measured on Firefox 157, 2026-10-19), so the floor alone would keep
 * it from ever playing.
 */
export const MARGIN_BYTES = 64 * 1024 * 1024

/** Ceiling on cold cache, so a busy embedding page cannot quietly fill a large disk. */
export const MAX_CACHE_BYTES = 20_000_000_000

/** Share of the browser's budget the cold cache may hold, under the ceiling. */
export const CACHE_SHARE = 0.25

/**
 * The floor, as a share of the whole budget when the budget is small.
 *
 * A fixed 1 GB is most of a 3.3 GB Chromium origin budget, which would keep a single ordinary
 * release from ever fitting. A fixed percentage is worthless at the other end, where 10% of a
 * 200 GB budget is 20 GB of headroom nobody asked for.
 */
export const evictionFloor = (limitBytes: number): number => {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return 0
  return Math.min(MIN_FREE_BYTES, Math.floor(limitBytes * 0.1))
}

/**
 * How much cold cache to keep when there is no space pressure at all.
 *
 * Without this the only bound is the browser's quota, which Chromium derives from free disk: on a
 * roomy machine that is hundreds of gigabytes of video an embedding page may write before a single
 * byte is ever reclaimed. `largestBytes` is the floor of the budget and is load bearing, because a
 * budget below the size of one item evicts something and then immediately downloads it again.
 */
export const cacheBudget = (limitBytes: number, largestBytes: number): number => {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return Math.max(0, largestBytes)
  return Math.max(Math.min(CACHE_SHARE * limitBytes, MAX_CACHE_BYTES), Math.max(0, largestBytes))
}

/**
 * Whether a file someone is watching cannot finish, which is when it is worth saying so.
 *
 * One expression, in one place, because it decides two different things: whether to sweep the bytes
 * nothing owns before giving up, and whether to raise the "Out of storage space" notice a player
 * shows instead of stalling with nothing on screen.
 *
 * Two ways to know. From the numbers: what is left is under {@link MARGIN_BYTES} and under what the
 * watched files owe. And from what the browser did: a refused write whose file, with
 * {@link MARGIN_BYTES}, owes more than is left plus the cold cache. That is the must-have
 * {@link planEviction} gives the cache up for, so a file the plan cannot make room for is always one
 * this calls full.
 *
 * WHY THE NUMBERS ALONE CANNOT SAY IT, measured 2026-09-03 on one machine with 2.7 TiB free, one
 * origin, three 512 MiB sparse writes per engine:
 *
 *  - CHROMIUM reports a FLOATING ceiling. The quota rose from 10.737 GB to 12.353 GB, by exactly
 *    what was written, and `quota - usage` moved by 0 bytes each time: 10,737,418,240, which is
 *    10 GiB, before and after every write. So the headroom is a constant, the first half is
 *    `10 GiB < 64 MiB`, and a file owing more than the headroom proves nothing: on Chromium 149 in a
 *    frame, a 40 GiB extent was accepted and the quota read 53.7 GB after it (2026-10-19).
 *  - FIREFOX reports a FIXED ceiling. The quota stayed at 10,737,418,240 and the headroom fell by
 *    1,613,063,025 bytes against 1,613,063,025 written, byte for byte. A write past it returns a
 *    short count, which `@banou/ponyfill` turns into the `QuotaExceededError` Chromium throws.
 *
 * That is not a small difference in a number, it is a difference in what the number MEANS, and it
 * had gone unnoticed because at low usage a flat quota and a flat headroom read identically.
 * `storage-relief.ts` records the 10 GiB as a cap on the budget; it is a cap on the HEADROOM, and
 * only that reading survives the pair above.
 *
 * The design still holds on Chromium, through {@link cacheBudget} rather than through pressure.
 * With `limit = used + 10 GiB` the cold cache settles where `cold = CACHE_SHARE * (cold + 10 GiB)`,
 * which is about 3.6 GB, so it is bounded and converges rather than growing without end. Pressure is
 * the branch that is inert there, not the whole of it.
 */
export const isOriginFull = ({ usedBytes, limitBytes, pendingBytes, refusedBytes, candidates }: Verdict): boolean => {
  /*
   * An origin whose quota the browser will not report is not an origin that is KNOWN to be full,
   * which is the same rule `planEviction` states below and states for the same reason.
   *
   * Without this line the arithmetic answers the opposite: a limit of 0 leaves `-used` free, which
   * is under anything a watched file owes, and an origin that merely declined to say would raise
   * "Out of storage space" permanently. Unreachable through `measureSpace`, which returns null on a
   * falsy quota before it ever gets here, and this is an exported primitive that two call sites
   * already share, so it may not depend on one caller's guard to be right.
   */
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return false
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return false
  const free = limitBytes - usedBytes
  if (free < Math.min(pendingBytes, MARGIN_BYTES)) return true
  const cache = candidates.reduce((sum, c) => sum + Math.max(0, c.bytesOnDisk), 0)
  return refusedBytes > 0 && refusedBytes + MARGIN_BYTES > free + cache
}

export type EvictionCandidate = {
  infoHash: string
  /** `lastUsedAt ?? addedAt`, resolved by the caller so this module never guesses at a default. */
  usedAt: number
  /** MEASURED OPFS footprint. Not `totalDone`: see the note at the top of this file. */
  bytesOnDisk: number
}

export type Budget = {
  usedBytes: number
  limitBytes: number
  /**
   * What the files someone is actually watching still have to grow by: each one's size less its
   * size on disk. Not its missing pieces, because OPFS charges the extent: once a file's tail is
   * written the holes before it cost nothing more (measured on Firefox 157, 512 MiB written into
   * them moved usage by 0 bytes), while its missing pieces still read as gigabytes.
   */
  pendingBytes: number
  /**
   * Torrents that may be given up: never one with a viewer or an in-flight read, never one the user
   * added by hand, never one still rooted at the shared save path.
   */
  candidates: EvictionCandidate[]
}

export type Verdict = Budget & {
  /**
   * What the files the browser refused a write to for want of room still owe, in torrents someone
   * is watching. Not necessarily part of `pendingBytes`: a download page holds one file of a pack
   * and writes the others.
   */
  refusedBytes: number
}

/** Oldest first, then by infoHash so the same budget always produces the same plan. */
const byAge = (a: EvictionCandidate, b: EvictionCandidate) =>
  a.usedAt - b.usedAt || (a.infoHash < b.infoHash ? -1 : a.infoHash > b.infoHash ? 1 : 0)

/**
 * Which torrents to give up, oldest use first, and no more than that.
 *
 * Two independent reasons to evict, and the plan is the longer of the two prefixes:
 *
 * - PRESSURE. The browser budget has to hold what the watched files still owe plus the floor, or
 *   failing that what they owe plus {@link MARGIN_BYTES}. When even giving up everything falls
 *   short of that the file can never fit, and nothing is given up for it: the write is refused
 *   either way, and the cache would be gone for nothing.
 * - SIZE. Cold cache is capped whether or not the disk is tight, so a page playing episode after
 *   episode cannot leave a hundred gigabytes behind on a machine that never feels full.
 */
export const planEviction = ({ usedBytes, limitBytes, pendingBytes, candidates }: Budget): string[] => {
  // an origin whose quota the browser will not report is not an origin that is known to be full
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return []
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return []

  // a torrent with nothing on disk buys nothing, so taking it is a free deletion
  const ordered = candidates.filter((c) => c.bytesOnDisk > 0).sort(byAge)
  if (!ordered.length) return []

  // freed[k] is what giving up the first k candidates returns
  const freed: number[] = [0]
  for (const c of ordered) freed.push(freed[freed.length - 1]! + c.bytesOnDisk)

  /** Fewest candidates for which `ok` holds, or -1 when it never does. */
  const fewest = (ok: (k: number) => boolean): number => {
    for (let k = 0; k <= ordered.length; k++) if (ok(k)) return k
    return -1
  }

  const owed = Math.max(0, pendingBytes)
  const free = limitBytes - usedBytes

  const forFloor = fewest((k) => free + freed[k]! >= owed + evictionFloor(limitBytes))
  const forMargin = fewest((k) => free + freed[k]! >= owed + MARGIN_BYTES)
  const pressure = forFloor >= 0 ? forFloor : Math.max(0, forMargin)

  const cold = freed[ordered.length]!
  const largest = ordered.reduce((most, c) => Math.max(most, c.bytesOnDisk), 0)
  const budget = cacheBudget(limitBytes, largest)
  const size = fewest((k) => cold - freed[k]! <= budget)

  return ordered.slice(0, Math.max(pressure, size < 0 ? ordered.length : size)).map((c) => c.infoHash)
}
