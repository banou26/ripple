import type { SaveLocation } from './library'

/**
 * What a person can actually DO about a full origin, and the words for it.
 *
 * On CHROMIUM the browser's budget is a flat cap rather than a share of the disk: measured
 * 2026-08-30 at exactly 10 GiB on a machine with 2.8 TiB free, identical for two unrelated origins,
 * and `navigator.storage.persist()` was refused on every attempt there without ever raising a
 * prompt. Nothing this module offers changes that number, and nothing else can either.
 *
 * The 10 GiB caps the HEADROOM, not the quota, which is a stronger statement than the paragraph
 * above knew when it was written and does not change a word of the advice it gives. Re-measured
 * 2026-09-03 by writing rather than by reading: three 512 MiB sparse writes raised Chromium's
 * reported quota from 10.737 GB to 12.353 GB, by exactly what was written, leaving `quota - usage`
 * at 10,737,418,240 bytes after every one of them. Firefox on the same machine and origin held its
 * quota still and let the headroom fall by the 1,613,063,025 bytes written, byte for byte.
 *
 * At low usage those two look identical, which is why one reading stood for the other. The reason it
 * matters is in `storage-budget.ts`: a ceiling that floats means Chromium never reports the origin
 * as full, so the pressure half of the eviction budget and the "Out of storage space" notice are
 * both inert there. What is NOT affected is anything this module says. Bytes still count against the
 * cap, moving them to a folder still takes them out from under it, and Chromium still refuses to
 * raise it.
 *
 * On FIREFOX that same call is not the same thing. Measured 2026-09-01 on torrent.fkn.app: granting
 * its "Store data in persistent storage" doorhanger moved the reported quota from 12 GB to 3.97 TB
 * on an 8.03 TB device. That route is deliberately NOT part of this module, because it is a prompt
 * the person may never be shown and that Chromium answers no to; it lives beside this one in
 * storage-permission.ts and use-persistent-storage.ts.
 *
 * So every route THIS module offers is about moving bytes OFF the origin, which works on every
 * engine, and there is exactly one place they can go, which is the folder the user granted.
 *
 * WHY THIS EXISTS AT ALL. Choosing a folder does not free anything. It turns on the auto-save
 * MIRROR, which copies finished downloads into the folder and keeps Ripple's own copy, so usage goes
 * UP. Freeing the origin needs a second, separate decision: the global save location moving to
 * `folder`, which is what makes `moveReadiness` return a move and `relocate` drop the browser copy.
 *
 * Those two controls sit next to each other in the footer and read as one feature. Somebody watching
 * their downloads stop had no way to know they needed both, and the warning they were reading said
 * "Removing a torrent frees its files", which points at deleting their library instead. This module
 * is the missing half of that sentence.
 *
 * Pure, like save-location.ts and for the same reason: the rules and the words are both worth
 * testing without a browser, a folder grant or an engine.
 */

export type StorageRelief =
  /** This browser cannot grant a folder at all, so removing torrents really is the only lever. */
  | { kind: 'none' }
  /** No folder has ever been chosen. */
  | { kind: 'choose' }
  /** A folder is live, but finished downloads are being COPIED there rather than moved. */
  | { kind: 'move', folderName: string }
  /** The folder is remembered and its permission is not currently granted, so nothing can move. */
  | { kind: 'allow', folderName: string }
  /** Already moving finished downloads out. Nothing further to offer. */
  | { kind: 'settled', folderName: string }

export const storageRelief = (
  { supported, folderName, permitted, defaultLocation }: {
    supported: boolean
    folderName: string | undefined
    permitted: boolean
    defaultLocation: SaveLocation
  },
): StorageRelief => {
  if (!supported) return { kind: 'none' }
  if (!folderName) return { kind: 'choose' }
  // ordered before the location check on purpose: a lapsed grant blocks the move whatever the
  // setting says, so offering "move them" while nothing can move would be a button that does nothing
  if (!permitted) return { kind: 'allow', folderName }
  if (defaultLocation !== 'folder') return { kind: 'move', folderName }
  return { kind: 'settled', folderName }
}

/**
 * The sentence after the figures, and the button beside it.
 *
 * Kept here rather than in the component so the copy is covered by the same table-driven test as the
 * rules. Every one of these has to say what the limit IS before offering a way round it, because the
 * first thing people try is to look for a setting that raises it.
 *
 * On Chromium there is no such setting. On Firefox there is a prompt, and it is a SEPARATE offer
 * with its own copy in storage-permission.ts. These sentences are about the folder, which moves
 * bytes out from under the limit and never moves the limit itself, so nothing here may be reworded
 * into a promise the folder cannot keep. That is what the last test in storage-relief.test.ts pins.
 */
export const reliefOffer = (relief: StorageRelief): { detail: string, action: string | null } => {
  switch (relief.kind) {
    case 'none':
      // no folder API here, so this is the honest whole of it
      return { detail: 'Removing a torrent frees its files.', action: null }
    case 'choose':
      return {
        // "on its own" rather than a flat "cannot raise it", because since 2026-09-01 Ripple can ASK,
        // and on Firefox that ask is what sets the limit. It still cannot raise it unasked, and on
        // Chromium the ask is refused, so this sentence stays true on both engines and stays honest
        // beside the separate persistent-storage offer that may be on screen with it.
        detail: 'Your browser sets that limit and Ripple cannot raise it on its own. Finished downloads'
          + ' can move to a folder on your computer instead, where only your own disk space applies.',
        action: 'Choose a folder and move finished downloads there',
      }
    case 'move':
      return {
        detail: `Ripple is copying finished downloads to ${relief.folderName}, but it keeps its own`
          + ' copy too, so this limit still applies. Move them instead and the browser copy is freed.',
        action: `Move finished downloads to ${relief.folderName}`,
      }
    case 'allow':
      return {
        detail: `Finished downloads are set to move to ${relief.folderName}, but the browser has`
          + ' forgotten its permission for that folder. Nothing can move until it is given back.',
        action: `Allow ${relief.folderName}`,
      }
    case 'settled':
      return {
        detail: `Finished downloads already move to ${relief.folderName}. What is still here is what`
          + ' has not finished yet, plus anything set to stay in the browser.',
        action: null,
      }
  }
}
