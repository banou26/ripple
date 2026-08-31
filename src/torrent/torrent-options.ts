import type { Torrent } from './types'
import type { SaveLocation } from './library'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { hasPlayableFile } from './watch'
import { moveReadiness, pendingLabel } from './save-location'
import { limitLabel } from './rate-limits'
import { contentFiles } from './types'

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
  /** Where this torrent's files are meant to be, its own choice or the global default. */
  intended?: SaveLocation
  /** Where its bytes actually are right now, which disagrees while a move is pending. */
  current?: SaveLocation
  /** The granted folder's name, absent when there is no folder or no live grant. */
  folderName?: string
  /** Whether a folder is usable at all right now, which decides if the choice can even be offered. */
  folderReady?: boolean
  /**
   * The ceilings applying to everything at once, in bytes per second, 0 meaning unlimited.
   *
   * Needed here because a per-torrent ceiling above the session one is accepted by libtorrent and
   * then ignored: a torrent can never exceed the global limit. Without the session figure to
   * compare against, the item would show a number that is not the one in force and read as broken.
   */
  sessionLimits?: { down: number, up: number }
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
  /** Choose where this torrent's files belong. The move itself follows when it can. */
  setLocation: (location: SaveLocation) => void
  /**
   * Whether Ripple may delete this torrent's bytes to make room.
   *
   * `true` means keep it, which is the direction the control is worded in. Turning it OFF makes the
   * data auto-deletable later with no further interaction, so the caller is expected to confirm that
   * direction; this module only declares the control.
   */
  setKept: (kept: boolean) => void
  /** Fetch the head and tail of each wanted file ahead of the middle. */
  setFirstLast: (on: boolean) => void
  /** Choose or change the folder, which is the picker qBittorrent's Set location opens. */
  pickFolder: () => void
  /** Open the speed ceiling editor for this torrent, one direction at a time as qBittorrent does. */
  limitRate: (direction: 'down' | 'up') => void
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

/**
 * A torrent with no engine handle behind it, for either of the two reasons there are.
 *
 * A ghost is not on this device at all. A `starting` row is on its way but the session does not exist
 * yet, which on a reload lasts over a second while the relay grants a listen port. Neither can be
 * acted on, and acting on one sends a command naming no torrent, so both disable the same controls.
 * They differ only in what is OFFERED instead: a ghost gets "Download to this device", and a
 * starting torrent gets nothing, because it is already doing that.
 */
const hasNoHandle = (t: Torrent) => isGhost(t) || t.state === 'starting'

export const buildTorrentOptions = (
  t: Torrent,
  a: TorrentOptionActions,
  context: TorrentOptionContext = { savedToUserStorage: false },
): OptionGroup[] => {
  // named `ghost` throughout for the reason it usually is one, but it covers both handle-less cases:
  // every control it disables would otherwise send a command naming no torrent
  const ghost = !hasNoHandle(t)
    ? undefined
    : isGhost(t) ? 'This torrent is not running on this device.' : 'This torrent is still starting up.'
  const complete = t.progress >= 1
  const sequential = has(t, TORRENT_FLAG.sequentialDownload)

  const multi = contentFiles(t.files).length > 1
  const sessionLimits = context.sessionLimits ?? { down: 0, up: 0 }

  /**
   * The things that used to be buttons on the row.
   *
   * The row kept seven of them and could not take another, which is what pushed this menu into
   * existence in the first place. It now keeps four icons for what people reach for constantly and
   * everything else lives here, where it has room for a name and a sentence.
   */
  const actions: OptionItem[] = []
  // Not for a ghost. Its file list is synced from another device, so it now looks playable while
  // none of the bytes are here, and Watch would silently start the full permanent download that the
  // row's own Download button exists to ask for.
  if (hasPlayableFile(t) && !isGhost(t)) {
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
      label: 'Download to this device',
      hint: 'This torrent is in your library but not on this device. This fetches it again.',
      run: a.start,
    })
  }
  if (!!contentFiles(t.files).length && complete && !isGhost(t)) {
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
      // a magnet is the whole of a share link, so this needs no metadata and no bytes on disk
      label: 'Get a share link',
      hint: 'Makes a link that plays or downloads this torrent on any device.',
      run: a.embed,
    })
  }

  const groups: OptionGroup[] = []
  // Named apart from the 'manage' group at the bottom, which was also "This torrent" and made the
  // menu read as though it repeated itself. This one is what you do WITH the content; that one is
  // what you do TO the torrent.
  if (actions.length) groups.push({ id: 'actions', label: 'Actions', items: actions })

  /**
   * Where this torrent's files belong.
   *
   * Two radios rather than a path field, because there are exactly two places a browser can put
   * them and neither is a path the user types. Offered only when a folder is actually usable: with
   * no grant there is one option, which is not a choice.
   *
   * The hint carries the pending state rather than a separate row, since choosing a folder for
   * something still downloading is a reasonable thing to ask for and the honest answer is "when it
   * finishes" rather than a refusal.
   */
  if (context.folderReady && !hasNoHandle(t)) {
    const intended = context.intended ?? 'browser'
    const current = context.current ?? 'browser'
    const readiness = moveReadiness({ current, intended, complete, folderReady: true })
    const pending = pendingLabel(readiness, context.folderName)
    groups.push({
      id: 'location',
      label: 'Set location',
      items: [
        {
          kind: 'radio',
          id: 'location-browser',
          group: 'location',
          label: 'Keep in browser storage',
          hint: current === 'browser' && intended === 'browser'
            ? 'Where Ripple downloads. Private to this browser, and counts against its storage quota.'
            : 'Copies the files back into browser storage. It can be shared and rechecked from there.',
          selected: intended === 'browser',
          apply: () => a.setLocation('browser'),
        },
        {
          kind: 'radio',
          id: 'location-folder',
          group: 'location',
          label: `Move to ${context.folderName ?? 'your folder'}`,
          hint: intended === 'folder' && pending
            ? pending
            : 'Puts the files somewhere you can open, and frees the browser storage they were using. Ripple keeps sharing them from there.',
          selected: intended === 'folder',
          apply: () => a.setLocation('folder'),
        },
        {
          kind: 'action',
          id: 'pick-folder',
          label: 'Choose another folder...',
          // Ripple holds ONE granted directory, so this changes it for everything rather than for
          // this torrent alone. Said out loud, because a per-torrent menu implies per-torrent scope
          // and quietly moving everyone else's files would be the worst possible surprise here.
          hint: 'Picks the folder Ripple saves into. It is shared by every torrent set to save there.',
          run: a.pickFolder,
        },
      ],
    })
  }

  /**
   * Whether this download survives, worded as KEEPING rather than as its opposite.
   *
   * Positive direction on purpose: promoting is the safe, common action and reads as switching
   * something on. The off direction is the one that can lose data, and it loses it LATER, silently,
   * with no further interaction, so the hint has to say that plainly and the caller confirms it.
   *
   * Shown for every torrent, not only temporary ones. A control that appears the moment a torrent
   * becomes deletable would be a control nobody ever finds, and the state it reports is worth
   * reading in both positions.
   */
  groups.push({
    id: 'keep',
    label: 'Storage',
    items: [
      {
        kind: 'toggle',
        id: 'keep',
        label: 'Keep this download',
        hint: t.ephemeral === true
          ? 'Ripple downloaded this to play a link and can delete it to free space. Keep it and only you can remove it.'
          : 'Only you can remove this. Turn it off and Ripple may delete it to free space when storage runs low.',
        checked: t.ephemeral !== true,
        // keyed by infohash rather than handle, like the location controls, so it works on a torrent
        // this device is not running. Without one there is nothing to name in the message.
        disabled: t.infoHash ? undefined : 'This torrent has not reported an infohash yet.',
        apply: (on) => a.setKept(on),
      },
    ],
  })

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
          label: 'Download in sequential order',
          hint: 'Downloads front to back so it can be watched while it arrives. Usually slower.',
          selected: sequential,
          disabled: ghost ?? (complete ? 'This torrent has finished downloading.' : undefined),
          apply: () => a.setFlags(TORRENT_FLAG.sequentialDownload, TORRENT_FLAG.sequentialDownload),
        },
        {
          kind: 'toggle',
          id: 'first-last',
          label: 'Download first and last pieces first',
          hint: 'Takes each file\'s head and tail early, where a player looks for the header and the index.',
          checked: t.firstLast === true,
          // it composes with the piece order rather than replacing it, exactly as in qBittorrent,
          // which is why it is a checkbox beside the pair rather than a third choice within it
          disabled: ghost ?? (complete ? 'This torrent has finished downloading.' : undefined),
          apply: (on) => a.setFirstLast(on),
        },
      ],
    },
    /**
     * The two speed ceilings, as ACTIONS that open a small editor rather than as a control drawn
     * inline.
     *
     * That is qBittorrent's own shape, and it is also the only one this list can express: an option
     * item is a toggle, a radio or an action, and none of the three carries a number. Adding a
     * fourth kind would mean teaching both renderers about a text field, its validation and its
     * commit, for a control most people never touch. The trailing dots are this file's existing mark
     * for an item that opens something.
     *
     * The label carries the value, which is the one place this file's "show the ENGINE's state"
     * rule is deliberately relaxed. There is nothing to read back: the engine's limit getters are
     * sync calls into a context that only runs inside a tick, so asking would hang it. What is shown
     * is what was last asked for, kept in the library entry so it survives a reload, and the label
     * also names the session limit whenever that is the one really binding.
     */
    {
      id: 'speed',
      label: 'Speed',
      items: ([
        ['limit-down', 'Limit download rate...', 'down', 'downloads', t.downloadLimit, sessionLimits.down],
        ['limit-up', 'Limit upload rate...', 'up', 'shares back', t.uploadLimit, sessionLimits.up],
      ] as const).map(([id, label, direction, verb, own, global]) => ({
        kind: 'action' as const,
        id,
        label,
        // the value lives in the hint rather than the label, so the label stays qBittorrent's and the
        // sentence still says what the control does to someone who has never set one
        hint: `How fast this torrent ${verb}, whatever else is running. Currently ${limitLabel(own, global)}.`,
        disabled: ghost,
        run: () => a.limitRate(direction),
      })),
    },
    {
      id: 'peers',
      label: 'Finding peers',
      items: [
        // Phrased in the negative, which is both qBittorrent's wording and libtorrent's own storage.
        // The control used to read "Use the DHT" and invert on the way in and out, which was a
        // needless place to get a switch backwards: the flag IS the disable, so this now says so.
        {
          kind: 'toggle',
          id: 'dht',
          label: 'Disable DHT for this torrent',
          hint: 'Stops looking for peers in the global peer directory. Trackers and peer exchange still apply.',
          checked: has(t, TORRENT_FLAG.disableDht),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? TORRENT_FLAG.disableDht : 0, TORRENT_FLAG.disableDht),
        },
        {
          kind: 'toggle',
          id: 'pex',
          label: 'Disable PeX for this torrent',
          hint: 'Stops connected peers introducing you to the peers they know.',
          checked: has(t, TORRENT_FLAG.disablePex),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? TORRENT_FLAG.disablePex : 0, TORRENT_FLAG.disablePex),
        },
        {
          kind: 'action',
          id: 'reannounce',
          label: 'Force reannounce',
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
          label: 'Upload mode',
          hint: 'Keeps sharing what is already here and stops asking for anything new.',
          checked: has(t, TORRENT_FLAG.uploadMode),
          disabled: ghost,
          apply: (on) => a.setFlags(on ? TORRENT_FLAG.uploadMode : 0, TORRENT_FLAG.uploadMode),
        },
        {
          kind: 'toggle',
          id: 'super-seed',
          label: 'Super seeding mode',
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
        ['queue-top', 'Move to top', 'top'],
        ['queue-up', 'Move up', 'up'],
        ['queue-down', 'Move down', 'down'],
        ['queue-bottom', 'Move to bottom', 'bottom'],
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
      label: 'Force recheck',
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
