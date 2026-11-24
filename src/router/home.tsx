import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { PoweredByFkn } from '@fkn/lib/react'
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { defineMessages, useIntl, type IntlShape } from 'react-intl'
import { Link, matchPath, useNavigate, useSearchParams } from 'react-router-dom'

import type { Reachability } from '../torrent/client'
import type { EngineTransport } from '../torrent/vpn-config'
import type { QuotaStatus } from '../torrent/use-quota'
import type { StorageUsage } from '../torrent/use-storage-usage'
import type { SyncState } from '../torrent/use-cloud-backup'

import { ChevronDown, ChevronRight, CirclePlay, Clock, Download, Ellipsis, FilePlus, Folder, Pause, Play, Plus, Search, Settings as Gear, Square, SquarePen, X } from 'lucide-react'

import { hexInfoHash, magnetInfoHash, readMagnets, sameInfoHash } from '../torrent/magnet'
import { useTorrents } from '../torrent/use-torrents'
import { useFolder } from '../torrent/use-folder'
import { useQuota } from '../torrent/use-quota'
import { LOW_STORAGE_BYTES, useStorageUsage } from '../torrent/use-storage-usage'
import { storageRelief } from '../torrent/storage-relief'
import { usePersistentStorage } from '../torrent/use-persistent-storage'
import { StorageWarning } from '../components/storage-warning'
import { useCloudBackup } from '../torrent/use-cloud-backup'
import { isSaveCancelled, saveTorrentAsZipToDisk, saveTorrentFileToDisk } from '../torrent/save-file'
import { copyKey, holdsChosen } from '../torrent/sync'
import { describeAddRequest, namedMagnet } from './add-request'
import { AddTorrentDialog } from '../components/add-torrent-dialog'
import {
  ADD_DIALOG_KEY, defaultChoices, dialogEnabled, flagsFor, planFor,
} from '../torrent/add-options'
import type { AddChoices } from '../torrent/add-options'
import {
  currentLocation, intendedLocation, moveReadiness, pendingLabel, readGlobalDefault, SAVE_LOCATION_KEY,
} from '../torrent/save-location'
import type { InboundNow } from '../torrent/inbound'
import type { SaveLocation } from '../torrent/library'
import { RateLimitDialog } from '../components/rate-limit-dialog'
import { NO_LIMITS, formatLimit, isLimit, limitNote } from '../torrent/rate-limits'
import type { RateLimits } from '../torrent/rate-limits'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG,
  CHART_PRIMARY, CHART_PRIMARY_FILL, CHART_SECONDARY,
  CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  DANGER, ELEVATED_BG, EMPHASIS, FOCUS_RING, GROUP_BAND, GROUP_COUNT_BG, GROUP_TEXT, HOVER_WASH, OK,
  PAGE_BG, STATE_DOWN, STATE_UP, SUNKEN_BG, SURFACE_BG,
  TEXT, TEXT_FAINT, TEXT_MUTED, WARN,
} from '../theme'
import { pickVideoFile, watchHref } from '../torrent/watch'
import { forgetThumbnail } from '../torrent/thumbnail-store'
import { forgetSyncedThumbnails } from '../torrent/thumbnail-sync'
import { useThumbnail, useThumbnailGeneration } from '../torrent/use-thumbnails'
import { useFinishNotice } from './finish-notice'
import { movedNews, onFolderNews, useSavedToFolder } from './folder-work'
import { getHumanReadableByteString, getRoundedSpeed, writePercent } from '../utils/bytes'
import { isFramed } from '../utils/framed'
import { useConfirm } from '../components/confirm-dialog'
import { toastStyle } from '../components/toast'
import { AddFieldButtons, HeaderButtons, rowMenuGroups, usePlaced } from '../plugins/plugin-buttons'
import { registerSuggester } from '../plugins/host'
import { ShareLinkDialog } from '../components/share-link-dialog'
import { CreateTorrentDialog } from '../components/create-torrent-dialog'
import { useCreateTorrent, useCreatedSources } from '../torrent/use-create-torrent'
import { useTakeFromPlayer } from '../torrent/use-handover'
import { decodeMagnetParam } from './magnet-codec'
import { getRoutePath, getRouterRoutePath, Route } from './path'
import { NO_INBOUND, inboundLabel } from '../torrent/inbound'
import { formatDuration } from '../torrent/uptime'
import { hint } from '../components/hint'
import { SampleOffer } from '../components/sample-offer'
import { contentFiles, finished, leavesFilesOut, stopped } from '../torrent/types'
import { TorrentDetailDock } from './torrent-detail'
import { VpnSwitch } from '../components/vpn-switch'
import { vpnOffAvailable } from '../torrent/vpn-setting'
import { noPeersLine } from '../torrent/no-peers'
import { AccountWidget } from '../components/account-widget'
import { ContextMenu } from '../components/menu'
import type { MenuPosition } from '../components/menu'
import { TorrentOptionsDialog } from '../components/torrent-options-dialog'
import type { OptionGroup } from '../torrent/torrent-options'
import { dropTarget } from './drop-target'
import { FileGlyph } from './file-glyph'
import { badgeRules, stateHues } from './badge-style'
import { STATE_LABEL, chosenBytes, retryLine, speed, withWhole } from './torrent-format'
import { TorrentTable } from './torrent-table'
import { useOrderedEntries } from './use-ordered-entries'
import { canDropInto, computeDropPlace, decodeDrag, encodeDrag, ROW_DRAG_MIME, type DragPayload, type DropIndicator, type DropPlace } from './list-drag'
import { ListToolbar } from '../components/list-toolbar'
import { BulkBar, RowCheck, pickedRowStyle, rowClicks } from '../components/bulk-actions'
import { GroupPoster } from '../components/group-icon'
import { GroupLinkDialog, GroupNameDialog, type GroupSaveResult } from '../components/group-dialogs'
import { pickable, toPause, toResume, toStart, useBulkSelection } from './bulk-selection'
import { addLinkedGroup, receivable, useExpandedGroups, useGroupLink } from './use-group-view'
import { MAX_LINK_TORRENTS, readGroupLink } from './group-link'
import type { LinkedGroup } from './group-link'
import { createGroup, deleteGroup, putInGroup, renameGroup, takeOutOfGroup, torrentsIn } from '../torrent/groups'
import type { TorrentGroup } from '../torrent/groups'
import { DEFAULT_ICON, type GroupIcon, clearGroupAppearance, saveGroupImage, setGroupIcon, useGroupAppearance } from '../torrent/group-appearance'
import { reorderKeys, saveGroupMemberOrder, saveTopOrder, useListOrder } from '../torrent/list-order'
import { cardEntryGroups, groupMemberKeys, summarizeGroup, visibleEntryTorrents, visibleTopKeys, type GroupEntry, type GroupSummary, type LibraryEntry } from '../torrent/group-rows'
import {
  GROUP_LABEL, LIST_COLLAPSED_KEY, LIST_FILTER_KEY, LIST_SORT_KEY, LIST_VIEW_KEY, NO_COLLAPSED, TEMPORARY_HINT,
  filterCounts, readCollapsed, readFilter, readSort, readView, reclaimable, toggleCollapsed,
  writeCollapsed, writeSort,
} from '../torrent/list-view'
import type { CardGroup, CollapsedGroups, ListFilter, ListGroup, SortDir, SortKey, ViewMode } from '../torrent/list-view'
import type { ShareSubject } from '../torrent/torrent-file'
import { readMagnet, readTorrentFile } from '../torrent/torrent-file'
import { buildTorrentOptions, removalWords } from '../torrent/torrent-options'
import { knownPrivate, shareableMagnet } from '../torrent/torrent-export'
import { saveSyncedTorrentFile } from '../torrent/torrent-file-sync'
import { useShareableMagnet, useShareableMagnets } from '../torrent/use-shareable-magnet'
import type { TorrentOptionActions, TorrentOptionContext } from '../torrent/torrent-options'
import type { ShareableMagnets } from '../torrent/use-shareable-magnet'

// a brand and a build, the same in every language
const WORDMARK = 'Ripple'
const LOGO = new URL('../assets/logo.svg', import.meta.url).href

/** Up to this width the header is a phone's: one row, Create an icon. */
const PHONE_MAX = 700
/** From this width the header shows the Ripple wordmark beside the logo; narrower screens show the logo alone. */
const WORDMARK_MIN = 800
/** The add field's floor wherever it is open: a phone's row that leaves it less folds it to its glyph until it is used. */
const FIELD_FLOOR = 240
/** From this width Create a torrent shows its words; under it, its icon, with the words as its hint. */
const CREATE_WORDS_MIN = 960
const BUILD = `v${__APP_VERSION__} · ${__COMMIT_HASH__.slice(0, 7)}`
/**
 * A group's name inside a sentence, between a first strong isolate and its end (U+2068, U+2069), so a right-to-left
 * name keeps the sentence in order and a U+202E in a name someone sent turns only the name.
 */
const isolated = (name: string) => `\u2068${name}\u2069`

/**
 * Whether a drag carries something this page could actually add.
 *
 * Files are a .torrent, and `text/uri-list` is what a link dragged out of another page or another
 * browser carries, which is how a magnet arrives. A selection dragged around inside a text field
 * carries `text/plain` and `text/html` and NOT `text/uri-list`, so gating on these two keeps the
 * page from lighting up for a gesture aimed at nothing.
 *
 * A magnet dragged as bare text out of an editor is therefore not announced, but it still drops:
 * this only decides the highlight, never what `acceptDrop` will take.
 */
const droppable = (data: DataTransfer | null): boolean => {
  const types = data?.types
  if (!types) return false
  return [...types].some((t) => t === 'Files' || t === 'text/uri-list')
}

/** What the add dialog asks about: a magnet, whose files the engine fetches, or a .torrent the page read, with its bytes. */
type AddOutcome = 'added' | 'declined' | 'already'

type PendingAdd = {
  magnet: string
  infoHash: string
  name: string
  external: boolean
  from: string | null
  bytes?: Uint8Array
  files?: { name: string, size: number, index: number }[]
  settle?: (outcome: AddOutcome) => void
}

/** A magnet waiting for the add dialog, which reads its name and info hash when its turn comes. */
type QueuedMagnet = Pick<PendingAdd, 'magnet' | 'external' | 'from' | 'settle'>


const QuotaStat = ({ quota }: { quota: QuotaStatus }) => {
  const intl = useIntl()
  const label = <label>{intl.formatMessage({ id: 'FKN quota', defaultMessage: 'FKN quota' })}</label>
  if (quota.premium) {
    return (
      <div className="stat quota">
        {label}
        <strong className="ok">{intl.formatMessage({ id: 'Premium', defaultMessage: 'Premium' })}</strong>
      </div>
    )
  }
  if (quota.throttled) {
    return (
      <div className="stat quota throttled">
        {label}
        <strong>{intl.formatMessage({ id: 'Throttled · {speed}', defaultMessage: 'Throttled · {speed}' }, { speed: getRoundedSpeed(quota.bytesPerSecond) })}</strong>
        <a href="https://fkn.app/account" target="_blank" rel="noreferrer">{intl.formatMessage({ id: 'Get full speed', defaultMessage: 'Get full speed' })}</a>
      </div>
    )
  }
  return (
    <div className="stat quota">
      {label}
      <strong>{intl.formatMessage({ id: '{size} left', defaultMessage: '{size} left' }, { size: getHumanReadableByteString(quota.remainingBytes, true) })}</strong>
    </div>
  )
}

const StorageStat = ({ storage, low }: { storage: StorageUsage, low: boolean }) => {
  const intl = useIntl()
  return (
    <div className={'stat storage' + (low ? ' low' : '')}>
      <label>{intl.formatMessage({ id: 'Storage', defaultMessage: 'Storage' })}</label>
      <strong>
        {intl.formatMessage({ id: '{done} / {total}', defaultMessage: '{done} / {total}' }, { done: getHumanReadableByteString(storage.usedBytes, true), total: getHumanReadableByteString(storage.limitBytes, true) })}
      </strong>
    </div>
  )
}

const SYNC_DETAIL = defineMessages({
  'signed-out': { id: 'Connect an account to sync your library.', defaultMessage: 'Connect an account to sync your library.' },
  'no-storage-grant': { id: 'Storage did not answer. Retrying.', defaultMessage: 'Storage did not answer. Retrying.' },
  'broker-timeout': { id: 'FKN did not respond. Retrying.', defaultMessage: 'FKN did not respond. Retrying.' },
  'account-unknown': { id: 'Waiting for your account.', defaultMessage: 'Waiting for your account.' },
  locked: { id: 'Your storage is locked. Unlock it to sync.', defaultMessage: 'Your storage is locked. Unlock it to sync.' },
  'read-failed': { id: 'Could not read your saved library. Retrying.', defaultMessage: 'Could not read your saved library. Retrying.' },
  'read-timeout': { id: 'FKN did not respond. Retrying.', defaultMessage: 'FKN did not respond. Retrying.' },
  'switch-unverified': { id: 'Waiting for this account\'s library.', defaultMessage: 'Waiting for this account\'s library.' },
  'write-failed': { id: 'Could not save your library. Retrying on the next change.', defaultMessage: 'Could not save your library. Retrying on the next change.' },
})

const SyncStat = ({ state }: { state: SyncState }) => {
  const intl = useIntl()
  const { status, reason } = state
  // A signed-out user is not having a problem, so nothing is shown. Every other state is, including
  // the ones that used to be silent: a library that is quietly not being backed up looks exactly
  // like one that is, which is the worst way for this to fail.
  if (status === 'off') return null
  const label = status === 'syncing' ? intl.formatMessage({ id: 'Syncing…', defaultMessage: 'Syncing…' })
    : status === 'error' ? intl.formatMessage({ id: 'Sync failed', defaultMessage: 'Sync failed' })
    : intl.formatMessage({ id: 'Synced', defaultMessage: 'Synced' })
  return (
    <div className={'stat sync' + (status === 'error' ? ' error' : '')} {...hint(reason ? intl.formatMessage(SYNC_DETAIL[reason]) : undefined)}>
      <label>{intl.formatMessage({ id: 'Library', defaultMessage: 'Library' })}</label>
      <strong className={status === 'synced' ? 'ok' : undefined}>{label}</strong>
    </div>
  )
}

/**
 * Whether peers out there can open a connection TO us, which decides how many of them we ever meet.
 *
 * A port is reserved on the relay before the engine starts and libtorrent announces that exact
 * number, so `port` being set is what separates "peers can dial us" from "we can only dial out".
 * `inbound` counts the ones that have, split by transport because uTP and TCP fail independently:
 * uTP arrives through the DHT's implied port while TCP depends on the announced number being real.
 */
/** Exported for its own test: a stat that throws takes the whole route with it. */
export const ConnectionStat = ({ reachable, inboundNow = NO_INBOUND }: {
  reachable: Reachability | null
  /** Peers dialled in RIGHT NOW. Defaults to none so an older engine renders the port and no count. */
  inboundNow?: InboundNow
}) => {
  const intl = useIntl()
  if (!reachable) return null
  const { port, inbound, listenFailed } = reachable
  /**
   * An engine older than 0.3.13 sends neither of these, and this component has to survive that.
   *
   * A deploy is never atomic. The page can be the new build while the engine chunk behind it is
   * still the one the service worker cached, and `engine-share` lets a tab receive state from
   * whichever OTHER tab owns the engine, which during a rollout is routinely the old one. This
   * shipped without the guard and took the whole route down with
   * `Cannot read properties of undefined (reading 'some')`, because a crash in a stat strip is a
   * crash in the page that contains it.
   *
   * `portOpen` defaults to TRUE on an old engine, not false: it cannot tell us, and claiming the
   * port is closed would be inventing a fault out of a missing field.
   */
  const listeners = reachable.listeners ?? []
  const portOpen = reachable.portOpen ?? true
  const failed = listenFailed.length > 0
  const detail = inboundLabel(inboundNow)
  // The announced port is fixed for the session and the sockets holding it are not, so a reserved
  // port is not by itself evidence anyone can still reach it. `portOpen` is the live half: after a
  // dropped tunnel the acceptor heals itself, and until it does this readout would otherwise keep
  // naming a dead number with exactly the confidence it had when the number worked.
  const healing = !!port && !portOpen && listeners.some((l) => l.healing)
  // its colon ahead of its digits in a right to left line too, as a message's `:{port}` gets from src/i18n
  const colonPort = `:${port}`
  const portText = <span dir="ltr">{colonPort}</span>
  /**
   * `:41337 · 2 tcp · 1 utp`: the port written the way it is everywhere else, then who is dialled in
   * THROUGH it right now, split by transport.
   *
   * The count used to be `reachable.inbound`, which is a running total of every connection accepted
   * since the session started. That is the right number for "does inbound work at all" and the wrong
   * one for a strip cell read beside a torrent's peer count, and it was reported as a bug twice: once
   * as `69 tcp · 19 utp` against a torrent connected to one peer, and again as `3 tcp` after a unit
   * was appended to it. Two attempts to fix the WORDING both failed, because the number itself was
   * answering a different question from the one being asked of it.
   *
   * So it is a live count now, from `inbound.ts`, counted off the peer lists because the engine has
   * no session-level live figure. The running total moves to the tooltip, where it is still worth
   * having: a port that has accepted connections is proven reachable even when nobody is on it this
   * second, and that is what the highlight below is keyed to rather than the live count.
   *
   * The split stays either way: which of uTP and TCP is carrying is what somebody checking their
   * connection came here to see.
   */
  const label =
    failed ? intl.formatMessage({ id: 'Failed', defaultMessage: 'Failed' })
    : !port ? intl.formatMessage({ id: 'Unreachable', defaultMessage: 'Unreachable' })
    : healing ? intl.formatMessage({ id: ':{port} · reconnecting', defaultMessage: ':{port} · reconnecting' }, { port })
    : !portOpen ? intl.formatMessage({ id: ':{port} · closed', defaultMessage: ':{port} · closed' }, { port })
    : !detail ? portText
    : <>{portText}{` · ${detail}`}</>
  /*
   * The tooltip carries what the label cannot: the session total. "Nobody is connected in right now"
   * is not the same as "nothing has ever reached this port", and only the second is a reason to go
   * looking at a router.
   */
  const withTotal = (sentence: string) => inbound > 0
    ? intl.formatMessage({ id: '{sentence} {count} accepted this session.', defaultMessage: '{sentence} {count} accepted this session.' }, { sentence, count: inbound })
    : sentence
  const title =
    failed ? listenFailed.join('\n')
    : healing ? intl.formatMessage({ id: 'Connection dropped. Reconnecting.', defaultMessage: 'Connection dropped. Reconnecting.' })
    : port && !portOpen ? intl.formatMessage({ id: 'Port {port} is closed. Reload to get a new one.', defaultMessage: 'Port {port} is closed. Reload to get a new one.' }, { port })
    : !port ? undefined
    : withTotal(inboundNow.total > 0
      ? intl.formatMessage({ id: '{count, plural, one {{count} peer connected in on port {port}: {detail}.} other {{count} peers connected in on port {port}: {detail}.}}', defaultMessage: '{count, plural, one {{count} peer connected in on port {port}: {detail}.} other {{count} peers connected in on port {port}: {detail}.}}' }, { count: inboundNow.total, port, detail })
      : intl.formatMessage({ id: 'Nobody connected in on port {port}.', defaultMessage: 'Nobody connected in on port {port}.' }, { port }))
  return (
    <div className={'stat inbound' + (failed || (!!port && !portOpen) ? ' error' : '')} {...hint(title)}>
      <label>{intl.formatMessage({ id: 'Inbound', defaultMessage: 'Inbound' })}</label>
      {/* the port stays visible once peers arrive: it is what a user checks against a router or a
          firewall, and hiding it exactly when the feature starts working is the wrong trade */}
      <strong className={inbound > 0 && portOpen ? 'ok' : undefined}>{label}</strong>
    </div>
  )
}

/** Exported for its own test. */
export const DhtStat = ({ nodes }: { nodes: number }) => {
  const intl = useIntl()
  return (
    <div className="stat dht">
      <label>{intl.formatMessage({ id: 'DHT nodes', defaultMessage: 'DHT nodes' })}</label>
      <strong>{nodes}</strong>
    </div>
  )
}

/** A total speed in the strip, in its direction's hue only while bytes move. Exported for its own test. */
export const SpeedStat = ({ dir, big, bps, room, label }: { dir: 'down' | 'up', big?: boolean, bps: number, room: string, label: string }) => (
  <div className={'stat' + (big ? ' big' : '') + ` rate ${dir}` + (bps > 0 ? ' live' : '')}>
    <label>{label}</label>
    <strong data-room={room}>{speed(bps)}</strong>
  </div>
)

const HISTORY = 120

/**
 * Samples kept per row, against the page graph's 120.
 *
 * Half the history because it is drawn in a tenth of the width: at 120 samples across 80 pixels each
 * one is well under a pixel, so the line stops being a shape and becomes a texture.
 */
const ROW_HISTORY = 60

/**
 * Exported so a row can be measured on its own.
 *
 * Every rule below is scoped to this one element, so a TorrentRow rendered anywhere else has no
 * styles at all: it still renders, and every box it reports is at the origin with no size. A test
 * that measures such a row is measuring nothing, so it has to mount this around it.
 */

export const style = css`
  /* dvh minus whatever the broker reserved at the top, so docking its header does not push the
     footer under the fold. See the root rule in index.tsx for what writes the variable. */
  height: calc(100dvh - var(--fkn-inset-top, 0px));
  display: flex;
  flex-direction: column;
  background: ${PAGE_BG};
  color: ${TEXT};
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  ${stateHues}

  a {
    text-decoration: none;
  }

  /*
   * A live figure keeps the room of the widest text it can show, so its changing never shoves what
   * sits beside it. data-room carries those texts one per line, laid under the figure with no height,
   * so the box is as wide as the widest of them in whatever font draws the page.
   *
   * Measured in the page rather than written as a width, because a width fits one font and one
   * language: 5.4em held 999.9 MB/s in Noto Sans Bold (5.35em), not in DejaVu Sans Bold (6.23em),
   * which is system-ui on a Linux machine without Noto, GitHub's runner among them, and not in
   * Japanese, whose 999.9 MB/秒 is 5.85em in Noto Sans itself.
   */
  [data-room] {
    display: inline-grid;

    &::after {
      content: attr(data-room);
      height: 0;
      overflow: hidden;
      visibility: hidden;
      white-space: pre;
      /* overflow makes this a scroll container, whose automatic minimum width in a grid is 0, so a
         phone's narrow row would shrink the box below its room and wrap the figure onto a second line */
      min-width: max-content;
    }
  }

  button {
    font-family: inherit;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;

    &:active {
      transform: scale(0.98);
    }
  }

  header {
    flex: none;
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    /* opaque rather than frosted: the bar has to hide the list scrolling under it, and a flat fill
       does that at any contrast setting where a blur only softened it */
    background: ${SURFACE_BG};
    border-bottom: 1px solid ${BORDER};

    .brand {
      flex: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* FKN's mark is 1cap of its own font size */
    .powered {
      font-size: 1.35rem;
      line-height: 1;
    }

    .logo {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      text-decoration: none;
      transition: opacity 120ms ease;

      .wordmark {
        display: none;
        font-size: 1.2rem;
        font-weight: 900;
        letter-spacing: 0.06em;
        color: ${TEXT};
        white-space: nowrap;
      }

      /* The file's own slate blues measure 1.8:1 on this bar, so they are drawn inverted with the hue kept, which is
         the light blue they become in a dark reader. */
      img {
        height: 30px;
        width: auto;
        flex: none;
        filter: invert(1) hue-rotate(180deg);
      }

      &:hover { opacity: 0.75; }

      &:focus-visible {
        outline: none;
        border-radius: 4px;
        box-shadow: 0 0 0 2px ${FOCUS_RING};
      }
    }

    @media (width >= ${WORDMARK_MIN}px) {
      .brand {
        align-items: baseline;
        gap: 8px;
      }

      .powered {
        font-size: 1.2rem;
      }

      .logo {
        align-items: baseline;

        img {
          height: 26px;
          align-self: center;
        }

        .wordmark {
          display: inline;
        }
      }
    }

    /**
     * One field, the way a search bar is one field.
     *
     * It used to be three controls in a row: the input, an Add button and an Open file button. They
     * could not shrink, so they took every pixel out of the only flexible item, and the field
     * measured 52px at a 900px viewport and 34px at 800px, where the form overflowed and the
     * document grew a horizontal scrollbar. Widening the field was treating the symptom; the actual
     * problem was three things competing for one row to say one thing.
     *
     * So the actions moved INSIDE the field as icons, which is the shape everybody already knows
     * from a browser's address bar, and the two buttons that used to carry words carry a tooltip
     * instead. Create, the gear and the account beside it squeeze it down to the floor below.
     */
    /* the field's floor wherever it is open: its icons and the start of its hint, which ends in an ellipsis below this */
    form {
      flex: 1;
      display: flex;
      min-width: ${FIELD_FLOOR}px;
    }

    .field {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding-block: 3px;
      padding-inline: 18px 5px;
      border-radius: 999px;
      /* a hole punched in the header, and an outline bright enough to be the only thing saying a
         control is here, which is all a bare pill has left once there is no accent to lean on */
      background: ${SUNKEN_BG};
      border: 1px solid ${BORDER_INTERACTIVE};
      transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;

      /* the ring belongs to the pill, not to the bare input inside it */
      &:focus-within {
        border-color: ${FOCUS_RING};
        box-shadow: 0 0 0 3px ${FOCUS_RING};
      }

      /* the same bright edge the page-wide overlay uses, so a drag reads as landing in one place */
      &[data-drop] {
        border-color: ${EMPHASIS};
        border-style: dashed;
        background: ${HOVER_WASH};
        box-shadow: 0 0 0 3px ${EMPHASIS};
      }

      .glyph {
        display: none;
      }

      /* the text itself: no chrome of its own, since the pill around it is the control */
      input:not([type='file']) {
        flex: 1;
        min-width: 0;
        background: none;
        border: none;
        outline: none;
        padding: 9px 0;
        color: ${TEXT};
        font-family: inherit;
        font-size: 0.9rem;
        text-overflow: ellipsis;

        &::placeholder { color: ${TEXT_MUTED}; }
      }

      /* A hairline between the text and the actions, the way an address bar separates them. The
         stronger of the two line tokens, because this one sits on the sunken fill rather than on a
         surface, and BORDER against that is 1.3:1, which is nothing. */
      .sep {
        flex: none;
        width: 1px;
        height: 20px;
        margin: 0 5px;
        background: ${BORDER_STRONG};
      }
    }

    /**
     * The actions, as round icon buttons.
     *
     * Each one keeps a title AND an aria-label: dropping the words is a real cost to anyone who has
     * not seen this shape before, and a tooltip is the cheapest way to pay it back. The file one is
     * a label wrapping an input rather than a button, so it needs the cursor and the focus ring a
     * button would have given it.
     */
    .icon {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: none;
      color: ${TEXT_MUTED};
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;

      svg { width: 17px; height: 17px; }

      &:hover:not(:disabled):not([aria-disabled='true']) {
        background: ${HOVER_WASH};
        color: ${TEXT};
      }

      /* outline: none above means this ring IS the focus indicator, so it is drawn at full strength
         rather than at the alpha the old accent ring used */
      &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px ${FOCUS_RING};
      }

      /**
       * A control that cannot act has to LOOK like one.
       *
       * Add is disabled whenever the field holds nothing to add. It used to keep its full contrast
       * and its hover while disabled, so pressing it was indistinguishable from pressing a live
       * button that silently did nothing. That is the whole of "Add does nothing".
       */
      &:disabled,
      &[aria-disabled='true'] {
        opacity: 0.35;
        cursor: default;
      }

      /* the submit, at full brightness against its muted neighbour so the one action that commits is
         the one that reads as an action */
      &.go:not(:disabled) { color: ${TEXT}; }

      /* the file picker's own input, sized to nothing rather than display:none, which would take it
         out of the tab order and leave the only .torrent picker unreachable without a mouse */
      &.file-button {
        position: relative;
        overflow: hidden;

        input[type='file'] {
          position: absolute;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }
      }
    }

    /* header-level actions, outside the add form, as square icon buttons as tall as the account's button */
    .tool {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      padding: 0;
      border-radius: 6px;
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT};

      svg { width: 17px; height: 17px; }

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: ${BORDER_STRONG};
      }

      &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px ${FOCUS_RING};
      }
    }

    .tool.create span {
      display: none;
    }

    /* plugins' buttons that do not fit beside the rest take a row of their own below it, out of its flow, so nothing of
       that row moves: the bar grows by one of their rows and a gap */
    &[data-plugins-wrapped] {
      padding-bottom: calc(12px + 38px + 12px);

      > .plugins {
        position: absolute;
        bottom: 12px;
        inset-inline-end: 18px;
      }
    }

    @media (width >= ${CREATE_WORDS_MIN}px) {
      .tool.create {
        width: auto;
        gap: 7px;
        padding: 0 14px;
        font: inherit;
        font-size: 0.85rem;
        font-weight: 700;

        span { display: inline; }
      }
    }
  }

  /**
   * A plane on the page: the stats panel, the storage warnings, every torrent row.
   *
   * Flat and opaque. This used to be a translucent fill, a frosting blur and a three-layer shadow
   * stack (a light ring, a drop shadow and an inset highlight) doing the work of saying "this is a
   * card". The border does that on its own, it costs one hairline instead of four paint layers, and
   * nothing scrolling underneath ghosts through it any more.
   */
  .surface {
    background: ${SURFACE_BG};
    border: 1px solid ${BORDER};
  }

  .storage-warning {
    flex: none;
    margin: 14px 16px 0;
    padding: 14px 18px;
    border-radius: 8px;
    /* the frame and the heading are the whole "this is a caution" signal, and they are the one place
       on the page a hue is still spent */
    border: 1px solid ${WARN};
    display: flex;
    flex-direction: column;
    gap: 4px;

    strong { color: ${WARN}; font-size: 0.95rem; }
    span { color: ${TEXT_MUTED}; font-size: 0.85rem; line-height: 1.6; }

    button {
      align-self: flex-start;
      margin-top: 6px;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT};

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: ${BORDER_STRONG};
      }
    }

    /* Recoverable on its own, so it reads as a notice rather than an alarm: the caution hue comes
       off both the frame and the heading and it goes back to being a neutral card. */
    &.offline {
      border-color: ${BORDER_STRONG};

      strong { color: ${TEXT}; }
    }
  }

  .stats {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 24px;
    margin: 14px 16px 0;
    padding: 14px 18px;
    border-radius: 8px;

    /* The speeds and the rest are two lines, side by side where they fit and one above the other where they do not, so
       the strip is never more than two rows. A line too long for its row scrolls sideways, faded at an end with more past
       it. The fades are drawn over the line rather than masking it: a mask also cut away the quota offer the VPN switch
       raises under it. */
    .readouts {
      flex: 0 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 14px 26px;
    }

    .fades {
      position: relative;
      min-width: 0;
      margin: -4px -8px;

      &::before, &::after {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        width: 28px;
        pointer-events: none;
        visibility: hidden;
      }

      &::before { inset-inline-start: 0; background: linear-gradient(to var(--inline-end, right), ${SURFACE_BG}, transparent); }
      &::after { inset-inline-end: 0; background: linear-gradient(to var(--inline-start, left), ${SURFACE_BG}, transparent); }
      &[data-more-start]::before, &[data-more-end]::after { visibility: visible; }
    }

    /* padded so the VPN switch's target, which overhangs its box, and a focus ring are not cut by the scroll */
    .line {
      display: flex;
      align-items: center;
      gap: 26px;
      padding: 4px 8px;
      overflow-x: auto;
      scrollbar-width: none;

      &::-webkit-scrollbar { display: none; }

      > * { flex: none; }
    }

    /* The VPN's word at its own width, not the room of its widest: it starts a line, so the room was a gap before the
       next readout, 73 px in English on a phone. Only the readouts after it move, when its state changes. */
    .vpn strong::after {
      content: none;
    }

    .stat {
      display: flex;
      flex-direction: column;
      gap: 2px;

      label {
        font-size: 0.65rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: ${TEXT_MUTED};
      }

      strong {
        font-size: 1.05rem;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      /* the number is identical in both states, so without a colour the low state would be the same
         pixels as the healthy one; this is a caution and it keeps the caution hue */
      &.storage.low strong {
        color: ${WARN};
      }

      &.big strong {
        font-size: 1.7rem;
        line-height: 1.1;
        color: ${TEXT};
      }

      /* a speed takes its direction's hue only while bytes move, so an idle library stays quiet */
      &.down.live strong { color: ${STATE_DOWN}; }
      &.up.live strong { color: ${STATE_UP}; }

      &.quota strong.ok {
        color: ${OK};
      }

      &.quota.throttled strong {
        color: ${WARN};
      }

      /* Underlined always, not only on hover. It repeats the label's size, weight and casing, so with
         the accent gone the underline is the only thing left saying it is a link. That frees colour
         to do the hover instead: it rests a tier down and climbs to the top one under the cursor,
         which is the whole feedback this link gets. */
      &.quota a {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: ${TEXT_MUTED};
        text-decoration: underline;
      }

      &.quota a:hover {
        color: ${TEXT};
      }

      &.sync strong.ok {
        color: ${OK};
      }

      &.sync.error strong {
        color: ${WARN};
      }
    }

    /*
     * A CLASS, not a bare element selector, and the class exists for this rule alone.
     *
     * This panel holds several readouts that carry their own glyphs, so a bare element selector here reached
     * all of them and laid a 13px icon out in the graph's 120px box. That is not a hypothetical
     * either: it was reported as the VPN readout's info icon "becoming massive", and it only showed
     * up when arriving from the download page.
     *
     * WHY THE ROUTE MATTERED, because that is the part worth remembering. Emotion inserts a
     * component's rules the first time it renders, so the stylesheet order follows the order pages
     * were visited. This rule and the VPN readout's own override have EQUAL specificity, so whichever was
     * inserted last wins. On a direct load home renders first and the override wins; the download
     * page mounts the same VPN readout with none of these rules present, so arriving from there
     * inserts them the other way round and this rule wins instead.
     *
     * Overriding harder would have worked and would have left the trap set for the next glyph added
     * to this panel. Naming what the rule is actually for removes it.
     */
    svg.graph {
      flex: 1;
      min-width: 120px;
      height: 52px;
      align-self: center;

      polyline {
        fill: none;
        stroke: ${CHART_PRIMARY};
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }
    }
  }

  main {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    /* the top room is a margin because a scroller's padding scrolls away with its content: a
       scrolled card then leaves view 14px below whatever sits above, not flush against it */
    margin-top: 14px;
    padding: 0 16px 14px;
    /* a card's name and numbers, or the column names and two rows, when the details take the rest
       of a short window; with less the list is a sliver of half drawn column names */
    min-height: 8rem;

    &:has(> .torrent-table) {
      scroll-padding-top: 38px;
    }
  }

  /* a group's heading and count, a sibling of the cards under it */
  .group-head {
    flex: none;
    margin: 4px 0 0;
    padding: 0;
    border-radius: 6px;
    background: ${GROUP_BAND};
    color: ${GROUP_TEXT};
    font-size: 1.05rem;
    font-weight: 600;
    letter-spacing: 0.01em;

    button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px;
      border: none;
      border-radius: inherit;
      background: none;
      color: inherit;
      font: inherit;
      letter-spacing: inherit;
      text-align: start;
      cursor: pointer;
      transition: background 120ms ease;

      &:hover { background: ${HOVER_WASH}; }

      &:focus-visible { outline: none; box-shadow: inset 0 0 0 2px ${FOCUS_RING}; }

      &[aria-expanded='false'] .chev { transform: rotate(-90deg); }

      &[aria-expanded='false']:dir(rtl) .chev { transform: rotate(90deg); }
    }

    .chev {
      flex: none;
      color: ${TEXT_MUTED};
      transition: transform 120ms ease;
    }

    .count {
      flex: none;
      padding: 1px 9px;
      border-radius: 999px;
      background: ${GROUP_COUNT_BG};
      font-size: 0.75rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
  }

  .torrent[data-dragging='true'], .group-row[data-dragging='true'] { opacity: 0.55; }
  .torrent[data-drop='before'], .group-row[data-drop='before'] { box-shadow: 0 -2px 0 0 ${FOCUS_RING}; }
  .torrent[data-drop='after'], .group-row[data-drop='after'] { box-shadow: 0 2px 0 0 ${FOCUS_RING}; }
  .torrent[data-drop='into'], .group-row[data-drop='into'] { border-color: ${FOCUS_RING}; box-shadow: 0 0 0 2px ${FOCUS_RING}; }

  .torrent.group-row {
    cursor: pointer;

    &[data-drop='into'] { border-color: ${FOCUS_RING}; box-shadow: 0 0 0 2px ${FOCUS_RING}; }

    .poster.group-poster {
      background: none;
      border: none;
      border-radius: 0;
    }

    /* Stacked under-card lip signals a closed container holding rows even when count is 1. */
    &:not([data-expanded='true']):not([data-drop='after']):not([data-drop='into'])::after {
      content: '';
      position: absolute;
      inset-inline: 10px;
      bottom: -5px;
      height: 4px;
      border-end-start-radius: 6px;
      border-end-end-radius: 6px;
      background: ${SURFACE_BG};
      border: 1px solid ${BORDER_STRONG};
      border-top: none;
      pointer-events: none;
    }

    .title {
      align-items: center;
      gap: 8px;
    }

    .expand-btn {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 1px solid ${BORDER};
      border-radius: 5px;
      background: ${CONTROL_BG};
      color: ${TEXT_MUTED};
      cursor: pointer;
      align-self: center;

      &:hover { color: ${TEXT}; background: ${CONTROL_HOVER_BG}; border-color: ${BORDER_STRONG}; }
      &:focus-visible { outline: 2px solid ${FOCUS_RING}; outline-offset: 1px; }

      svg { flex: none; transition: transform 120ms ease; }
    }

    &:not([data-expanded='true']):dir(rtl) .expand-btn svg {
      transform: rotate(180deg);
    }

    &[data-expanded='true'] .expand-btn svg {
      transform: rotate(90deg);
    }

    .group-count {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      background: ${GROUP_COUNT_BG};
      color: ${GROUP_TEXT};
      font-size: 0.75rem;
      font-weight: 700;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;

      svg { flex: none; }
    }
  }

  .group-children {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-inline-start: 20px;
    padding-inline-start: 12px;
    border-inline-start: 2px solid ${BORDER_STRONG};
  }

  .group-empty {
    padding: 10px 12px;
    border-radius: 8px;
    border: 1px dashed ${BORDER};
    color: ${TEXT_MUTED};
    font-size: 0.82rem;
  }

  .torrent, .sample {
    /* the row whose details are in the dock, marked clearly enough to find at a glance in a long
       library without shouting over the rest of it */
    &.selected {
      border-color: ${BORDER_INTERACTIVE};
      background: ${CONTROL_BG};
    }

    &.picked { ${pickedRowStyle} }

    cursor: default;

    flex: none;
    position: relative;
    border-radius: 8px;
    padding: 10px 12px;
    /* a ROW at the top level, so the picture is a column of its own spanning the whole card rather
       than a thing beside one line of it */
    display: flex;
    align-items: stretch;
    gap: 12px;
    transition: border-color 120ms ease, background 120ms ease;

    /* the state's edge, drawn over the border so it costs the row no width */
    &::before {
      content: '';
      position: absolute;
      inset-inline-start: -1px;
      top: 12px;
      bottom: 12px;
      width: 4px;
      border-start-end-radius: 4px;
      border-end-end-radius: 4px;
      background: var(--edge, transparent);
    }

    /* a ticked row's own edge says so, full height, and the state's would cover it */
    &.picked::before { content: none; }

    /* Hover brightens the edge, and that is the whole of it. It used to lift a pixel as well, which
       made sense while the row also grew a drop shadow underneath: the two together read as the card
       rising off the page. Flat, the shadow is gone and the lift has nothing left to explain it, so
       a row that jumps a pixel under the cursor reads as the layout twitching rather than as
       feedback. Selection above holds a brighter edge AND a lighter fill: two different properties
       for two different states, rather than two alphas of one colour, which is what told them apart
       before and would not survive without a hue to vary. */
    &:hover {
      border-color: ${BORDER_STRONG};
    }

    /* Everything that is not the picture. A column, because the file list sits under the main line
       and both of them have to clear the picture on the left. */
    .content {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 8px;
    }

    /* what the torrent is on the left, what can be done to it on the right, on ONE line */
    .main {
      display: flex;
      align-items: center;
      gap: 12px;
      /* a floor, so a row whose bar is hidden is not visibly shorter than the one above it */
      min-height: 62px;
    }

    /**
     * Stretched rather than a fixed height, so the picture is as tall as the card it belongs to.
     *
     * Capped, because the card grows by the whole file list when that is opened, and a season pack
     * would otherwise turn a 16:9 frame into a 150 by 500 pixel column of one cropped stripe. The cap
     * is above any collapsed row, so it only ever takes effect for an opened list.
     */
    .poster {
      flex: none;
      align-self: stretch;
      box-sizing: border-box;
      width: 150px;
      min-height: 84px;
      max-height: 148px;
      border-radius: 8px;
      object-fit: cover;
      background: ${SUNKEN_BG};
      border: 1px solid ${BORDER};
    }

    /* the bulk selection's box, over the picture's corner, so it takes no width from the name */
    > .row-check {
      position: absolute;
      top: 7px;
      inset-inline-start: 9px;
      z-index: 1;
    }

    /* Held even when there is no picture, so every row's text starts at the same place. An absent
       left column would make a list of mixed torrents look ragged rather than compact. */
    .poster.placeholder {
      display: grid;
      place-items: center;
      align-content: center;
      gap: 4px;
      /* lighter than the plain poster fill, so an empty frame reads as a deliberate placeholder
         rather than as a picture that has not arrived yet */
      border-color: ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT_MUTED};

      svg { width: 20px; height: 20px; }
      .ext { font-size: 11px; font-weight: 600; line-height: 1; letter-spacing: 0.04em; }
    }

    .body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 6px;
    }

    .title {
      display: flex;
      align-items: baseline;
      gap: 10px;

      strong {
        flex: 1;
        font-size: 0.95rem;
        font-weight: 600;
        overflow-wrap: anywhere;
      }

      .pct {
        flex: none;
        font-size: 0.85rem;
        font-variant-numeric: tabular-nums;
        color: ${TEXT_MUTED};
      }
    }

    .side .pct {
      color: var(--hue, ${TEXT});
      font-weight: 600;
    }

    /* the state chip, shared with the table view so there is one source for it */
    ${badgeRules}

    /* why a torrent stalled and when it tries again, brighter than the meta numbers it sits among so
       it does not read as one more of them */
    .retry {
      color: ${TEXT};
      overflow-wrap: anywhere;
    }

    /* thin, and inside the body rather than owning a row of its own */
    .bar {
      height: 4px;
      border-radius: 2px;
      background: var(--tint, ${SUNKEN_BG});
      overflow: hidden;

      /* No width transition: the width moves on every engine tick, so one never ends and lays the
         page out 48 times a second while anything downloads (23 against 9 ms/s of main thread). */
      .fill {
        height: 100%;
        border-radius: 2px;
        background: var(--hue, ${EMPHASIS});
      }
    }

    .row {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px 16px;
    }

    .meta {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 3px 14px;
      color: ${TEXT_MUTED};
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;

      /* a figure takes its direction's hue only while bytes move, so an idle library stays quiet */
      .rate.down.live { color: ${STATE_DOWN}; }
      .rate.up.live { color: ${STATE_UP}; }

      /* The temporary marker, in the same box the limit chip uses: both are properties of the
         torrent rather than live numbers, so they read as one kind of thing. No hue: hue means a
         torrent's state, and this is not one. */
      .temp {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 0 6px;
        border-radius: 4px;
        border: 1px solid ${BORDER};
        background: ${CONTROL_BG};
        color: ${TEXT_MUTED};
        font: inherit;
        font-size: inherit;
        cursor: pointer;

        svg { width: 11px; height: 11px; }

        &:hover { color: ${TEXT}; border-color: ${BORDER_STRONG}; }
      }

      /* A ceiling is a setting rather than a measurement, so it is marked off from the live numbers
         beside it instead of reading as another one of them. The chrome does that now, not the
         colour: same text as its neighbours, sitting in a box they do not have. */
      .limit {
        padding: 0 6px;
        border-radius: 4px;
        color: ${TEXT_MUTED};
        background: ${CONTROL_BG};
        border: 1px solid ${BORDER};
      }
    }

    /**
     * The per-row transfer graph.
     *
     * Fixed width and flex: none, so it cannot compete with the title for space: the name is what
     * people scan for, and a graph that grew would push it around as rows come and go.
     */
    .spark {
      flex: none;
      width: 84px;
      height: 26px;
      align-self: center;

      .down-fill { fill: ${CHART_PRIMARY_FILL}; }

      .down-line {
        fill: none;
        stroke: ${CHART_PRIMARY};
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }

      /* Thinner and dimmer than the download line, so the two are told apart at 26px without a key.
         Hue used to be the first of those cues and is gone; what is left is three redundant ones,
         brightness, stroke width, and the fact that only download carries a filled area. */
      .up-line {
        fill: none;
        stroke: ${CHART_SECONDARY};
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
    }

    /* One right-hand group on one line.
       The state, the percentage and the buttons used to sit at three different heights: the first two
       at the end of the title, the third centred against the whole body, which reads as three things
       that were each aligned to something different. They are one thing, so they are one row. */
    .side {
      flex: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .actions {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;

      /* Every control here is an icon now, so they are all the same square. The label lives in the
         title and aria-label attributes, never only in the shape. Note for anyone editing this
         block: it sits inside a css template literal, so a backtick in a comment ends the string
         and the whole file stops parsing. */
      a, button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
      }

      svg {
        display: block;
      }

      /* the one exception: a save in progress shows its percentage, which needs the room */
      .saving {
        font-size: 0.68rem;
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }

      a, button {
        border-radius: 4px;
        font-size: 0.8rem;
        font-weight: 700;
      }

      /* Watch is one of the four, not a highlight sitting among them. It was solid white, which made
         every row carry a bright dot pulling the eye away from the torrent's own name and progress,
         for an action already reachable by clicking the row. Same shape, same fill, same border. */
      .primary,
      button {
        border: 1px solid ${BORDER};
        background: ${CONTROL_BG};
        color: ${TEXT};

        &:hover {
          background: ${CONTROL_HOVER_BG};
          border-color: ${BORDER_STRONG};
        }

        &:disabled {
          opacity: 0.6;
          cursor: default;
        }
      }
    }

    .detail {
      summary {
        cursor: pointer;
        color: ${TEXT_MUTED};
        font-size: 0.8rem;
        user-select: none;
        transition: color 120ms ease;

        &:hover {
          color: ${TEXT};
        }
      }

      .tabs {
        display: flex;
        gap: 4px;
        margin: 10px 0 8px;
        padding: 3px;
        border-radius: 6px;
        background: ${SUNKEN_BG};
        width: fit-content;
        max-width: 100%;
        flex-wrap: wrap;

        button {
          border: none;
          border-radius: 4px;
          background: none;
          color: ${TEXT_MUTED};
          padding: 4px 12px;
          font-size: 0.75rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;

          &:hover {
            color: ${TEXT};
          }

          /* The selected tab, which has to stand out from the three beside it and no further. It was
             solid white, and once Watch and Add stopped being white it was the only such thing left
             on the page, which read as something that had been missed. A raised surface separates it
             from the sunken track behind it without shouting, and it cannot be confused with a hover
             because hover here declares no fill at all: it only brightens the label, so the selected
             tab owns the only filled box in the strip. */
          &[data-on] {
            background: ${CONTROL_ACTIVE_BG};
            color: ${TEXT};
          }

          /*
           * Dimmed rather than given a colour of its own, so it tracks whatever state the tab is
           * in instead of pinning one value and being wrong in two of the three.
           *
           * 0.7 stopped being survivable when the strip went to SUNKEN_BG and the label to
           * TEXT_MUTED: 0.7 of that over #0f0f0f composites to #6e6e6e, 3.76:1 on a 0.75rem badge,
           * under the 4.5 this palette holds normal text to. 0.85 gives #828282 and 4.99:1. Hovered
           * (12.4:1) and selected (8.1:1) were never the problem and keep their margin.
           *
           * The same badge, with the same value, exists in torrent-detail.tsx. Both were moved.
           */
          .count {
            font-variant-numeric: tabular-nums;
            font-weight: 600;
            opacity: 0.85;
          }
        }
      }

      /* every tab body is capped and scrolls inside itself: a swarm of eighty peers must not push
         the next torrent in the library off the bottom of the page */
      .pane {
        max-height: 260px;
        overflow-y: auto;
        padding-inline-end: 8px;
      }

      .none {
        margin: 6px 0 2px;
        color: ${TEXT_MUTED};
        font-size: 0.8rem;
      }

      .facts {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 2px 24px;
      }

      .fact {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 5px 0;
        border-bottom: 1px solid ${BORDER};
        font-size: 0.8rem;

        label {
          flex: none;
          color: ${TEXT_MUTED};
        }

        span {
          min-width: 0;
          overflow-wrap: anywhere;
          text-align: end;
          color: ${TEXT};
          font-variant-numeric: tabular-nums;
        }
      }

      .mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.95em;
      }

      .rows {
        display: flex;
        flex-direction: column;
      }

      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 0;
        border-top: 1px solid ${BORDER};
        font-size: 0.8rem;

        &:first-of-type {
          border-top: none;
        }

        /* Sticky so a long swarm keeps its column names while it scrolls, and opaque because rows
           pass underneath it. It takes the card's own fill, so on an unselected row it is invisible
           except for the words, which is what a column header should be. */
        &.head {
          position: sticky;
          top: 0;
          z-index: 1;
          background: ${SURFACE_BG};
          border-top: none;
          padding-top: 2px;
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: ${TEXT_MUTED};
        }

        .name {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          overflow-wrap: anywhere;
          /* the name is what the row is about, so it takes the top tier and everything else in the
             row sits a step below it */
          color: ${TEXT};

          .dim {
            color: ${TEXT_FAINT};
          }
        }

        .client {
          flex: none;
          width: 130px;
          color: ${TEXT_MUTED};
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;

          &.ok {
            color: ${OK};
          }

          &.warn {
            color: ${DANGER};
          }
        }

        .num {
          flex: none;
          width: 74px;
          text-align: end;
          color: ${TEXT_MUTED};
          font-variant-numeric: tabular-nums;
        }

        .tags {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }

        .tag {
          border-radius: 2px;
          padding: 1px 7px;
          font-size: 0.62rem;
          font-weight: 700;
          color: ${TEXT_MUTED};
          background: ${CONTROL_BG};
        }

        button {
          flex: none;
          border: 1px solid ${BORDER};
          border-radius: 4px;
          background: ${CONTROL_BG};
          color: ${TEXT};
          padding: 4px 12px;
          font-size: 0.75rem;

          &:hover {
            background: ${CONTROL_HOVER_BG};
            border-color: ${BORDER_STRONG};
          }

          &:disabled {
            opacity: 0.6;
            cursor: default;
          }
        }
      }
    }
  }

  /* the one row whose actions are words: the strip above sizes every control as a 32px icon */
  .sample .actions button {
    width: auto;
    padding: 0 12px;
  }

  /* a plain word that behaves like a link, for the two places an action sits inside a sentence */
  .link {
    border: none;
    background: none;
    padding: 0;
    margin-inline-start: 8px;
    font: inherit;
    font-size: inherit;
    color: ${TEXT};
    text-decoration: underline;
    cursor: pointer;
  }

  /* Under the list rather than in it, so appearing moves no row and covers none. Sticky for a phone, where the list
     runs below the window and the page scrolls: the bar is held to the window's bottom, not to the list's. */
  .bulk-bar {
    position: sticky;
    bottom: 8px;
    z-index: 2;
    margin: 0 16px 8px;
  }

  .hidden-note {
    flex: none;
    margin-top: 4px;
    padding: 8px 2px;
    color: ${TEXT_MUTED};
    font-size: 0.8rem;
  }

  .empty {
    position: relative;
    margin: auto;
    text-align: center;
    color: ${TEXT_MUTED};
    font-size: 0.95rem;
    line-height: 1.7;
    padding: 24px;

    /**
     * The headline, at the top text tier across both halves.
     *
     * The emphasised half used to be gradient text against plain white, so the gradient was what
     * marked "this is the point" of the sentence. Nothing sits above TEXT to hand the em instead, and
     * dimming the lead-in to manufacture a step would put the largest headline in the app on the same
     * tier as the paragraph under it, which is the one thing this block must not do: the .empty
     * wrapper is already TEXT_MUTED, so the h1 would then contribute no brightness step at all. Both
     * halves are TEXT and the em is left only cancelling the browser italic.
     */
    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.7rem, 4.5vw, 2.6rem);
      font-weight: 900;
      letter-spacing: -0.01em;
      line-height: 1.15;
      color: ${TEXT};

      em {
        font-style: normal;
      }
    }

    .hints {
      display: flex;
      justify-content: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 22px;

      span {
        padding: 6px 14px;
        border-radius: 4px;
        border: 1px solid ${BORDER};
        background: ${SURFACE_BG};
        font-size: 0.78rem;
        color: ${TEXT_MUTED};
      }
    }
  }

  /**
   * A frame with the message sitting in it, rather than a page-sized flood of colour.
   *
   * Nothing tints the page: the frame is what says WHERE the drop lands, and it can say that at the
   * edge of the window without covering everything the person is looking at. The dashed edge is the
   * half of the cue that never depended on a hue, which is why it survives intact here; what changed
   * is that it is now drawn at full brightness rather than at an alpha of the accent, since a dim
   * neutral hairline at the very edge of a viewport is not something anyone would notice.
   */
  .drop {
    position: fixed;
    inset: 12px;
    z-index: 20;
    display: grid;
    place-items: center;
    border: 2px dashed ${EMPHASIS};
    border-radius: 8px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 150ms ease;

    /* opaque and edged rather than lifted on a shadow: it floats over the library, so it takes the
       floating pair of tokens */
    span {
      padding: 10px 22px;
      border-radius: 8px;
      background: ${ELEVATED_BG};
      border: 1px solid ${BORDER_STRONG};
      color: ${TEXT};
      font-size: 1rem;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
  }

  &[data-drag] .drop {
    opacity: 1;
  }

  footer {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 18px;
    padding: 8px 16px;
    /* opaque for the same reason the header is: the list scrolls under it */
    background: ${SURFACE_BG};
    border-top: 1px solid ${BORDER};
    font-size: 0.78rem;
    color: ${TEXT_MUTED};

    a {
      color: ${TEXT_MUTED};
      transition: color 120ms ease;

      &:hover {
        color: ${TEXT};
      }
    }

    .build {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.01em;
      opacity: 0.85;
    }

    .controls {
      margin-inline-start: auto;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 18px;
    }

    .folder {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 7px;

      button {
        font-size: 0.75rem;
        padding: 4px 12px;
        border-radius: 4px;
        border: 1px solid ${BORDER};
        background: ${CONTROL_BG};
        color: ${TEXT_MUTED};

        &:hover {
          background: ${CONTROL_HOVER_BG};
          color: ${TEXT};
          border-color: ${BORDER_STRONG};
        }

        /* The only thing saying a limit is set or a folder is live. It used to be an accent border,
           which was one cue; a toggle with nothing else to identify it gets all three the palette
           has, the active fill, the top text tier and the interactive outline, because "on" and
           "hovered" are one step apart otherwise. */
        &.on {
          background: ${CONTROL_ACTIVE_BG};
          color: ${TEXT};
          border-color: ${BORDER_INTERACTIVE};
        }

        /* The hover rule above and the .on rule weigh the same, and .on is written last, so it wins
           every property it declares and an on-toggle would otherwise answer the cursor with
           nothing. It cannot simply fall back to that rule either: CONTROL_HOVER_BG is darker than
           CONTROL_ACTIVE_BG, so an active toggle would appear to dim under the pointer. The outline
           is the cue with somewhere left to go, and every one of these buttons opens a dialog or
           flips a setting, so it owes the pointer an answer. */
        &.on:hover {
          border-color: ${TEXT};
        }
      }
    }
  }

  /* a phone: one row, of which fkn.app's 140 px Connect FKN frame takes nearly half at 320 px */
  @media (max-width: ${PHONE_MAX}px) {
    header {
      --gap: 8px;
      gap: var(--gap);
      padding: 8px;

      .powered {
        display: none;
      }

      .logo img {
        height: 24px;
      }

      /* a phone's form takes the room the row leaves, and never less than the folded field's 100 px */
      form {
        min-width: 100px;
      }

      /* 38 px tall, as Connect FKN and the account are, so the row keeps its height while they give way to it */
      .field {
        padding-block: 3px;

        input:not([type='file']) {
          box-sizing: border-box;
          height: 30px;
          padding-block: 0;
        }
      }

      .icon, .tool {
        width: 30px;
        height: 30px;
      }

      /* under 375 px a signed-out row has room for only 4 px between its items */
      @media (width < 375px) {
        --gap: 4px;
      }

      &[data-plugins-wrapped] {
        padding-bottom: calc(8px + 30px + 4px);

        > .plugins {
          bottom: 8px;
          inset-inline-end: 8px;
        }
      }

      /* fkn.app's pill cannot narrow, since its words wrap rather than overflow, so under 360 px it is drawn smaller,
         and so is the room held for it until the broker answers */
      @media (width < 360px) {
        iframe, .account-pending {
          transform: scale(0.78);
          margin: 0 -15px;
        }
      }

      /*
       * The row leaves the field under its floor: it folds to its search glyph, its file and its + until it is pressed,
       * and unfolds over the controls after it while it has the focus. They keep their places, hidden, so the room it
       * was folded for holds, and stay in the tab order: reaching one hands the row back to them. A search it holds
       * while folded is marked on the glyph.
       */
      &[data-folded] {
        .field {
          flex: none;
          position: relative;
          padding-inline: 2px;

          .glyph {
            display: block;
            position: absolute;
            inset-inline-start: 9px;
            top: calc(50% - 8px);
            width: 16px;
            height: 16px;
            color: ${TEXT_MUTED};
            pointer-events: none;
          }

          /* folded to the glyph, as wide a target as the buttons beside it, with no room for its hint */
          input:not([type='file']) {
            flex: 0 0 30px;
            width: 30px;
            padding-inline: 30px 0;

            &::placeholder { color: transparent; }
          }

          /* typed in the other direction than the page's, the glyph is at the input's end */
          &:dir(rtl) input:not([type='file']):dir(ltr), &:dir(ltr) input:not([type='file']):dir(rtl) {
            padding-inline: 0 30px;
          }

          .sep {
            margin: 0 1px;
          }
        }

        /* folded, the glyph is a button beside the others, with no text to set them apart from */
        &:not([data-searching]) .field {
          .clear, .sep, .plugin, .plugin-more { display: none; }

          &[data-held] {
            .glyph { color: ${TEXT}; }

            &::after {
              content: '';
              position: absolute;
              top: 5px;
              inset-inline-start: 22px;
              width: 8px;
              height: 8px;
              border-radius: 50%;
              background: ${EMPHASIS};
              box-shadow: 0 0 0 2px ${SUNKEN_BG};
              pointer-events: none;
            }
          }
        }

        &[data-searching] {
          /* from after the 24 px logo to the row's end */
          .field {
            position: absolute;
            inset-block: 8px;
            inset-inline: calc(8px + 24px + var(--gap)) 8px;

            input:not([type='file']) {
              flex: 1 1 auto;

              &::placeholder { color: ${TEXT_MUTED}; }
            }
          }

          > :not(.brand, form) {
            opacity: 0;
            pointer-events: none;
          }

          /* plugins on a row of their own stay there, below the field */
          &[data-plugins-wrapped] > .plugins {
            top: auto;
            inset-inline-start: auto;
            opacity: 1;
            pointer-events: auto;
          }
        }
      }
    }

    /* the panels around it can take a whole phone, so the list keeps room for a row and the page scrolls; with the
       details open it gives way down to the floor above, or they would open below the fold (the bulk bar can stand
       between the two) */
    main:not(:has(~ section)) {
      min-height: 24rem;
    }

    .stats {
      margin: 10px 16px 0;
      padding: 10px 12px;

      .readouts {
        gap: 6px 16px;
      }

      .line {
        gap: 16px;
      }

      .stat label, .stat .name {
        font-size: 0.6rem;
      }

      .stat strong {
        font-size: 0.85rem;
      }

      .stat.big strong {
        font-size: 1.15rem;
      }

      .graph, .inbound, .dht {
        display: none;
      }
    }

    /* each limit as its arrow, whole, beside Speed, which gives way to an ellipsis down to a letter and the ellipsis
       before a limit takes a second line */
    footer {
      .folder > span {
        flex: 1 1 0;
        min-width: 2em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .folder button {
        flex: none;
        > span { display: none; }
        &::before { content: attr(data-arrow); }
      }
    }

    /* the right-hand group takes its own line rather than squeezing the name out of existence */
    .torrent .main, .sample .main {
      flex-wrap: wrap;
    }

    /* no speed graph on a phone, the row's own included: its 84px column beside the name broke names mid-word */
    .torrent .spark {
      display: none;
    }

    .torrent .side, .sample .side {
      flex-basis: 100%;
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .torrent .actions, .sample .actions {
      justify-content: flex-start;
    }

    .sample .actions {
      flex: 1;
    }

    .torrent .poster, .sample .poster {
      width: 96px;
      min-height: 64px;
    }

    .torrent.group-row .poster.group-poster {
      padding-top: 6px;

      .folder-tab {
        height: 7px;
      }
    }

    .group-children {
      margin-inline-start: 10px;
      padding-inline-start: 8px;
    }
  }
`

/*
 * On the body at a modal's height, like the Updating screen: raised from a dialog, it is the later child and is drawn
 * above that dialog's backdrop, outside the page the dialog makes inert. A press goes through it to the dialog's
 * footer, which it lies over on a phone.
 */
const SpeedGraph = ({ history }: { history: number[] }) => {
  const w = 100
  const h = 30
  const max = Math.max(...history, 1)
  const offset = HISTORY - history.length
  const points = history
    .map((v, i) => `${(((offset + i) / (HISTORY - 1)) * w).toFixed(2)},${(h - 1 - (v / max) * (h - 4)).toFixed(2)}`)
    .join(' ')
  if (!points) return null
  return (
    <svg className="graph" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {/* A flat fill, the same token RowGraph uses. This area used to fade out with a gradient;
          gradients are gone, and one shared token keeps the two graphs reading as one thing. */}
      <polygon fill={CHART_PRIMARY_FILL} points={`${((offset / (HISTORY - 1)) * w).toFixed(2)},${h} ${points} ${w},${h}`}/>
      <polyline points={points}/>
    </svg>
  )
}

/**
 * One torrent's recent transfer, drawn the way the page graph draws the whole session's.
 *
 * BOTH directions, which is where it departs from the page graph on purpose. That one totals
 * downloads because that is what the page is doing; a single torrent is often seeding, and a
 * download-only sparkline on a finished torrent is a flat line saying nothing while the thing is
 * working hard. Download is the filled area, upload the plain line over it, and both are scaled to
 * the same peak so the two can be read against each other.
 *
 * A flat fill, which the page graph now uses too. It used to be the odd one out here: the page graph
 * faded its area with a gradient, and this one could not, because a gradient needs a `<defs>` with an
 * id, and an id repeated once per row is invalid in the document and resolves to whichever copy came
 * first. The gradient is gone from both, so the constraint no longer forces anything, but it still
 * holds for any per-row SVG filter, mask or clipPath somebody adds later: those want an id too.
 */
const RowGraph = ({ down, up }: { down: number[], up: number[] }) => {
  const w = 100
  const h = 26
  // one peak for both series: scaling each to its own would draw a seeding torrent's 20 kB/s at the
  // same height as another's 20 MB/s, which is the one thing a graph must never do
  const max = Math.max(...down, ...up, 1)
  const at = (values: number[]) => {
    const offset = ROW_HISTORY - values.length
    return values
      .map((v, i) => `${(((offset + i) / (ROW_HISTORY - 1)) * w).toFixed(2)},${(h - 1 - (v / max) * (h - 3)).toFixed(2)}`)
      .join(' ')
  }
  if (!down.length) return null
  const downPoints = at(down)
  const offset = ROW_HISTORY - down.length
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <polygon
        className="down-fill"
        points={`${((offset / (ROW_HISTORY - 1)) * w).toFixed(2)},${h} ${downPoints} ${w},${h}`}
      />
      <polyline className="down-line" points={downPoints}/>
      {up.some((v) => v > 0) && <polyline className="up-line" points={at(up)}/>}
    </svg>
  )
}

// fileIndex -1 tracks a whole-torrent zip save (never collides with a real file).
const savingKey = (id: string, fileIndex: number) => `${id}:${fileIndex}`

type RowProps = {
  t: Torrent
  saving: Record<string, number>
  onToggle: (t: Torrent) => void
  onSave: (t: Torrent, fileIndex: number) => void
  onSaveZip: (t: Torrent) => void
  onStart: (t: Torrent) => void
  /** `at` opens the menu at a point; null opens the options dialog instead. */
  onOptions: (t: Torrent, at: MenuPosition | null) => void
  selected: boolean
  /** Selects, and only selects. Deselecting is the dock's own gesture, not a second click here. */
  onSelect: (t: Torrent) => void
  /** Ticked for a bulk action, which is not the selection above. */
  checked: boolean
  /** Ticks or unticks `t`, or with `shift` the run from the box clicked before, and ignores a row that cannot be ticked. */
  onPick: (t: Torrent, shift: boolean) => void
  /** Whether this torrent's files are already in the folder the user chose. Hides the save button. */
  savedToUserStorage: boolean
  /** This row's recent transfer, newest last. Absent until the second state tick has been seen. */
  rates?: { down: number[], up: number[] }
  /** What carries the engine's peers, which the line of a download that found nobody names. */
  transport?: EngineTransport | null
  dragKey?: string
  parentGroupId?: string
  dropPlace?: DropPlace
  isDragging?: boolean
  onRowDragStart?: (payload: DragPayload, dragKey: string, e: ReactDragEvent) => void
  onRowDragEnd?: () => void
  onRowDragOver?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  onRowDragLeave?: (targetKey: string) => void
  onRowDrop?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
}

/** A torrent's name with a break chance after each dot, underscore and dash, so a release name wraps between its parts. */
const Name = ({ name }: { name: string }) => (
  <strong dir="auto">{name.split(/(?<=[._-])/u).flatMap((part, i) => (i ? [<wbr key={i}/>, part] : [part]))}</strong>
)

/** The picture, or the box it would have been in, so every row's text starts at the same place. */
const Poster = ({ url, t }: { url: string | null, t: Torrent }) =>
  url
    // decorative: the name is right beside it, so a screen reader announcing this twice is worse
    // than it announcing nothing
    ? <img className="poster" src={url} alt="" />
    : <div className="poster placeholder"><FileGlyph name={t.name} files={t.files}/></div>

/**
 * A library row drawn before its engine handle exists.
 *
 * Presentational on purpose: no click handler, no context menu, no controls. Every action on a live
 * row resolves a handle with `Number(t.id)`, and this row's id cannot produce one, so anything
 * offered here would send a command naming no torrent. It exists to say "this is in your library and
 * it is coming back", which is the honest answer for the second the relay takes to grant a port, and
 * it is replaced by the real row the moment the engine reports.
 */
const StartingRow = ({ t, poster }: { t: Torrent, poster: string | null }) => {
  const intl = useIntl()
  return (
    <div className="torrent surface starting" data-state={t.state}>
      <Poster url={poster} t={t}/>
      <div className="content">
        <div className="main">
          <div className="body">
            <div className="title"><Name name={t.name}/></div>
            <div className="meta"><span>{intl.formatMessage({ id: 'Connecting', defaultMessage: 'Connecting' })}</span></div>
          </div>
          <div className="side">
            <span className={`badge ${t.state}`}>{intl.formatMessage(STATE_LABEL[t.state])}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const MissingRow = ({
  t, poster, onStart, onOptions, selected, onSelect, checked, onPick,
  dragKey, parentGroupId, dropPlace, isDragging,
  onRowDragStart, onRowDragEnd, onRowDragOver, onRowDragLeave, onRowDrop,
}: Pick<RowProps, 't' | 'onStart' | 'onOptions' | 'selected' | 'onSelect' | 'checked' | 'onPick' | 'dragKey' | 'parentGroupId' | 'dropPlace' | 'isDragging' | 'onRowDragStart' | 'onRowDragEnd' | 'onRowDragOver' | 'onRowDragLeave' | 'onRowDrop'> & { poster: string | null }) => {
  const intl = useIntl()
  const allowInto = !parentGroupId && !!t.infoHash
  const dragProps = dragKey && onRowDragStart
    ? {
      draggable: !!t.infoHash,
      'data-dragging': isDragging || undefined,
      'data-drop': dropPlace || undefined,
      onDragStart: (e: ReactDragEvent) => {
        if (t.infoHash) onRowDragStart(parentGroupId ? { kind: 'member', groupId: parentGroupId, infoHash: t.infoHash } : { kind: 'top', key: `t:${t.infoHash}` }, dragKey, e)
      },
      onDragEnd: onRowDragEnd,
      onDragOver: (e: ReactDragEvent) => onRowDragOver?.(dragKey, allowInto, e),
      onDragLeave: () => onRowDragLeave?.(dragKey),
      onDrop: (e: ReactDragEvent) => onRowDrop?.(dragKey, allowInto, e),
    }
    : {}
  return (
    <div
      className={'torrent surface missing' + (selected ? ' selected' : '') + (checked ? ' picked' : '')}
      data-state={t.state}
      aria-current={selected || undefined}
      {...dragProps}
      {...rowClicks((shift) => onPick(t, shift), (e) => {
        if ((e.target as HTMLElement).closest('button, a')) return
        onSelect(t)
      })}
      onContextMenu={(e) => {
        if (e.shiftKey || e.ctrlKey) return
        e.preventDefault()
        // no onSelect: see the live row's handler for why the right button leaves the dock alone
        onOptions(t, { x: e.clientX, y: e.clientY })
      }}
    >
      {pickable(t) && <RowCheck name={t.name} checked={checked} onChange={(shift) => onPick(t, shift)} overPicture/>}
      {/* the files are gone from this device but the picture was cached here, so it still shows */}
      <Poster url={poster} t={t}/>
      <div className="content">
        <div className="main">
          <div className="body">
            <div className="title"><Name name={t.name}/></div>
            <div className="meta">
              {/* A created source is the one ghost whose files were never in a swarm: this device was
                  the only seed, so there is nobody to fetch them from and the line has to say what
                  actually happened instead of offering a download that cannot work. */}
              {/* otherwise the size: the chip, and the heading where there is one, already say the files are not here */}
              {t.saveTo === 'source'
                ? <span>{intl.formatMessage({ id: 'Source files unavailable. Create it again from the same files.', defaultMessage: 'Source files unavailable. Create it again from the same files.' })}</span>
                : t.size > 0 && <span>{getHumanReadableByteString(t.size, true)}</span>}
            </div>
          </div>
          <div className="side">
            <span className={`badge ${t.state}`}>{intl.formatMessage(STATE_LABEL[t.state])}</span>
            {/* Two, matching the live rows: fetch it, or open the menu. Removing a library entry is
                in the menu with everything else destructive.
                ONE EXCEPTION, and it is not cosmetic. A created source has no swarm behind it, and
                `start` on one adds the torrent at its `/source/<hash>` path with no handles
                registered, which throws inside the storage on the first read: a fatal disk error, a
                red retrying row backing off to five minutes, and an entry written back to
                `started: true`, which hides it from this list again with its Remove option gone. So
                the row offers the menu alone, where Remove is. */}
            <div className="actions">
              {t.saveTo !== 'source' && (
                <button
                  className="primary"
                  onClick={() => onStart(t)}
                  {...hint(intl.formatMessage({ id: 'Download to this device', defaultMessage: 'Download to this device' }))}
                  aria-label={intl.formatMessage({ id: 'Download {name}', defaultMessage: 'Download {name}' }, { name: t.name })}
                >
                  <Download size={16} aria-hidden="true"/>
                </button>
              )}
              <button
                className="more"
                aria-haspopup="dialog"
                aria-label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: t.name })}
                {...hint(intl.formatMessage({ id: 'Options', defaultMessage: 'Options' }))}
                onClick={() => onOptions(t, null)}
              >
                <Ellipsis size={16} aria-hidden="true"/>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The widest a speed is written in each unit, to the single digit of gigabytes a second no browser transfer passes.
 * 999.95e6 is written 1,000 MB/s, since the unit is picked before the rounding, and a comma can be wider than a point.
 */
const WIDEST_SPEEDS = [999.9, 999.9e3, 999.9e6, 999.95e6, 9.99e9]

/** The widest a count of bytes is written in each unit, from bytes to terabytes. */
const WIDEST_SIZES = [999.9, 999.9e3, 999.9e6, 999.99e9, 999.99e12]

/** What `write` makes of each figure, one per line, which is what data-room takes. */
const room = (write: (figure: number) => string, figures: number[]) => figures.map(write).join('\n')

/**
 * A row's live figures, written by one function each so that the text and the room it keeps agree. `chosen` is the
 * size of the chosen files where some are left out, whose total then carries the whole `size` in brackets.
 */
const rowFigures = (intl: IntlShape, size: number, chosen?: number) => {
  const whole = getHumanReadableByteString(size, true)
  const total = chosen === undefined ? whole : withWhole(intl, getHumanReadableByteString(chosen, true), whole)
  const pair = (done: number) => intl.formatMessage({ id: '{done} / {total}', defaultMessage: '{done} / {total}' }, { done: getHumanReadableByteString(done, true), total })
  const down = (bps: number) => intl.formatMessage({ id: '↓ {speed}', defaultMessage: '↓ {speed}' }, { speed: speed(bps) })
  const up = (bps: number) => intl.formatMessage({ id: '↑ {speed}', defaultMessage: '↑ {speed}' }, { speed: speed(bps) })
  const peers = (count: number) => intl.formatMessage({ id: '{count, plural, one {{count} peer} other {{count} peers}}', defaultMessage: '{count, plural, one {{count} peer} other {{count} peers}}' }, { count })
  return {
    pair, down, up, peers,
    rooms: {
      pair: room(pair, WIDEST_SIZES),
      down: room(down, WIDEST_SPEEDS),
      up: room(up, WIDEST_SPEEDS),
      peers: peers(999),
    },
  }
}

/**
 * Props compared by value. Every engine tick rebuilds every row's data, and a row whose values did not
 * move skips its render: at 500 idle torrents that is 297 against 32 ms/s of main thread.
 *
 * A function compares by identity, so a row prop that is a new function on each render (an inline
 * arrow, a handler without useCallback) silently turns the skip off for every row.
 */
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

/** Exported for its own test: the page around it needs the whole engine, and the row does not. */
export const TorrentRow = memo(({
  t, saving, onToggle, onSave, onSaveZip, onStart, onOptions, selected, onSelect, checked, onPick,
  savedToUserStorage, rates, transport,
  dragKey, parentGroupId, dropPlace, isDragging,
  onRowDragStart, onRowDragEnd, onRowDragOver, onRowDragLeave, onRowDrop,
}: RowProps) => {
  const intl = useIntl()
  /**
   * Before the missing branch, not after it.
   *
   * A torrent moves between missing and present at runtime (a recheck, a restored library), and a
   * hook that only runs on one side of that branch changes the hook COUNT between two renders of the
   * same component, which React treats as a corrupted render rather than a state change.
   */
  const poster = useThumbnail(t.infoHash)
  const chosen = chosenBytes(t)
  const figures = useMemo(() => rowFigures(intl, t.size, chosen?.size), [intl, t.size, chosen?.size])
  if (t.state === 'starting') return <StartingRow t={t} poster={poster}/>
  if (t.state === 'missing') {
    return (
      <MissingRow
        t={t} poster={poster} onStart={onStart}
        onOptions={onOptions} selected={selected} onSelect={onSelect}
        checked={checked} onPick={onPick}
        dragKey={dragKey} parentGroupId={parentGroupId} dropPlace={dropPlace} isDragging={isDragging}
        onRowDragStart={onRowDragStart} onRowDragEnd={onRowDragEnd} onRowDragOver={onRowDragOver}
        onRowDragLeave={onRowDragLeave} onRowDrop={onRowDrop}
      />
    )
  }
  const href = watchHref(t)
  const mainIndex = pickVideoFile(t.files)
  const multi = contentFiles(t.files).length > 1
  const mainSaving = saving[savingKey(t.id, multi ? -1 : mainIndex)]
  const complete = t.progress >= 1
  // 'retrying' is not stopped, it is waiting out a backoff, so the control still offers to pause it
  const running = !stopped(t)
  const isFinished = finished(t)
  // the panel keys by file index; the page keys by torrent-and-index, since one map covers every row
  const fileSaving: Record<number, number> = {}
  t.files?.forEach((_, i) => {
    const s = saving[savingKey(t.id, i)]
    if (s != null) fileSaving[i] = s
  })
  const allowInto = !parentGroupId && !!t.infoHash
  const dragProps = dragKey && onRowDragStart
    ? {
      draggable: !!t.infoHash,
      'data-dragging': isDragging || undefined,
      'data-drop': dropPlace || undefined,
      onDragStart: (e: ReactDragEvent) => {
        if (t.infoHash) onRowDragStart(parentGroupId ? { kind: 'member', groupId: parentGroupId, infoHash: t.infoHash } : { kind: 'top', key: `t:${t.infoHash}` }, dragKey, e)
      },
      onDragEnd: onRowDragEnd,
      onDragOver: (e: ReactDragEvent) => onRowDragOver?.(dragKey, allowInto, e),
      onDragLeave: () => onRowDragLeave?.(dragKey),
      onDrop: (e: ReactDragEvent) => onRowDrop?.(dragKey, allowInto, e),
    }
    : {}
  return (
    <div
      className={'torrent surface' + (selected ? ' selected' : '') + (checked ? ' picked' : '')}
      data-state={t.state}
      aria-current={selected || undefined}
      {...dragProps}
      // Selecting is what fills the dock, so it has to be the ordinary click on the card. Anything
      // that already does something of its own keeps doing it: the buttons, the Watch link, the
      // file list, and any text the user is trying to select rather than click.
      {...rowClicks((shift) => onPick(t, shift), (e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, a, input, summary')) return
        if (window.getSelection()?.toString()) return
        onSelect(t)
      })}
      onContextMenu={(e) => {
        // The detail panel keeps the browser's own menu: its peer addresses, tracker URLs and info
        // hash are there to be copied, and replacing Copy with a torrent menu would take away the
        // only reason to select that text.
        if ((e.target as HTMLElement).closest('.detail .pane')) return
        // Held modifier means the user wants the browser's menu, not this one. Taking over the
        // right button removes Inspect, Copy and Save as, and there has to be a way back; the menu
        // says which keys in its own footer, so the escape hatch is not left to be discovered.
        if (e.shiftKey || e.ctrlKey) return
        e.preventDefault()
        /*
         * The right button opens the menu and NOTHING else. It used to select the row first, so the
         * menu and the dock would agree on subject, but that made one gesture do two things: asking
         * for a menu also opened the detail panel, or swapped what an already open one was showing,
         * neither of which was asked for.
         *
         * Nothing needs the selection anyway. The menu carries its own subject (`menu.id`, not
         * `selectedId`), it opens at the pointer on the row it belongs to, and it names that torrent
         * in its own label, so there is no ambiguity left for a selection to resolve.
         */
        onOptions(t, { x: e.clientX, y: e.clientY })
      }}
    >
      {pickable(t) && <RowCheck name={t.name} checked={checked} onChange={(shift) => onPick(t, shift)} overPicture/>}
      <Poster url={poster} t={t}/>
      <div className="content">
        <div className="main">
          <div className="body">
            <div className="title">
              <Name name={t.name}/>
            </div>
            <div className="meta">
              {/* First, before the numbers, because it changes what all of them mean. A button rather
                  than a chip, so a touch device can reach the options at all; `title` alone is
                  invisible without a pointer. */}
              {t.ephemeral === true && (
                <button
                  type="button" className="temp"
                  onClick={() => onOptions(t, null)}
                  aria-label={intl.formatMessage({ id: 'Temporary download: options for {name}', defaultMessage: 'Temporary download: options for {name}' }, { name: t.name })}
                  {...hint(reclaimable(t) ? intl.formatMessage(TEMPORARY_HINT) : null)}
                >
                  <Clock aria-hidden="true"/>{intl.formatMessage({ id: 'Temporary', defaultMessage: 'Temporary' })}
                </button>
              )}
              <span className="pair" data-room={figures.rooms.pair}>{figures.pair(chosen?.done ?? t.downloaded)}</span>
              <span className={'rate down' + (t.down > 0 ? ' live' : '')} data-room={figures.rooms.down}>{figures.down(t.down)}</span>
              <span className={'rate up' + (t.up > 0 ? ' live' : '')} data-room={figures.rooms.up}>{figures.up(t.up)}</span>
              <span className="peers" data-room={figures.rooms.peers}>{figures.peers(t.peers)}</span>
              {t.state === 'downloading' && t.eta !== '-' && <span>{t.etaSeconds === undefined ? intl.formatMessage({ id: 'queued', defaultMessage: 'queued' }) : intl.formatMessage({ id: '{eta} left', defaultMessage: '{eta} left' }, { eta: t.eta })}</span>}
              {/* Only once there is something to have seeded, and only where it means something: a
                  torrent still downloading has an ETA in this slot, which is the more useful number,
                  and a row carrying both reads as two competing answers to "how long". */}
              {isFinished && (t.stats?.seedingSeconds ?? 0) > 0 && (
                <span className="seeded">
                  {intl.formatMessage({ id: 'seeded for {duration}', defaultMessage: 'seeded for {duration}' }, { duration: formatDuration(t.stats?.seedingSeconds ?? 0) })}
                </span>
              )}
              {/* Only when this torrent has been given one of its own. The session ceiling lives in
                  the footer and would be the same on every row, which is noise rather than news. */}
              {isLimit(t.downloadLimit) && t.downloadLimit > 0 && (
                <span className="limit">
                  {intl.formatMessage({ id: '↓ max {limit}', defaultMessage: '↓ max {limit}' }, { limit: formatLimit(t.downloadLimit, intl) })}
                </span>
              )}
              {isLimit(t.uploadLimit) && t.uploadLimit > 0 && (
                <span className="limit">
                  {intl.formatMessage({ id: '↑ max {limit}', defaultMessage: '↑ max {limit}' }, { limit: formatLimit(t.uploadLimit, intl) })}
                </span>
              )}
              {/* with the VPN off alone: behind the relay, a download with nobody is retried from 2 minutes in, and
                  that line says so, where two lines in turn would say one thing twice */}
              {t.retry
                ? <span className="retry">{retryLine(t, t.retry)}</span>
                : t.noPeers && transport === 'direct' && <span className="retry">{noPeersLine(transport)}</span>}
            </div>
            {/* only while there is something to watch: at 100% it is a solid bar saying what the
                percentage beside the name already says, across the whole width of the card */}
            {(t.progress < 1 || t.state === 'checking') && (
              <div className="bar">
                <div className="fill" style={{ width: `${Math.min(100, t.progress * 100)}%` }}/>
              </div>
            )}
          </div>
          {/* between the text and the controls, so it reads as part of what the row is REPORTING
              rather than as something to click */}
          {rates && <RowGraph down={rates.down} up={rates.up}/>}
          <div className="side">
            <span className={`badge ${t.state}`}>{intl.formatMessage(STATE_LABEL[t.state])}</span>
            <span className="pct">{writePercent(t.progress, t.progress < 1 ? 1 : 0)}</span>
            {/**
              * Four controls, and every one of them is something people reach for constantly.
              *
              * This strip carried seven text buttons and had run out of room: Watch, Save, Pause,
              * Embed, Recheck, Remove and then the options button wedged on the end. Recheck and
              * Embed are occasional, Remove is destructive and does not belong one stray click from
              * Pause, and none of the three needs to be on screen for every torrent at all times.
              * They live in the menu now, which has room to name and explain them.
              *
              * Icons rather than labels for the same reason: at four, the shapes are quicker to
              * find than the words were, and every one carries a title and an aria-label so it is
              * never only a shape.
              */}
            <div className="actions">
              {href && (
                <Link
                  className="primary" to={href}
                  {...hint(intl.formatMessage({ id: 'Watch', defaultMessage: 'Watch' }))}
                  aria-label={intl.formatMessage({ id: 'Watch {name}', defaultMessage: 'Watch {name}' }, { name: t.name })}
                >
                  <CirclePlay size={16} aria-hidden="true"/>
                </Link>
              )}
              {/* Only when there is something to write out AND it is not already sitting in the
                  user's own folder: offering to save a second copy of a file they already have is
                  an action with no outcome. */}
              {!!t.files?.length && complete && !savedToUserStorage && (
                <button
                  onClick={() => multi ? onSaveZip(t) : onSave(t, mainIndex)}
                  disabled={mainSaving != null}
                  {...hint(multi ? intl.formatMessage({ id: 'Save as a zip', defaultMessage: 'Save as a zip' }) : intl.formatMessage({ id: 'Save to disk', defaultMessage: 'Save to disk' }))}
                  aria-label={multi
                    ? intl.formatMessage({ id: 'Save {name} as a zip', defaultMessage: 'Save {name} as a zip' }, { name: t.name })
                    : intl.formatMessage({ id: 'Save {name} to disk', defaultMessage: 'Save {name} to disk' }, { name: t.name })}
                >
                  {mainSaving != null
                    ? <span className="saving">{writePercent(mainSaving)}</span>
                    : <Download size={16} aria-hidden="true"/>}
                </button>
              )}
              {t.state !== 'checking' && (
                <button
                  onClick={() => onToggle(t)}
                  {...hint(running
                    ? (isFinished ? intl.formatMessage({ id: 'Stop', defaultMessage: 'Stop' }) : intl.formatMessage({ id: 'Pause', defaultMessage: 'Pause' }))
                    : isFinished ? intl.formatMessage({ id: 'Start', defaultMessage: 'Start' }) : intl.formatMessage({ id: 'Resume', defaultMessage: 'Resume' }))}
                  aria-label={running
                    ? (isFinished
                      ? intl.formatMessage({ id: 'Stop {name}', defaultMessage: 'Stop {name}' }, { name: t.name })
                      : intl.formatMessage({ id: 'Pause {name}', defaultMessage: 'Pause {name}' }, { name: t.name }))
                    : isFinished
                      ? intl.formatMessage({ id: 'Start {name}', defaultMessage: 'Start {name}' }, { name: t.name })
                      : intl.formatMessage({ id: 'Resume {name}', defaultMessage: 'Resume {name}' }, { name: t.name })}
                >
                  {running ? (isFinished ? <Square size={16} aria-hidden="true"/> : <Pause size={16} aria-hidden="true"/>) : <Play size={16} aria-hidden="true"/>}
                </button>
              )}
              <button
                className="more"
                aria-haspopup="dialog"
                aria-label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: t.name })}
                {...hint(intl.formatMessage({ id: 'Options', defaultMessage: 'Options' }))}
                onClick={() => onOptions(t, null)}
              >
                <Ellipsis size={16} aria-hidden="true"/>
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}, same)

const GroupRow = ({
  group,
  summary,
  icon,
  expanded,
  onToggleExpand,
  onStartMany,
  onOptions,
  dropPlace,
  isDragging,
  onRowDragStart,
  onRowDragEnd,
  onRowDragOver,
  onRowDragLeave,
  onRowDrop,
  children,
}: {
  group: TorrentGroup
  summary: GroupSummary
  icon: GroupIcon
  expanded: boolean
  onToggleExpand: (groupId: string) => void
  onStartMany: (rows: readonly Torrent[]) => void
  onOptions: (group: TorrentGroup, at: MenuPosition | null) => void
  dropPlace?: DropPlace
  isDragging?: boolean
  onRowDragStart?: (payload: DragPayload, dragKey: string, e: ReactDragEvent) => void
  onRowDragEnd?: () => void
  onRowDragOver?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  onRowDragLeave?: (targetKey: string) => void
  onRowDrop?: (targetKey: string, allowInto: boolean, e: ReactDragEvent) => void
  children?: ReactNode
}) => {
  const intl = useIntl()
  const entryKey = `g:${group.id}` as const
  const active = summary.state !== 'missing' && summary.state !== 'starting'
  const showBar = summary.count > 0 && (summary.progress < 1 || summary.state === 'checking')
  return (
    <>
      <div
        className="torrent surface group-row"
        data-state={summary.state}
        data-expanded={expanded || undefined}
        data-dragging={isDragging || undefined}
        data-drop={dropPlace || undefined}
        draggable={!!onRowDragStart}
        onDragStart={onRowDragStart ? (e) => onRowDragStart({ kind: 'top', key: entryKey }, entryKey, e) : undefined}
        onDragEnd={onRowDragEnd}
        onDragOver={onRowDragOver ? (e) => onRowDragOver(entryKey, true, e) : undefined}
        onDragLeave={onRowDragLeave ? () => onRowDragLeave(entryKey) : undefined}
        onDrop={onRowDrop ? (e) => onRowDrop(entryKey, true, e) : undefined}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, input, summary')) return
          if (window.getSelection()?.toString()) return
          onToggleExpand(group.id)
        }}
        onContextMenu={(e) => {
          if (e.shiftKey || e.ctrlKey) return
          e.preventDefault()
          onOptions(group, { x: e.clientX, y: e.clientY })
        }}
      >
        <GroupPoster groupId={group.id} icon={icon} previewHashes={summary.previewHashes}/>
        <div className="content">
          <div className="main">
            <div className="body">
              <div className="title">
                <button
                  type="button"
                  className="expand-btn"
                  aria-expanded={expanded}
                  aria-label={expanded
                    ? intl.formatMessage({ id: 'Collapse {name}', defaultMessage: 'Collapse {name}' }, { name: group.name })
                    : intl.formatMessage({ id: 'Expand {name}', defaultMessage: 'Expand {name}' }, { name: group.name })}
                  onClick={(e) => { e.stopPropagation(); onToggleExpand(group.id) }}
                >
                  <ChevronRight size={16} aria-hidden="true"/>
                </button>
                <Name name={group.name}/>
                <span className="group-count">
                  <Folder size={12} strokeWidth={2} aria-hidden="true"/>
                  {summary.count}
                </span>
              </div>
              <div className="meta">
                <span>{intl.formatMessage({ id: '{count, plural, one {{count} torrent} other {{count} torrents}}', defaultMessage: '{count, plural, one {{count} torrent} other {{count} torrents}}' }, { count: summary.count })}</span>
                {summary.size > 0 && <span>{getHumanReadableByteString(summary.size, true)}</span>}
                {active && (
                  <>
                    <span className={'rate down' + (summary.down > 0 ? ' live' : '')}>
                      {intl.formatMessage({ id: '↓ {speed}', defaultMessage: '↓ {speed}' }, { speed: speed(summary.down) })}
                    </span>
                    <span className={'rate up' + (summary.up > 0 ? ' live' : '')}>
                      {intl.formatMessage({ id: '↑ {speed}', defaultMessage: '↑ {speed}' }, { speed: speed(summary.up) })}
                    </span>
                    <span>
                      {intl.formatMessage({ id: '{count, plural, one {{count} peer} other {{count} peers}}', defaultMessage: '{count, plural, one {{count} peer} other {{count} peers}}' }, { count: summary.peers })}
                    </span>
                    {summary.state === 'downloading' && summary.etaSeconds !== undefined && (
                      <span>
                        {intl.formatMessage({ id: '{eta} left', defaultMessage: '{eta} left' }, { eta: formatDuration(summary.etaSeconds) })}
                      </span>
                    )}
                  </>
                )}
              </div>
              {showBar && (
                <div className="bar">
                  <div className="fill" style={{ width: `${Math.min(100, summary.progress * 100)}%` }}/>
                </div>
              )}
            </div>
            <div className="side">
              <span className={`badge ${summary.state}`}>{intl.formatMessage(STATE_LABEL[summary.state])}</span>
              {summary.count > 0 && <span className="pct">{writePercent(summary.progress, summary.progress < 1 ? 1 : 0)}</span>}
              <div className="actions">
                {summary.fetchable.length > 0 && (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onStartMany(summary.fetchable)}
                    {...hint(intl.formatMessage({ id: 'Download all', defaultMessage: 'Download all' }))}
                    aria-label={intl.formatMessage({ id: 'Download all in {name}', defaultMessage: 'Download all in {name}' }, { name: group.name })}
                  >
                    <Download size={16} aria-hidden="true"/>
                  </button>
                )}
                <button
                  type="button"
                  className="more"
                  aria-haspopup="dialog"
                  aria-label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: group.name })}
                  {...hint(intl.formatMessage({ id: 'Options', defaultMessage: 'Options' }))}
                  onClick={() => onOptions(group, null)}
                >
                  <Ellipsis size={16} aria-hidden="true"/>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
      {expanded && (
        <div className="group-children">
          {summary.members.length > 0
            ? children
            : <div className="group-empty">{intl.formatMessage({ id: 'No torrents in this group', defaultMessage: 'No torrents in this group' })}</div>}
        </div>
      )}
    </>
  )
}

/**
 * The cards, each run under its group's heading and count where it has one. Headings and cards are siblings in one
 * list, so a card that changes group is moved rather than mounted again. Exported for its own test, like the row.
 */
export const CardList = <T,>({
  groups,
  row,
  collapsed = NO_COLLAPSED,
  onToggleGroup,
}: {
  groups: CardGroup<T>[]
  row: (item: T) => ReactNode
  collapsed?: CollapsedGroups
  onToggleGroup?: (group: ListGroup) => void
}) => {
  const intl = useIntl()
  return (
    <>
      {groups.flatMap(({ group, rows }) => {
        const folded = !!group && collapsed.has(group)
        return [
          group && (
            <h2 className="group-head" key={'group:' + group} data-collapsed={folded || undefined}>
              <button
                type="button"
                aria-expanded={!folded}
                onClick={onToggleGroup ? () => onToggleGroup(group) : undefined}
              >
                <ChevronDown className="chev" size={16} aria-hidden="true"/>
                <span>{intl.formatMessage(GROUP_LABEL[group])}</span>
                <span className="count">{rows.length}</span>
              </button>
            </h2>
          ),
          ...(folded ? [] : rows.map(row)),
        ]
      })}
    </>
  )
}

/** A line of the stats strip, which marks the ends it scrolls past for their fades. */
const ReadoutLine = ({ children }: { children: ReactNode }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState({ start: false, end: false })
  const read = useCallback(() => {
    const box = ref.current
    if (!box) return
    // right to left, a line scrolled from its start reads a negative scrollLeft
    const scrolled = Math.abs(box.scrollLeft)
    const start = scrolled > 1
    const end = scrolled + box.clientWidth < box.scrollWidth - 1
    setMore((was) => (was.start === start && was.end === end ? was : { start, end }))
  }, [])
  // a readout's words change with every engine tick, and a resize moves the end, so each render reads it again
  useLayoutEffect(read)
  useEffect(() => {
    addEventListener('resize', read)
    return () => removeEventListener('resize', read)
  }, [read])
  return (
    <div className="fades" data-more-start={more.start || undefined} data-more-end={more.end || undefined}>
      <div ref={ref} className="line" onScroll={read}>{children}</div>
    </div>
  )
}

const WORDLESS = `(width < ${CREATE_WORDS_MIN}px)`
const onWordlessChange = (changed: () => void) => {
  const query = matchMedia(WORDLESS)
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}

/** Keeps the focus where it is through a press, so the add field neither folds nor unfolds under a button in it. */
const keepFocus = (e: ReactMouseEvent) => e.preventDefault()

const Home = () => {
  const intl = useIntl()
  const wordless = useSyncExternalStore(onWordlessChange, () => matchMedia(WORDLESS).matches)
  const rowPlugins = usePlaced('row-menu')
  const { torrents, list, inboundNow, dhtNodes, addMagnet, addTorrentFile, pause, resume, retry, recheck, remove, start, startMany, removeMissing, storageUnavailable, workerError, reachable, transport, sampleOffered, answerSample, client } = useTorrents()
  const [input, setInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState<Record<string, number>>({})
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const toastTimer = useRef<number | undefined>(undefined)
  const { confirm, confirmElement, confirmOpen } = useConfirm()
  const navigate = useNavigate()

  const fieldRef = useRef<HTMLInputElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  /*
   * Whether the add field or one of its buttons has the focus, which is when a phone's field unfolds over the header's
   * other controls. Read from the document rather than from the form's blur: the window losing the focus, as the file
   * picker opening does, leaves it on the field, where a blur event would fold it.
   */
  const [searching, setSearching] = useState(false)
  const [fieldMenuOpen, setFieldMenuOpen] = useState(false)
  useEffect(() => {
    const read = () => setSearching(!!formRef.current?.contains(document.activeElement))
    document.addEventListener('focusin', read)
    document.addEventListener('focusout', read)
    return () => {
      document.removeEventListener('focusin', read)
      document.removeEventListener('focusout', read)
    }
  }, [])
  /*
   * Whether a phone's row leaves the add field under its floor, measured on the form, which takes what the logo,
   * Create, the gear and the account leave it: the account's width decides that room as much as the window's.
   * Folding and unfolding move nothing in the row, so the measure holds in every state.
   */
  const [folded, setFolded] = useState(false)
  useLayoutEffect(() => {
    const form = formRef.current
    if (!form) return
    const read = () => setFolded(form.getBoundingClientRect().width < FIELD_FLOOR)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(form)
    return () => observer.disconnect()
  }, [])
  const [embedOpen, setEmbedOpen] = useState(false)
  /**
   * What the share dialog is building a link FOR.
   *
   * Held as a subject rather than as a library id, because the dialog no longer adds anything. A
   * `.torrent` carries its own infohash, name, file list and trackers, and a magnet carries its own
   * infohash, so a link is built from the input in the page and the engine is never involved.
   * Opened from a torrent's own row it is simply that torrent, mapped into the same shape.
   */
  const [shareSubject, setShareSubject] = useState<ShareSubject | null>(null)

  /**
   * How fast anything is allowed to go, read from the ENGINE rather than kept here.
   *
   * Deliberately not localStorage, which is how the default save location works and is the wrong
   * shape for this one. The engine lives in whichever tab won the election, and a setting pushed
   * down from a page is lost the moment that election moves, with nothing to re-push it. So the
   * worker owns these, reads them back at startup and reports them on its ordinary broadcast: every
   * tab then renders the value actually in force, including a `/watch` tab that has no settings
   * screen to push from at all.
   */
  const [sessionLimits, setSessionLimits] = useState<RateLimits>(NO_LIMITS)
  useEffect(() => client.onRateLimits(setSessionLimits), [client])

  /**
   * Which ceiling is being edited, if any. `scope` names the session or one torrent.
   *
   * Up here beside the other surfaces rather than next to the handlers that use it, because the
   * window-level paste listener has to stand down while it is open and that effect is declared
   * further up the body.
   */
  const [rateEdit, setRateEdit] = useState<
    { scope: 'session' | { torrent: string }, direction: 'down' | 'up' } | null
  >(null)
  /** A group being created or edited, for the same reason as `rateEdit`. */
  const [naming, setNaming] = useState<{ title: string, groupId?: string, name?: string, icon?: GroupIcon, save: (result: GroupSaveResult) => void } | null>(null)
  /** A group sent by a link, being asked about; up here for the same reason. */
  const [received, setReceived] = useState<LinkedGroup | null>(null)
  /**
   * What the panel should adopt once the engine catches up with a drop.
   *
   * A drop is answered asynchronously: a magnet appears in the list on the next state tick, and a
   * .torrent only after the worker has polled up to ten seconds for its infohash. So the panel
   * cannot be pointed at anything at drop time, and this records what to point it at when it shows
   * up. `hash` covers a magnet, whose infohash is known immediately and which may ALSO already be in
   * the list; `before` covers a file, whose identity the page never learns (the worker's `added`
   * message reaches nothing), leaving "the one that was not here a moment ago" as the only handle.
   */

  const torrentsRef = useRef(torrents)
  torrentsRef.current = torrents

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  /** Asks about the group a link's fragment names. Refused inside a frame, as an /add link is (see that effect). */
  const receive = useCallback((fragment: string) => {
    if (isFramed()) return
    const group = receivable(readGroupLink(fragment))
    if (group) setReceived(group)
    else showToast(intl.formatMessage({ id: 'That link could not be read', defaultMessage: 'That link could not be read' }))
  }, [showToast, intl])

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) }
  }, [])

  useEffect(() => client.onAddFailed(showToast), [client, showToast])

  // Mounted once, here, because it drives the WHOLE library rather than a row: every job opens a
  // libav worker, so one owner with a queue is the difference between one at a time and one per row.
  useThumbnailGeneration(client)
  useFinishNotice(torrents)

  /** Whether an add the person made themselves stops to ask. Off by default: it is friction. */
  const [addDialog, setAddDialog] = useState(() => dialogEnabled((k) => localStorage.getItem(k)))
  const chooseAddDialog = (on: boolean) => {
    setAddDialog(on)
    try { localStorage.setItem(ADD_DIALOG_KEY, on ? '1' : '0') } catch {}
  }

  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null)
  const pendingRef = useRef(pendingAdd)
  pendingRef.current = pendingAdd
  const [choices, setChoices] = useState<AddChoices | null>(null)
  const heldRef = useRef<number | null>(null)

  /** Whether the dialog now asks about this magnet. */
  const beginAdd = useCallback((magnet: string, external: boolean, from: string | null = null, settle?: (outcome: AddOutcome) => void): boolean => {
    const request = describeAddRequest({ magnet })
    if (!request.ok) { showToast(request.problem); return false }
    const existing = torrentsRef.current.find((t) => sameInfoHash(t.infoHash, request.infoHash) && !t.ephemeral && (settle || t.state !== 'missing'))
    if (existing) {
      if (settle) settle('already')
      else showToast(intl.formatMessage({ id: 'Already in your list', defaultMessage: 'Already in your list' }))
      return false
    }
    client.addMagnet(request.magnet, { ephemeral: true, hold: true })
    const next: PendingAdd = { magnet: request.magnet, infoHash: request.infoHash, name: request.name, external, from, settle }
    pendingRef.current = next
    setPendingAdd(next)
    setChoices(null)
    return true
  }, [client, showToast, intl])

  // the magnets of a paste or a link and the .torrent files still to ask about, after the one the dialog shows
  const addQueue = useRef<(QueuedMagnet | PendingAdd)[]>([])
  const askNext = useCallback(() => {
    for (let next = addQueue.current.shift(); next; next = addQueue.current.shift()) {
      if ('infoHash' in next) {
        if (next.settle && torrentsRef.current.some((t) => sameInfoHash(t.infoHash, next.infoHash) && !t.ephemeral)) {
          next.settle('already')
          continue
        }
        pendingRef.current = next
        setPendingAdd(next)
        setChoices(null)
        return
      }
      if (beginAdd(next.magnet, next.external, next.from, next.settle)) return
    }
  }, [beginAdd])

  const commitMagnet = useCallback((raw: string): boolean => {
    const magnets = readMagnets(raw)
    if (!magnets.length) return false
    // Re-adding would join the swarm and start downloading; a synced "Files missing" torrent must only start from its explicit Download button
    const fresh = magnets.filter((m) => !torrentsRef.current.some((t) => t.magnet && sameInfoHash(magnetInfoHash(t.magnet), magnetInfoHash(m))))
    if (!fresh.length) {
      showToast(intl.formatMessage({ id: 'Already in your list', defaultMessage: 'Already in your list' }))
      return true
    }
    if (addDialog) {
      addQueue.current.push(...fresh.map((magnet) => ({ magnet, external: false, from: null })))
      if (!pendingRef.current) askNext()
      return true
    }
    for (const magnet of fresh) addMagnet(magnet)
    showToast(fresh.length === 1
      ? intl.formatMessage({ id: 'Magnet added', defaultMessage: 'Magnet added' })
      : intl.formatMessage({ id: '{count, plural, one {{count} magnet added} other {{count} magnets added}}', defaultMessage: '{count, plural, one {{count} magnet added} other {{count} magnets added}}' }, { count: fresh.length }))
    return true
  }, [addMagnet, showToast, addDialog, askNext, intl])

  const addTorrentFiles = useCallback(async (files: Iterable<File>) => {
    const all = [...files]
    const torrents = all.filter((file) => /\.torrent$/i.test(file.name))
    // Something was handed over and none of it was usable, which used to end in silence. A drop that
    // reports nothing is indistinguishable from one the page never received.
    if (!torrents.length) {
      if (all.length) {
        showToast(all.length === 1
          ? intl.formatMessage({ id: 'That is not a .torrent file', defaultMessage: 'That is not a .torrent file' })
          : intl.formatMessage({ id: 'No .torrent file in what you dropped', defaultMessage: 'No .torrent file in what you dropped' }))
      }
      return
    }
    for (const file of torrents) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const read = await readTorrentFile(bytes)
      const ih = read && magnetInfoHash(read.magnet)
      if (torrentsRef.current.some((t) => sameInfoHash(t.infoHash, ih) && !t.ephemeral)) {
        showToast(intl.formatMessage({ id: 'Already in your list', defaultMessage: 'Already in your list' }))
        continue
      }
      if (addDialog && read?.files && ih) {
        addQueue.current.push({ magnet: read.magnet, infoHash: ih, name: read.name, external: false, from: null, bytes, files: read.files })
        continue
      }
      addTorrentFile(bytes)
      showToast(intl.formatMessage({ id: '{name} added', defaultMessage: '{name} added' }, { name: file.name }))
    }
    if (!pendingRef.current) askNext()
  }, [addTorrentFile, showToast, addDialog, askNext, intl])

  /**
   * The share dialog's two inputs. Neither adds anything to the library.
   *
   * Handing them to the add path and waiting for the torrent to come back was the old shape. It
   * produced a link and it also started a download nobody asked for: somebody wanting a url to send
   * a friend ended up with the torrent in their own list. Reading the input in the page gives the
   * same link and leaves the library alone.
   */
  const shareMagnet = useCallback((raw: string): boolean => {
    const subject = readMagnet(raw)
    if (!subject) return false
    setShareSubject(subject)
    return true
  }, [])

  const shareFiles = useCallback((files: Iterable<File>) => {
    const torrent = [...files].find((file) => /\.torrent$/i.test(file.name))
    if (!torrent) { showToast(intl.formatMessage({ id: 'That is not a .torrent file', defaultMessage: 'That is not a .torrent file' })); return }
    void (async () => {
      const subject = await readTorrentFile(new Uint8Array(await torrent.arrayBuffer()))
      if (!subject) { showToast(intl.formatMessage({ id: 'That .torrent could not be read', defaultMessage: 'That .torrent could not be read' })); return }
      setShareSubject(subject)
    })()
  }, [showToast, intl])

  /**
   * The one place a drop is turned into an action, shared by the window and by the magnet field.
   *
   * Both targets have to agree, and the field cannot simply let the drop bubble: it stops
   * propagation so the page-wide overlay does not also claim the drop, which means the window
   * listener never runs and this is the only handler that fires.
   *
   * WHILE THE SHARE DIALOG IS ASKING FOR A TORRENT, the drop belongs to it and to nothing else.
   * Dropping a .torrent onto the open dialog used to do both: build the link AND add the torrent to
   * the library, so asking for a url started a download. The dialog is a link builder, so the drop
   * is read in the page and the library is left alone.
   */
  const acceptDrop = useCallback((data: DataTransfer | null) => {
    const forShareDialog = embedOpen && !shareSubject
    if (data?.files?.length) {
      if (forShareDialog) { shareFiles(data.files); return }
      void addTorrentFiles(data.files)
      return
    }
    const text = data?.getData('text') ?? ''
    if (!text.trim()) return
    if (forShareDialog) {
      if (!shareMagnet(text)) showToast(intl.formatMessage({ id: 'Not a magnet link', defaultMessage: 'Not a magnet link' }))
      return
    }
    if (!commitMagnet(text)) showToast(intl.formatMessage({ id: 'Not a magnet link', defaultMessage: 'Not a magnet link' }))
  }, [addTorrentFiles, commitMagnet, embedOpen, shareSubject, shareFiles, shareMagnet, showToast, intl])

  const openEmbed = useCallback((subject: ShareSubject | null) => {
    setShareSubject(subject)
    setEmbedOpen(true)
  }, [])

  const closeEmbed = useCallback(() => {
    setShareSubject(null)
    setEmbedOpen(false)
  }, [])

  /** a torrent already in the library, in the same shape a parsed file produces */
  const subjectOf = useCallback(async (t: Torrent): Promise<ShareSubject> => ({
    magnet: (await shareableMagnet(t)) ?? '',
    name: t.name,
    size: t.size,
    // pads are not the person's files, and a share link listing one would offer a `.pad` to watch.
    // `index` comes along because the link names files by ENGINE index: dropping it left the dialog
    // numbering a filtered list 0..n-1 and emitting positions, which pointed at the wrong files.
    files: t.files ? contentFiles(t.files).map((f) => ({ name: f.name, size: f.size, index: f.index })) : null,
    fileCount: t.files?.length ?? 0,
    private: t.private === true || await knownPrivate(t.infoHash),
  }), [])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // A modal makes the page inert to pointers but not to window-level listeners, so without this
      // a paste behind an open confirmation would add a torrent the user cannot see. The rate limit
      // editor counts for the same reason, and doubly so: it holds a text field, so a stray paste
      // there is a gesture aimed at THIS dialog rather than at the page behind it. And the add dialog,
      // whose torrent a paste behind it would replace.
      if (confirmOpen || rateEdit || pendingAdd || naming || received) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const text = e.clipboardData?.getData('text') ?? ''
      if (readMagnets(text).length) { e.preventDefault(); commitMagnet(text) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [commitMagnet, confirmOpen, rateEdit, pendingAdd, naming, received])

  // dragenter/dragleave fire per element, so a depth counter keeps the overlay from flickering while the drag crosses children
  const [dragging, setDragging] = useState(false)
  /**
   * A ref rather than a closure variable, because the magnet field also has to clear it.
   *
   * That field stops the drop propagating, so the window listener that would normally zero this
   * never runs. Left as a local, the count would stay at whatever the last dragenter made it and
   * every later drag would start already "inside", leaving the overlay stuck on.
   */
  const dragDepth = useRef(0)
  // no depth counter for the field: an <input> is void, so its dragenter/dragleave cannot nest
  const [fieldDrag, setFieldDrag] = useState(false)
  const endDrag = useCallback(() => { dragDepth.current = 0; setDragging(false); setFieldDrag(false) }, [])
  useEffect(() => {
    // a drop adds nothing while the add dialog or a group link's asks, as a paste does
    const asking = pendingAdd || received
    const onDragEnter = (e: DragEvent) => {
      if (asking || !droppable(e.dataTransfer)) return
      if (++dragDepth.current === 1) setDragging(true)
    }
    const onDragLeave = (e: DragEvent) => {
      if (!droppable(e.dataTransfer)) return
      if (--dragDepth.current <= 0) endDrag()
    }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      endDrag()
      if (!asking) acceptDrop(e.dataTransfer)
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    /**
     * A drag that ends anywhere else still has to put the page back.
     *
     * `dragleave` does not fire when a drag is cancelled with Escape, dropped on another window, or
     * ends outside the viewport, and the depth counter then never reaches zero, so the highlight is
     * stuck on with nothing being dragged. `dragend` covers a drag that started here; the window
     * losing focus covers one that did not.
     */
    window.addEventListener('dragend', endDrag)
    window.addEventListener('blur', endDrag)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragend', endDrag)
      window.removeEventListener('blur', endDrag)
      window.removeEventListener('drop', onDrop)
    }
  }, [acceptDrop, endDrag, pendingAdd, received])

  useEffect(() => {
    // a launch's address is read as the router reads a path, so /Add and /add/ are /add, as they are in a tab
    const at = (route: Route, url: URL) => matchPath(getRouterRoutePath(route), url.pathname)
    const addFromLaunchUrl = (rawUrl: string | undefined) => {
      if (!rawUrl) return
      try {
        const url = new URL(rawUrl, window.location.origin)
        const magnet = at(Route.HOME, url) && url.searchParams.get('magnet')
        if (magnet) commitMagnet(magnet)
      } catch {}
    }
    // an /add link, or the address it leads to, asks first as it does in a tab; the launch does not say which site
    // sent it
    const askAboutLaunchedLink = (rawUrl: string | undefined): boolean => {
      if (!rawUrl) return false
      try {
        const url = new URL(rawUrl, window.location.origin)
        // a group link, or the address it leads to
        if (url.hash && (at(Route.ADD, url) ? !url.searchParams.has('magnet') : at(Route.HOME, url) && url.searchParams.has('group'))) {
          receive(url.hash.slice(1))
          return true
        }
        const magnet = at(Route.ADD, url)
          ? namedMagnet(url.searchParams.get('magnet') ?? '', url.searchParams.get('name'))
          : at(Route.HOME, url) && url.searchParams.get('add')
        if (!magnet) return false
        addQueue.current.push({ magnet, external: true, from: null })
        if (!pendingRef.current) askNext()
        return true
      } catch { return false }
    }

    // Protocol-handler launches arrive as /?magnet=... in the address bar.
    addFromLaunchUrl(window.location.href)
    // Left in place, a torrent the user removed comes back on the next reload and the list sync pushes that resurrection to every other device
    if (window.location.search.includes('magnet=')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash)
    }

    const queue = window.launchQueue
    if (!queue) return
    try {
      queue.setConsumer(async (params: LaunchParams) => {
        if (!askAboutLaunchedLink(params.targetURL)) addFromLaunchUrl(params.targetURL)
        if (params.files?.length) {
          const files = await Promise.all(params.files.map((handle) => handle.getFile()))
          await addTorrentFiles(files)
        }
      })
    } catch {}
  }, [addTorrentFiles, askNext, commitMagnet, receive])

  const onToggle = useCallback((t: Torrent) => stopped(t) ? resume(Number(t.id)) : pause(Number(t.id)), [resume, pause])

  const onStart = useCallback((t: Torrent) => { if (t.infoHash) start(t.infoHash) }, [start])

  const onRemove = async (t: Torrent) => {
    // A torrent whose files are already gone has nothing to destroy, so asking would be noise.
    const missing = t.state === 'missing'
    if (!missing) {
      const ok = await confirm({
        title: intl.formatMessage({ id: 'Remove {name}?', defaultMessage: 'Remove {name}?' }, { name: t.name }),
        ...removalWords([t], inFolder),
        tone: 'danger',
      })
      if (!ok) return
    }
    removeWithFiles(t)
  }

  const removeWithFiles = (t: Torrent) => {
    // Nothing else would ever collect it: the worker deletes its own three key shapes on removal and
    // never clears the store, so a picture left behind here outlives the torrent it belongs to.
    if (t.infoHash) void forgetThumbnail(t.infoHash)
    if (t.state === 'missing') { if (t.infoHash) removeMissing(t.infoHash) }
    else remove(Number(t.id), true)
  }

  const onRecheck = (t: Torrent) => {
    recheck(Number(t.id))
    showToast(intl.formatMessage({ id: 'Checking {name}', defaultMessage: 'Checking {name}' }, { name: t.name }))
  }

  /**
   * Remove the torrent and LEAVE the files. Separate from onRemove, which deletes those held in browser storage.
   *
   * Still confirmed, because it is still not undoable: the library entry, the resume data and the
   * thumbnail all go. It just does not cost the bytes back, so it says so and does not offer to be
   * remembered, unlike the destructive one.
   */
  const onRemoveKeepingFiles = async (t: Torrent) => {
    if (t.state !== 'missing') {
      const ok = await confirm({
        title: intl.formatMessage({ id: 'Remove {name} from the library?', defaultMessage: 'Remove {name} from the library?' }, { name: t.name }),
        body: intl.formatMessage({ id: 'The downloaded files stay, but its progress is forgotten.', defaultMessage: 'The downloaded files stay, but its progress is forgotten.' }),
        confirmLabel: intl.formatMessage({ id: 'Remove', defaultMessage: 'Remove' }),
      })
      if (!ok) return
    }
    if (t.infoHash) void forgetThumbnail(t.infoHash)
    if (t.state === 'missing') { if (t.infoHash) removeMissing(t.infoHash) }
    else remove(Number(t.id), false)
  }


  /**
   * Which torrent's options are open, and in which surface. Held here rather than per row because
   * only one may be open at a time, and because both surfaces have to sit above every row.
   */
  const [menu, setMenu] = useState<{ id: string, at: MenuPosition } | null>(null)
  const [optionsId, setOptionsId] = useState<string | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ id: string, at: MenuPosition } | null>(null)
  const [groupOptionsId, setGroupOptionsId] = useState<string | null>(null)
  /**
   * The torrent the dock is showing. One at a time.
   *
   * Clicking a row SELECTS it and never deselects it, even when it is already the selected one.
   * A dock that toggles off under a second click is a dock that closes while the user is reading
   * it: rows are large, they carry buttons and a poster, and clicking one again to look at
   * something in it is a completely ordinary thing to do. Closing is its own gesture, so it has its
   * own controls, the header button and Escape.
   */
  /**
   * Creating a torrent from something on this device.
   *
   * The hook owns the pickers, the hashing and the durable handle; this page owns when the dialog is
   * on screen. Closing it does NOT cancel a pass in flight, which is deliberate: hashing a large
   * folder takes minutes and the dialog is not the only thing somebody wants to look at while it
   * runs. Cancel is its own button.
   */
  const create = useCreateTorrent(client)
  const [createOpen, setCreateOpen] = useState(false)
  const closeCreate = useCallback(() => setCreateOpen(false), [])
  const { waiting: waitingSources, allow: allowSource } = useCreatedSources(client, list, client.owns())

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const onSelect = useCallback((t: Torrent) => setSelectedId(t.id), [])

  const onOptions = useCallback((t: Torrent, at: MenuPosition | null) => {
    setGroupMenu(null)
    setGroupOptionsId(null)
    if (at) { setOptionsId(null); setMenu({ id: t.id, at }) }
    else { setMenu(null); setOptionsId(t.id) }
  }, [])

  const onGroupOptions = useCallback((g: TorrentGroup, at: MenuPosition | null) => {
    setMenu(null)
    setOptionsId(null)
    if (at) { setGroupOptionsId(null); setGroupMenu({ id: g.id, at }) }
    else { setGroupMenu(null); setGroupOptionsId(g.id) }
  }, [])

  const copy = (text: string, copied: string, failed: string) => {
    navigator.clipboard.writeText(text).then(() => showToast(copied)).catch(() => showToast(failed))
  }
  const magnetsCopied = (count: number, left: number) => (left
    ? intl.formatMessage({ id: '{count, plural, one {{count} magnet copied} other {{count} magnets copied}}, {left, plural, one {{left} private torrent left out} other {{left} private torrents left out}}', defaultMessage: '{count, plural, one {{count} magnet copied} other {{count} magnets copied}}, {left, plural, one {{left} private torrent left out} other {{left} private torrents left out}}' }, { count, left })
    : intl.formatMessage({ id: '{count, plural, one {{count} magnet copied} other {{count} magnets copied}}', defaultMessage: '{count, plural, one {{count} magnet copied} other {{count} magnets copied}}' }, { count }))

  const optionActions = (t: Torrent, magnet: string | undefined | null): TorrentOptionActions => ({
    setFlags: (flags, mask) => client.setFlags(Number(t.id), flags, mask),
    reannounce: () => {
      client.reannounce(Number(t.id))
      // the only one of these with no visible consequence anywhere, so it says so itself
      showToast(intl.formatMessage({ id: 'Reannouncing {name}', defaultMessage: 'Reannouncing {name}' }, { name: t.name }))
    },
    moveInQueue: (where) => client.moveInQueue(Number(t.id), where),
    copyMagnet: () => {
      if (magnet === null) { showToast(magnetsCopied(0, 1)); return }
      if (!magnet) return
      copy(
        magnet,
        intl.formatMessage({ id: 'Copied {name}\'s magnet', defaultMessage: 'Copied {name}\'s magnet' }, { name: t.name }),
        intl.formatMessage({ id: 'Could not copy the magnet', defaultMessage: 'Could not copy the magnet' }),
      )
    },
    copyName: () => copy(
      t.name,
      intl.formatMessage({ id: 'Copied {name}', defaultMessage: 'Copied {name}' }, { name: t.name }),
      intl.formatMessage({ id: 'Could not copy', defaultMessage: 'Could not copy' }),
    ),
    copyInfoHash: () => {
      if (!t.infoHash) return
      copy(
        hexInfoHash(t.infoHash),
        intl.formatMessage({ id: 'Copied {name}\'s info hash', defaultMessage: 'Copied {name}\'s info hash' }, { name: t.name }),
        intl.formatMessage({ id: 'Could not copy', defaultMessage: 'Could not copy' }),
      )
    },
    saveTorrentFile: () => {
      if (!t.magnet || !t.infoHash) return
      /*
       * The kept .torrent, else the account's, else one rebuilt from the resume blob. `flushResume`
       * is what makes a blob exist for a torrent the engine has not got round to persisting yet; it
       * writes to IndexedDB, not to torrent storage.
       */
      void saveSyncedTorrentFile({ infoHash: t.infoHash, magnet: t.magnet, name: t.name, flush: () => client.flushResume() })
        .then((result) => showToast(
          result === 'saved' ? intl.formatMessage({ id: 'Saved {name}.torrent', defaultMessage: 'Saved {name}.torrent' }, { name: t.name })
            : result === 'no-metadata' ? intl.formatMessage({ id: '{name} has no metadata yet', defaultMessage: '{name} has no metadata yet' }, { name: t.name })
              : intl.formatMessage({ id: 'The .torrent for {name} could not be built', defaultMessage: 'The .torrent for {name} could not be built' }, { name: t.name }),
        ))
    },
    recheck: () => onRecheck(t),
    pause: () => pause(Number(t.id)),
    resume: () => resume(Number(t.id)),
    forceStart: () => client.forceStart(Number(t.id)),
    remove: () => { void onRemoveKeepingFiles(t) },
    removeWithFiles: () => { void onRemove(t) },
    setLocation: (location) => onSetLocation(t, location),
    setKept: (kept) => { void onSetKept(t, kept) },
    setFirstLast: (on) => client.setPlan(Number(t.id), { wanted: t.wantedFiles, firstLast: on }),
    pickFolder,
    limitRate: (direction) => setRateEdit({ scope: { torrent: t.id }, direction }),
    // the row's Watch is a <Link>; from a menu it has to navigate itself
    watch: () => { const href = watchHref(t); if (href) void navigate(href) },
    save: () => (contentFiles(t.files).length > 1 ? onSaveZip(t) : onSave(t, pickVideoFile(t.files))),
    embed: () => { void subjectOf(t).then(openEmbed) },
    retryNow: () => retry(Number(t.id)),
    start: () => { if (t.infoHash) start(t.infoHash) },
    setInGroup: (id, on) => { const g = groups?.find((one) => one.id === id); if (g && t.infoHash) putIn(g, [t.infoHash], on) },
    newGroup: () => newGroup(() => (t.infoHash ? [t.infoHash] : [])),
  })

  /**
   * Looked up by id on every render rather than captured when the surface opened, so a switch
   * shows what the ENGINE now reports. A captured torrent would leave every toggle frozen at the
   * value it had when the menu opened, including after the change it just made.
   */
  const selectedTorrent = selectedId ? torrents.find((t) => t.id === selectedId) : undefined
  // the dock keys by file index; the page keys by torrent-and-index, since one map covers every row
  const dockSaving: Record<number, number> = {}
  selectedTorrent?.files?.forEach((_, i) => {
    const at = saving[savingKey(selectedTorrent.id, i)]
    if (at != null) dockSaving[i] = at
  })

  const menuTorrent = menu ? torrents.find((t) => t.id === menu.id) : undefined
  const optionsTorrent = optionsId ? torrents.find((t) => t.id === optionsId) : undefined
  // one of the two is open at a time, and both offer Copy magnet, so neither opens before this is read
  const shared = useShareableMagnet(menuTorrent ?? optionsTorrent)

  // Called synchronously from the click so showSaveFilePicker keeps the user gesture
  const onSave = useCallback((t: Torrent, fileIndex: number) => {
    const file = t.files?.[fileIndex]
    if (!file) return
    const key = savingKey(t.id, fileIndex)
    setSaving((s) => ({ ...s, [key]: 0 }))
    saveTorrentFileToDisk(client, Number(t.id), fileIndex, file.name, file.size, (f) => setSaving((s) => ({ ...s, [key]: f })))
      .catch((error) => { if (!isSaveCancelled(error)) showToast(intl.formatMessage({ id: 'Saving {name} failed', defaultMessage: 'Saving {name} failed' }, { name: file.name })) })
      .finally(() => setSaving((s) => { const { [key]: _, ...rest } = s; return rest }))
  }, [client, intl, showToast])

  const onSaveZip = useCallback((t: Torrent) => {
    if (!contentFiles(t.files).length) return
    const key = savingKey(t.id, -1)
    setSaving((s) => ({ ...s, [key]: 0 }))
    saveTorrentAsZipToDisk(client, Number(t.id), t.name, t.files ?? [], (f) => setSaving((s) => ({ ...s, [key]: f })))
      .catch((error) => { if (!isSaveCancelled(error)) showToast(intl.formatMessage({ id: 'Saving {name} failed', defaultMessage: 'Saving {name} failed' }, { name: t.name })) })
      .finally(() => setSaving((s) => { const { [key]: _, ...rest } = s; return rest }))
  }, [client, intl, showToast])

  const { supported: folderSupported, folder, permitted, pick: pickFolder, allow: allowFolder } = useFolder()


  /**
   * Where torrents go by default, and where each one goes when it says otherwise.
   *
   * Two places exist and only one of them can take a download, so this is qBittorrent's split
   * between a save path and an incomplete path rather than a free choice of directory. A torrent
   * headed for the folder still lands in browser storage first and moves when it finishes.
   */
  const [defaultLocation, setDefaultLocation] = useState<SaveLocation>(() => {
    try { return readGlobalDefault((k) => localStorage.getItem(k)) } catch { return 'browser' }
  })
  /**
   * How the list is shown: what is in it, in what order, and in which shape.
   *
   * Page preferences, so localStorage, read through validating readers that fall back rather than
   * trusting a stored value. The temporary flag deliberately does NOT live here: that is engine
   * state, owned by whichever tab won the election, and a second copy in this tab would be the
   * same drift that has already caused two bugs in this file's neighbours.
   */
  const [listFilter, setListFilter] = useState<ListFilter>(() => readFilter((k) => localStorage.getItem(k)))
  const [listView, setListView] = useState<ViewMode>(() => readView((k) => localStorage.getItem(k)))
  const [listSort, setListSort] = useState(() => readSort((k) => localStorage.getItem(k)))
  const [collapsedGroups, setCollapsedGroups] = useState<CollapsedGroups>(() => readCollapsed((k) => localStorage.getItem(k)))
  const [searchCollapsed, setSearchCollapsed] = useState<CollapsedGroups>(NO_COLLAPSED)
  const prevSearch = useRef('')

  const chooseFilter = (filter: ListFilter) => {
    setListFilter(filter)
    try { localStorage.setItem(LIST_FILTER_KEY, filter) } catch {}
  }
  const chooseView = (view: ViewMode) => {
    setListView(view)
    try { localStorage.setItem(LIST_VIEW_KEY, view) } catch {}
  }
  const chooseSort = (key: SortKey, dir: SortDir) => {
    setListSort({ key, dir })
    try { localStorage.setItem(LIST_SORT_KEY, writeSort(key, dir)) } catch {}
  }

  const [params, setParams] = useSearchParams()

  /*
   * `?torrent=<info hash>` opens that torrent when the page loads, which is how the embedded player
   * links back here for the release somebody is watching inside another site.
   *
   * An INFO HASH, resolved to a row id here rather than carried as one: a row id is a libtorrent
   * handle, a counter inside one session, so a link holding one would open a different torrent in the
   * next engine. See HomeOptions.
   *
   * IT FOLLOWS THE ROW ACROSS ITS ID CHANGING, which a one-shot version got wrong. A torrent the
   * engine has not reached yet is a `starting` row under `starting:<hash>`, and the same torrent a
   * second later is a live row under its handle. Selecting the first one silently loses the selection
   * when it becomes the second, and `StartingRow` draws no selected state anyway, so the page just
   * sat there looking untouched. Which of the two a link landed on was pure timing.
   *
   * `applied` is what keeps that from fighting the person: it holds the id this put there last, and
   * the moment the selection is anything else, because they closed the panel or opened another row,
   * this stops touching it.
   */
  const applied = useRef<string | null>(null)
  const wanted = params.get('torrent')
  useEffect(() => {
    if (!wanted) return
    const row = torrents.find((t) => sameInfoHash(t.infoHash, wanted))
    if (!row || applied.current === row.id) return
    // they have moved the selection since, so it is theirs now
    if (applied.current !== null && selectedId !== applied.current) return
    applied.current = row.id
    setSelectedId(row.id)
  }, [wanted, torrents, selectedId])

  // the same torrent from the player that opened this tab, or the add dialog for the link's magnet
  useTakeFromPlayer(wanted, () => {
    const magnet = decodeMagnetParam(params)
    if (magnet) setParams((now) => { now.set('add', magnet); return now }, { replace: true })
  })

  const chooseDefaultLocation = (location: SaveLocation) => {
    setDefaultLocation(location)
    try { localStorage.setItem(SAVE_LOCATION_KEY, location) } catch {}
  }
  // a default chosen in another tab is this one's too
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      // a null key is the whole storage cleared
      if (event.key !== SAVE_LOCATION_KEY && event.key !== null) return
      try { setDefaultLocation(readGlobalDefault((k) => localStorage.getItem(k))) } catch {}
    }
    window.addEventListener('storage', changed)
    return () => window.removeEventListener('storage', changed)
  }, [])

  const rateEditTorrent = rateEdit && typeof rateEdit.scope === 'object'
    ? torrents.find((t) => t.id === (rateEdit.scope as { torrent: string }).torrent)
    : undefined

  const applyRateEdit = (bytesPerSecond: number) => {
    if (!rateEdit) return
    const side = rateEdit.direction === 'down' ? 'down' : 'up'
    if (rateEdit.scope === 'session') client.setSessionLimits({ [side]: bytesPerSecond })
    else if (rateEditTorrent) client.setLimits(Number(rateEditTorrent.id), { [side]: bytesPerSecond })
    setRateEdit(null)
  }

  const locationOf = (t: Torrent) => ({
    intended: intendedLocation(t, defaultLocation),
    // the engine's own answer for where it is writing, rather than a remembered one
    current: currentLocation(t.stats?.savePath),
  })

  // moves asked for in this tab and made by the tab running the engine, by info hash, with where each goes
  const askedRef = useRef(new Map<string, SaveLocation>())
  useEffect(() => {
    for (const t of torrents) {
      const at = currentLocation(t.stats?.savePath)
      // a row with no engine report, as every row is while an engine starts, reads browser storage
      if (!t.infoHash || !t.stats || askedRef.current.get(t.infoHash) !== at) continue
      askedRef.current.delete(t.infoHash)
      showToast(movedNews(intl, t.name, at, folder?.name ?? ''))
    }
  }, [torrents, folder, showToast, intl])

  /**
   * Record where a torrent belongs, which the tab running the engine moves it to once it can.
   *
   * Recording always happens, so choosing a folder for something still downloading is remembered
   * and acted on when it finishes rather than refused.
   */
  const onSetLocation = (t: Torrent, location: SaveLocation) => {
    if (!t.infoHash) return
    client.setLocation(t.infoHash, location)
    askedRef.current.delete(t.infoHash)
    const { current } = locationOf(t)
    const readiness = moveReadiness({
      current,
      intended: location,
      complete: t.progress >= 1 && holdsChosen(t),
      folderReady: !!folder && permitted,
      leavesFilesOut: leavesFilesOut(t),
    })
    if (!readiness.move) {
      const waiting = pendingLabel(readiness, folder?.name, intl)
      if (waiting) showToast(waiting)
      return
    }
    // the tab running the engine says so once the move lands, and this one once its row reports the new place
    if (!client.owns()) askedRef.current.set(t.infoHash, location)
  }

  /**
   * Keep this download, or hand it back to the space Ripple may reclaim.
   *
   * Only ONE direction asks first. Keeping is safe and reversible. Un-keeping does not delete
   * anything now, it makes the bytes deletable LATER, without warning and without another click,
   * which is the kind of consequence a person cannot see coming from the switch itself.
   *
   * And only for a torrent the budget pass may then take ({@link reclaimable}): un-keeping any other changes its mark,
   * the Show filter and the pause once a player stops watching, so it asks nothing and says nothing.
   */
  const onSetKept = async (t: Torrent, kept: boolean) => {
    if (!t.infoHash) return
    const deletable = reclaimable(t)
    if (!kept && deletable) {
      const ok = await confirm({
        title: intl.formatMessage({ id: 'Let Ripple delete {name}?', defaultMessage: 'Let Ripple delete {name}?' }, { name: t.name }),
        body: intl.formatMessage({ id: 'Ripple may delete its files when storage runs low.', defaultMessage: 'Ripple may delete its files when storage runs low.' }),
        confirmLabel: intl.formatMessage({ id: 'Let Ripple delete it', defaultMessage: 'Let Ripple delete it' }),
      })
      if (!ok) return
    }
    client.setTemporary(t.infoHash, !kept)
    if (kept || deletable) showToast(kept
      ? intl.formatMessage({ id: '{name} is yours to keep', defaultMessage: '{name} is yours to keep' }, { name: t.name })
      : intl.formatMessage({ id: '{name} can be deleted to free space', defaultMessage: '{name} can be deleted to free space' }, { name: t.name }))
  }

  const savedToFolder = useSavedToFolder()
  useEffect(() => onFolderNews(showToast), [showToast])

  /**
   * What the option list needs to know about this torrent's surroundings.
   *
   * The folder grant has to be live, not merely remembered: a restored directory handle comes back
   * without permission, and a copy made under a grant the browser has since dropped is not one the
   * user can be told is still there.
   */
  /**
   * The add dialog: what is in this torrent, and which of it do you want.
   *
   * One flow for two arrivals. A magnet the person pasted or dropped only gets the dialog when they
   * have turned it on, since it is friction in front of a question whose answer is usually "all of
   * it". A magnet arriving from another site through `/add` always gets it, because that one is a
   * stranger's proposal and this is where they agree to it.
   *
   * The torrent is added `ephemeral` first either way. A magnet carries no file list, so the swarm
   * is the only place to get one, which means adding it before anything can be asked. Ephemeral is
   * what keeps that from being a decision: those bytes are a cache the engine may reclaim and the row
   * is not part of the library, so cancelling can drop it and changing nothing is genuinely nothing.
   */
  const pendingTorrent = pendingAdd && !pendingAdd.bytes
    ? torrents.find((t) => sameInfoHash(t.infoHash, pendingAdd.infoHash) && t.state !== 'missing')
    : undefined
  const pendingFiles = pendingAdd?.files ?? pendingTorrent?.files ?? []

  // The file list decides the default selection, so the choices cannot exist until it arrives. This
  // is also where the torrent is HELD: metadata is in by now, so from here on it would be fetching
  // pieces nobody has agreed to yet.
  useEffect(() => {
    const files = pendingAdd?.files ?? pendingTorrent?.files
    if (!pendingAdd || choices || !files?.length) return
    setChoices(defaultChoices({ files, location: defaultLocation }))
    // a .torrent's list was read in the page, and nothing of it is in the engine to hold
    if (!pendingTorrent) return
    heldRef.current = Number(pendingTorrent.id)
    pause(Number(pendingTorrent.id))
  }, [pendingAdd, choices, pendingTorrent, defaultLocation, pause])

  const closeAdd = useCallback((outcome: AddOutcome) => {
    // this answer is for its copies still waiting too: an Add has not reached the list yet, so asking one would hold
    // the torrent just added
    const current = pendingRef.current
    const answered = current?.infoHash
    current?.settle?.(outcome)
    const remaining: (QueuedMagnet | PendingAdd)[] = []
    for (const next of addQueue.current) {
      const ih = 'infoHash' in next ? next.infoHash : magnetInfoHash(next.magnet)
      if (sameInfoHash(ih, answered)) next.settle?.(outcome)
      else remaining.push(next)
    }
    addQueue.current = remaining
    pendingRef.current = null
    setPendingAdd(null)
    setChoices(null)
    heldRef.current = null
    // the link is spent once it has been answered, so a reload does not ask again
    if (params.get('add')) setParams(new URLSearchParams(), { replace: true })
    askNext()
  }, [params, setParams, askNext])

  const listRef = useRef(list)
  listRef.current = list
  const dropPendingEphemeral = useCallback((pending: PendingAdd | null) => {
    if (!pending || pending.bytes || !pending.infoHash) return
    // Only the cache entry this flow created: anything already theirs was never ours to remove. Read off the list and
    // removed by hash, because the list has the add up to one engine state (500 ms) before a row with its handle does;
    // when cancelled before that first list broadcast arrives, still drop it unless a non-ephemeral row already held it.
    const entry = listRef.current.find((e) => sameInfoHash(e.infoHash, pending.infoHash))
    if (entry ? entry.ephemeral : !torrentsRef.current.some((t) => sameInfoHash(t.infoHash, pending.infoHash) && !t.ephemeral)) {
      removeMissing(entry?.infoHash ?? pending.infoHash)
    }
  }, [removeMissing])

  const cancelAdd = useCallback(() => {
    if (!pendingAdd || pendingRef.current !== pendingAdd) return
    dropPendingEphemeral(pendingAdd)
    closeAdd('declined')
  }, [pendingAdd, dropPendingEphemeral, closeAdd])

  const confirmAdd = useCallback(() => {
    if (!pendingAdd || pendingRef.current !== pendingAdd || !choices) return
    if (pendingAdd.bytes) {
      // the engine has nothing of it yet, so the answers go with the add
      addTorrentFile(pendingAdd.bytes, {
        saveTo: choices.location, ...planFor(choices, pendingAdd.files ?? []),
        sequential: choices.sequential, paused: !choices.start, top: choices.topOfQueue,
      })
    } else {
      if (!pendingTorrent) return
      const handle = Number(pendingTorrent.id)
      // the same magnet without `ephemeral`, which is the gesture that promotes it into the library
      addMagnet(pendingAdd.magnet)
      client.setPlan(handle, planFor(choices, pendingTorrent.files ?? []))
      client.setFlags(handle, ...flagsFor(choices))
      if (pendingAdd.infoHash) client.setLocation(pendingAdd.infoHash, choices.location)
      if (choices.topOfQueue) client.moveInQueue(handle, 'top')
      // held since the file list arrived, so starting is an explicit step rather than the absence of one
      if (choices.start) resume(handle)
    }
    showToast(choices.start
      ? intl.formatMessage({ id: '{name} added', defaultMessage: '{name} added' }, { name: pendingAdd.name })
      : intl.formatMessage({ id: '{name} added, paused', defaultMessage: '{name} added, paused' }, { name: pendingAdd.name }))
    closeAdd('added')
  }, [pendingAdd, choices, pendingTorrent, addMagnet, addTorrentFile, client, resume, showToast, closeAdd, intl])

  // plugin `suggest` proposals go into the same add queue as external links, naming the plugin in the dialog
  const askNextRef = useRef(askNext)
  askNextRef.current = askNext
  const dropPendingRef = useRef(dropPendingEphemeral)
  dropPendingRef.current = dropPendingEphemeral
  useEffect(() => {
    const unregister = registerSuggester((proposal) => new Promise((resolve) => {
      if (torrentsRef.current.some((t) => sameInfoHash(t.infoHash, proposal.infoHash) && !t.ephemeral)) {
        resolve({ infoHash: proposal.infoHash, outcome: 'already' })
        return
      }
      const settle = (outcome: AddOutcome) => resolve({ infoHash: proposal.infoHash, outcome })
      addQueue.current.push(proposal.bytes
        ? { magnet: proposal.magnet, infoHash: proposal.infoHash, name: proposal.name, external: true, from: proposal.from, bytes: proposal.bytes, files: proposal.files, settle }
        : { magnet: proposal.magnet, external: true, from: proposal.from, settle })
      if (!pendingRef.current) askNextRef.current()
    }))
    return () => {
      unregister()
      const current = pendingRef.current
      if (current?.settle) dropPendingRef.current(current)
      current?.settle?.('declined')
      for (const next of addQueue.current.splice(0)) next.settle?.('declined')
    }
  }, [])

  /**
   * A torrent handed over by another site, through `/add`.
   *
   * Refused inside a frame, and not as a formality: a page that can size and position an invisible
   * iframe can put the Add button under the visitor's cursor while they believe they are clicking
   * something else. Nothing rendered inside the frame helps, because the page around it chooses what
   * is visible.
   */
  useEffect(() => {
    const magnet = params.get('add')
    if (!magnet) return
    if (isFramed()) { setParams(new URLSearchParams(), { replace: true }); return }
    let from: string | null = null
    try { from = document.referrer ? new URL(document.referrer).origin : null } catch { from = null }
    if (from === window.location.origin) from = null
    addQueue.current.push({ magnet, external: true, from })
    if (!pendingRef.current) askNext()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('add')])

  // a group link, read before anything updates the address, which drops the fragment, and spent once read whatever it
  // holds, so a reload asks nothing again
  useEffect(() => {
    if (!params.has('group')) return
    const fragment = window.location.hash.slice(1)
    setParams(new URLSearchParams(), { replace: true })
    receive(fragment)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // moved there, which the engine's save path says without a live grant, or copied there whole: removing never deletes there
  const inFolder = (t: Torrent) => locationOf(t).current === 'folder' || (!!folder && permitted && savedToFolder.has(copyKey(t)))

  const optionContext = (t: Torrent): TorrentOptionContext => {
    const { intended, current } = locationOf(t)
    return {
      savedToUserStorage: inFolder(t),
      intended,
      current,
      folderName: folder?.name,
      folderReady: !!folder && permitted,
      sessionLimits,
      groups: t.infoHash ? holding([t.infoHash]) : undefined,
    }
  }

  const [history, setHistory] = useState<number[]>([])
  // since the page opened, so neither the graph's window moving on nor a new engine lowers it
  const [peak, setPeak] = useState(0)
  useEffect(() => {
    const down = torrents.reduce((n, t) => n + t.down, 0)
    setHistory((prev) => [...prev.slice(-(HISTORY - 1)), down])
    setPeak((prev) => Math.max(prev, down))
  }, [torrents])

  /**
   * The same running history, per torrent.
   *
   * Rebuilt from the CURRENT list each tick rather than patched, so a torrent that is removed takes
   * its samples with it. Patching would leave the series of every torrent ever seen in this tab
   * accumulating behind the page for as long as it stays open.
   */
  const [rowRates, setRowRates] = useState<Record<string, { down: number[], up: number[] }>>({})
  useEffect(() => {
    setRowRates((prev) => {
      const next: Record<string, { down: number[], up: number[] }> = {}
      for (const t of torrents) {
        const was = prev[t.id]
        next[t.id] = {
          down: [...(was?.down ?? []).slice(-(ROW_HISTORY - 1)), t.down],
          up: [...(was?.up ?? []).slice(-(ROW_HISTORY - 1)), t.up],
        }
      }
      return next
    })
  }, [torrents])

  const totalDown = torrents.reduce((n, t) => n + t.down, 0)
  const totalUp = torrents.reduce((n, t) => n + t.up, 0)
  const speedRoom = room(speed, WIDEST_SPEEDS)

  /**
   * What the list actually shows, filtered and arranged, with the ORDER held still for a moment at a
   * time so rows do not swap under a cursor while somebody aims at a button.
   *
   * The stats strip above deliberately keeps counting `torrents`, not this. The strip describes what
   * this device's engine is doing and the list describes the library; a filter is a question about
   * the second one, and letting it silence the first would make the app report 0 B/s while it is
   * plainly downloading.
   */
  const { groups, expanded: storedExpanded, toggle: toggleExpandGroup, expand: expandGroup } = useExpandedGroups()
  const groupIconMap = useGroupAppearance()
  const listOrder = useListOrder()
  const filterCount = filterCounts(torrents)
  // the add field, when what it holds adds nothing, narrows the list instead
  const adds = readMagnets(input).length > 0
  const search = adds ? '' : input.trim()
  const { entries, groupOf: groupOfEntry, interaction } = useOrderedEntries(
    torrents, groups ?? [], listFilter, search, listSort.key, listSort.dir, listOrder,
  )
  const effectiveExpanded = useMemo(
    () => (search ? new Set(entries.flatMap((e) => (e.kind === 'group' ? [e.group.id] : []))) : storedExpanded),
    [search, entries, storedExpanded],
  )
  const entryGroups = cardEntryGroups(entries, listFilter, groupOfEntry)
  // Searching opens every category transiently without overwriting saved folded categories; a new search query resets
  // any manual folds made during the previous query.
  if (prevSearch.current !== search) {
    prevSearch.current = search
    if (searchCollapsed.size > 0) setSearchCollapsed(NO_COLLAPSED)
  }
  const collapsed = search ? searchCollapsed : collapsedGroups
  const toggleGroup = useCallback((group: ListGroup) => {
    if (search) {
      setSearchCollapsed((was) => toggleCollapsed(was, group))
      return
    }
    setCollapsedGroups((was) => {
      const next = toggleCollapsed(was, group)
      try {
        const serialized = writeCollapsed(next)
        if (serialized) localStorage.setItem(LIST_COLLAPSED_KEY, serialized)
        else localStorage.removeItem(LIST_COLLAPSED_KEY)
      } catch {}
      return next
    })
  }, [search])
  const visibleRows = useMemo(() => visibleEntryTorrents(entryGroups, collapsed, effectiveExpanded), [entryGroups, collapsed, effectiveExpanded])
  const tableBulkRows = useMemo(
    () => visibleEntryTorrents([{ group: null, rows: entries }], NO_COLLAPSED, effectiveExpanded),
    [entries, effectiveExpanded],
  )
  const bulk = useBulkSelection(listView === 'table' ? tableBulkRows : visibleRows)
  /**
   * The ticked torrents as the engine knows them NOW, read again after a confirmation: a handover
   * while it was open gives every row a new handle, and the ones picked are found by info hash.
   */
  const pickedNow = () => torrentsRef.current.filter((t) => pickable(t) && bulk.picked.has(t.infoHash))
  const pausePicked = () => { for (const t of toPause(pickedNow())) pause(Number(t.id)) }
  const resumePicked = () => { for (const t of toResume(pickedNow())) resume(Number(t.id)) }
  const startRows = useCallback((rows: readonly Torrent[]) => startMany(rows.flatMap((t) => (t.infoHash ? [t.infoHash] : []))), [startMany])
  const startPicked = () => startRows(toStart(pickedNow()))
  const pickedMagnets = useShareableMagnets(bulk.rows)
  const copyPicked = ({ magnets, left }: ShareableMagnets) => {
    const copied = magnetsCopied(magnets.length, left)
    if (magnets.length) copy(magnets.join('\n'), copied, intl.formatMessage({ id: 'Could not copy', defaultMessage: 'Could not copy' }))
    else showToast(copied)
  }
  const removePicked = async () => {
    const live = bulk.rows.filter((t) => t.state !== 'missing')
    if (live.length) {
      const ok = await confirm({
        title: intl.formatMessage({ id: '{count, plural, one {Remove {count} torrent?} other {Remove {count} torrents?}}', defaultMessage: '{count, plural, one {Remove {count} torrent?} other {Remove {count} torrents?}}' }, { count: bulk.rows.length }),
        ...removalWords(live, inFolder),
        tone: 'danger',
      })
      if (!ok) return
    }
    // Unticks each one sent. A row still reconnecting after a handover is sent nothing and stays ticked, so the bar
    // comes back with it rather than the removal looking done.
    for (const t of pickedNow()) { removeWithFiles(t); bulk.toggle(t) }
  }

  const anyPicked = bulk.rows.length > 0

  const putIn = useCallback((g: TorrentGroup, hashes: string[], put: boolean) => {
    void (put ? putInGroup : takeOutOfGroup)(g.id, hashes).then(() => showToast(put
      ? intl.formatMessage({ id: 'Added to {name}', defaultMessage: 'Added to {name}' }, { name: isolated(g.name) })
      : intl.formatMessage({ id: 'Taken out of {name}', defaultMessage: 'Taken out of {name}' }, { name: isolated(g.name) })))
  }, [intl, showToast])
  const moveBetweenGroups = useCallback((from: TorrentGroup | undefined, to: TorrentGroup, hash: string) => {
    void (async () => {
      await putInGroup(to.id, [hash])
      if (from && from.id !== to.id) await takeOutOfGroup(from.id, [hash])
      expandGroup(to.id)
      showToast(intl.formatMessage({ id: 'Added to {name}', defaultMessage: 'Added to {name}' }, { name: isolated(to.name) }))
    })()
  }, [expandGroup, intl, showToast])
  /** Asks for a name and icon and creates a group holding `hashes`, expanding it immediately. */
  const newGroup = useCallback((hashes: () => string[], afterCreate?: (id: string) => Promise<void> | void) => setNaming({
    title: intl.formatMessage({ id: 'New group', defaultMessage: 'New group' }),
    save: ({ name, icon, imageFile }) => {
      const held = hashes()
      void (async () => {
        const id = await createGroup(name, held, expandGroup)
        if (!id) return
        if (imageFile) await saveGroupImage(id, imageFile)
        else if (icon.kind === 'preset') await setGroupIcon(id, icon)
        await afterCreate?.(id)
        expandGroup(id)
        if (held.length) showToast(intl.formatMessage({ id: 'Added to {name}', defaultMessage: 'Added to {name}' }, { name: isolated(name) }))
      })()
    },
  }), [expandGroup, intl, showToast])
  const openEditGroup = useCallback((g: TorrentGroup) => setNaming({
    title: g.name,
    groupId: g.id,
    name: g.name,
    icon: groupIconMap.get(g.id) ?? DEFAULT_ICON,
    save: ({ name, icon, imageFile }) => {
      void (async () => {
        if (name !== g.name) await renameGroup(g.id, name)
        let staleKey: string | null = null
        if (imageFile) staleKey = (await saveGroupImage(g.id, imageFile)).previousKey
        else staleKey = await setGroupIcon(g.id, icon)
        if (staleKey) void forgetSyncedThumbnails([staleKey]).catch(() => {})
      })()
    },
  }), [groupIconMap])
  const holding = (hashes: string[]) => (groups ?? []).map((g) => {
    const held = torrentsIn(g)
    return { id: g.id, name: g.name, holds: hashes.every((hash) => held.has(hash)) }
  })
  const deleteShown = useCallback(async (g: TorrentGroup) => {
    const ok = await confirm({
      title: intl.formatMessage({ id: 'Delete {name}?', defaultMessage: 'Delete {name}?' }, { name: isolated(g.name) }),
      body: intl.formatMessage({ id: 'Its torrents stay in your list.', defaultMessage: 'Its torrents stay in your list.' }),
      confirmLabel: intl.formatMessage({ id: 'Delete group', defaultMessage: 'Delete group' }),
      tone: 'danger',
    })
    if (!ok) return
    const staleKey = await clearGroupAppearance(g.id)
    if (staleKey) void forgetSyncedThumbnails([staleKey]).catch(() => {})
    await deleteGroup(g.id)
  }, [confirm, intl])
  const addReceived = (linked: LinkedGroup) => {
    setReceived(null)
    void addLinkedGroup(linked, groups ?? [], client.importList).then((id) => {
      // its rows are not on this device, which a remembered state such as Downloading would hide
      if (id) { chooseFilter('all'); expandGroup(id) }
      showToast(intl.formatMessage({ id: '{name} added', defaultMessage: '{name} added' }, { name: isolated(linked.name) }))
    }, () => showToast(intl.formatMessage({ id: 'Could not add the group', defaultMessage: 'Could not add the group' })))
  }
  const activeGroupEntry = useMemo((): GroupEntry | undefined => {
    const gid = groupMenu?.id ?? groupOptionsId
    if (!gid) return undefined
    const g = groups?.find((one) => one.id === gid)
    if (!g) return undefined
    const held = torrentsIn(g)
    const raw = torrents.filter((t) => !!t.infoHash && held.has(t.infoHash))
    return { kind: 'group', key: `g:${g.id}`, group: g, summary: summarizeGroup(g, raw, listSort.key, listSort.dir) }
  }, [groupMenu?.id, groupOptionsId, groups, torrents, listSort.key, listSort.dir])
  const emptyMembers = useMemo<Torrent[]>(() => [], [])
  const activeGroupLink = useGroupLink(activeGroupEntry?.group.name ?? '', activeGroupEntry?.summary.members ?? emptyMembers)
  const copyGroupLink = ({ link, privateLeftOut: left }: { link: string | null, privateLeftOut: number }) => {
    if (!link) {
      showToast(intl.formatMessage({ id: 'Links hold up to {max} torrents', defaultMessage: 'Links hold up to {max} torrents' }, { max: MAX_LINK_TORRENTS }))
      return
    }
    copy(
      link,
      left
        ? intl.formatMessage({ id: '{count, plural, one {Link copied, {count} private torrent left out} other {Link copied, {count} private torrents left out}}', defaultMessage: '{count, plural, one {Link copied, {count} private torrent left out} other {Link copied, {count} private torrents left out}}' }, { count: left })
        : intl.formatMessage({ id: 'Link copied', defaultMessage: 'Link copied' }),
      intl.formatMessage({ id: 'Could not copy the link', defaultMessage: 'Could not copy the link' }),
    )
  }
  const buildGroupOptions = (entry: GroupEntry): OptionGroup[] => [{
    id: 'group',
    label: entry.group.name,
    typed: true,
    items: [
      ...(entry.summary.fetchable.length > 0 ? [{
        kind: 'action' as const,
        id: 'download-all',
        label: intl.formatMessage({ id: 'Download all', defaultMessage: 'Download all' }),
        run: () => startRows(entry.summary.fetchable),
      }] : []),
      ...(activeGroupLink?.count ? [{
        kind: 'action' as const,
        id: 'copy-link',
        label: intl.formatMessage({ id: 'Copy link', defaultMessage: 'Copy link' }),
        run: () => copyGroupLink(activeGroupLink),
      }] : []),
      {
        kind: 'action' as const,
        id: 'edit',
        label: intl.formatMessage({ id: 'Edit...', defaultMessage: 'Edit...' }),
        run: () => openEditGroup(entry.group),
      },
      {
        kind: 'action' as const,
        id: 'delete',
        label: intl.formatMessage({ id: 'Delete group', defaultMessage: 'Delete group' }),
        danger: true,
        run: () => { void deleteShown(entry.group) },
      },
    ],
  }]

  const activeDragRef = useRef<{ payload: DragPayload, key: string } | null>(null)
  const [draggingKey, setDraggingKey] = useState<string | null>(null)
  const [dropIndicator, setDropIndicator] = useState<DropIndicator>(null)
  const dragCtxRef = useRef({ entries, listOrder, groups, chooseSort, expandGroup, putIn, moveBetweenGroups, newGroup })
  dragCtxRef.current = { entries, listOrder, groups, chooseSort, expandGroup, putIn, moveBetweenGroups, newGroup }

  const onRowDragStart = useCallback((payload: DragPayload, key: string, e: ReactDragEvent) => {
    activeDragRef.current = { payload, key }
    setDraggingKey(key)
    setDropIndicator(null)
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData(ROW_DRAG_MIME, encodeDrag(payload))
    }
  }, [])

  const onRowDragEnd = useCallback(() => {
    activeDragRef.current = null
    setDraggingKey(null)
    setDropIndicator(null)
  }, [])

  const onRowDragOver = useCallback((targetKey: string, allowInto: boolean, e: ReactDragEvent) => {
    const active = activeDragRef.current
    const hasMime = !!e.dataTransfer?.types && [...e.dataTransfer.types].includes(ROW_DRAG_MIME)
    if (!active && !hasMime) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    if (active && active.key === targetKey) {
      setDropIndicator((prev) => (prev ? null : prev))
      return
    }
    const canInto = canDropInto(active?.payload ?? null, targetKey, allowInto)
    const place = computeDropPlace(e.clientY, (e.currentTarget as HTMLElement).getBoundingClientRect(), canInto)
    setDropIndicator((prev) => (prev?.targetKey === targetKey && prev.place === place ? prev : { targetKey, place }))
  }, [])

  const onRowDragLeave = useCallback((targetKey: string) => {
    setDropIndicator((prev) => (prev?.targetKey === targetKey ? null : prev))
  }, [])

  const onRowDrop = useCallback((targetKey: string, allowInto: boolean, e: ReactDragEvent) => {
    const payload = decodeDrag(e.dataTransfer?.getData(ROW_DRAG_MIME)) ?? activeDragRef.current?.payload
    if (!payload) return
    e.preventDefault()
    e.stopPropagation()
    activeDragRef.current = null
    setDraggingKey(null)
    setDropIndicator(null)

    const { entries: curEntries, listOrder: curOrder, groups: curGroups, chooseSort: setSort, expandGroup: expand, putIn: moveIn, moveBetweenGroups: transferGroup, newGroup: openNewGroup } = dragCtxRef.current
    const canInto = canDropInto(payload, targetKey, allowInto)
    const place = computeDropPlace(e.clientY, (e.currentTarget as HTMLElement).getBoundingClientRect(), canInto)
    const hasLooseHash = (hash: string) => curEntries.some((entry) => entry.kind === 'torrent' && entry.torrent.infoHash === hash)
    const placeNewGroup = async (targetHash: string, draggedHash: string, groupId: string) => {
      if (curOrder.top.length > 0) {
        const base = curOrder.top.includes(`t:${targetHash}`) ? curOrder.top : visibleTopKeys(curEntries)
        const nextTop = base.flatMap((key) => (key === `t:${targetHash}` ? [`g:${groupId}` as const] : key === `t:${draggedHash}` ? [] : [key]))
        await saveTopOrder(nextTop)
      }
      await saveGroupMemberOrder(groupId, [targetHash, draggedHash])
    }

    if (payload.kind === 'top') {
      if (targetKey.startsWith('t:') && place === 'into' && payload.key.startsWith('t:') && targetKey !== payload.key) {
        const draggedHash = payload.key.slice(2)
        const targetHash = targetKey.slice(2)
        if (hasLooseHash(targetHash)) openNewGroup(() => [targetHash, draggedHash], (id) => placeNewGroup(targetHash, draggedHash, id))
        return
      }
      if (targetKey.startsWith('g:') && place === 'into' && payload.key.startsWith('t:')) {
        const groupId = targetKey.slice(2)
        const targetGroup = curGroups?.find((g) => g.id === groupId)
        if (targetGroup) {
          moveIn(targetGroup, [payload.key.slice(2)], true)
          expand(groupId)
        }
        return
      }
      if (targetKey.startsWith('child:') && payload.key.startsWith('t:')) {
        const rest = targetKey.slice('child:'.length)
        const sep = rest.indexOf(':')
        const targetGroupId = sep > 0 ? rest.slice(0, sep) : ''
        const targetChildHash = sep > 0 ? rest.slice(sep + 1) : ''
        const targetGroup = curGroups?.find((g) => g.id === targetGroupId)
        const draggedHash = payload.key.slice(2)
        if (targetGroup && targetChildHash) {
          const parent = curEntries.find((entry): entry is GroupEntry => entry.kind === 'group' && entry.group.id === targetGroupId)
          const visibleMembers = parent ? groupMemberKeys(parent.summary) : []
          const existingMembers = curOrder.groups[targetGroupId]?.members ?? []
          const nextMembers = reorderKeys([...visibleMembers, draggedHash], existingMembers, draggedHash, targetChildHash, place === 'before' ? 'before' : 'after')
          moveIn(targetGroup, [draggedHash], true)
          expand(targetGroupId)
          void saveGroupMemberOrder(targetGroupId, nextMembers)
          setSort('custom', 'asc')
        }
        return
      }
      if ((targetKey.startsWith('g:') || targetKey.startsWith('t:')) && targetKey !== payload.key) {
        const nextTop = reorderKeys(visibleTopKeys(curEntries), curOrder.top, payload.key, targetKey as `g:${string}` | `t:${string}`, place === 'before' ? 'before' : 'after')
        void saveTopOrder(nextTop)
        setSort('custom', 'asc')
      }
      return
    }

    // payload.kind === 'member'
    if (targetKey.startsWith(`child:${payload.groupId}:`)) {
      const targetHash = targetKey.slice(`child:${payload.groupId}:`.length)
      if (targetHash === payload.infoHash) return
      const parent = curEntries.find((entry): entry is GroupEntry => entry.kind === 'group' && entry.group.id === payload.groupId)
      if (!parent) return
      const visibleMembers = groupMemberKeys(parent.summary)
      const existingMembers = curOrder.groups[payload.groupId]?.members ?? []
      const nextMembers = reorderKeys(visibleMembers, existingMembers, payload.infoHash, targetHash, place === 'before' ? 'before' : 'after')
      void saveGroupMemberOrder(payload.groupId, nextMembers)
      setSort('custom', 'asc')
      return
    }
    if (targetKey.startsWith('child:')) {
      const rest = targetKey.slice('child:'.length)
      const sep = rest.indexOf(':')
      const targetGroupId = sep > 0 ? rest.slice(0, sep) : ''
      const targetChildHash = sep > 0 ? rest.slice(sep + 1) : ''
      const targetGroup = curGroups?.find((g) => g.id === targetGroupId)
      if (targetGroup && targetChildHash) {
        const parent = curEntries.find((entry): entry is GroupEntry => entry.kind === 'group' && entry.group.id === targetGroupId)
        const visibleMembers = parent ? groupMemberKeys(parent.summary) : []
        const existingMembers = curOrder.groups[targetGroupId]?.members ?? []
        const nextMembers = reorderKeys([...visibleMembers, payload.infoHash], existingMembers, payload.infoHash, targetChildHash, place === 'before' ? 'before' : 'after')
        const fromGroup = curGroups?.find((g) => g.id === payload.groupId)
        transferGroup(fromGroup, targetGroup, payload.infoHash)
        void saveGroupMemberOrder(targetGroupId, nextMembers)
        setSort('custom', 'asc')
      }
      return
    }
    if (targetKey.startsWith('g:')) {
      const targetGroupId = targetKey.slice(2)
      if (targetGroupId === payload.groupId) return
      if (place === 'into') {
        const targetGroup = curGroups?.find((g) => g.id === targetGroupId)
        if (targetGroup) {
          const fromGroup = curGroups?.find((g) => g.id === payload.groupId)
          transferGroup(fromGroup, targetGroup, payload.infoHash)
        }
        return
      }
      const fromGroup = curGroups?.find((g) => g.id === payload.groupId)
      if (fromGroup) moveIn(fromGroup, [payload.infoHash], false)
      const nextTop = reorderKeys(visibleTopKeys(curEntries), curOrder.top, `t:${payload.infoHash}`, targetKey as `g:${string}`, place)
      void saveTopOrder(nextTop)
      setSort('custom', 'asc')
      return
    }
    if (targetKey.startsWith('t:')) {
      if (place === 'into') {
        const targetHash = targetKey.slice(2)
        if (targetHash !== payload.infoHash && hasLooseHash(targetHash)) {
          const fromGroup = curGroups?.find((g) => g.id === payload.groupId)
          openNewGroup(() => [targetHash, payload.infoHash], async (id) => {
            if (fromGroup) await takeOutOfGroup(fromGroup.id, [payload.infoHash])
            await placeNewGroup(targetHash, payload.infoHash, id)
          })
        }
        return
      }
      const fromGroup = curGroups?.find((g) => g.id === payload.groupId)
      if (fromGroup) moveIn(fromGroup, [payload.infoHash], false)
      const nextTop = reorderKeys(visibleTopKeys(curEntries), curOrder.top, `t:${payload.infoHash}`, targetKey as `t:${string}`, place === 'before' ? 'before' : 'after')
      void saveTopOrder(nextTop)
      setSort('custom', 'asc')
    }
  }, [])

  const pickedHashes = () => pickedNow().flatMap((t) => (t.infoHash ? [t.infoHash] : []))

  const toolbar = {
    filter: listFilter, onFilter: chooseFilter,
    onNewGroup: () => newGroup(() => []),
    sortKey: listSort.key, sortDir: listSort.dir, onSort: chooseSort,
    view: listView, onView: chooseView,
    counts: filterCount,
    picked: bulk.all ? 'all' as const : anyPicked ? 'some' as const : 'none' as const,
    canPick: bulk.canPick,
    onPickAll: bulk.toggleAll,
  }
  const clearPicked = bulk.clear
  useEffect(() => {
    if (!anyPicked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      // a field, a dialog and a menu each use Escape for themselves; a box in the list does not
      if (target instanceof Element && target.closest('textarea, input:not([type="checkbox"]), [role="dialog"], [role="menu"]')) return
      // claimed, so the detail panel's own Escape leaves it open: one press does one thing
      e.preventDefault()
      clearPicked()
    }
    // capture, so this runs before the detail panel's listener on the same window
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [anyPicked, clearPicked])
  const shownUniqueCount = useMemo(() => {
    const seen = new Set<string>()
    for (const e of entries) {
      if (e.kind === 'torrent') seen.add(e.torrent.infoHash ?? e.torrent.id)
      else for (const m of e.summary.members) seen.add(m.infoHash ?? m.id)
    }
    return seen.size
  }, [entries])
  const hiddenByFilter = Math.max(0, torrents.length - shownUniqueCount)

  const hasLive = torrents.some((t) => t.state !== 'missing')
  const quota = useQuota(hasLive)
  const syncState = useCloudBackup()
  const retrying = torrents.filter((t) => t.state === 'retrying').length
  /**
   * The persistent-storage ask, and the reason its key is folded into the reading below.
   *
   * A grant MOVES THE LIMIT on Firefox: from 12 GB to 3.97 TB on an 8.03 TB device, measured
   * 2026-09-01 on torrent.fkn.app. The poll would pick that up on its own within 30 seconds, so
   * without the fold the figure on screen is not wrong, only late. Folding `refreshKey` in is what
   * makes it change while the person is still looking at the button they just pressed.
   */
  const persistence = usePersistentStorage()
  const storage = useStorageUsage(`${torrents.length}:${persistence.refreshKey}`)
  const lowStorage = !!storage && storage.limitBytes - storage.usedBytes < LOW_STORAGE_BYTES

  /** What the storage warning can offer, and what its button does. See storage-relief.ts. */
  const relief = storageRelief({
    supported: folderSupported,
    folderName: folder?.name,
    permitted,
    defaultLocation,
  })

  /**
   * Choosing a folder and choosing to MOVE into it are one intent here, unlike in the footer.
   *
   * The footer keeps them apart deliberately: picking a folder there means "also keep a copy over
   * there", which is a reasonable thing to want. Pressed from a warning that downloads are about to
   * stop, it is not: a second copy of everything writes MORE bytes into the budget that just ran
   * out, so the button would make the reported problem worse. Hence both halves, and a label that
   * says both halves.
   *
   * The location is only set when a folder was actually picked, which is why `pick` reports it.
   */
  const takeRelief = async () => {
    if (relief.kind === 'choose') {
      if (await pickFolder()) chooseDefaultLocation('folder')
      return
    }
    if (relief.kind === 'allow') { await allowFolder(); return }
    // 'move': the folder is live and permitted, so flipping the default is the whole action. The
    // move effect re-reads `intended` every state tick, so torrents that are ALREADY finished drain
    // on the next tick rather than waiting for something new to complete.
    if (relief.kind === 'move') chooseDefaultLocation('folder')
  }

  /**
   * The ONE surface that announces the drop, chosen in `dropTarget` and read from nowhere else.
   *
   * Every surface below is driven by comparing against this, rather than by a flag of its own. That
   * is the whole point: the same defect shipped twice from three independent booleans, first the
   * page lighting alongside the magnet field, then the page lighting alongside the share panel's
   * box, because two of them were still reading one value. A single name cannot describe two places.
   *
   * The share dialog only draws a drop zone while it is waiting to be given a torrent; once one is
   * chosen it shows that torrent's link options instead, and there is nothing there for a drop to
   * land on, so the page-wide overlay is the right surface again. Note that the dialog is a modal,
   * so while it is asking it covers the field too, which is why it outranks it.
   */
  const createLabel = intl.formatMessage({ id: 'Create a torrent', defaultMessage: 'Create a torrent' })
  const settingsLabel = intl.formatMessage({ id: 'Settings', defaultMessage: 'Settings' })
  const downLimit = formatLimit(sessionLimits.down, intl)
  const upLimit = formatLimit(sessionLimits.up, intl)
  const downWords = intl.formatMessage({ id: '{limit} down', defaultMessage: '{limit} down' }, { limit: downLimit })
  const upWords = intl.formatMessage({ id: '{limit} up', defaultMessage: '{limit} up' }, { limit: upLimit })

  const target = dropTarget({
    dragging,
    overField: fieldDrag,
    shareOpen: embedOpen && !shareSubject,
  })

  return (
    <div css={style} data-drag={target === 'page' || undefined}>
      {/* Rendered here rather than beside the row that asks: the Modal shell portals to the body, so
          its position in the tree does not affect stacking, and one instance serves every caller. */}
      {confirmElement}
      {/* Both are rendered from here rather than from the row: only one may be open at a time, and
          each has to sit above every row rather than inside one. The menu is positioned against the
          viewport; the dialog portals to the body, one step below the broker frame. */}
      {menu && menuTorrent && shared && (
        <ContextMenu
          groups={[...buildTorrentOptions(menuTorrent, optionActions(menuTorrent, shared.magnet), optionContext(menuTorrent)), ...rowMenuGroups(rowPlugins, menuTorrent.infoHash)]}
          at={menu.at}
          label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: menuTorrent.name })}
          onClose={() => setMenu(null)}
        />
      )}
      {optionsTorrent && shared && (
        <TorrentOptionsDialog
          title={optionsTorrent.name}
          groups={[...buildTorrentOptions(optionsTorrent, optionActions(optionsTorrent, shared.magnet), optionContext(optionsTorrent)), ...rowMenuGroups(rowPlugins, optionsTorrent.infoHash)]}
          onClose={() => setOptionsId(null)}
        />
      )}
      {groupMenu && activeGroupEntry && (activeGroupEntry.summary.members.length === 0 || activeGroupLink) && (
        <ContextMenu
          groups={buildGroupOptions(activeGroupEntry)}
          at={groupMenu.at}
          label={intl.formatMessage({ id: 'Options for {name}', defaultMessage: 'Options for {name}' }, { name: activeGroupEntry.group.name })}
          onClose={() => setGroupMenu(null)}
        />
      )}
      {groupOptionsId && activeGroupEntry && (activeGroupEntry.summary.members.length === 0 || activeGroupLink) && (
        <TorrentOptionsDialog
          title={activeGroupEntry.group.name}
          groups={buildGroupOptions(activeGroupEntry)}
          onClose={() => setGroupOptionsId(null)}
        />
      )}
      <div className="drop"><span>{intl.formatMessage({ id: 'Drop a .torrent or a magnet link to add it', defaultMessage: 'Drop a .torrent or a magnet link to add it' })}</span></div>
      <header data-searching={searching || fieldMenuOpen || undefined} data-folded={folded || undefined}>
        {/* the way home from every other page, so it is one here too rather than a word that is a
            link on the download page and dead text on this one */}
        <span className="brand">
          <Link className="logo" to="/" aria-label={WORDMARK}>
            <img src={LOGO} alt="" width={553} height={561}/>
            <span className="wordmark">{WORDMARK}</span>
          </Link>
          <PoweredByFkn
            className="powered"
            label={intl.formatMessage({ id: 'Powered by FKN', defaultMessage: 'Powered by FKN' })}
            linkLabel={intl.formatMessage({ id: 'How it works', defaultMessage: 'How it works' })}
            href="https://docs.fkn.dev/user/"
          />
        </span>
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault()
            if (commitMagnet(input)) setInput('')
          }}
        >
          {/**
            * The pill takes a dropped .torrent as well as typed text, and says so.
            *
            * The handlers sit on the WRAPPER rather than on the input, so the whole control is the
            * target and the highlight is the whole control. It stops the drop propagating so the
            * page-wide overlay does not light up over a target that is already lit; `endDrag` is
            * what keeps the window's depth count honest across that, since its own drop listener
            * never runs.
            */}
          <div
            className="field"
            data-drop={target === 'field' || undefined}
            data-held={!!input || undefined}
            onDragEnter={() => { if (!storageUnavailable) setFieldDrag(true) }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={() => setFieldDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              endDrag()
              if (!storageUnavailable) acceptDrop(e.dataTransfer)
            }}
          >
            {/* drawn over the start of the text, which is all a phone shows of it while it is folded */}
            <Search className="glyph" aria-hidden="true"/>
            <input
              ref={fieldRef}
              value={input}
              // each entry in its own direction, and the placeholder in the page's, which auto with nothing typed is not
              dir={input ? 'auto' : undefined}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setInput('') }}
              placeholder={intl.formatMessage({ id: 'Add a magnet link, or search', defaultMessage: 'Add a magnet link, or search' })}
              aria-label={intl.formatMessage({ id: 'Add a magnet link, or search', defaultMessage: 'Add a magnet link, or search' })}
              spellCheck={false}
              disabled={storageUnavailable}
            />

            {/* only while there is something to clear, the way a search field does it */}
            {input && (
              <button
                className="icon clear"
                type="button"
                onMouseDown={keepFocus}
                {...hint(intl.formatMessage({ id: 'Clear', defaultMessage: 'Clear' }))}
                aria-label={intl.formatMessage({ id: 'Clear', defaultMessage: 'Clear' })}
                onClick={() => { setInput(''); fieldRef.current?.focus() }}
              >
                <X/>
              </button>
            )}

            <span className="sep" aria-hidden="true"/>
            <AddFieldButtons text={input} onMouseDown={keepFocus} onMenuOpenChange={setFieldMenuOpen}/>

            {/**
              * The only way to pick a .torrent that is not a drag.
              *
              * There was none: the file could be dropped or handed over by the OS through the
              * installed app, and a browser that cannot drag (a touch screen, a file manager the
              * page cannot reach) had no route at all. A label wrapping an input is what gives it
              * the native picker without a click handler.
              */}
            <label
              className="icon file-button"
              onMouseDown={keepFocus}
              {...hint(intl.formatMessage({ id: 'Open a .torrent file', defaultMessage: 'Open a .torrent file' }))}
              aria-label={intl.formatMessage({ id: 'Open a .torrent file', defaultMessage: 'Open a .torrent file' })}
              aria-disabled={storageUnavailable || undefined}
            >
              <FilePlus/>
              <input
                type="file"
                accept=".torrent,application/x-bittorrent"
                multiple
                disabled={storageUnavailable}
                onChange={(e) => {
                  const picked = e.currentTarget.files
                  if (picked?.length) void addTorrentFiles(picked)
                  // cleared so choosing the SAME file again still fires a change event
                  e.currentTarget.value = ''
                }}
              />
            </label>

            {/* disabled on an empty field rather than accepting the click and doing nothing with it */}
            <button
              className="icon go"
              type="submit"
              onMouseDown={keepFocus}
              {...hint(intl.formatMessage({ id: 'Add this magnet link', defaultMessage: 'Add this magnet link' }))}
              aria-label={intl.formatMessage({ id: 'Add', defaultMessage: 'Add' })}
              disabled={storageUnavailable || !adds}
            >
              <Plus/>
            </button>
          </div>
        </form>
        <HeaderButtons/>
        {create.supported && (
          <button
            className="tool create"
            type="button"
            aria-label={createLabel}
            aria-expanded={createOpen}
            {...hint(wordless ? createLabel : null)}
            onClick={() => (createOpen ? closeCreate() : setCreateOpen(true))}
          >
            <SquarePen/>
            <span>{createLabel}</span>
          </button>
        )}
        <Link className="tool settings" to={getRoutePath(Route.SETTINGS)} aria-label={settingsLabel} {...hint(settingsLabel)}><Gear/></Link>
        <AccountWidget onToast={showToast}/>
      </header>

      {embedOpen && (
        <ShareLinkDialog
          torrent={shareSubject}
          dragging={target === 'share'}
          onMagnet={shareMagnet}
          onFiles={shareFiles}
          onClear={() => setShareSubject(null)}
          onClose={closeEmbed}
          onToast={showToast}
        />
      )}

      {createOpen && (
        <CreateTorrentDialog
          create={create}
          onClose={closeCreate}
          onShare={(subject) => { closeCreate(); openEmbed(subject) }}
          onToast={showToast}
        />
      )}

      {waitingSources.length > 0 && (
        <div className="storage-warning surface" role="status">
          <strong>
            {intl.formatMessage({ id: '{count, plural, one {A torrent you created needs access to its files again} other {{count} torrents you created need access to their files again}}', defaultMessage: '{count, plural, one {A torrent you created needs access to its files again} other {{count} torrents you created need access to their files again}}' }, { count: waitingSources.length })}
          </strong>
          <div className="actions">
            {/* One button per source, and one press each. `requestPermission` consumes the transient
                activation, so a loop over several folders shows one prompt and silently fails for the
                rest, which reads as a button that does nothing. */}
            {waitingSources.map(({ entry, name }) => (
              <button
                key={entry.infoHash}
                type="button"
                onClick={() => {
                  void allowSource(entry.infoHash).then((ok) => {
                    if (ok) showToast(intl.formatMessage({ id: 'Sharing {name} again', defaultMessage: 'Sharing {name} again' }, { name: entry.name ?? name }))
                    else showToast(intl.formatMessage({ id: 'Ripple still cannot read {name}', defaultMessage: 'Ripple still cannot read {name}' }, { name }))
                  })
                }}
              >
                {intl.formatMessage({ id: 'Allow {name}', defaultMessage: 'Allow {name}' }, { name })}
              </button>
            ))}
          </div>
        </div>
      )}

      {storageUnavailable && (
        <div className="storage-warning surface" role="alert">
          <strong>{intl.formatMessage({ id: 'Ripple can\'t run in this window', defaultMessage: 'Ripple can\'t run in this window' })}</strong>
          <span>{intl.formatMessage({ id: 'Open Ripple in a normal window, with site storage allowed.', defaultMessage: 'Open Ripple in a normal window, with site storage allowed.' })}</span>
        </div>
      )}

      {workerError && (
        <div className="storage-warning surface" role="alert">
          <strong>{intl.formatMessage({ id: 'The download engine stopped', defaultMessage: 'The download engine stopped' })}</strong>
          <button onClick={() => window.location.reload()}>{intl.formatMessage({ id: 'Reload', defaultMessage: 'Reload' })}</button>
        </div>
      )}

      {offline && !storageUnavailable && !workerError && (
        <div className="storage-warning surface offline" role="status">
          <strong>{intl.formatMessage({ id: 'You\'re offline', defaultMessage: 'You\'re offline' })}</strong>
        </div>
      )}

      {!offline && retrying > 0 && !workerError && (
        <div className="storage-warning surface offline" role="status">
          <strong>{intl.formatMessage({ id: '{count, plural, one {A download hit a problem, retrying} other {{count} downloads hit a problem, retrying}}', defaultMessage: '{count, plural, one {A download hit a problem, retrying} other {{count} downloads hit a problem, retrying}}' }, { count: retrying })}</strong>
        </div>
      )}

      {storage && lowStorage && !storageUnavailable && (
        <StorageWarning
          storage={storage}
          relief={relief}
          onAct={() => void takeRelief()}
          persist={persistence}
          onAskPersist={() => void persistence.request()}
        />
      )}

      {/* The strip is drawn before the first torrent too, with the VPN's switch alone: a header item more would
          put the header on two rows at the commonest laptop widths. */}
      {(torrents.length > 0 || vpnOffAvailable()) && (
        <section className="stats surface">
          <div className="readouts">
            {torrents.length > 0 && (
              <ReadoutLine>
                <SpeedStat dir="down" big bps={totalDown} room={speedRoom} label={intl.formatMessage({ id: 'Download#a speed', defaultMessage: 'Download', description: 'a speed' })}/>
                <SpeedStat dir="up" bps={totalUp} room={speedRoom} label={intl.formatMessage({ id: 'Upload#a speed', defaultMessage: 'Upload', description: 'a speed' })}/>
                {/* Which direction this is has to be said: `history` samples download alone, so a library that is
                    purely seeding shows a flat 0 here. */}
                <div className="stat rate">
                  <label>{intl.formatMessage({ id: 'Peak down', defaultMessage: 'Peak down' })}</label>
                  <strong data-room={speedRoom}>{speed(peak)}</strong>
                </div>
              </ReadoutLine>
            )}
            {/* the VPN's switch first, where Active was, so it is never past the end of a line that scrolls */}
            <ReadoutLine>
              <VpnSwitch reachable={reachable} transport={transport} quota={quota}/>
              {torrents.length > 0 && (
                <>
                  {/* with the VPN off nothing passes through the relay, so nobody can dial in through it, and the DHT is off */}
                  {transport !== 'direct' && <ConnectionStat reachable={reachable} inboundNow={inboundNow}/>}
                  {transport !== 'direct' && dhtNodes !== null && <DhtStat nodes={dhtNodes}/>}
                  {storage && <StorageStat storage={storage} low={lowStorage}/>}
                  {quota && <QuotaStat quota={quota}/>}
                  <SyncStat state={syncState}/>
                </>
              )}
            </ReadoutLine>
          </div>
          {torrents.length > 0 && <SpeedGraph history={history}/>}
        </section>
      )}

      {torrents.length > 0 && <ListToolbar {...toolbar}/>}

      <main {...interaction}>
        {sampleOffered && torrents.length === 0 && <SampleOffer onAnswer={answerSample}/>}
        {torrents.length === 0
          ? (
            <div className="empty">
              <h1>{intl.formatMessage({ id: 'Download. Stream.', defaultMessage: 'Download. Stream.' })}<br/><em>{intl.formatMessage({ id: 'In your browser.', defaultMessage: 'In your browser.' })}</em></h1>
              <div className="hints">
                <span>{intl.formatMessage({ id: 'Paste a magnet link above', defaultMessage: 'Paste a magnet link above' })}</span>
                <span>{intl.formatMessage({ id: 'Or drop a magnet or a .torrent anywhere', defaultMessage: 'Or drop a magnet or a .torrent anywhere' })}</span>
              </div>
            </div>
          )
          : entries.length === 0
            ? (
              /**
               * A filter matched nothing. Emphatically NOT the hero above, which says "Ripple is a
               * torrent client that runs entirely in your browser" and would tell somebody with a
               * full library that it is empty. It names the filter as the reason and offers the way
               * back, because a control the person set two seconds ago is still the least obvious
               * thing on the page once the list it emptied is gone.
               *
               * Not while a row is still starting before the engine's first report: its state is not
               * known yet, so a filter remembered from the last visit would read empty for the second
               * after every reload. The engine restores the library before that report, so a row still
               * starting after it may never start, and must not blank the list for the session.
               */
              (reachable || !torrents.some((t) => t.state === 'starting')) && <div className="empty">
                {intl.formatMessage({ id: 'Nothing matches this filter.', defaultMessage: 'Nothing matches this filter.' })}
                <div className="hints">
                  <button type="button" className="link" onClick={() => { chooseFilter('all'); setInput('') }}>
                    {intl.formatMessage({ id: 'Show everything', defaultMessage: 'Show everything' })}
                  </button>
                </div>
              </div>
            )
          : listView === 'table'
            ? (
              <TorrentTable
                entries={entries}
                expandedGroups={effectiveExpanded}
                groupIcons={groupIconMap}
                onToggleExpand={toggleExpandGroup}
                onGroupOptions={onGroupOptions}
                transport={transport}
                sortKey={listSort.key} sortDir={listSort.dir} onSort={chooseSort}
                selectedId={selectedId}
                onSelect={onSelect}
                onOptions={onOptions}
                picked={bulk.picked}
                onPick={bulk.toggle}
                draggingKey={draggingKey}
                dropIndicator={dropIndicator}
                onRowDragStart={onRowDragStart}
                onRowDragEnd={onRowDragEnd}
                onRowDragOver={onRowDragOver}
                onRowDragLeave={onRowDragLeave}
                onRowDrop={onRowDrop}
              />
            )
            : (
              <CardList
                groups={entryGroups}
                collapsed={collapsed}
                onToggleGroup={toggleGroup}
                row={(entry) => {
                  const renderRow = (t: Torrent, key: string, dragKey: string, parentGroupId?: string) => (
                    <TorrentRow
                      key={key}
                      t={t}
                      saving={saving}
                      onToggle={onToggle}
                      onSave={onSave}
                      onSaveZip={onSaveZip}
                      onStart={onStart}
                      onOptions={onOptions}
                      selected={t.id === selectedId}
                      onSelect={onSelect}
                      checked={!!t.infoHash && bulk.picked.has(t.infoHash)}
                      onPick={bulk.toggle}
                      savedToUserStorage={!!folder && permitted && savedToFolder.has(copyKey(t))}
                      rates={rowRates[t.id]}
                      transport={transport}
                      dragKey={dragKey}
                      parentGroupId={parentGroupId}
                      dropPlace={dropIndicator?.targetKey === dragKey ? dropIndicator.place : undefined}
                      isDragging={draggingKey === dragKey}
                      onRowDragStart={onRowDragStart}
                      onRowDragEnd={onRowDragEnd}
                      onRowDragOver={onRowDragOver}
                      onRowDragLeave={onRowDragLeave}
                      onRowDrop={onRowDrop}
                    />
                  )
                  if (entry.kind === 'torrent') return renderRow(entry.torrent, entry.torrent.id, entry.key)
                  const { group: g, summary } = entry
                  const expanded = effectiveExpanded.has(g.id)
                  return (
                    <GroupRow
                      key={entry.key}
                      group={g}
                      summary={summary}
                      icon={groupIconMap.get(g.id) ?? DEFAULT_ICON}
                      expanded={expanded}
                      onToggleExpand={toggleExpandGroup}
                      onStartMany={startRows}
                      onOptions={onGroupOptions}
                      dropPlace={dropIndicator?.targetKey === entry.key ? dropIndicator.place : undefined}
                      isDragging={draggingKey === entry.key}
                      onRowDragStart={onRowDragStart}
                      onRowDragEnd={onRowDragEnd}
                      onRowDragOver={onRowDragOver}
                      onRowDragLeave={onRowDragLeave}
                      onRowDrop={onRowDrop}
                    >
                      {expanded && summary.members.map((m) => renderRow(m, `group:${g.id}:${m.id}`, `child:${g.id}:${m.infoHash ?? m.id}`, g.id))}
                    </GroupRow>
                  )
                }}
              />
            )}
        {/**
          * Hiding is only honest if it says so. A persisted filter outlives the session that set it,
          * so without this a person comes back to a library missing gigabytes they can see in the
          * storage readout and cannot see in the list.
          */}
        {/* not while the list is empty: the empty state above already explains it and offers the
            same way back, and two Show buttons is one too many */}
        {hiddenByFilter > 0 && entries.length > 0 && (
          <div className="hidden-note" role="status">
            {intl.formatMessage({ id: '{count, plural, one {{count} torrent hidden} other {{count} torrents hidden}}', defaultMessage: '{count, plural, one {{count} torrent hidden} other {{count} torrents hidden}}' }, { count: hiddenByFilter })}
            <button type="button" className="link" onClick={() => chooseFilter('all')}>{intl.formatMessage({ id: 'Show#verb', defaultMessage: 'Show', description: 'verb' })}</button>
          </div>
        )}
      </main>

      {anyPicked && (
        <BulkBar
          count={bulk.rows.length}
          infoHashes={pickedHashes()}
          canPause={toPause(bulk.rows).length > 0}
          canResume={toResume(bulk.rows).length > 0}
          finished={bulk.rows.every(finished)}
          canDownload={toStart(bulk.rows).length > 0}
          onDownload={startPicked}
          onCopyMagnets={pickedMagnets ? () => copyPicked(pickedMagnets) : undefined}
          groups={holding(bulk.rows.map((t) => t.infoHash))}
          onGroup={(id, put) => { const g = groups?.find((one) => one.id === id); if (g) putIn(g, pickedHashes(), put) }}
          onNewGroup={() => newGroup(pickedHashes)}
          onPause={pausePicked}
          onResume={resumePicked}
          onRemove={() => { void removePicked() }}
          onClear={bulk.clear}
        />
      )}

      {/* Docked below the list rather than inside a row: one place, one subject, and the engine
          computes peers and trackers only while something is selected. A torrent that vanishes
          from the library takes the dock with it rather than leaving a panel about nothing. */}
      {selectedTorrent && (
        <TorrentDetailDock
          t={selectedTorrent}
          handle={Number.isFinite(Number(selectedTorrent.id)) ? Number(selectedTorrent.id) : null}
          saving={dockSaving}
          onSave={(i) => onSave(selectedTorrent, i)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {pendingAdd && (
        <AddTorrentDialog
          key={pendingAdd.infoHash}
          name={pendingAdd.name}
          from={pendingAdd.from}
          external={pendingAdd.external}
          files={pendingFiles}
          choices={choices ?? defaultChoices({ files: pendingFiles, location: defaultLocation })}
          onChoices={setChoices}
          folderName={folder?.name}
          folderReady={!!folder && permitted}
          // the same figures the warning above gets, so "this will not fit" can be said where the
          // decision is made rather than after the download has stopped
          storage={storage}
          persist={persistence}
          onAskPersist={() => void persistence.request()}
          onConfirm={confirmAdd}
          onCancel={cancelAdd}
          // switching the step off is offered only for their OWN adds: a setting that could silence
          // the consent step for links from anywhere is not one worth having
          onNeverAsk={pendingAdd.external ? undefined : () => {
            chooseAddDialog(false)
            // the setting is for their own adds, so a waiting link is still asked about
            for (const next of addQueue.current.splice(0)) {
              if (next.external) addQueue.current.push(next)
              else if (!('infoHash' in next)) addMagnet(next.magnet)
              else if (next.bytes) addTorrentFile(next.bytes)
            }
          }}
        />
      )}

      {naming && (
        <GroupNameDialog
          title={naming.title}
          groupId={naming.groupId}
          name={naming.name}
          icon={naming.icon}
          onCancel={() => setNaming(null)}
          onSave={(result) => { setNaming(null); naming.save(result) }}
        />
      )}

      {received && (
        <GroupLinkDialog
          name={received.name}
          count={received.torrents.length}
          onCancel={() => setReceived(null)}
          onAdd={() => addReceived(received)}
        />
      )}

      {rateEdit && (rateEdit.scope === 'session' || rateEditTorrent) && (
        <RateLimitDialog
          title={rateEdit.direction === 'down'
            ? (rateEdit.scope === 'session' ? intl.formatMessage({ id: 'Total download rate limit', defaultMessage: 'Total download rate limit' }) : intl.formatMessage({ id: 'Download rate limit', defaultMessage: 'Download rate limit' }))
            : (rateEdit.scope === 'session' ? intl.formatMessage({ id: 'Total upload rate limit', defaultMessage: 'Total upload rate limit' }) : intl.formatMessage({ id: 'Upload rate limit', defaultMessage: 'Upload rate limit' }))}
          subject={rateEdit.scope === 'session'
            ? intl.formatMessage({ id: 'All torrents', defaultMessage: 'All torrents' })
            : rateEditTorrent?.name}
          value={rateEdit.scope === 'session'
            ? (rateEdit.direction === 'down' ? sessionLimits.down : sessionLimits.up)
            : (rateEdit.direction === 'down' ? rateEditTorrent?.downloadLimit : rateEditTorrent?.uploadLimit)}
          // only for a torrent: the session limit cannot be overridden by one, and saying so is the
          // difference between a control that looks broken and one that explains itself
          note={rateEdit.scope === 'session'
            ? null
            : limitNote(
              rateEdit.direction === 'down' ? rateEditTorrent?.downloadLimit : rateEditTorrent?.uploadLimit,
              rateEdit.direction === 'down' ? sessionLimits.down : sessionLimits.up,
              intl,
            )}
          onCancel={() => setRateEdit(null)}
          onApply={applyRateEdit}
        />
      )}

      <footer>
        <a href="https://fkn.app" target="_blank" rel="noreferrer">{intl.formatMessage({ id: 'Powered by FKN', defaultMessage: 'Powered by FKN' })}</a>
        <Link to="/legal">{intl.formatMessage({ id: 'Legal', defaultMessage: 'Legal' })}</Link>
        <Link to="/privacy">{intl.formatMessage({ id: 'Privacy', defaultMessage: 'Privacy' })}</Link>
        <a
          className="build"
          href={`https://github.com/banou26/ripple/commit/${__COMMIT_HASH__}`}
          target="_blank"
          rel="noreferrer"
          {...hint(intl.formatMessage({ id: 'commit {hash}', defaultMessage: 'commit {hash}' }, { hash: __COMMIT_HASH__ }))}
        >
          {BUILD}
        </a>
        <div className="controls">
          {/* qBittorrent keeps the global limits in its status bar, reachable in one click from
              wherever you are, rather than buried in a preferences tree. Same here. */}
          <div className="folder">
            <span>{intl.formatMessage({ id: 'Speed', defaultMessage: 'Speed' })}</span>
            <button
              className={sessionLimits.down > 0 ? 'on' : undefined}
              aria-label={downWords}
              data-arrow={intl.formatMessage({ id: '↓ {speed}', defaultMessage: '↓ {speed}' }, { speed: downLimit })}
              onClick={() => setRateEdit({ scope: 'session', direction: 'down' })}
            >
              <span>{downWords}</span>
            </button>
            <button
              className={sessionLimits.up > 0 ? 'on' : undefined}
              aria-label={upWords}
              data-arrow={intl.formatMessage({ id: '↑ {speed}', defaultMessage: '↑ {speed}' }, { speed: upLimit })}
              onClick={() => setRateEdit({ scope: 'session', direction: 'up' })}
            >
              <span>{upWords}</span>
            </button>
          </div>
        </div>
      </footer>

      {toast && createPortal(<div role="status" className="toast" css={toastStyle}>{toast}</div>, document.body)}
    </div>
  )
}

export default Home
