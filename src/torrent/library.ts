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
// wantedFiles is the file selection, absent meaning all of them, and firstLast is qBittorrent's "download first and last pieces first"; both live here rather than only in the engine because clearStreamWindow rewrites the whole priority map on every restore
// saveTo is where the user WANTS this torrent, which is not the same fact as savePath, where its bytes are: a folder cannot hold a download in progress, so the two disagree until it finishes
// downloadLimit and uploadLimit are this torrent's own speed ceilings in bytes per second, and they live here because the engine cannot be asked: the getters for them are sync calls into an io_context that only runs inside a tick, so what the user asked for is only ever what we remember asking for
// absent means never given one, which is NOT the same as 0: 0 is a torrent deliberately exempted from a limit, and collapsing the two cannot be undone once written
export type Persisted = {
  infoHash: string, magnet: string, savePath: string, addedAt: number,
  started?: boolean, paused?: boolean, ephemeral?: boolean, lastUsedAt?: number, rootEntry?: string,
  saveTo?: SaveLocation, wantedFiles?: number[], firstLast?: boolean,
  downloadLimit?: number, uploadLimit?: number,
  /**
   * What the torrent IS, written once its metadata lands and then never re-derived.
   *
   * Device-portable on purpose, unlike everything above it that describes what this browser is
   * holding. A second device signed into the same account has the magnet and nothing else, so
   * without these its row could only show eight characters of infohash and a size of zero. The
   * metadata is a property of the torrent, not of the machine, so it travels.
   *
   * `files` is capped when it is written; see the writer for why and for what a truncated list
   * means to a reader.
   */
  name?: string, size?: number, files?: { name: string, size: number }[],
}

/**
 * Where a torrent's files are meant to live.
 *
 * Declared here rather than in `save-location.ts`, which owns the rules, because that module reads
 * save paths out of this one and the dependency cannot run both ways.
 *
 * Device-local, like `started` and `paused`: a folder belongs to one machine, so it has no business
 * being mirrored to another. The cloud backup allowlists four fields, so it stays out for free.
 */
export type SaveLocation = 'browser' | 'folder'

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
 * - the speed ceilings come from the OLD entry unless the add carries its own. Unlike a save
 *   location, a cap does not describe the copy on disk, it describes how hard the user is willing to
 *   let this torrent work their connection, and re-adding a torrent is no reason to quietly uncap
 *   it. An add that names a limit still wins, so the add dialog stays authoritative.
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
      // An add carries no metadata: it is written before the swarm has said anything. Letting the
      // spread through would erase what a previous session, or another device, already learned, and
      // the erased version is what the next cloud write uploads.
      name: next.name ?? was.name,
      size: next.size ?? was.size,
      files: next.files ?? was.files,
      downloadLimit: next.downloadLimit ?? was.downloadLimit,
      uploadLimit: next.uploadLimit ?? was.uploadLimit,
    }
    : next

/**
 * How many file entries travel with a torrent in the library list.
 *
 * The list is mirrored to the cloud as one json document, so an unbounded per-torrent array makes
 * the whole backup hostage to the largest torrent in it. A hundred is comfortably more than a
 * season pack and small enough that fifty of them stay well inside a sensible blob.
 */
export const SYNCED_FILE_CAP = 100

/**
 * The metadata fields of an incoming entry, and nothing else.
 *
 * This is json that has been round-tripped through cloud storage, so it is shaped by whatever wrote
 * it last, which may be a newer or older ripple. Each field is checked rather than trusted: a `size`
 * that is a string would render as `NaN B`, and a `files` array with no bound would let one entry
 * decide how much memory the list costs. The same cap is applied on the way in as on the way out,
 * because the writer's promise is not a property of the reader's input.
 */
export const syncedMetadata = (e: Partial<Persisted>): Pick<Persisted, 'name' | 'size' | 'files'> => ({
  name: typeof e.name === 'string' && e.name ? e.name : undefined,
  size: typeof e.size === 'number' && Number.isFinite(e.size) && e.size >= 0 ? e.size : undefined,
  files: Array.isArray(e.files)
    ? e.files
      .filter((f): f is { name: string, size: number } =>
        !!f && typeof f.name === 'string' && typeof f.size === 'number' && Number.isFinite(f.size))
      .slice(0, SYNCED_FILE_CAP)
    : undefined,
})

/**
 * Where the library list lives in this browser.
 *
 * Shared rather than private to the worker because the PAGE reads it too, at mount, to find out
 * which thumbnails it can show before the engine exists. That read costs a fraction of a
 * millisecond and the engine takes seconds, so binding the two together made every reload look like
 * the pictures had been lost.
 */
export const LIST_KEY = 'ripple:torrents'
