import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import type { Reachability } from '../torrent/client'
import type { QuotaStatus } from '../torrent/use-quota'
import type { StorageUsage } from '../torrent/use-storage-usage'
import type { SyncReason, SyncState } from '../torrent/use-cloud-backup'

import { Clock, Download, FilePlus, Folder, Link2, MoreHorizontal, Pause, Play, PlayCircle, Plus, X } from 'react-feather'

import { magnetInfoHash } from '../torrent/magnet'
import { isActive, useTorrents } from '../torrent/use-torrents'
import { useFolder } from '../torrent/use-folder'
import { useQuota } from '../torrent/use-quota'
import { LOW_STORAGE_BYTES, useStorageUsage } from '../torrent/use-storage-usage'
import { storageRelief } from '../torrent/storage-relief'
import { StorageWarning } from '../components/storage-warning'
import { useCloudBackup } from '../torrent/use-cloud-backup'
import { isSaveCancelled, saveTorrentAsZipToDisk, saveTorrentFileToDisk } from '../torrent/save-file'
import { syncTorrentToDirectory } from '../torrent/sync'
import { moveTorrentFiles } from '../torrent/move-files'
import { describeAddRequest } from './add-request'
import { AddTorrentDialog } from '../components/add-torrent-dialog'
import {
  ADD_DIALOG_KEY, defaultChoices, dialogEnabled, flagsFor, planFor,
} from '../torrent/add-options'
import type { AddChoices } from '../torrent/add-options'
import {
  currentLocation, intendedLocation, moveReadiness, pendingLabel, readGlobalDefault, SAVE_LOCATION_KEY,
} from '../torrent/save-location'
import type { SaveLocation } from '../torrent/library'
import { ownsItsDirectory } from '../torrent/library'
import { RateLimitDialog } from '../components/rate-limit-dialog'
import { NO_LIMITS, formatLimit, isLimit, limitNote } from '../torrent/rate-limits'
import type { RateLimits } from '../torrent/rate-limits'
import {
  BORDER, BORDER_INTERACTIVE, BORDER_STRONG,
  CHART_PRIMARY, CHART_PRIMARY_FILL, CHART_SECONDARY,
  CONTROL_ACTIVE_BG, CONTROL_BG, CONTROL_HOVER_BG,
  DANGER, ELEVATED_BG, EMPHASIS, FOCUS_RING, HOVER_WASH, OK,
  PAGE_BG, SUNKEN_BG, SURFACE_BG,
  TEXT, TEXT_FAINT, TEXT_MUTED, WARN,
} from '../theme'
import { pickVideoFile, watchHref } from '../torrent/watch'
import { forgetThumbnail } from '../torrent/thumbnail-store'
import { useThumbnail, useThumbnailGeneration } from '../torrent/use-thumbnails'
import { getHumanReadableByteString } from '../utils/bytes'
import { isAppInstalled, setupHandlers } from '../utils/pwa'
import { useConfirm } from '../components/confirm-dialog'
import { ShareLinkDialog } from '../components/share-link-dialog'
import { TorrentDetailDock } from './torrent-detail'
import { VpnStat } from '../components/vpn-stat'
import { AccountWidget } from '../components/account-widget'
import { ContextMenu } from '../components/menu'
import type { MenuPosition } from '../components/menu'
import { TorrentOptionsDialog } from '../components/torrent-options-dialog'
import { dropTarget } from './drop-target'
import { badgeRules } from './badge-style'
import { STATE_LABEL, relativeDay, speed } from './torrent-format'
import { TorrentTable } from './torrent-table'
import { useOrderedTorrents } from './use-ordered-torrents'
import { ListToolbar } from '../components/list-toolbar'
import {
  LIST_FILTER_KEY, LIST_SORT_KEY, LIST_VIEW_KEY, TEMPORARY_GONE_HINT, TEMPORARY_HINT,
  isTemporary, readFilter, readSort, readView, writeSort,
} from '../torrent/list-view'
import type { ListFilter, SortDir, SortKey, ViewMode } from '../torrent/list-view'
import type { ShareSubject } from '../torrent/torrent-file'
import { readMagnet, readTorrentFile } from '../torrent/torrent-file'
import { buildTorrentOptions } from '../torrent/torrent-options'
import type { TorrentOptionActions, TorrentOptionContext } from '../torrent/torrent-options'

const isMagnet = (s: string): boolean => /^magnet:\?/i.test(s.trim())

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

const retryLine = (t: Torrent, retry: NonNullable<Torrent['retry']>): string => {
  const stalled = retry.reason === 'stalled'
    ? (t.peers > 0 ? 'Peers stopped sending data' : 'Not connected to any peers')
    : 'Stopped by an error'
  const reason = retry.message ?? stalled
  const wait = retry.retryInSeconds <= 0
    ? 'retrying now'
    : retry.retryInSeconds < 60
      ? `retrying in ${retry.retryInSeconds}s`
      : `retrying in ${Math.ceil(retry.retryInSeconds / 60)}m`
  return `${reason} · ${wait}`
}

const rate = (bytesPerSecond: number): string => {
  const mbs = bytesPerSecond / 1_000_000
  if (mbs >= 1000) return `${Math.round(mbs / 1000)} GB/s`
  if (mbs >= 1) return `${Math.round(mbs)} MB/s`
  return `${Math.round(bytesPerSecond / 1000)} KB/s`
}

const QuotaStat = ({ quota }: { quota: QuotaStatus }) => {
  if (quota.premium) {
    return (
      <div className="stat quota">
        <label>FKN quota</label>
        <strong className="ok">Premium</strong>
      </div>
    )
  }
  if (quota.throttled) {
    return (
      <div className="stat quota throttled">
        <label>FKN quota</label>
        <strong>Throttled · {rate(quota.bytesPerSecond)}</strong>
        <a href="https://fkn.app/account" target="_blank" rel="noreferrer">Get full speed</a>
      </div>
    )
  }
  return (
    <div className="stat quota">
      <label>FKN quota</label>
      <strong>{getHumanReadableByteString(quota.remainingBytes, true)} left</strong>
    </div>
  )
}

const StorageStat = ({ storage, low }: { storage: StorageUsage, low: boolean }) => (
  <div className={'stat storage' + (low ? ' low' : '')}>
    <label>Storage</label>
    <strong>
      {getHumanReadableByteString(storage.usedBytes, true)} / {getHumanReadableByteString(storage.limitBytes, true)}
    </strong>
  </div>
)

/**
 * One line each, because a stat strip is not the place for a paragraph and a new user has no idea
 * what a connect grant is. The distinction that matters to them is whether their library is safe
 * somewhere else, and whether they need to do anything about it.
 */
const SYNC_DETAIL: Record<SyncReason, string> = {
  'signed-out': 'Connect an account to keep your library across devices.',
  'no-storage-grant': 'Your account is connected but storage did not answer. Retrying.',
  'broker-timeout': 'FKN did not respond in time. Retrying.',
  'account-unknown': 'Waiting until your account identifies itself, so libraries cannot be mixed up.',
  locked: 'Your storage is locked. Unlock it to sync again.',
  'read-failed': 'Your saved library could not be read, so it has been left untouched. Retrying.',
  'read-timeout': 'FKN did not answer in time, so your saved library was left untouched. Retrying.',
  'switch-unverified': 'Waiting to read this account\'s library before replacing the one on this device.',
  'write-failed': 'This device\'s library could not be saved. It will retry on the next change.',
}

const SyncStat = ({ state }: { state: SyncState }) => {
  const { status, reason } = state
  // A signed-out user is not having a problem, so nothing is shown. Every other state is, including
  // the ones that used to be silent: a library that is quietly not being backed up looks exactly
  // like one that is, which is the worst way for this to fail.
  if (status === 'off') return null
  const label = status === 'syncing' ? 'Syncing…' : status === 'error' ? 'Sync failed' : 'Synced'
  return (
    <div className={'stat sync' + (status === 'error' ? ' error' : '')} title={reason ? SYNC_DETAIL[reason] : undefined}>
      <label>Library</label>
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
export const ConnectionStat = ({ reachable }: { reachable: Reachability | null }) => {
  if (!reachable) return null
  const { port, inbound, inboundByTransport, listenFailed } = reachable
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
  const detail = Object.entries(inboundByTransport)
    .map(([transport, n]) => `${n} ${transport}`)
    .join(' · ')
  // The announced port is fixed for the session and the sockets holding it are not, so a reserved
  // port is not by itself evidence anyone can still reach it. `portOpen` is the live half: after a
  // dropped tunnel the acceptor heals itself, and until it does this readout would otherwise keep
  // naming a dead number with exactly the confidence it had when the number worked.
  const healing = !!port && !portOpen && listeners.some((l) => l.healing)
  const label =
    failed ? 'Failed'
    : !port ? 'Unreachable'
    : healing ? `Port ${port} · reconnecting`
    : !portOpen ? `Port ${port} · closed`
    : inbound === 0 ? `Port ${port}`
    : `${port} · ${detail}`
  const title =
    failed ? listenFailed.join('\n')
    : healing ? 'The connection carrying this port dropped. Reclaiming it.'
    : port && !portOpen ? `Peers were told to dial ${port} and nothing is holding it any more. Reload to take a new one.`
    : undefined
  return (
    <div className={'stat' + (failed || (!!port && !portOpen) ? ' error' : '')} title={title}>
      <label>Inbound</label>
      {/* the port stays visible once peers arrive: it is what a user checks against a router or a
          firewall, and hiding it exactly when the feature starts working is the wrong trade */}
      <strong className={inbound > 0 && portOpen ? 'ok' : undefined}>{label}</strong>
    </div>
  )
}

const HISTORY = 120

/**
 * Samples kept per row, against the page graph's 120.
 *
 * Half the history because it is drawn in a tenth of the width: at 120 samples across 80 pixels each
 * one is well under a pixel, so the line stops being a shape and becomes a texture.
 */
const ROW_HISTORY = 60

// A torrent already copied to the folder is parked on DONE, and a failed copy waits SYNC_RETRY before the next attempt
const DONE = Number.POSITIVE_INFINITY
const SYNC_RETRY = 30_000

// Resolves to null when another tab already holds it, which is a skip rather than a success or a failure
const copyUnderLock = (torrent: Torrent, copy: () => Promise<number>): Promise<number | null> => {
  const key = torrent.infoHash
  if (!navigator.locks || !key) return copy()
  return navigator.locks.request(
    `ripple:folder-sync:${key}`,
    { ifAvailable: true },
    (lock) => (lock ? copy() : Promise.resolve(null)),
  )
}

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

  a {
    text-decoration: none;
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
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding: 12px 18px;
    /* opaque rather than frosted: the bar has to hide the list scrolling under it, and a flat fill
       does that at any contrast setting where a blur only softened it */
    background: ${SURFACE_BG};
    border-bottom: 1px solid ${BORDER};

    .wordmark {
      font-size: 1.35rem;
      font-weight: 900;
      letter-spacing: 0.06em;
      color: ${TEXT};
      transition: opacity 120ms ease;

      /* it is a link now, and a link that answers nothing under the cursor reads as dead text */
      &:hover { opacity: 0.75; }
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
     * from a browser's address bar. The pill is the only item in the row now, nothing beside it can
     * squeeze it, and the two buttons that used to carry words carry a tooltip instead.
     */
    form {
      flex: 1;
      display: flex;
      /*
       * The floor is on the FORM and has to cover the icons, not just the text.
       *
       * Set to 260 it read as "the field may shrink to 260", which it did, leaving 160px of actual
       * text once the two icon buttons and the padding took their ~110px out of it. The number that
       * matters is the readable width of the placeholder, so it is written as that plus what the
       * chrome costs, and the header wraps the form to its own line rather than go under it.
       */
      min-width: 330px;
    }

    .field {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px 5px 3px 18px;
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

    /* header-level actions, outside the add form: the header itself wraps, so these can drop a line */
    .setup,
    .share {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 0.85rem;
      font-weight: 700;
      border: 1px solid ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT};

      svg { width: 15px; height: 15px; }

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: ${BORDER_STRONG};
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

    .readouts {
      flex: none;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 14px 26px;
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

      /* the VPN readout brings its own colours: it is mounted on the download page too, where none
         of these rules exist, so it cannot lean on them here either */
    }

    svg {
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
    padding: 14px 16px;
  }

  .torrent {
    /* the row whose details are in the dock, marked clearly enough to find at a glance in a long
       library without shouting over the rest of it */
    &.selected {
      border-color: ${BORDER_INTERACTIVE};
      background: ${CONTROL_BG};
    }

    cursor: default;

    flex: none;
    border-radius: 8px;
    padding: 10px 12px;
    /* a ROW at the top level, so the picture is a column of its own spanning the whole card rather
       than a thing beside one line of it */
    display: flex;
    align-items: stretch;
    gap: 12px;
    transition: border-color 120ms ease, background 120ms ease;

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

    /* Held even when there is no picture, so every row's text starts at the same place. An absent
       left column would make a list of mixed torrents look ragged rather than compact. */
    .poster.placeholder {
      display: grid;
      place-items: center;
      /* lighter than the plain poster fill, so an empty frame reads as a deliberate placeholder
         rather than as a picture that has not arrived yet */
      border-color: ${BORDER};
      background: ${CONTROL_BG};
      color: ${TEXT_MUTED};

      svg { width: 20px; height: 20px; }
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
      background: ${SUNKEN_BG};
      overflow: hidden;

      /* No glow under this any more. The old fill was a mid-saturation orange on a purple track and
         needed a 10px bloom to be perceptible at 3%; against a sunken track this is the brightest
         object on the page at 17:1, so the sliver reads on its own. */
      .fill {
        height: 100%;
        border-radius: 2px;
        background: ${EMPHASIS};
        transition: width 400ms ease;
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

      /* The temporary marker, in the same box the limit chip uses: both are properties of the
         torrent rather than live numbers, so they read as one kind of thing. No hue, because the
         palette spends colour on exactly two states and a third claimant breaks the only rule it
         still enforces. */
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
        padding-right: 8px;
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
          text-align: right;
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
          text-align: right;
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

  /* a plain word that behaves like a link, for the two places an action sits inside a sentence */
  .link {
    border: none;
    background: none;
    padding: 0;
    margin-left: 8px;
    font: inherit;
    font-size: inherit;
    color: ${TEXT};
    text-decoration: underline;
    cursor: pointer;
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
      margin-left: auto;
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px 18px;
    }

    .folder {
      display: flex;
      align-items: center;
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

  .toast {
    position: fixed;
    bottom: 52px;
    left: 50%;
    transform: translateX(-50%);
    /* Fully opaque, which it was not before. It is fixed over the live torrent list, so at 85% with
       no blur behind it rows would visibly slide past under its own text; the border is what says it
       is floating now that the shadow is gone. */
    background: ${ELEVATED_BG};
    border: 1px solid ${BORDER_STRONG};
    border-radius: 8px;
    padding: 11px 20px;
    font-size: 0.85rem;
    z-index: 30;
    animation: slide-up 200ms ease-out;
  }

  @keyframes slide-up {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(14px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  @media (max-width: 700px) {
    header form {
      flex-basis: 100%;
    }

    .stats {
      flex-direction: column;
      gap: 12px;
      padding: 12px 14px;

      .readouts {
        gap: 18px;
      }

      .stat strong {
        font-size: 0.9rem;
      }

      .stat.big strong {
        font-size: 1.25rem;
      }

      svg {
        height: 44px;
        flex: none;
        width: 100%;
      }
    }

    /* the right-hand group takes its own line rather than squeezing the name out of existence */
    .torrent .main {
      flex-wrap: wrap;
    }

    .torrent .side {
      flex-basis: 100%;
      flex-wrap: wrap;
      justify-content: flex-start;
    }

    .torrent .actions {
      justify-content: flex-start;
    }

    .torrent .poster {
      width: 96px;
      min-height: 64px;
    }
  }
`

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
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
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
  onRecheck: (t: Torrent) => void
  onRemove: (t: Torrent) => void
  onStart: (t: Torrent) => void
  onPause: (t: Torrent) => void
  onEmbed: (t: Torrent) => void
  /** `at` opens the menu at a point; null opens the options dialog instead. */
  onOptions: (t: Torrent, at: MenuPosition | null) => void
  selected: boolean
  /** Selects, and only selects. Deselecting is the dock's own gesture, not a second click here. */
  onSelect: (t: Torrent) => void
  /** Whether this torrent's files are already in the folder the user chose. Hides the save button. */
  savedToUserStorage: boolean
  /** This row's recent transfer, newest last. Absent until the second state tick has been seen. */
  rates?: { down: number[], up: number[] }
}

/** The picture, or the box it would have been in, so every row's text starts at the same place. */
const Poster = ({ url }: { url: string | null }) =>
  url
    // decorative: the name is right beside it, so a screen reader announcing this twice is worse
    // than it announcing nothing
    ? <img className="poster" src={url} alt="" />
    : <div className="poster placeholder"><Folder /></div>

/**
 * A library row drawn before its engine handle exists.
 *
 * Presentational on purpose: no click handler, no context menu, no controls. Every action on a live
 * row resolves a handle with `Number(t.id)`, and this row's id cannot produce one, so anything
 * offered here would send a command naming no torrent. It exists to say "this is in your library and
 * it is coming back", which is the honest answer for the second the relay takes to grant a port, and
 * it is replaced by the real row the moment the engine reports.
 */
const StartingRow = ({ t, poster }: { t: Torrent, poster: string | null }) => (
  <div className="torrent surface starting">
    <Poster url={poster}/>
    <div className="content">
      <div className="main">
        <div className="body">
          <div className="title"><strong>{t.name}</strong></div>
          <div className="meta"><span>Connecting</span></div>
        </div>
        <div className="side">
          <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
        </div>
      </div>
    </div>
  </div>
)

const MissingRow = ({
  t, poster, onStart, onOptions, selected, onSelect,
}: Pick<RowProps, 't' | 'onStart' | 'onOptions' | 'selected' | 'onSelect'> & { poster: string | null }) => (
  <div
    className={'torrent surface missing' + (selected ? ' selected' : '')}
    aria-current={selected || undefined}
    onClick={(e) => {
      if ((e.target as HTMLElement).closest('button, a')) return
      onSelect(t)
    }}
    onContextMenu={(e) => {
      if (e.shiftKey || e.ctrlKey) return
      e.preventDefault()
      onSelect(t)
      onOptions(t, { x: e.clientX, y: e.clientY })
    }}
  >
    {/* the files are gone from this device but the picture was cached here, so it still shows */}
    <Poster url={poster}/>
    <div className="content">
      <div className="main">
        <div className="body">
          <div className="title"><strong>{t.name}</strong></div>
          <div className="meta">
            {t.ephemeral === true && (
              <button
                type="button" className="temp"
                onClick={() => onOptions(t, null)}
                aria-label={'Temporary download: options for ' + t.name}
                title={TEMPORARY_GONE_HINT}
              >
                <Clock aria-hidden="true"/>Temporary
              </button>
            )}
            <span>Files aren't on this device · download to fetch them</span>
          </div>
        </div>
        <div className="side">
          <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
          {/* Two, matching the live rows: fetch it, or open the menu. Removing a library entry is
              in the menu with everything else destructive. */}
          <div className="actions">
            <button
              className="primary"
              onClick={() => onStart(t)}
              title="Download to this device"
              aria-label={`Download ${t.name}`}
            >
              <Download size={16} aria-hidden="true"/>
            </button>
            <button
              className="more"
              aria-haspopup="dialog"
              aria-label={`Options for ${t.name}`}
              title="Options"
              onClick={() => onOptions(t, null)}
            >
              <MoreHorizontal size={16} aria-hidden="true"/>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
)

/** Exported for its own test: the page around it needs the whole engine, and the row does not. */
export const TorrentRow = ({ t, saving, onToggle, onSave, onSaveZip, onRecheck, onRemove, onStart, onPause, onEmbed, onOptions, selected, onSelect, savedToUserStorage, rates }: RowProps) => {
  /**
   * Before the missing branch, not after it.
   *
   * A torrent moves between missing and present at runtime (a recheck, a restored library), and a
   * hook that only runs on one side of that branch changes the hook COUNT between two renders of the
   * same component, which React treats as a corrupted render rather than a state change.
   */
  const poster = useThumbnail(t.infoHash)
  if (t.state === 'starting') return <StartingRow t={t} poster={poster}/>
  if (t.state === 'missing') {
    return (
      <MissingRow
        t={t} poster={poster} onStart={onStart}
        onOptions={onOptions} selected={selected} onSelect={onSelect}
      />
    )
  }
  const href = watchHref(t)
  const mainIndex = pickVideoFile(t.files)
  const multi = (t.files?.length ?? 0) > 1
  const mainSaving = saving[savingKey(t.id, multi ? -1 : mainIndex)]
  const complete = t.progress >= 1
  // 'retrying' is not stopped, it is waiting out a backoff, so the control still offers to pause it
  const running = t.state !== 'paused' && t.state !== 'queued'
  // the panel keys by file index; the page keys by torrent-and-index, since one map covers every row
  const fileSaving: Record<number, number> = {}
  t.files?.forEach((_, i) => {
    const s = saving[savingKey(t.id, i)]
    if (s != null) fileSaving[i] = s
  })
  return (
    <div
      className={'torrent surface' + (selected ? ' selected' : '')}
      aria-current={selected || undefined}
      // Selecting is what fills the dock, so it has to be the ordinary click on the card. Anything
      // that already does something of its own keeps doing it: the buttons, the Watch link, the
      // file list, and any text the user is trying to select rather than click.
      onClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, a, input, summary')) return
        if (window.getSelection()?.toString()) return
        onSelect(t)
      }}
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
        // right-clicking a row selects it first, so the menu and the dock always agree on subject
        onSelect(t)
        onOptions(t, { x: e.clientX, y: e.clientY })
      }}
    >
      <Poster url={poster}/>
      <div className="content">
        <div className="main">
          <div className="body">
            <div className="title">
              <strong>{t.name}</strong>
            </div>
            <div className="meta">
              {/* First, before the numbers, because it changes what all of them mean: these bytes
                  are ones Ripple may take back. A button rather than a chip, so a touch device can
                  reach the explanation at all; `title` alone is invisible without a pointer. */}
              {t.ephemeral === true && (
                <button
                  type="button" className="temp"
                  onClick={() => onOptions(t, null)}
                  aria-label={'Temporary download: options for ' + t.name}
                  title={TEMPORARY_HINT}
                >
                  <Clock aria-hidden="true"/>Temporary
                </button>
              )}
              <span>{getHumanReadableByteString(t.downloaded, true)} / {getHumanReadableByteString(t.size, true)}</span>
              <span>↓ {speed(t.down)}</span>
              <span>↑ {speed(t.up)}</span>
              <span>{t.peers} peers</span>
              {t.state === 'downloading' && t.eta !== '-' && <span>{t.eta} left</span>}
              {/* Only when this torrent has been given one of its own. The session ceiling lives in
                  the footer and would be the same on every row, which is noise rather than news. */}
              {isLimit(t.downloadLimit) && t.downloadLimit > 0 && (
                <span className="limit" title={`This torrent will not download faster than ${formatLimit(t.downloadLimit)}`}>
                  ↓ max {formatLimit(t.downloadLimit)}
                </span>
              )}
              {isLimit(t.uploadLimit) && t.uploadLimit > 0 && (
                <span className="limit" title={`This torrent will not upload faster than ${formatLimit(t.uploadLimit)}`}>
                  ↑ max {formatLimit(t.uploadLimit)}
                </span>
              )}
              {t.retry && <span className="retry">{retryLine(t, t.retry)}</span>}
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
            <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
            <span className="pct">{(t.progress * 100).toFixed(t.progress < 1 ? 1 : 0)}%</span>
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
                <Link className="primary" to={href} title="Watch" aria-label={`Watch ${t.name}`}>
                  <PlayCircle size={16} aria-hidden="true"/>
                </Link>
              )}
              {/* Only when there is something to write out AND it is not already sitting in the
                  user's own folder: offering to save a second copy of a file they already have is
                  an action with no outcome. */}
              {!!t.files?.length && complete && !savedToUserStorage && (
                <button
                  onClick={() => multi ? onSaveZip(t) : onSave(t, mainIndex)}
                  disabled={mainSaving != null}
                  title={multi ? 'Save as a zip' : 'Save to disk'}
                  aria-label={multi ? `Save ${t.name} as a zip` : `Save ${t.name} to disk`}
                >
                  {mainSaving != null
                    ? <span className="saving">{Math.round(mainSaving * 100)}%</span>
                    : <Download size={16} aria-hidden="true"/>}
                </button>
              )}
              {t.state !== 'checking' && (
                <button
                  onClick={() => onToggle(t)}
                  title={running ? 'Pause' : t.state === 'retrying' ? 'Try again now' : 'Resume'}
                  aria-label={`${running ? 'Pause' : 'Resume'} ${t.name}`}
                >
                  {running ? <Pause size={16} aria-hidden="true"/> : <Play size={16} aria-hidden="true"/>}
                </button>
              )}
              <button
                className="more"
                aria-haspopup="dialog"
                aria-label={`Options for ${t.name}`}
                title="Options"
                onClick={() => onOptions(t, null)}
              >
                <MoreHorizontal size={16} aria-hidden="true"/>
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

const Home = () => {
  const { torrents, addMagnet, addTorrentFile, pause, resume, retry, recheck, remove, start, removeMissing, storageUnavailable, workerError, reachable, client } = useTorrents()
  const [input, setInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState<Record<string, number>>({})
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const toastTimer = useRef<number | undefined>(undefined)
  const { confirm, confirmElement, confirmOpen } = useConfirm()
  const navigate = useNavigate()

  const fieldRef = useRef<HTMLInputElement>(null)
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
   * tab then renders the value actually in force, including an `/embed` tab that has no settings
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

  const [showSetup] = useState(() => !isAppInstalled())
  const onSetupHandlers = useCallback(async () => {
    const outcome = await setupHandlers()
    if (outcome === 'installed') showToast('Ripple installed. Torrent files and magnet links open here now.')
    else if (outcome === 'magnet-registered') showToast('Confirm the prompt to route magnet links to Ripple.')
    else if (outcome === 'already-installed') showToast('Ripple is already set up on this device.')
    else showToast('Use your browser menu to install Ripple as an app.')
  }, [showToast])

  /** Whether an add the person made themselves stops to ask. Off by default: it is friction. */
  const [addDialog, setAddDialog] = useState(() => dialogEnabled((k) => localStorage.getItem(k)))
  const chooseAddDialog = (on: boolean) => {
    setAddDialog(on)
    try { localStorage.setItem(ADD_DIALOG_KEY, on ? '1' : '0') } catch {}
  }

  const [pendingAdd, setPendingAdd] = useState<{ magnet: string, infoHash: string, name: string, external: boolean, from: string | null } | null>(null)
  const [choices, setChoices] = useState<AddChoices | null>(null)
  const heldRef = useRef<number | null>(null)

  const beginAdd = useCallback((magnet: string, external: boolean, from: string | null = null) => {
    const request = describeAddRequest({ magnet })
    if (!request.ok) { showToast(request.problem); return }
    const existing = torrentsRef.current.find((t) => t.infoHash === request.infoHash && !t.ephemeral && t.state !== 'missing')
    if (existing) { showToast('Already in your list'); return }
    client.addMagnet(request.magnet, { ephemeral: true })
    setPendingAdd({ magnet: request.magnet, infoHash: request.infoHash, name: request.name, external, from })
    setChoices(null)
  }, [client, showToast])

  const commitMagnet = useCallback((raw: string): boolean => {
    const text = raw.trim()
    if (!isMagnet(text)) return false
    const ih = magnetInfoHash(text)
    // Re-adding would join the swarm and start downloading; a synced "Files missing" torrent must only start from its explicit Download button
    if (ih && torrentsRef.current.some((t) => t.magnet && magnetInfoHash(t.magnet) === ih)) {
      showToast('Already in your list')
      return true
    }
    if (addDialog) { beginAdd(text, false); return true }
    addMagnet(text)
    showToast('Magnet added')
    return true
  }, [addMagnet, showToast, addDialog, beginAdd])

  const addTorrentFiles = useCallback(async (files: Iterable<File>) => {
    const all = [...files]
    const torrents = all.filter((file) => /\.torrent$/i.test(file.name))
    // Something was handed over and none of it was usable, which used to end in silence. A drop that
    // reports nothing is indistinguishable from one the page never received.
    if (!torrents.length) {
      if (all.length) showToast(all.length === 1 ? 'That is not a .torrent file' : 'No .torrent file in what you dropped')
      return
    }
    for (const file of torrents) {
      addTorrentFile(new Uint8Array(await file.arrayBuffer()))
      showToast(`${file.name} added`)
    }
  }, [addTorrentFile, showToast])

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
    if (!torrent) { showToast('That is not a .torrent file'); return }
    void (async () => {
      const subject = await readTorrentFile(new Uint8Array(await torrent.arrayBuffer()))
      if (!subject) { showToast('That .torrent could not be read'); return }
      setShareSubject(subject)
    })()
  }, [showToast])

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
      if (!shareMagnet(text)) showToast('Not a magnet link')
      return
    }
    if (!commitMagnet(text)) showToast('Not a magnet link')
  }, [addTorrentFiles, commitMagnet, embedOpen, shareSubject, shareFiles, shareMagnet, showToast])

  const openEmbed = useCallback((subject: ShareSubject | null) => {
    setShareSubject(subject)
    setEmbedOpen(true)
  }, [])

  const closeEmbed = useCallback(() => {
    setShareSubject(null)
    setEmbedOpen(false)
  }, [])

  /** a torrent already in the library, in the same shape a parsed file produces */
  const subjectOf = useCallback((t: Torrent): ShareSubject => ({
    magnet: t.magnet ?? '',
    name: t.name,
    size: t.size,
    files: t.files ? t.files.map((f) => ({ name: f.name, size: f.size })) : null,
  }), [])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // A modal makes the page inert to pointers but not to window-level listeners, so without this
      // a paste behind an open confirmation would add a torrent the user cannot see. The rate limit
      // editor counts for the same reason, and doubly so: it holds a text field, so a stray paste
      // there is a gesture aimed at THIS dialog rather than at the page behind it.
      if (confirmOpen || rateEdit) return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const text = e.clipboardData?.getData('text') ?? ''
      if (isMagnet(text)) { e.preventDefault(); commitMagnet(text) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [commitMagnet, confirmOpen, rateEdit])

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
    const onDragEnter = (e: DragEvent) => {
      if (!droppable(e.dataTransfer)) return
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
      acceptDrop(e.dataTransfer)
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
  }, [acceptDrop, endDrag])

  useEffect(() => {
    const addFromLaunchUrl = (rawUrl: string | undefined) => {
      if (!rawUrl) return
      try {
        const magnet = new URL(rawUrl, window.location.origin).searchParams.get('magnet')
        if (magnet) commitMagnet(magnet)
      } catch {}
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
        addFromLaunchUrl(params.targetURL)
        if (params.files?.length) {
          const files = await Promise.all(params.files.map((handle) => handle.getFile()))
          await addTorrentFiles(files)
        }
      })
    } catch {}
  }, [addTorrentFiles, commitMagnet])

  const onToggle = (t: Torrent) =>
    t.state === 'retrying'
      ? retry(Number(t.id))
      : t.state === 'paused' || t.state === 'queued' ? resume(Number(t.id)) : pause(Number(t.id))

  const onPause = (t: Torrent) => pause(Number(t.id))

  const onStart = (t: Torrent) => { if (t.infoHash) start(t.infoHash) }

  const onRemove = async (t: Torrent) => {
    // A torrent whose files are already gone has nothing to destroy, so asking would be noise. Every
    // other case deletes the payload, which on a metered connection costs the time to fetch it again.
    const missing = t.state === 'missing'
    if (!missing) {
      const onDisk = getHumanReadableByteString(t.downloaded ?? 0, true)
      const ok = await confirm({
        title: `Remove ${t.name}?`,
        body: `This deletes the ${onDisk} already downloaded. It cannot be undone, and getting it back means downloading it again.`,
        confirmLabel: 'Remove and delete',
        tone: 'danger',
        rememberKey: 'ripple:confirm-remove',
      })
      if (!ok) return
    }
    // Nothing else would ever collect it: the worker deletes its own three key shapes on removal and
    // never clears the store, so a picture left behind here outlives the torrent it belongs to.
    if (t.infoHash) void forgetThumbnail(t.infoHash)
    if (missing) { if (t.infoHash) removeMissing(t.infoHash) }
    else remove(Number(t.id), true)
  }

  const onRecheck = (t: Torrent) => {
    recheck(Number(t.id))
    showToast(`Checking ${t.name} against the files on disk`)
  }

  /**
   * Remove the torrent and LEAVE the files. Separate from onRemove, which deletes them.
   *
   * Still confirmed, because it is still not undoable: the library entry, the resume data and the
   * thumbnail all go. It just does not cost the bytes back, so it says so and does not offer to be
   * remembered, unlike the destructive one.
   */
  const onRemoveKeepingFiles = async (t: Torrent) => {
    if (t.state !== 'missing') {
      const ok = await confirm({
        title: `Remove ${t.name} from the library?`,
        body: 'The downloaded files stay where they are. Ripple stops sharing it and forgets its progress.',
        confirmLabel: 'Remove',
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
  /**
   * The torrent the dock is showing. One at a time.
   *
   * Clicking a row SELECTS it and never deselects it, even when it is already the selected one.
   * A dock that toggles off under a second click is a dock that closes while the user is reading
   * it: rows are large, they carry buttons and a poster, and clicking one again to look at
   * something in it is a completely ordinary thing to do. Closing is its own gesture, so it has its
   * own controls, the header button and Escape.
   */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const onSelect = useCallback((t: Torrent) => setSelectedId(t.id), [])

  const onOptions = useCallback((t: Torrent, at: MenuPosition | null) => {
    if (at) { setOptionsId(null); setMenu({ id: t.id, at }) }
    else { setMenu(null); setOptionsId(t.id) }
  }, [])

  const optionActions = (t: Torrent): TorrentOptionActions => ({
    setFlags: (flags, mask) => client.setFlags(Number(t.id), flags, mask),
    reannounce: () => {
      client.reannounce(Number(t.id))
      // the only one of these with no visible consequence anywhere, so it says so itself
      showToast(`Asking ${t.name}'s trackers for peers again`)
    },
    moveInQueue: (where) => client.moveInQueue(Number(t.id), where),
    recheck: () => onRecheck(t),
    pause: () => pause(Number(t.id)),
    resume: () => resume(Number(t.id)),
    remove: () => { void onRemoveKeepingFiles(t) },
    removeWithFiles: () => { void onRemove(t) },
    setLocation: (location) => { void onSetLocation(t, location) },
    setKept: (kept) => { void onSetKept(t, kept) },
    setFirstLast: (on) => client.setPlan(Number(t.id), { wanted: t.wantedFiles, firstLast: on }),
    pickFolder,
    limitRate: (direction) => setRateEdit({ scope: { torrent: t.id }, direction }),
    // the row's Watch is a <Link>; from a menu it has to navigate itself
    watch: () => { const href = watchHref(t); if (href) navigate(href) },
    save: () => ((t.files?.length ?? 0) > 1 ? onSaveZip(t) : onSave(t, pickVideoFile(t.files))),
    embed: () => openEmbed(subjectOf(t)),
    retryNow: () => retry(Number(t.id)),
    start: () => { if (t.infoHash) start(t.infoHash) },
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

  // Called synchronously from the click so showSaveFilePicker keeps the user gesture
  const onSave = (t: Torrent, fileIndex: number) => {
    const file = t.files?.[fileIndex]
    if (!file) return
    const key = savingKey(t.id, fileIndex)
    setSaving((s) => ({ ...s, [key]: 0 }))
    saveTorrentFileToDisk(client, Number(t.id), fileIndex, file.name, file.size, (f) => setSaving((s) => ({ ...s, [key]: f })))
      .catch((error) => { if (!isSaveCancelled(error)) showToast(`Saving ${file.name} failed`) })
      .finally(() => setSaving((s) => { const { [key]: _, ...rest } = s; return rest }))
  }

  const onSaveZip = (t: Torrent) => {
    if (!t.files?.length) return
    const key = savingKey(t.id, -1)
    setSaving((s) => ({ ...s, [key]: 0 }))
    saveTorrentAsZipToDisk(client, Number(t.id), t.name, t.files, (f) => setSaving((s) => ({ ...s, [key]: f })))
      .catch((error) => { if (!isSaveCancelled(error)) showToast(`Saving ${t.name} failed`) })
      .finally(() => setSaving((s) => { const { [key]: _, ...rest } = s; return rest }))
  }

  const { supported: folderSupported, folder, permitted, pick: pickFolder, allow: allowFolder, clear: clearFolder } = useFolder()


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

  const chooseDefaultLocation = (location: SaveLocation) => {
    setDefaultLocation(location)
    try { localStorage.setItem(SAVE_LOCATION_KEY, location) } catch {}
  }

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

  /**
   * Hand the engine the folder, from whichever tab actually holds the grant.
   *
   * A File System Access grant belongs to a realm, and the engine runs in whichever tab won the
   * election, which is not necessarily this one. Every tab offers what it has and the newest offer
   * wins, so a grant given anywhere reaches the engine. Offering null when the grant goes is just as
   * important: a stale handle would have the engine reading against permission it no longer has.
   */
  useEffect(() => {
    client.setFolder(folder && permitted ? folder : null)
  }, [client, folder, permitted])

  const locationOf = (t: Torrent) => ({
    intended: intendedLocation(t, defaultLocation),
    // the engine's own answer for where it is writing, rather than a remembered one
    current: currentLocation(t.stats?.savePath),
  })

  /**
   * Record where a torrent belongs, and move it if it can move now.
   *
   * The two halves are deliberately separate. Recording always happens, so choosing a folder for
   * something still downloading is remembered and acted on when it finishes rather than refused.
   */
  const onSetLocation = async (t: Torrent, location: SaveLocation) => {
    if (!t.infoHash) return
    client.setLocation(t.infoHash, location)
    const { current } = locationOf(t)
    const readiness = moveReadiness({
      current,
      intended: location,
      complete: t.progress >= 1,
      folderReady: !!folder && permitted,
    })
    if (!readiness.move) {
      const waiting = pendingLabel(readiness, folder?.name)
      if (waiting) showToast(waiting)
      return
    }
    await runMove(t, location)
  }

  /**
   * Keep this download, or hand it back to the space Ripple may reclaim.
   *
   * Only ONE direction asks first. Keeping is safe and reversible. Un-keeping does not delete
   * anything now, it makes the bytes deletable LATER, without warning and without another click,
   * which is the kind of consequence a person cannot see coming from the switch itself.
   *
   * The two bodies differ because the promise differs: a torrent in its own directory really is what
   * the budget pass takes, while one still on the shared save path is never auto-deleted at all, so
   * saying it would be is a threat the app does not carry out.
   */
  const onSetKept = async (t: Torrent, kept: boolean) => {
    if (!t.infoHash) return
    if (!kept) {
      const ownsDirectory = ownsItsDirectory(t.stats?.savePath, t.infoHash)
      const ok = await confirm({
        title: `Let Ripple delete ${t.name}?`,
        body: ownsDirectory
          ? 'It stops being part of your library. Ripple can delete its files to free space when storage runs low, without asking again. You can download it again at any time.'
          : 'It stops being part of your library. Its files are stored where Ripple does not delete on its own, so nothing is removed until you remove it.',
        confirmLabel: 'Let Ripple delete it',
      })
      if (!ok) return
    }
    client.setTemporary(t.infoHash, !kept)
    showToast(kept ? `${t.name} is yours to keep` : `${t.name} can be deleted to free space`)
  }

  /** In-flight moves, so the effect below and a click cannot start the same one twice. */
  const movingRef = useRef(new Set<string>())
  const [moving, setMoving] = useState<Record<string, string>>({})

  const runMove = async (t: Torrent, to: SaveLocation) => {
    if (!folder || !permitted || movingRef.current.has(t.id)) return
    movingRef.current.add(t.id)
    setMoving((m) => ({ ...m, [t.id]: `Moving ${t.name}` }))
    try {
      await moveTorrentFiles({
        client,
        torrent: t,
        folder,
        to,
        onProgress: ({ file, files }) => setMoving((m) => ({ ...m, [t.id]: `Moving ${t.name}, file ${file + 1} of ${files}` })),
      })
      showToast(to === 'folder' ? `${t.name} moved to ${folder.name}` : `${t.name} moved into browser storage`)
    } catch {
      // nothing was deleted: the copy runs first and the engine is only told once it lands
      showToast(`Moving ${t.name} failed, nothing was lost`)
    } finally {
      movingRef.current.delete(t.id)
      setMoving((m) => { const { [t.id]: _, ...rest } = m; return rest })
    }
  }

  /**
   * Carry out the moves that became possible: a torrent finished, or the folder came back.
   *
   * Runs off the same state tick as the mirror below, so it re-checks twice a second, and every move
   * it starts is guarded by `movingRef` so a tick during a copy cannot start a second one.
   */
  useEffect(() => {
    if (!folder || !permitted) return
    for (const t of torrents) {
      if (t.state === 'missing') continue
      const { intended, current } = locationOf(t)
      const readiness = moveReadiness({ current, intended, complete: t.progress >= 1, folderReady: true })
      if (readiness.move) void runMove(t, readiness.to)
    }
  })

  // The backoff is what makes retrying safe: this effect re-runs twice a second from the state tick, so a bare retry would hammer the disk
  const syncAtRef = useRef(new Map<string, number>())
  // In-flight copies are tracked apart from the backoff: a copy can run longer than the retry window while this effect re-runs twice a second, and a swap-file
  // writable leaves the destination at its old size until close(), so the size-based idempotence check cannot catch a second pass over the same files
  const syncingRef = useRef(new Set<string>())
  const folderGenerationRef = useRef(0)
  /**
   * Which torrents have actually landed in the user's folder, as STATE rather than a ref.
   *
   * The backoff map above is a ref because nothing renders from it. This does render: it decides
   * whether "Remove from the library" is offered at all, since keeping the files is only a real
   * choice once the files are somewhere the person can open.
   */
  const [savedToFolder, setSavedToFolder] = useState<Set<string>>(new Set())
  useEffect(() => {
    folderGenerationRef.current++
    syncAtRef.current.clear()
    // a different folder, or a revoked grant, means nothing is known to be mirrored any more
    setSavedToFolder(new Set())
  }, [folder, permitted])
  // Both maps are keyed by the session handle, which names a different torrent after the engine moves to another tab
  useEffect(() => client.onEngineReset(() => {
    syncAtRef.current.clear()
    syncingRef.current.clear()
    // ids are session handles, so after a reset they name different torrents entirely
    setSavedToFolder(new Set())
  }), [client])
  useEffect(() => {
    if (!folder || !permitted) return
    const now = Date.now()
    for (const t of torrents) {
      if (t.state !== 'done' && t.state !== 'seeding') continue
      if (!t.files?.length || syncingRef.current.has(t.id)) continue
      const attempt = syncAtRef.current.get(t.id)
      if (attempt !== undefined && (attempt === DONE || now < attempt)) continue
      syncingRef.current.add(t.id)
      const generation = folderGenerationRef.current
      copyUnderLock(t, () => syncTorrentToDirectory(client, t, folder))
        .then((written) => {
          if (generation !== folderGenerationRef.current) return
          if (written === null) return
          syncAtRef.current.set(t.id, DONE)
          // `written` is false for a copy that was already there, which is still "it is in the
          // folder" and still the thing the removal options need to know
          setSavedToFolder((prev) => (prev.has(t.id) ? prev : new Set(prev).add(t.id)))
          if (written) showToast(`${t.name} saved to ${folder.name}`)
        })
        .catch(() => {
          if (generation !== folderGenerationRef.current) return
          syncAtRef.current.set(t.id, Date.now() + SYNC_RETRY)
          showToast(`Saving ${t.name} to ${folder.name} failed, retrying`)
        })
        .finally(() => syncingRef.current.delete(t.id))
    }
  }, [torrents, folder, permitted, client, showToast])

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
  const pendingTorrent = pendingAdd
    ? torrents.find((t) => t.infoHash === pendingAdd.infoHash && t.state !== 'missing')
    : undefined
  const pendingFiles = pendingTorrent?.files ?? []

  // The file list decides the default selection, so the choices cannot exist until it arrives. This
  // is also where the torrent is HELD: metadata is in by now, so from here on it would be fetching
  // pieces nobody has agreed to yet.
  useEffect(() => {
    if (!pendingAdd || choices || pendingFiles.length === 0 || !pendingTorrent) return
    setChoices(defaultChoices({ fileCount: pendingFiles.length, location: defaultLocation }))
    heldRef.current = Number(pendingTorrent.id)
    pause(Number(pendingTorrent.id))
  }, [pendingAdd, choices, pendingFiles.length, pendingTorrent, defaultLocation, pause])

  const closeAdd = useCallback(() => {
    setPendingAdd(null)
    setChoices(null)
    heldRef.current = null
    // the link is spent once it has been answered, so a reload does not ask again
    if (params.get('add')) setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])

  const cancelAdd = useCallback(() => {
    // only the cache entry this flow created. Anything already theirs was never ours to remove.
    if (pendingTorrent?.ephemeral) remove(Number(pendingTorrent.id), true)
    closeAdd()
  }, [pendingTorrent, remove, closeAdd])

  const confirmAdd = useCallback(() => {
    if (!pendingAdd || !choices || !pendingTorrent) return
    const handle = Number(pendingTorrent.id)
    // the same magnet without `ephemeral`, which is the gesture that promotes it into the library
    addMagnet(pendingAdd.magnet)
    client.setPlan(handle, planFor(choices, pendingFiles.length))
    client.setFlags(handle, ...flagsFor(choices))
    if (pendingAdd.infoHash) client.setLocation(pendingAdd.infoHash, choices.location)
    if (choices.topOfQueue) client.moveInQueue(handle, 'top')
    // held since the file list arrived, so starting is an explicit step rather than the absence of one
    if (choices.start) resume(handle)
    showToast(choices.start ? `${pendingAdd.name} added` : `${pendingAdd.name} added, paused`)
    closeAdd()
  }, [pendingAdd, choices, pendingTorrent, pendingFiles.length, addMagnet, client, resume, showToast, closeAdd])

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
    let framed = true
    try { framed = window.top !== window.self } catch { framed = true }
    if (framed) { setParams(new URLSearchParams(), { replace: true }); return }
    let from: string | null = null
    try { from = document.referrer ? new URL(document.referrer).origin : null } catch { from = null }
    if (from === window.location.origin) from = null
    beginAdd(magnet, true, from)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('add')])

  const optionContext = (t: Torrent): TorrentOptionContext => {
    const { intended, current } = locationOf(t)
    return {
      savedToUserStorage: !!folder && permitted && savedToFolder.has(t.id),
      intended,
      current,
      folderName: folder?.name,
      folderReady: !!folder && permitted,
      sessionLimits,
    }
  }

  const [history, setHistory] = useState<number[]>([])
  useEffect(() => {
    setHistory((prev) => [...prev.slice(-(HISTORY - 1)), torrents.reduce((n, t) => n + t.down, 0)])
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
  const peak = Math.max(...history, 0)
  const active = torrents.filter((t) => isActive(t.state)).length

  /**
   * What the list actually shows, filtered and arranged, with the ORDER held still for a moment at a
   * time so rows do not swap under a cursor while somebody aims at a button.
   *
   * The stats strip above deliberately keeps counting `torrents`, not this. The strip describes what
   * this device's engine is doing and the list describes the library; a filter is a question about
   * the second one, and letting it silence the first would make the app report 0 B/s while it is
   * plainly downloading.
   */
  const temporaryCount = torrents.filter(isTemporary).length
  const { rows: visibleRows, interaction } = useOrderedTorrents(torrents, listFilter, listSort.key, listSort.dir)
  const hiddenByFilter = torrents.length - visibleRows.length
  const hiddenBytes = listFilter === 'library'
    ? torrents.filter(isTemporary).reduce((n, t) => n + t.size, 0)
    : 0

  const hasLive = torrents.some((t) => t.state !== 'missing')
  const quota = useQuota(hasLive)
  const syncState = useCloudBackup()
  const retrying = torrents.filter((t) => t.state === 'retrying').length
  const storage = useStorageUsage(torrents.length)
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
      {menu && menuTorrent && (
        <ContextMenu
          groups={buildTorrentOptions(menuTorrent, optionActions(menuTorrent), optionContext(menuTorrent))}
          at={menu.at}
          label={`Options for ${menuTorrent.name}`}
          onClose={() => setMenu(null)}
        />
      )}
      {optionsTorrent && (
        <TorrentOptionsDialog
          title={optionsTorrent.name}
          groups={buildTorrentOptions(optionsTorrent, optionActions(optionsTorrent), optionContext(optionsTorrent))}
          onClose={() => setOptionsId(null)}
        />
      )}
      <div className="drop"><span>Drop a .torrent or a magnet link to add it</span></div>
      <header>
        {/* the way home from every other page, so it is one here too rather than a word that is a
            link on the download page and dead text on this one */}
        <Link className="wordmark" to="/">Ripple</Link>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (commitMagnet(input)) setInput('')
            else if (input.trim()) showToast('Not a magnet link')
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
            <input
              ref={fieldRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Add a magnet link, or drop a .torrent"
              aria-label="Magnet link"
              spellCheck={false}
              disabled={storageUnavailable}
            />

            {/* only while there is something to clear, the way a search field does it */}
            {input && (
              <button
                className="icon"
                type="button"
                title="Clear"
                aria-label="Clear"
                onClick={() => { setInput(''); fieldRef.current?.focus() }}
              >
                <X/>
              </button>
            )}

            <span className="sep" aria-hidden="true"/>

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
              title="Open a .torrent file"
              aria-label="Open a .torrent file"
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
              title="Add this magnet link"
              aria-label="Add"
              disabled={storageUnavailable || !input.trim()}
            >
              <Plus/>
            </button>
          </div>
        </form>
        {/**
          * "Embed" named the artefact, not the job, and named the least common one at that.
          *
          * The panel behind it mostly produces a LINK that anyone can open, and offers an iframe as
          * a disclosure below it. The label now says what pressing it is for, and the title says
          * what comes out, because the word on its own explained nothing to anybody who had not
          * already used it.
          *
          * Outside the form, where it belongs: it does not add anything, and a third control inside
          * a row that cannot wrap was taking its width out of the magnet field. The header wraps, so
          * out here it drops to its own line instead of squeezing the field.
          */}
        <button
          className="share"
          type="button"
          aria-expanded={embedOpen}
          title="Make a link that plays or downloads a torrent on any device, with no account"
          onClick={() => (embedOpen ? closeEmbed() : openEmbed(null))}
        >
          <Link2/>
          Share a torrent
        </button>
        {showSetup && (
          <button className="setup" type="button" onClick={() => { void onSetupHandlers() }}>
            Open torrents with Ripple
          </button>
        )}
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

      {storageUnavailable && (
        <div className="storage-warning surface" role="alert">
          <strong>Ripple can't run in this window</strong>
          <span>
            Downloads are stored in your browser's private file system (OPFS), which isn't
            available in private/incognito windows or when site storage is blocked. Open Ripple
            in a normal window to download and stream.
          </span>
        </div>
      )}

      {workerError && (
        <div className="storage-warning surface" role="alert">
          <strong>The download engine stopped</strong>
          <span>
            Nothing will download until the page is reloaded. Your library and everything already
            downloaded are safe. ({workerError})
          </span>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      )}

      {offline && !storageUnavailable && !workerError && (
        <div className="storage-warning surface offline" role="status">
          <strong>You're offline</strong>
          <span>Downloads carry on automatically as soon as the connection is back.</span>
        </div>
      )}

      {!offline && retrying > 0 && !workerError && (
        <div className="storage-warning surface offline" role="status">
          <strong>{retrying === 1 ? 'A download hit a problem' : `${retrying} downloads hit a problem`}</strong>
          <span>Ripple is retrying on its own. Each row shows why and when the next attempt is.</span>
        </div>
      )}

      {storage && lowStorage && !storageUnavailable && (
        <StorageWarning storage={storage} relief={relief} onAct={() => void takeRelief()}/>
      )}

      {torrents.length > 0 && (
        <section className="stats surface">
          <div className="readouts">
            <div className="stat big">
              <label>Download</label>
              <strong>{speed(totalDown)}</strong>
            </div>
            <div className="stat">
              <label>Upload</label>
              <strong>{speed(totalUp)}</strong>
            </div>
            {/* Which direction this is has to be said. `history` samples download alone, so a
                library that is purely seeding shows a flat 0 here, and beside DOWNLOAD 0 B/s and an
                ACTIVE that used to ignore seeding, the strip read as idle while it was uploading to
                forty peers. */}
            <div className="stat">
              <label>Peak down</label>
              <strong>{speed(peak)}</strong>
            </div>
            <div className="stat">
              <label>Active</label>
              <strong>{active} / {torrents.length}</strong>
            </div>
            <ConnectionStat reachable={reachable}/>
            {storage && <StorageStat storage={storage} low={lowStorage}/>}
            {quota && <QuotaStat quota={quota}/>}
            {/* beside the quota, because both answer "is FKN doing anything for me right now" */}
            <VpnStat reachable={reachable}/>
            <SyncStat state={syncState}/>
          </div>
          <SpeedGraph history={history}/>
        </section>
      )}

      {torrents.length > 0 && (
        <ListToolbar
          filter={listFilter} onFilter={chooseFilter}
          sortKey={listSort.key} sortDir={listSort.dir} onSort={chooseSort}
          view={listView} onView={chooseView}
          temporaryCount={temporaryCount}
        />
      )}

      <main {...interaction}>
        {torrents.length === 0
          ? (
            <div className="empty">
              <h1>Download. Stream.<br/><em>In your browser.</em></h1>
              Ripple is a torrent client that runs entirely in your browser.<br/>
              Watch the video while it downloads, then save it to your disk.
              <div className="hints">
                <span>Paste a magnet link in the bar above</span>
                <span>Or drop a magnet or a .torrent anywhere on this page</span>
              </div>
            </div>
          )
          : visibleRows.length === 0
            ? (
              /**
               * A filter matched nothing. Emphatically NOT the hero above, which says "Ripple is a
               * torrent client that runs entirely in your browser" and would tell somebody with a
               * full library that it is empty. It names the filter as the reason and offers the way
               * back, because a control the person set two seconds ago is still the least obvious
               * thing on the page once the list it emptied is gone.
               */
              <div className="empty">
                {listFilter === 'temporary'
                  ? 'No temporary downloads. Everything here is yours to keep.'
                  : 'Nothing to show with this filter.'}
                <div className="hints">
                  <button type="button" className="link" onClick={() => chooseFilter('all')}>
                    Show everything
                  </button>
                </div>
              </div>
            )
          : listView === 'table'
            ? (
              <TorrentTable
                torrents={visibleRows}
                sortKey={listSort.key} sortDir={listSort.dir} onSort={chooseSort}
                selectedId={selectedId}
                onSelect={onSelect}
                onOptions={onOptions}
              />
            )
            : visibleRows.map((t) => (
            <TorrentRow
              key={t.id}
              t={t}
              saving={saving}
              onToggle={onToggle}
              onSave={onSave}
              onSaveZip={onSaveZip}
              onRecheck={onRecheck}
              onRemove={onRemove}
              onStart={onStart}
              onPause={onPause}
              onEmbed={(t) => openEmbed(subjectOf(t))}
              onOptions={onOptions}
              selected={t.id === selectedId}
              onSelect={onSelect}
              savedToUserStorage={!!folder && permitted && savedToFolder.has(t.id)}
              rates={rowRates[t.id]}
            />
          ))}
        {/**
          * Hiding is only honest if it says so. A persisted filter outlives the session that set it,
          * so without this a person comes back to a library missing gigabytes they can see in the
          * storage readout and cannot see in the list.
          */}
        {/* not while the list is empty: the empty state above already explains it and offers the
            same way back, and two Show buttons is one too many */}
        {hiddenByFilter > 0 && visibleRows.length > 0 && (
          <div className="hidden-note" role="status">
            {hiddenByFilter} temporary {hiddenByFilter === 1 ? 'download' : 'downloads'} hidden
            {hiddenBytes > 0 && ` · ${getHumanReadableByteString(hiddenBytes, true)}`}
            <button type="button" className="link" onClick={() => chooseFilter('all')}>Show</button>
          </div>
        )}
      </main>

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
          name={pendingAdd.name}
          from={pendingAdd.from}
          external={pendingAdd.external}
          files={pendingFiles}
          choices={choices ?? defaultChoices({ fileCount: 0, location: defaultLocation })}
          onChoices={setChoices}
          folderName={folder?.name}
          folderReady={!!folder && permitted}
          onConfirm={confirmAdd}
          onCancel={cancelAdd}
          // switching the step off is offered only for their OWN adds: a setting that could silence
          // the consent step for links from anywhere is not one worth having
          onNeverAsk={pendingAdd.external ? undefined : () => chooseAddDialog(false)}
        />
      )}

      {rateEdit && (rateEdit.scope === 'session' || rateEditTorrent) && (
        <RateLimitDialog
          title={rateEdit.direction === 'down'
            ? (rateEdit.scope === 'session' ? 'Total download rate limit' : 'Download rate limit')
            : (rateEdit.scope === 'session' ? 'Total upload rate limit' : 'Upload rate limit')}
          subject={rateEdit.scope === 'session'
            ? 'Applies to every torrent at once'
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
            )}
          onCancel={() => setRateEdit(null)}
          onApply={applyRateEdit}
        />
      )}

      <footer>
        <a href="https://fkn.app" target="_blank" rel="noreferrer">Powered by FKN</a>
        <Link to="/legal">Legal</Link>
        <Link to="/privacy">Privacy</Link>
        <a
          className="build"
          href={`https://github.com/Banou26/ripple/commit/${__COMMIT_HASH__}`}
          target="_blank"
          rel="noreferrer"
          title={`commit ${__COMMIT_HASH__}`}
        >
          v{__APP_VERSION__} · {__COMMIT_HASH__.slice(0, 7)}
        </a>
        <div className="controls">
          {/* qBittorrent keeps the global limits in its status bar, reachable in one click from
              wherever you are, rather than buried in a preferences tree. Same here. */}
          <div className="folder">
            <span>Speed</span>
            <button
              className={sessionLimits.down > 0 ? 'on' : undefined}
              onClick={() => setRateEdit({ scope: 'session', direction: 'down' })}
              title="The most Ripple will download in total, across every torrent at once."
            >
              {formatLimit(sessionLimits.down)} down
            </button>
            <button
              className={sessionLimits.up > 0 ? 'on' : undefined}
              onClick={() => setRateEdit({ scope: 'session', direction: 'up' })}
              title="The most Ripple will upload in total. Sharing back is what keeps a torrent alive, so leaving room here helps everyone on it."
            >
              {formatLimit(sessionLimits.up)} up
            </button>
          </div>
          <div className="folder">
            <span>On add</span>
            <button
              className={addDialog ? 'on' : undefined}
              onClick={() => chooseAddDialog(!addDialog)}
              title={
                addDialog
                  ? 'Adding a magnet opens a dialog first, so you can pick which files to download and where they go.'
                  : 'A magnet you add starts straight away with every file. Torrents sent from other sites always ask, whatever this says.'
              }
            >
              {addDialog ? 'Ask what to download' : 'Start straight away'}
            </button>
          </div>
          {folderSupported && (
            <div className="folder">
              <span>Auto-save</span>
              {!folder
                ? <button onClick={pickFolder}>Choose folder</button>
                : permitted
                  ? (
                    <>
                      <button className="on" onClick={pickFolder}>{folder.name}</button>
                      <button onClick={clearFolder}>Stop</button>
                    </>
                  )
                  : <button className="on" onClick={allowFolder}>Allow {folder.name}</button>}
              {folder && permitted && (
                <button
                  className={defaultLocation === 'folder' ? 'on' : undefined}
                  onClick={() => chooseDefaultLocation(defaultLocation === 'folder' ? 'browser' : 'folder')}
                  title={
                    defaultLocation === 'folder'
                      ? `New torrents download into browser storage and move into ${folder.name} once they finish. Ripple keeps sharing them from there.`
                      : `New torrents stay in browser storage. Ripple can still copy them into ${folder.name}, and keeps its own copy as well.`
                  }
                >
                  {defaultLocation === 'folder' ? `Files go to ${folder.name}` : 'Files stay in the browser'}
                </button>
              )}
            </div>
          )}
        </div>
      </footer>

      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  )
}

export default Home
