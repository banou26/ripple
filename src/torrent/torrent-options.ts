import type { Torrent } from './types'

import { TORRENT_FLAG } from 'libtorrent-wasm'

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
}

const has = (t: Torrent, flag: number) => (t.flags & flag) !== 0

/**
 * A torrent this device knows about but has not added to the session. It has no engine handle, so
 * nothing here can act on it, and its `flags` of 0 would otherwise read as "every option off".
 */
const isGhost = (t: Torrent) => t.state === 'missing'

export const buildTorrentOptions = (t: Torrent, a: TorrentOptionActions): OptionGroup[] => {
  const ghost = isGhost(t) ? 'This torrent is not running on this device.' : undefined
  const complete = t.progress >= 1
  const sequential = has(t, TORRENT_FLAG.sequentialDownload)

  const groups: OptionGroup[] = [
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
  ]

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

  groups.push({
    id: 'maintenance',
    label: 'This torrent',
    items: [
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
      {
        kind: 'action',
        id: 'remove',
        label: 'Remove from the library',
        hint: 'Forgets the torrent and leaves the downloaded files where they are.',
        danger: true,
        run: a.remove,
      },
      {
        kind: 'action',
        id: 'remove-files',
        label: 'Remove and delete the files',
        hint: 'Forgets the torrent and deletes what it downloaded. This cannot be undone.',
        danger: true,
        disabled: ghost,
        run: a.removeWithFiles,
      },
    ],
  })

  return groups
}
