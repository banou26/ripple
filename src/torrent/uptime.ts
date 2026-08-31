/**
 * How long a torrent has been running, and how long it has been seeding, across every session.
 *
 * libtorrent counts both itself (`active_duration` and `seeding_duration`) and writes them into
 * resume data, so in principle they survive a restart on their own. In practice they do not, for two
 * reasons that are both about WHEN a blob gets written rather than about the counters:
 *
 *  - a finished or seeding torrent's resume is saved ONCE and then never again, because the periodic
 *    saver in `worker.ts` is `state === 3`, downloading. So the number that comes back is whatever it
 *    was a few seconds after that torrent finished, however many days ago.
 *  - a torrent created from the user's own files has no resume blob at all, deliberately: it holds
 *    every byte from the moment it exists and a blob could only ever be consulted in the one case it
 *    must not be, after the source moved.
 *
 * So the totals are kept in the library entry, which is written for other reasons anyway and is the
 * one record that is always there. The engine stays the source of truth for the CURRENT session and
 * this only accumulates.
 */

export type Uptime = {
  /** Seconds this torrent has been in the session, running, across all time. */
  activeSeconds: number
  /** Of those, seconds spent seeding. */
  seedingSeconds: number
}

export const NO_UPTIME: Uptime = { activeSeconds: 0, seedingSeconds: 0 }

/**
 * The counters that accumulate, seconds and bytes alike, kept together because the argument for
 * keeping them is one argument.
 *
 * The header above is about time, and every word of it applies to the BYTES without change.
 * libtorrent counts `all_time_download` and `all_time_upload` itself and writes them into resume
 * data, and they come back exactly as unreliably: a finished torrent's blob is written once and then
 * never again, so a torrent that has been seeding for a week reports whatever it had uploaded a few
 * seconds after it finished. Somebody who leaves a library seeding sees their upload total reset on
 * every reload, which is the most visible way this goes wrong.
 *
 * So the same delta rule carries them: stored plus what this session added, rebased on every write.
 */
export type Totals = Uptime & {
  /** Bytes moved across every session, as opposed to libtorrent's per-session counters. */
  downloaded: number
  uploaded: number
  /** Bytes that arrived and could not be used: failed hashes plus data already held. */
  wasted: number
}

export const TOTAL_KEYS = ['activeSeconds', 'seedingSeconds', 'downloaded', 'uploaded', 'wasted'] as const

export const NO_TOTALS: Totals = {
  activeSeconds: 0, seedingSeconds: 0, downloaded: 0, uploaded: 0, wasted: 0,
}

const clamp = (n: number | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0

/**
 * The running total, from what was stored plus what this session has added.
 *
 * A DELTA against the engine's reading when the torrent was added, not the engine's reading itself.
 * That is the whole of the correctness here, and it is what stops the two mechanisms fighting: when
 * a resume blob DID restore libtorrent's own counters, the engine starts this session at, say, 900
 * seconds and the stored total already contains those 900. Adding the engine's number would count
 * them twice and the figure would roughly double on every reload. Adding the delta counts them once,
 * and does the right thing in the other case too, where the engine starts at zero.
 *
 * The delta is floored at zero. It goes NEGATIVE for real: a recheck resets libtorrent's timers, and
 * so does re-adding a torrent whose blob was deleted, and time that has already been counted is not
 * something to give back.
 */
/**
 * What THIS session has contributed, which is the delta the total is built from.
 *
 * Factored out rather than written twice because it is the same quantity read two ways: the total
 * adds it to what was stored, and the detail panel shows it beside that total as "this session", the
 * way Downloaded and Uploaded already read. Two spellings of one subtraction would eventually
 * disagree, and the one on screen is the one nobody would check.
 *
 * NOT the engine's own reading. When a resume blob restored libtorrent's counters the engine starts
 * this session at, say, 900 seconds, and 900 of those belong to sessions already counted. Floored at
 * zero because the delta goes negative for real: a recheck resets libtorrent's timers, and so does
 * re-adding a torrent whose blob was deleted.
 */
export const sessionUptime = (atAdd: Uptime, now: Uptime): Uptime => ({
  activeSeconds: Math.max(0, clamp(now.activeSeconds) - clamp(atAdd.activeSeconds)),
  seedingSeconds: Math.max(0, clamp(now.seedingSeconds) - clamp(atAdd.seedingSeconds)),
})

export const totalUptime = (stored: Uptime | undefined, atAdd: Uptime, now: Uptime): Uptime => {
  const session = sessionUptime(atAdd, now)
  return {
    activeSeconds: clamp(stored?.activeSeconds) + session.activeSeconds,
    seedingSeconds: clamp(stored?.seedingSeconds) + session.seedingSeconds,
  }
}

/** Every counter's delta for this session, the same subtraction as `sessionUptime` over more keys. */
export const sessionTotals = (atAdd: Partial<Totals>, now: Partial<Totals>): Totals =>
  Object.fromEntries(TOTAL_KEYS.map((key) =>
    [key, Math.max(0, clamp(now[key]) - clamp(atAdd[key]))])) as Totals

/** Stored plus this session's delta, for every counter. Rebase `atAdd` after storing the result. */
export const accumulate = (stored: Partial<Totals> | undefined, atAdd: Partial<Totals>, now: Partial<Totals>): Totals => {
  const session = sessionTotals(atAdd, now)
  return Object.fromEntries(TOTAL_KEYS.map((key) =>
    [key, clamp(stored?.[key]) + session[key]])) as Totals
}

/**
 * Two devices' totals reconciled, taking the HIGHEST of each.
 *
 * The merge the owner asked for: a laptop on 3 GB and a desktop on 2 GB both end on 3 GB, rather
 * than on 5 GB. Summing would be right only if the two never ran at the same time, and wrong in a
 * way nobody can see afterwards, where a maximum is merely conservative.
 *
 * The property that makes this safe to run anywhere, in any order, any number of times: maximum is
 * commutative, associative and idempotent, and every device's own total only ever grows. So a merge
 * can never move a number backwards, a write lost to a race is republished in full by the next one,
 * and two devices that keep syncing converge. A plain last-writer-wins on the same fields has none
 * of those properties and loses whatever the other device counted.
 */
export const mergeTotals = (a: Partial<Totals> | undefined, b: Partial<Totals> | undefined): Totals =>
  Object.fromEntries(TOTAL_KEYS.map((key) =>
    [key, Math.max(clamp(a?.[key]), clamp(b?.[key]))])) as Totals

/**
 * Whether the totals have moved enough to be worth writing to disk again.
 *
 * Every torrent reports new numbers twice a second, and each write is an IndexedDB transaction over
 * the whole library list. The number on screen comes from memory and is always current; this only
 * decides how much of it survives a tab being closed without warning, so the question is how many
 * seconds of a crash it is acceptable to lose, not how fresh the display is.
 */
export const WRITE_EVERY_SECONDS = 30

export const worthWriting = (stored: Uptime | undefined, next: Uptime): boolean =>
  next.activeSeconds - clamp(stored?.activeSeconds) >= WRITE_EVERY_SECONDS
  || next.seedingSeconds - clamp(stored?.seedingSeconds) >= WRITE_EVERY_SECONDS

/**
 * `3d 4h`, `2h 5m`, `45s`. Two units at most, largest first, and never a bare zero unit beside it.
 *
 * Its own function rather than reusing the ETA formatter: an ETA is a guess about a few minutes and
 * this is a fact about possibly months, so they want different units and round differently. Sharing
 * one would mean a torrent seeding for three months reading `2160h 0m`.
 */
export const formatDuration = (totalSeconds: number): string => {
  const seconds = clamp(totalSeconds)
  if (seconds < 60) return `${seconds}s`
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  return `${minutes}m`
}
