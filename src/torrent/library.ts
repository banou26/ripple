/**
 * The shape of a library entry, and the one rule for combining two of them.
 *
 * Small and separate because it is where the damage is silent. Every field here decides something
 * the user can lose: whether a torrent is restored on the next reload, whether its bytes may be
 * reclaimed automatically, and which directory they were written to.
 */

// started === false is a torrent synced from another device and NOT added to the session; both flags are device-local and deliberately left out of the cloud backup
// absent or true means active here; paused === true is a pause the user asked for, kept across reloads so auto-recovery never restarts a torrent stopped on purpose
// ephemeral === true is a torrent the PLAYER asked for rather than the user: its bytes are a cache the engine may reclaim, and only those are ever auto-deleted
// lastUsedAt orders that cache; rootEntry is the one name the torrent occupies inside its save path, which is what lets the orphan sweep account for it
// savedTo records that this device wrote the files into a folder of the user's and then let go of its own copy, which is why the row survives with no bytes behind it
export type Persisted = {
  infoHash: string, magnet: string, savePath: string, addedAt: number,
  started?: boolean, paused?: boolean, ephemeral?: boolean, lastUsedAt?: number, rootEntry?: string,
  savedTo?: SavedTo,
}

/** The folder this device copied a torrent into, and when. Device-local, like `started` and `paused`. */
export type SavedTo = { name: string, at: number }

/**
 * The save root every torrent used before per-torrent directories.
 *
 * Deleting one torrent's files there can delete another's: libtorrent names files by their path
 * inside the save path, and a single-file torrent gets no directory of its own, so two releases
 * carrying the same filename are the same OPFS file. Nothing rooted here is ever auto-evicted.
 */
export const SHARED_ROOT = '/dl'

export const savePathFor = (infoHash: string | null) => (infoHash ? SHARED_ROOT + '/' + infoHash : SHARED_ROOT)

/** Only a torrent that owns its whole directory can have that directory deleted out from under it. */
export const ownsItsDirectory = (savePath: string | undefined, infoHash: string) =>
  savePath === savePathFor(infoHash)

/**
 * Combine an existing entry with an add of the same torrent.
 *
 * Field by field, never a spread of either side whole, because the two halves disagree about which
 * direction history flows:
 *
 * - `started` and `paused` come from the INCOMING entry alone. An add is what clears the tombstone
 *   an eviction leaves behind, and carrying a stale `started: false` forward leaves a torrent live
 *   and downloading now but skipped by the next reload's restore. That is a full copy of a video on
 *   disk attached to nothing, and before the orphan sweep existed nothing could ever reclaim it.
 * - `savePath` comes from the OLD entry. Bytes already written stay where they are, so a re-add
 *   must never move a torrent to a fresh directory and strand the old one.
 * - `ephemeral` is an AND, so a deliberate add clears it for good and two player adds cannot put a
 *   torrent the user claimed back into the reclaimable cache.
 * - `addedAt` keeps the earliest and `lastUsedAt` the latest, which is what each one means.
 * - `savedTo` comes from the INCOMING entry, by falling out of the spread, and that is the wanted
 *   behaviour rather than an oversight: an add is a fresh copy being downloaded into this browser,
 *   so a record saying the last copy was handed to a folder no longer describes anything.
 */
export const mergeEntry = (was: Persisted | null | undefined, next: Persisted): Persisted =>
  was
    ? {
      ...next,
      ephemeral: was.ephemeral === true && next.ephemeral === true,
      addedAt: Math.min(was.addedAt, next.addedAt),
      lastUsedAt: Math.max(was.lastUsedAt ?? 0, next.lastUsedAt ?? next.addedAt),
      savePath: was.savePath || next.savePath,
      rootEntry: next.rootEntry ?? was.rootEntry,
    }
    : next
