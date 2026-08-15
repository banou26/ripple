/**
 * How fast Ripple is allowed to transfer, globally and for one torrent.
 *
 * Two independent ceilings, exactly as in qBittorrent, and they narrow rather than override: a
 * torrent gets the SMALLER of the session limit and its own. libtorrent enforces them through
 * separate limiters and states outright that a torrent can never exceed the session limit
 * (torrent_handle.hpp:1234), so a per-torrent number above the global one does nothing at all. That
 * is the one thing about this feature a user cannot see, so {@link limitNote} says it out loud.
 *
 * Three values, and all three are different:
 *
 *  - `undefined` is NEVER SET. Only per-torrent, and it is what lets a torrent follow the session
 *    limit and nothing else.
 *  - `0` is EXPLICITLY UNLIMITED. Someone ticked the box, and this torrent is not to be capped even
 *    if a default arrives later.
 *  - anything above 0 is a ceiling in bytes per second.
 *
 * Collapsing the first two is the mistake to avoid, and it is unrecoverable once written to storage.
 *
 * Nothing here reads storage or touches the engine, so the rules can be tested on their own.
 * `worker.ts` carries them out.
 */

/** What a caller stores and what the engine is handed. Bytes per second, 0 meaning unlimited. */
export type RateLimits = {
  down: number
  up: number
}

/** The session-wide pair, under one key so the two are always written together. */
export const RATE_LIMITS_KEY = 'ripple:rate-limits'

export const UNLIMITED = 0

export const NO_LIMITS: RateLimits = { down: UNLIMITED, up: UNLIMITED }

/**
 * Is this a number a ceiling can be expressed as?
 *
 * Deliberately strict. The wasm layer floors and clamps whatever it is given, so a fractional or
 * negative value would be silently accepted and turned into something else, and the number the user
 * then sees would not be the number in force.
 */
export const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** A stored or transmitted value, reduced to something safe to apply. Anything unrecognised is unlimited. */
export const normalizeLimits = (raw: unknown): RateLimits => {
  const source = (raw ?? {}) as Partial<RateLimits>
  return {
    down: isLimit(source.down) ? source.down : UNLIMITED,
    up: isLimit(source.up) ? source.up : UNLIMITED,
  }
}

/** One torrent's own ceilings, absent where it has never been given one. */
export type TorrentLimits = {
  down?: number
  up?: number
}

export const limitsOf = (
  entry: { downloadLimit?: number, uploadLimit?: number } | null | undefined,
): TorrentLimits => ({
  down: isLimit(entry?.downloadLimit) ? entry.downloadLimit : undefined,
  up: isLimit(entry?.uploadLimit) ? entry.uploadLimit : undefined,
})

/**
 * The ceiling that actually applies, which is the tighter of the two.
 *
 * 0 is unlimited on either side, so it loses every comparison rather than winning it as the smallest
 * number. Getting that backwards would make an unlimited session cap everything at zero, which
 * presents as a download that connects, finds peers and never moves.
 */
export const effectiveLimit = (global: number, own: number | undefined): number => {
  if (!isLimit(global) || global === UNLIMITED) return isLimit(own) ? own : UNLIMITED
  if (!isLimit(own) || own === UNLIMITED) return global
  return Math.min(global, own)
}

/**
 * Ripple counts a kilobyte as 1000 bytes everywhere else, so a limit does too.
 *
 * qBittorrent's field is KiB/s, and matching it here would mean a number typed into Ripple and the
 * same number typed into qBittorrent producing different speeds, while the rate shown beside it in
 * the row is computed the decimal way. Consistency within one screen wins over consistency with
 * another program's arithmetic.
 */
export const BYTES_PER_KB = 1000

/**
 * Read what someone typed into the kB/s field.
 *
 * Returns null for anything that is not a usable number, so a caller can refuse rather than guess.
 * An empty field is null and not zero: zero means unlimited, and a half-typed field should never be
 * read as a decision to remove the limit.
 */
export const parseLimit = (text: string): number | null => {
  const trimmed = text.trim()
  if (trimmed === '') return null
  // Number() rather than parseFloat, which happily reads "12abc" as 12
  const kb = Number(trimmed)
  if (!Number.isFinite(kb) || kb < 0) return null
  const bytes = Math.round(kb * BYTES_PER_KB)
  return Number.isSafeInteger(bytes) ? bytes : null
}

/** What goes back INTO the kB/s field. Empty for unlimited, so the field is not prefilled with a 0 to delete. */
export const limitInputValue = (limit: number | undefined): string =>
  isLimit(limit) && limit > UNLIMITED ? String(limit / BYTES_PER_KB) : ''

/** How a ceiling reads in a menu or a row. */
export const formatLimit = (limit: number | undefined): string => {
  if (!isLimit(limit) || limit === UNLIMITED) return 'Unlimited'
  if (limit >= 1_000_000) {
    const mb = limit / 1_000_000
    return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB/s`
  }
  return `${Math.round(limit / BYTES_PER_KB)} kB/s`
}

/**
 * What the option's own line says: its value, and the session limit when that is what really binds.
 *
 * Naming the session limit here is the whole point. A per-torrent number above the global one is
 * accepted by libtorrent and then ignored, so without this the control reads as broken.
 */
export const limitLabel = (own: number | undefined, global: number): string => {
  const mine = isLimit(own) ? own : undefined
  if (mine === undefined) return global === UNLIMITED ? 'Unlimited' : `Unlimited, ${formatLimit(global)} in total`
  const effective = effectiveLimit(global, mine)
  if (effective !== mine) return `${formatLimit(mine)}, held to ${formatLimit(effective)} in total`
  return formatLimit(mine)
}

/**
 * The sentence shown under a per-torrent field when the session limit is the one that binds.
 *
 * Null when there is nothing surprising to report, so a caller can render it or not.
 */
export const limitNote = (own: number | undefined, global: number): string | null => {
  if (!isLimit(own) || own === UNLIMITED) return null
  if (global === UNLIMITED || own <= global) return null
  return `Everything together is limited to ${formatLimit(global)}, so this torrent will not go faster than that.`
}
