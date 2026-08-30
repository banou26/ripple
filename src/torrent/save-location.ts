import type { SaveLocation } from './library'

import { SHARED_ROOT, savePathFor } from './library'
import { isNativeSavePath, nativeSavePathFor } from './hybrid-storage'

/**
 * Where a torrent's files are meant to live, and where they actually are.
 *
 * Two places exist, and they are not interchangeable:
 *
 *  - `browser`, which is OPFS. The only place a download can be WRITTEN. libtorrent writes pieces at
 *    arbitrary offsets as they arrive, and OPFS is the only backend that takes an in-place random
 *    write, through a sync access handle.
 *  - `folder`, a directory the user granted. Readable, so a torrent can be shared out of it, but a
 *    write there can only go through `createWritable`, which publishes by renaming a `.crswap`
 *    sibling over the target at close.
 *
 * MEASURED, because "you cannot download into a folder" would be too strong and is not what the
 * browser does. One long-lived writable taking random positional writes runs at 51 MB/s against the
 * sync handle's 52, so speed is not the problem. Three other things are: the target file reads 0
 * bytes for the whole download, a `.crswap` sits in the user's folder throughout, and a crash loses
 * everything since the last close because the target was never written at all. Reopening to
 * checkpoint costs a full copy of the file each time, about 1.25 ms per MiB.
 *
 * So downloads land in `browser` and move to `folder` on completion. That is not a compromise
 * invented here: it is exactly qBittorrent's "Keep incomplete torrents in" temp path, arrived at
 * from the same constraint, and it means the intended location and the current one are separate
 * facts about a torrent rather than one.
 *
 * RE-MEASURED 2026-08-30 on Chrome 151, against a real picker-granted directory, because
 * `createWritable` gained a `mode` option since the above was written and `exclusive` reads like it
 * would remove every objection in it. It does not. The conclusion is unchanged and the reasons are
 * now stronger, so do not reopen this without new evidence:
 *
 *  - **`mode: 'exclusive'` still writes a `.crswap`.** Seen twice, by the page and by a process
 *    outside the browser watching the same directory, with siloed mode as the control proving the
 *    detection works. `mode` governs LOCKING, not swap files: a second writable on an already-open
 *    file throws `NoModificationAllowedError`, and that is the whole of what it does.
 *  - **The target still reads 0 bytes mid-stream**, in both modes, which is the objection that
 *    actually made this unusable.
 *  - **Sync access handles are still OPFS only**, re-confirmed in a WORKER (the only realm that
 *    exposes them) with an OPFS handle created by the same worker on the same run as the control:
 *    `InvalidStateError: Access Handles may only be created on temporary file systems`.
 *  - **Checkpointing by reopening costs 3.48 ms per MiB** at 64 MiB and grows with file size, with
 *    `keepExistingData: false` flat at ~70 ms as the control proving the copy is real. Checkpointing
 *    a 1.4 GB episode every 64 MiB is around 50 seconds of pure copying and doubles the writes.
 *
 * What DID come back positive, and is not enough on its own: random positional writes land correctly
 * at 209 MB/s, writes past EOF zero fill exactly as OPFS does, 30 concurrent writables can be held
 * open, and a worker can write through a structured-cloned handle. Speed was never the blocker.
 *
 * Everything in this file is a decision with no IO in it, so the rules can be tested on their own.
 * `move-files.ts` carries them out.
 */

export type { SaveLocation }

export const SAVE_LOCATION_KEY = 'ripple:save-location'

export const isSaveLocation = (value: unknown): value is SaveLocation =>
  value === 'browser' || value === 'folder'

/** What a torrent with no preference of its own gets. */
export const readGlobalDefault = (read: (key: string) => string | null): SaveLocation => {
  const stored = read(SAVE_LOCATION_KEY)
  return isSaveLocation(stored) ? stored : 'browser'
}

/** Where the user WANTS this torrent: its own choice, else the global default. */
export const intendedLocation = (
  entry: { saveTo?: SaveLocation } | null | undefined,
  globalDefault: SaveLocation,
): SaveLocation => (isSaveLocation(entry?.saveTo) ? entry.saveTo : globalDefault)

/** Where the bytes are RIGHT NOW, read off the save path libtorrent was given. */
export const currentLocation = (savePath: string | undefined): SaveLocation =>
  isNativeSavePath(savePath) ? 'folder' : 'browser'

/** The save path to hand libtorrent for a torrent living in `location`. */
export const savePathIn = (location: SaveLocation, infoHash: string | null): string =>
  location === 'folder'
    ? (infoHash ? nativeSavePathFor(infoHash) : SHARED_ROOT)
    : savePathFor(infoHash)

export type MoveReadiness =
  /** already where it should be */
  | { move: false, reason: 'settled' }
  /** wants a folder, but a folder cannot hold something still being written */
  | { move: false, reason: 'incomplete' }
  /** wants a folder, but there is no folder to use right now */
  | { move: false, reason: 'no-folder' }
  /** it should move, and everything it needs is in place */
  | { move: true, to: SaveLocation }

/**
 * Should this torrent's files move, and if not, why not.
 *
 * The `incomplete` case is the whole reason the two locations are tracked separately. Choosing a
 * folder for something still downloading is a perfectly reasonable thing to ask for, and the answer
 * is "yes, once it finishes", not "no". A caller shows that as a pending state rather than an error.
 *
 * `no-folder` is ordinary too: a directory grant is per session and comes back unpermitted after a
 * reload until the user acts. Nothing is wrong, the move just waits.
 */
export const moveReadiness = (
  { current, intended, complete, folderReady }: {
    current: SaveLocation
    intended: SaveLocation
    complete: boolean
    folderReady: boolean
  },
): MoveReadiness => {
  if (current === intended) return { move: false, reason: 'settled' }
  // needed in BOTH directions: moving out of a folder has to read from it, and moving into one has
  // to write to it, so neither can happen while the grant is missing
  if (!folderReady) return { move: false, reason: 'no-folder' }
  if (intended === 'folder' && !complete) return { move: false, reason: 'incomplete' }
  return { move: true, to: intended }
}

/** What a row or an option list says about a location that has not been reached yet. */
export const pendingLabel = (readiness: MoveReadiness, folderName: string | undefined): string | null => {
  if (readiness.move) return null
  if (readiness.reason === 'settled') return null
  const where = folderName ?? 'your folder'
  if (readiness.reason === 'incomplete') return `Moves to ${where} when it finishes`
  return `Waiting for access to ${where}`
}

export const locationLabel = (location: SaveLocation, folderName: string | undefined): string =>
  location === 'folder' ? (folderName ?? 'your folder') : 'Browser storage'
