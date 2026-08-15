import type { Torrent } from './types'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { hasPlayableFile } from './watch'

/**
 * What a user may change about one torrent, defined once and rendered twice.
 *
 * There are two surfaces onto this: a right-click menu on the row, and a dialog behind the row's
 * options button. They are different shapes for different moments, not different feature sets, and
 * the way to keep them that way is for neither to know what the options are. Both walk this list.
 *
 * Two rules run through the whole file.
 *
 * The state shown is always the ENGINE's, read from `t.flags`, never a memory of what was last
 * clicked. libtorrent refuses some combinations and drives others itself, so a control that
 * remembers its own request eventually disagrees with the torrent it claims to describe.
 *
 * A control that cannot change an outcome is not shown at all. Local peer discovery is the clearest
 * case: libtorrent has a per-torrent flag for it, and the session disables LSD outright
 * (`wrapper.cpp` `enable_lsd, false`), so a switch for it would be furniture. The same reasoning
 * keeps queue moves hidden unless the torrent is actually queued.
 */

export type OptionItem =
  | {
    kind: 'toggle'
    id: string
    label: string
    hint: string
    checked: boolean
    /** Why this cannot be used right now, or absent when it can. */
    disabled?: string
    apply: (on: boolean) => void
  }
  | {
    kind: 'radio'
    id: string
    /** Items sharing a `group` are one choice; exactly one of them is selected. */
    group: string
    label: string
    hint: string
    selected: boolean
    disabled?: string
    apply: () => void
  }
  | {
    kind: 'action'
    id: string
    label: string
    hint: string
    /** Destructive, so it is separated and marked in both surfaces. */
    danger?: boolean
    disabled?: string
    run: () => void
  }

export type OptionGroup = {
  id: string
  label: string
  items: OptionItem[]
}

/**
 * What is true about this torrent's surroundings, which the torrent itself cannot say.
 */
export interface TorrentOptionContext {
  /**
   * Whether this torrent's files exist somewhere the person can actually open.
   *
   * Ripple downloads into OPFS, which is browser-private storage with no path, no file manager
   * entry and no way for anyone to reach it except through Ripple. So "remove the torrent and keep
   * the files" is a real choice only once the bytes have also been written into the folder the user
   * chose; against OPFS alone it promises to keep something that is not keepable, and quietly
   * leaves the origin quota spent on data nobody can ever open again.
   *
   * The auto-save mirror is the signal actually available. A one-off "Save to disk" also puts the
   * bytes somewhere real, and leaves no state to observe, so it is not counted; the cost of that is
   * an option hidden from someone who could have used it, which is the safe direction to be wrong
   * in.
   */
  savedToUserStorage: boolean
}

/** Everything the option list needs to be able to do. Supplied by whoever renders it. */
export interface TorrentOptionActions {
  setFlags: (flags: number, mask: number) => void
  reannounce: () => void
  moveInQueue: (where: 'top' | 'up' | 'down' | 'bottom') => void
  recheck: () => void
  pause: () => void
  resume: () => void
  remove: () => void
  removeWithFiles: () => void
  /** Delete this device's copy and keep the library row, for a torrent already in the user's folder. */
  release: () => void
  /** Open the player. Only reachable when the torrent has something playable in it. */
  watch: () => void
  /** Write it out: one file to disk, or the whole torrent as a zip when there is more than one. */
  save: () => void
  /** Open the embed builder for this torrent. */
  embed: () => void
  /** Stop waiting out the recovery backoff and try again now. */
  retryNow: () => void
  /** Add a library entry back to the session, for a torrent this device knows and is not running. */
  start: () => void
}

const has = (t: Torrent, flag: number) => (t.flags & flag) !== 0

/**
 * A torrent this device knows about but has not added to the session. It has no engine handle, so
 * nothing here can act on it, and its `flags` of 0 would otherwise read as "every option off".
 */
const isGhost = (t: Torrent) => t.state === 'missing'

export const buildTorrentOptions = (
  t: Torrent,
  a: TorrentOptionActions,
  context: TorrentOptionContext = { savedToUserStorage: false },
): OptionGroup[] => {
  const ghost = isGhost(t) ? 'This torrent is not running on this device.' : undefined
  const complete = t.progress >= 1
  const sequential = has(t, TORRENT_FLAG.sequentialDownload)

  const multi = (t.files?.length ?? 0) > 1

  /**
   * The things that used to be buttons on the row.
   *
   * The row kept seven of them and could not take another, which is what pushed this menu into
   * existence in the first place. It now keeps four icons for what people reach for constantly and
   * everything else lives here, where it has room for a name and a sentence.
   */
  const actions: OptionItem[] = []
  if (hasPlayableFile(t)) {
    actions.push({
      kind: 'action',
      id: 'watch',
      label: 'Watch',
      hint: 'Play it here. It streams while the rest arrives, so it does not have to finish first.',
      run: a.watch,
    })
  }
  if (isGhost(t)) {
    actions.push({
      kind: 'action',
      id: 'start',
      // A ghost carrying `savedTo` is not missing, it is on their disk with no second copy here. The
      // two cases want the same button and a different sentence, because fetching it again is a
      // recovery in one reading and a duplicate download in the other.
      label: t.savedTo ? 'Download it here again' : 'Download to this device',
      hint: t.savedTo
        ? `The files are in ${t.savedTo.name}, and Ripple is not keeping its own copy. Fetching it again is what it takes to share it.`
        : 'This torrent is in your library but not on this device. This fetches it again.',
      run: a.start,
    })
  }
  if (!!t.files?.length && complete && !isGhost(t)) {
    actions.push({
      kind: 'action',
      id: 'save',
      label: multi ? 'Save as a zip' : 'Save to disk',
      hint: multi
        ? 'Writes every file out as one zip, wherever you choose.'
        : 'Writes the file out wherever you choose.',
      run: a.save,
    })
  }
  if (t.magnet) {
    actions.push({
      kind: 'action',
      id: 'embed',
      // a magnet is the whole of an embed link, so this needs no metadata and no bytes on disk
      label: 'Embed this torrent',
      hint: 'Builds a link or an iframe that plays this torrent on another page.',
      run: a.embed,
    })
  }

  const groups: OptionGroup[] = []
  // Named apart from the 'manage' group at the bottom, which was also "This torrent" and made the
  // menu read as though it repeated itself. This one is what you do WITH the content; that one is
  // what you do TO the torrent.
  if (actions.length) groups.push({ id: 'actions', label: 'Actions', items: actions })

  groups.push(
    {
      id: 'order',
      label: 'Piece order',
      items: [
        {
          kind: 'radio',
          id: 'order-rarest',
          group: 'order',
          label: 'Rarest first',
          hint: 'Grabs the pieces fewest peers have. Finishes sooner and is kinder to the swarm.',
          selected: !sequential,
          // Rarest first is not a flag of its own: it is libtorrent's default picker, and what
          // `sequential_download` replaces. So choosing it means clearing that flag, and there is
          // no state in which both or neither is true.
          disabled: ghost ?? (complete ? 'This torrent has finished downloading.' : undefined),
          apply: () => a.setFlags(0, TORRENT_FLAG.sequentialDownload),
        },
        {
          kind: 'radio',
          id: 'order-sequential',
          group: 'order',
          label: 'In order',
          hint: 'Downloads front to back so it can be watched while it arrives. Usually slower.',
          selected: sequential,
          disabled: ghost ?? (complete ? 'This torrent has finished downloading.' : undefined),
          apply: () => a.setFlags(TORRENT_FLAG.sequentialDownload, TORRENT_FLAG.sequentialDownload),
        },
      ],
    },
    {
      id: 'peers',
      label: 'Finding peers',
      items: [
        {
          kind: 'toggle',
          id: 'dht',
          label: 'Use the DHT',
          hint: 'Finds peers through the global peer directory, with no tracker involved.',
          // stored in the negative: the flag being SET is the DHT being off
          checked: !has(t, TORRENT_FLAG.disableDht),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? 0 : TORRENT_FLAG.disableDht, TORRENT_FLAG.disableDht),
        },
        {
          kind: 'toggle',
          id: 'pex',
          label: 'Exchange peers',
          hint: 'Lets connected peers introduce you to the peers they know. Also stored in the negative.',
          checked: !has(t, TORRENT_FLAG.disablePex),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? 0 : TORRENT_FLAG.disablePex, TORRENT_FLAG.disablePex),
        },
        {
          kind: 'action',
          id: 'reannounce',
          label: 'Ask trackers again now',
          hint: 'Announces immediately instead of waiting for the next interval.',
          disabled: ghost,
          run: a.reannounce,
        },
      ],
    },
    {
      id: 'sharing',
      label: 'Sharing',
      items: [
        {
          kind: 'toggle',
          id: 'upload-only',
          label: 'Upload only',
          hint: 'Keeps sharing what is already here and stops asking for anything new.',
          checked: has(t, TORRENT_FLAG.uploadMode),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? TORRENT_FLAG.uploadMode : 0, TORRENT_FLAG.uploadMode),
        },
        {
          kind: 'toggle',
          id: 'super-seed',
          label: 'Super seeding',
          hint: 'Hands each peer a different piece so the swarm gets a full copy sooner. For rare torrents.',
          checked: has(t, TORRENT_FLAG.superSeeding),
          // libtorrent ignores it while anything is still missing, so offering it then would be a
          // switch that flips back on its own
          disabled: ghost ?? (complete ? undefined : 'Only available once the download has finished.'),
          apply: (on) => a.setFlags(on ? TORRENT_FLAG.superSeeding : 0, TORRENT_FLAG.superSeeding),
        },
      ],
    },
  )

  // Only auto-managed torrents have a position at all; for everything else it is -1 and every move
  // would be a no-op the user could keep clicking.
  if (t.queuePosition >= 0 && !isGhost(t)) {
    groups.push({
      id: 'queue',
      label: `Queue position ${t.queuePosition + 1}`,
      items: ([
        ['queue-top', 'Move to the front', 'top'],
        ['queue-up', 'Move up', 'up'],
        ['queue-down', 'Move down', 'down'],
        ['queue-bottom', 'Move to the back', 'bottom'],
      ] as const).map(([id, label, where]) => ({
        kind: 'action' as const,
        id,
        label,
        hint: 'Decides which torrents run first when more are waiting than can run at once.',
        run: () => a.moveInQueue(where),
      })),
    })
  }

  const maintenance: OptionItem[] = [
    {
      kind: 'action',
      id: 'toggle-run',
      label: t.state === 'paused' || t.state === 'queued' ? 'Resume' : 'Pause',
      hint: 'Stops or restarts this torrent without forgetting anything.',
      disabled: ghost,
      run: () => (t.state === 'paused' || t.state === 'queued' ? a.resume() : a.pause()),
    },
    {
      kind: 'action',
      id: 'recheck',
      label: 'Check the files again',
      hint: 'Re-hashes what is on disk. Use it if the files were changed outside Ripple.',
      disabled: ghost ?? (t.state === 'checking' ? 'A check is already running.' : undefined),
      run: a.recheck,
    },
  ]

  // A stalled torrent is waiting out a backoff rather than paused, so "resume" would do nothing for
  // it. This is the item that actually shortens the wait.
  if (t.state === 'retrying') {
    maintenance.splice(1, 0, {
      kind: 'action',
      id: 'retry-now',
      label: 'Try again now',
      hint: 'Stops waiting out the retry timer and reconnects immediately.',
      run: a.retryNow,
    })
  }

  /**
   * Which removals are real for this torrent.
   *
   * A ghost has no files here at all, so forgetting the entry is the only thing removal can mean.
   * A torrent living only in OPFS cannot have its files "kept", because there is nowhere for them
   * to be kept: offering it would promise something the storage cannot deliver. Only once the
   * bytes are in the user's own folder do both readings exist, and only then are both offered.
   */
  if (isGhost(t)) {
    maintenance.push({
      kind: 'action',
      id: 'remove',
      label: 'Remove from the library',
      hint: 'Forgets this entry. Its files are not on this device anyway.',
      danger: true,
      run: a.remove,
    })
  } else {
    if (context.savedToUserStorage) {
      /**
       * Freeing the space without losing the torrent.
       *
       * Ripple downloads into OPFS and the auto-save mirror then writes the same bytes into the
       * user's folder, so a mirrored torrent is stored twice on one disk and one of the two copies
       * is browser-private storage nobody can open. This drops that one.
       *
       * It is not free, and the hint says so rather than burying it: libtorrent serves uploads by
       * reading the files back, so a torrent with nothing here to read cannot share. That is the
       * whole cost, and it is why this is an action someone chooses rather than something that
       * happens on its own.
       */
      maintenance.push({
        kind: 'action',
        id: 'release',
        label: 'Free Ripple\'s copy',
        hint: 'Deletes the second copy Ripple keeps in browser storage and leaves yours alone. The torrent stays in your library, and stops being shared.',
        run: a.release,
      })
      maintenance.push({
        kind: 'action',
        id: 'remove',
        label: 'Remove from the library',
        hint: 'Forgets the torrent and stops sharing it. The copy in your folder stays.',
        danger: true,
        run: a.remove,
      })
    }
    maintenance.push({
      kind: 'action',
      id: 'remove-files',
      label: context.savedToUserStorage ? 'Remove and delete Ripple\'s copy' : 'Remove and delete the files',
      hint: context.savedToUserStorage
        ? 'Forgets the torrent and frees the space Ripple is using. The copy in your folder stays.'
        : 'Forgets the torrent and deletes what it downloaded. This cannot be undone.',
      danger: true,
      run: a.removeWithFiles,
    })
  }

  groups.push({ id: 'maintenance', label: 'Manage', items: maintenance })

  return groups
}
