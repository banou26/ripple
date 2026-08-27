import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'

import type { Reachability } from '../torrent/client'
import type { QuotaStatus } from '../torrent/use-quota'
import type { StorageUsage } from '../torrent/use-storage-usage'
import type { SyncReason, SyncState } from '../torrent/use-cloud-backup'

import { Download, FilePlus, Folder, Link2, MoreHorizontal, Pause, Play, PlayCircle } from 'react-feather'
import { ConnectButton } from '@fkn/lib/react'

import { magnetInfoHash } from '../torrent/magnet'
import { useTorrents } from '../torrent/use-torrents'
import { useFolder } from '../torrent/use-folder'
import { useQuota } from '../torrent/use-quota'
import { LOW_STORAGE_BYTES, useStorageUsage } from '../torrent/use-storage-usage'
import { useCloudBackup } from '../torrent/use-cloud-backup'
import { useAccount } from '../torrent/use-account'
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
import { RateLimitDialog } from '../components/rate-limit-dialog'
import { NO_LIMITS, formatLimit, isLimit, limitNote } from '../torrent/rate-limits'
import type { RateLimits } from '../torrent/rate-limits'
import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'
import { pickVideoFile, watchHref } from '../torrent/watch'
import { forgetThumbnail } from '../torrent/thumbnail-store'
import { useThumbnail, useThumbnailGeneration } from '../torrent/use-thumbnails'
import { getHumanReadableByteString } from '../utils/bytes'
import { isAppInstalled, setupHandlers } from '../utils/pwa'
import { useConfirm } from '../components/confirm-dialog'
import { EmbedBuilder } from './embed-builder'
import { TorrentDetailDock } from './torrent-detail'
import { ContextMenu } from '../components/menu'
import type { MenuPosition } from '../components/menu'
import { TorrentOptionsDialog } from '../components/torrent-options-dialog'
import { dropTarget } from './drop-target'
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

const STATE_LABEL: Record<Torrent['state'], string> = {
  downloading: 'Downloading',
  seeding: 'Seeding',
  paused: 'Paused',
  queued: 'Queued',
  done: 'Done',
  error: 'Error',
  missing: 'Files missing',
  retrying: 'Retrying',
  checking: 'Checking',
  starting: 'Starting',
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

const speed = (bps: number) => `${getHumanReadableByteString(bps, true)}/s`

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

const AccountWidget = () => {
  const { info, ready, logout } = useAccount()
  const [busy, setBusy] = useState(false)

  const onDisconnect = async () => {
    setBusy(true)
    try { await logout() } finally { setBusy(false) }
  }

  if (!ready) return null

  if (!info) return <ConnectButton style={{ flex: 'none', width: 140, height: 38 }} />

  return (
    <div className="account">
      <div className="who">
        <span className="name">{info.name || 'Account'}</span>
        <span className={`tier ${info.premium ? 'premium' : 'free'}`}>{info.premium ? 'Premium' : 'Free'}</span>
      </div>
      <button className="disconnect" disabled={busy} onClick={onDisconnect}>Disconnect</button>
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
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1100px 500px at 75% -5%, #2b1f3f 0%, transparent 60%),
    radial-gradient(900px 420px at -10% 110%, #221a31 0%, transparent 55%),
    #16131c;
  color: #f4f2f8;
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
    background: rgba(30, 26, 40, 0.6);
    border-bottom: 1px solid rgba(44, 39, 55, 0.9);
    backdrop-filter: blur(12px) saturate(1.2);

    .wordmark {
      font-size: 1.35rem;
      font-weight: 900;
      letter-spacing: 0.06em;
      background: linear-gradient(90deg, #fbbf24, #f97316);
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
    }

    /**
     * Wraps, and the field keeps a width worth reading.
     *
     * Three unshrinkable controls in a row that could not wrap took every pixel out of the only
     * flexible item: the field measured 52px at a 900px viewport and 34px at 800px, where the form
     * itself then overflowed and the document grew a horizontal scrollbar. A zero minimum width on
     * the field is what allowed that, and the field is the one thing here that must not shrink,
     * since its placeholder is the page's whole explanation of how to add anything.
     */
    form {
      flex: 1;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-width: 240px;

      /* the file picker's own input is hidden inside its label and must not take this treatment */
      input:not([type='file']) {
        flex: 1;
        min-width: 210px;
        background: rgba(22, 19, 28, 0.8);
        border: 1px solid #2c2737;
        border-radius: 6px;
        padding: 8px 16px;
        color: #f4f2f8;
        font-size: 0.9rem;
        outline: none;
        transition: border-color 120ms ease, box-shadow 120ms ease;

        &::placeholder {
          color: #8b8499;
        }

        &:focus {
          border-color: #f97316;
          box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
        }

        /* the same amber the page-wide overlay uses, so a drag reads as landing in one place */
        &[data-drop] {
          border-color: #fbbf24;
          border-style: dashed;
          background: rgba(249, 115, 22, 0.08);
          box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
        }
      }

      button,
      .file-button {
        flex: none;
        border-radius: 6px;
        padding: 8px 18px;
        font-size: 0.85rem;
        font-weight: 700;
        white-space: nowrap;

        /**
         * Add reads exactly like the buttons beside it.
         *
         * It used to be solid white, which made it the brightest thing on the page for an action
         * that is not more important than the ones next to it: it is simply the one that happens to
         * be first. The white was emphasis with nothing behind it.
         */
        &.primary,
        &.ghost {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          border: 1px solid #3a3447;
          background: ${CONTROL_BG};
          color: #f4f2f8;

          svg { width: 15px; height: 15px; }

          &:hover:not(:disabled) {
            background: ${CONTROL_HOVER_BG};
            border-color: rgba(249, 115, 22, 0.45);
          }

          &:active:not(:disabled) {
            transform: scale(0.98);
          }
        }

        /**
         * A control that cannot act has to LOOK like one.
         *
         * Add is disabled whenever the field holds nothing to add, and it used to keep its full
         * contrast and its hover while disabled, so pressing it was indistinguishable from pressing
         * a live button that silently did nothing. That is the whole of "Add does nothing".
         */
        &:disabled {
          opacity: 0.4;
          cursor: default;
        }
      }

      /* a label wrapping a hidden file input, so it needs the cursor a button has by default */
      .file-button {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        cursor: pointer;
        user-select: none;
        /* so the absolutely positioned input below is contained rather than laid out off the page */
        position: relative;
        overflow: hidden;

        svg { width: 15px; height: 15px; }

        /**
         * Hidden without being removed, so it can still be reached by keyboard.
         *
         * A display:none input is out of the accessibility tree AND out of the tab order,
         * which would leave the only .torrent picker on the page unreachable to anybody not using a
         * mouse. Sized to nothing instead, with the label taking the focus ring on its behalf.
         */
        input {
          position: absolute;
          width: 1px;
          height: 1px;
          opacity: 0;
          pointer-events: none;
        }

        &:focus-within {
          background: ${CONTROL_HOVER_BG};
          border-color: #f97316;
          box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.18);
        }

        &[aria-disabled='true'] {
          opacity: 0.4;
          cursor: default;
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
      border: 1px solid #3a3447;
      background: ${CONTROL_BG};
      color: #f4f2f8;

      svg { width: 15px; height: 15px; }

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: rgba(249, 115, 22, 0.45);
      }
    }

    .account {
      flex: none;
      display: flex;
      align-items: center;
      gap: 10px;

      .who {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 1px;
        line-height: 1.15;
        min-width: 0;
      }

      .name {
        font-size: 0.82rem;
        font-weight: 600;
        color: #f4f2f8;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tier {
        font-size: 0.6rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .tier.premium {
        color: #7dd3a0;
      }

      .tier.free {
        color: #8b8499;
      }

      .disconnect {
        flex: none;
        border-radius: 6px;
        padding: 7px 14px;
        font-size: 0.78rem;
        font-weight: 700;
        border: 1px solid #3a3447;
        background: ${CONTROL_BG};
        color: #f4f2f8;

        &:hover {
          background: ${CONTROL_HOVER_BG};
          border-color: rgba(249, 115, 22, 0.45);
        }
      }
    }

    .account button:disabled {
      opacity: 0.6;
      cursor: default;
    }
  }

  .surface {
    background: rgba(30, 26, 40, 0.66);
    border: 1px solid rgba(44, 39, 55, 0.9);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.03),
      0 4px 14px -4px rgba(0, 0, 0, 0.35),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    backdrop-filter: blur(12px) saturate(1.2);
  }

  .storage-warning {
    flex: none;
    margin: 14px 16px 0;
    padding: 14px 18px;
    border-radius: 8px;
    border: 1px solid rgba(249, 115, 22, 0.45);
    display: flex;
    flex-direction: column;
    gap: 4px;

    strong { color: #fbbf24; font-size: 0.95rem; }
    span { color: #8b8499; font-size: 0.85rem; line-height: 1.6; }

    button {
      align-self: flex-start;
      margin-top: 6px;
      border-radius: 6px;
      padding: 6px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      border: 1px solid #3a3447;
      background: ${CONTROL_BG};
      color: #f4f2f8;

      &:hover {
        background: ${CONTROL_HOVER_BG};
        border-color: rgba(249, 115, 22, 0.35);
      }
    }

    /* Recoverable on its own, so it reads as a notice rather than an alarm. */
    &.offline {
      border-color: rgba(139, 132, 153, 0.35);

      strong { color: #c9c4d4; }
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
        color: #8b8499;
      }

      strong {
        font-size: 1.05rem;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      &.storage.low strong {
        color: #fbbf24;
      }

      &.big strong {
        font-size: 1.7rem;
        line-height: 1.1;
        background: linear-gradient(90deg, #fbbf24, #f97316);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
      }

      &.quota strong.ok {
        color: #7dd3a0;
      }

      &.quota.throttled strong {
        color: #fbbf24;
      }

      &.quota a {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #fbbf24;
        text-decoration: none;
      }

      &.quota a:hover {
        text-decoration: underline;
      }

      &.sync strong.ok {
        color: #7dd3a0;
      }

      &.sync.error strong {
        color: #fbbf24;
      }
    }

    svg {
      flex: 1;
      min-width: 120px;
      height: 52px;
      align-self: center;

      polyline {
        fill: none;
        stroke: #f97316;
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
      border-color: rgba(249, 115, 22, 0.55);
      background: rgba(41, 33, 46, 0.8);
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
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;

    &:hover {
      border-color: rgba(249, 115, 22, 0.35);
      transform: translateY(-1px);
      box-shadow:
        0 0 0 1px rgba(249, 115, 22, 0.12),
        0 8px 20px -6px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
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
      background: #221a31;
      border: 1px solid rgba(44, 39, 55, 0.9);
    }

    /* Held even when there is no picture, so every row's text starts at the same place. An absent
       left column would make a list of mixed torrents look ragged rather than compact. */
    .poster.placeholder {
      display: grid;
      place-items: center;
      border-color: rgba(249, 115, 22, 0.25);
      background: rgba(249, 115, 22, 0.06);
      color: rgba(251, 191, 36, 0.55);

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
        color: #b6b0c4;
      }
    }

    .badge {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 10px;
      border-radius: 4px;
      background: #2c2737;
      border: 1px solid transparent;
      color: #a39db3;

      &::before {
        content: '';
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.7;
      }

      &.downloading {
        color: #fbbf24;
        background: #fbbf2414;
        border-color: #fbbf2430;

        &::before {
          animation: pulse 1.6s ease-in-out infinite;
        }
      }
      &.seeding { color: #2dd4bf; background: #2dd4bf14; border-color: #2dd4bf30; }

      /* Working, not waiting: the progress bar tracks the check while this runs. */
      &.checking {
        color: #60a5fa;
        background: #60a5fa14;
        border-color: #60a5fa30;

        &::before {
          animation: pulse 1.6s ease-in-out infinite;
        }
      }

      /* Connecting rather than idle, so it pulses like the other in-progress states. Grey, because
         it says nothing yet about whether this torrent is downloading, seeding or finished. */
      &.starting {
        color: #8b8499;
        background: #8b849914;
        border-color: #8b849930;

        &::before {
          animation: pulse 1.6s ease-in-out infinite;
        }
      }

      &.done { color: #c084fc; background: #c084fc14; border-color: #c084fc30; }
      &.error { color: #ef4444; background: #ef444414; border-color: #ef444430; }
      &.missing { color: #8b8499; background: #8b849914; border-color: #8b849930; }

      &.retrying {
        color: #f97316;
        background: #f9731614;
        border-color: #f9731630;

        &::before {
          animation: pulse 1.6s ease-in-out infinite;
        }
      }
    }

    .retry {
      color: #f97316;
      overflow-wrap: anywhere;
    }

    /* thin, and inside the body rather than owning a row of its own */
    .bar {
      height: 4px;
      border-radius: 2px;
      background: rgba(44, 39, 55, 0.9);
      overflow: hidden;

      .fill {
        height: 100%;
        border-radius: 2px;
        background: linear-gradient(90deg, #fbbf24, #f97316);
        box-shadow: 0 0 10px rgba(249, 115, 22, 0.45);
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
      color: #a39db3;
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;

      /* a ceiling is a setting rather than a measurement, so it is marked off from the live numbers
         beside it instead of reading as another one of them */
      .limit {
        padding: 0 6px;
        border-radius: 4px;
        color: #d9b38c;
        background: rgba(249, 115, 22, 0.12);
        border: 1px solid rgba(249, 115, 22, 0.22);
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

      .down-fill { fill: rgba(249, 115, 22, 0.18); }

      .down-line {
        fill: none;
        stroke: #f97316;
        stroke-width: 1.2;
        vector-effect: non-scaling-stroke;
      }

      /* thinner and cooler than the download line, so the two are told apart at 26px without a key */
      .up-line {
        fill: none;
        stroke: #7dd3a0;
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
        border: 1px solid #3a3447;
        background: ${CONTROL_BG};
        color: #f4f2f8;

        &:hover {
          background: ${CONTROL_HOVER_BG};
          border-color: rgba(249, 115, 22, 0.35);
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
        color: #a39db3;
        font-size: 0.8rem;
        user-select: none;
        transition: color 120ms ease;

        &:hover {
          color: #c9c4d4;
        }
      }

      .tabs {
        display: flex;
        gap: 4px;
        margin: 10px 0 8px;
        padding: 3px;
        border-radius: 6px;
        background: rgba(22, 19, 28, 0.8);
        width: fit-content;
        max-width: 100%;
        flex-wrap: wrap;

        button {
          border: none;
          border-radius: 4px;
          background: none;
          color: #a39db3;
          padding: 4px 12px;
          font-size: 0.75rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          gap: 6px;

          &:hover {
            color: #f4f2f8;
          }

          /* The selected tab, which has to stand out from the three beside it and no further. It was
             solid white, and once Watch and Add stopped being white it was the only such thing left
             on the page, which read as something that had been missed. A raised surface separates it
             from the sunken track behind it without shouting. */
          &[data-on] {
            background: ${CONTROL_HOVER_BG};
            color: #f4f2f8;
          }

          .count {
            font-variant-numeric: tabular-nums;
            font-weight: 600;
            opacity: 0.7;
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
        color: #8b8499;
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
        border-bottom: 1px solid rgba(44, 39, 55, 0.9);
        font-size: 0.8rem;

        label {
          flex: none;
          color: #8b8499;
        }

        span {
          min-width: 0;
          overflow-wrap: anywhere;
          text-align: right;
          color: #d6d1e0;
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
        border-top: 1px solid rgba(44, 39, 55, 0.9);
        font-size: 0.8rem;

        &:first-of-type {
          border-top: none;
        }

        /* sticky so a long swarm keeps its column names while it scrolls */
        &.head {
          position: sticky;
          top: 0;
          z-index: 1;
          background: #1c1826;
          border-top: none;
          padding-top: 2px;
          font-size: 0.65rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: #8b8499;
        }

        .name {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          overflow-wrap: anywhere;
          color: #b6b0c4;

          .dim {
            color: #6f6980;
          }
        }

        .client {
          flex: none;
          width: 130px;
          color: #8b8499;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;

          &.ok {
            color: #7dd3a0;
          }

          &.warn {
            color: #ef4444;
          }
        }

        .num {
          flex: none;
          width: 74px;
          text-align: right;
          color: #8b8499;
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
          color: #a39db3;
          background: rgba(58, 52, 71, 0.6);
        }

        button {
          flex: none;
          border: 1px solid #3a3447;
          border-radius: 4px;
          background: ${CONTROL_BG};
          color: #f4f2f8;
          padding: 4px 12px;
          font-size: 0.75rem;

          &:hover {
            background: ${CONTROL_HOVER_BG};
            border-color: rgba(249, 115, 22, 0.35);
          }

          &:disabled {
            opacity: 0.6;
            cursor: default;
          }
        }
      }
    }
  }

  .empty {
    position: relative;
    margin: auto;
    text-align: center;
    color: #8b8499;
    font-size: 0.95rem;
    line-height: 1.7;
    padding: 24px;

    &::before, &::after {
      content: '';
      position: absolute;
      border-radius: 999px;
      filter: blur(70px);
      pointer-events: none;
    }

    &::before {
      width: 280px;
      height: 280px;
      top: -80px;
      left: -60px;
      background: #f59e0b;
      opacity: 0.14;
    }

    &::after {
      width: 320px;
      height: 320px;
      bottom: -100px;
      right: -80px;
      background: #7c3aed;
      opacity: 0.16;
    }

    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.7rem, 4.5vw, 2.6rem);
      font-weight: 900;
      letter-spacing: -0.01em;
      line-height: 1.15;
      color: #f4f2f8;

      em {
        font-style: normal;
        background: linear-gradient(90deg, #fbbf24, #f97316, #c084fc);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
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
        border: 1px solid #2c2737;
        background: rgba(30, 26, 40, 0.66);
        font-size: 0.78rem;
        color: #a39db3;
      }
    }
  }

  /**
   * A frame with the message sitting in it, rather than a page-sized amber flood.
   *
   * The wash is gone from the fill and lives on the message alone: the frame is what says WHERE the
   * drop lands, and it can say that at the edge of the window without tinting everything the person
   * is looking at.
   */
  .drop {
    position: fixed;
    inset: 12px;
    z-index: 20;
    display: grid;
    place-items: center;
    border: 2px dashed rgba(249, 115, 22, 0.55);
    border-radius: 8px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 150ms ease;

    span {
      padding: 10px 22px;
      border-radius: 8px;
      background: rgba(22, 19, 28, 0.92);
      border: 1px solid rgba(249, 115, 22, 0.35);
      box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.7);
      color: #fbbf24;
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
    background: rgba(30, 26, 40, 0.6);
    border-top: 1px solid rgba(44, 39, 55, 0.9);
    backdrop-filter: blur(12px) saturate(1.2);
    font-size: 0.78rem;
    color: #8b8499;

    a {
      color: #8b8499;
      transition: color 120ms ease;

      &:hover {
        color: #c9c4d4;
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
        border: 1px solid #2c2737;
        background: ${CONTROL_BG};
        color: #8b8499;

        &:hover {
          background: ${CONTROL_HOVER_BG};
          color: #c9c4d4;
          border-color: #3a3447;
        }

        &.on {
          color: #f4f2f8;
          border-color: #f97316;
        }
      }
    }
  }

  .toast {
    position: fixed;
    bottom: 52px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(30, 26, 40, 0.85);
    border: 1px solid rgba(58, 52, 71, 0.9);
    border-radius: 8px;
    padding: 11px 20px;
    font-size: 0.85rem;
    backdrop-filter: blur(12px) saturate(1.2);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.04),
      0 10px 34px rgba(0, 0, 0, 0.45);
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

  @keyframes pulse {
    0%, 100% { opacity: 0.7; }
    50% { opacity: 0.25; }
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
      <defs>
        <linearGradient id="speed-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f97316" stopOpacity="0.3"/>
          <stop offset="100%" stopColor="#f97316" stopOpacity="0.02"/>
        </linearGradient>
      </defs>
      <polygon fill="url(#speed-fill)" points={`${((offset / (HISTORY - 1)) * w).toFixed(2)},${h} ${points} ${w},${h}`}/>
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
 * A flat fill rather than the page graph's gradient, deliberately: a gradient needs a `<defs>` with
 * an id, and an id repeated once per row is invalid in the document and resolves to whichever copy
 * came first. At 26 pixels tall the gradient was not visible anyway.
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

  const [embedOpen, setEmbedOpen] = useState(false)
  const [embedId, setEmbedId] = useState<string | null>(null)

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
  const claimRef = useRef<{ hash: string } | { before: Set<string> } | null>(null)

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
   * The one place a drop is turned into an add, shared by the window and by the magnet field.
   *
   * Both targets have to agree, and the field cannot simply let the drop bubble: it stops
   * propagation so the page-wide overlay does not also claim the drop, which means the window
   * listener never runs and this is the only handler that fires.
   */
  const acceptDrop = useCallback((data: DataTransfer | null) => {
    // Armed BEFORE the add, because `before` has to be the list as it was; reading it afterwards
    // would already contain the new torrent and nothing would ever look new.
    const claim = (next: { hash: string } | { before: Set<string> }) => {
      if (embedOpen) claimRef.current = next
    }
    if (data?.files?.length) {
      claim({ before: new Set(torrentsRef.current.map((t) => t.id)) })
      void addTorrentFiles(data.files)
      return
    }
    const text = data?.getData('text') ?? ''
    if (!text.trim()) return
    const hash = magnetInfoHash(text.trim())
    if (hash) claim({ hash })
    if (!commitMagnet(text)) showToast('Not a magnet link')
  }, [addTorrentFiles, commitMagnet, embedOpen, showToast])

  // The claim is resolved here rather than at the drop, because this is the first render at which
  // the torrent it names exists. A claim that never resolves (a bad file, an add that failed) is
  // dropped when the panel closes, so it cannot adopt an unrelated torrent added minutes later.
  useEffect(() => {
    const claim = claimRef.current
    if (!claim) return
    const found = 'hash' in claim
      ? torrents.find((t) => t.infoHash === claim.hash)
      : torrents.find((t) => !claim.before.has(t.id))
    if (!found) return
    claimRef.current = null
    setEmbedId(found.id)
  }, [torrents])

  const openEmbed = useCallback((id: string | null) => {
    claimRef.current = null
    setEmbedId(id)
    setEmbedOpen(true)
  }, [])

  const closeEmbed = useCallback(() => {
    claimRef.current = null
    setEmbedOpen(false)
  }, [])

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
    setFirstLast: (on) => client.setPlan(Number(t.id), { wanted: t.wantedFiles, firstLast: on }),
    pickFolder,
    limitRate: (direction) => setRateEdit({ scope: { torrent: t.id }, direction }),
    // the row's Watch is a <Link>; from a menu it has to navigate itself
    watch: () => { const href = watchHref(t); if (href) navigate(href) },
    save: () => ((t.files?.length ?? 0) > 1 ? onSaveZip(t) : onSave(t, pickVideoFile(t.files))),
    embed: () => openEmbed(t.id),
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
  const active = torrents.filter((t) => t.state === 'downloading').length

  const hasLive = torrents.some((t) => t.state !== 'missing')
  const quota = useQuota(hasLive)
  const syncState = useCloudBackup()
  const retrying = torrents.filter((t) => t.state === 'retrying').length
  const storage = useStorageUsage(torrents.length)
  const lowStorage = !!storage && storage.limitBytes - storage.usedBytes < LOW_STORAGE_BYTES

  /**
   * The ONE surface that announces the drop, chosen in `dropTarget` and read from nowhere else.
   *
   * Every surface below is driven by comparing against this, rather than by a flag of its own. That
   * is the whole point: the same defect shipped twice from three independent booleans, first the
   * page lighting alongside the magnet field, then the page lighting alongside the share panel's
   * box, because two of them were still reading one value. A single name cannot describe two places.
   *
   * The share panel only draws a drop box while it is waiting to be given a torrent; once one is
   * chosen it shows that torrent's link options instead, and there is nothing there for a drop to
   * land on, so the page-wide overlay is the right surface again.
   */
  const target = dropTarget({
    dragging,
    overField: fieldDrag,
    pickOpen: embedOpen && !torrents.some((t) => t.id === embedId),
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
        <span className="wordmark">Ripple</span>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (commitMagnet(input)) setInput('')
            else if (input.trim()) showToast('Not a magnet link')
          }}
        >
          {/**
            * The field takes a dropped .torrent as well as typed text, and says so.
            *
            * It stops the drop propagating so the page-wide overlay does not light up over a target
            * that is already lit; `endDrag` is what keeps the window's depth count honest across
            * that, since its own drop listener never runs.
            */}
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a magnet link, or drop a .torrent"
            spellCheck={false}
            disabled={storageUnavailable}
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
          />
          {/* disabled on an empty field rather than accepting the click and doing nothing with it */}
          <button className="primary" type="submit" disabled={storageUnavailable || !input.trim()}>Add</button>
          {/**
            * The only way to pick a .torrent that is not a drag.
            *
            * There was none: the file could be dropped or handed over by the OS through the
            * installed app, and a browser that cannot drag (a touch screen, a file manager the page
            * cannot reach) had no route at all. A label wrapping a hidden input is what gives it the
            * native picker without a click handler.
            */}
          <label className="ghost file-button" aria-disabled={storageUnavailable || undefined}>
            <FilePlus/>
            Open file
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
          title="Make a link that plays or downloads one of your torrents on any device"
          onClick={() => (embedOpen ? closeEmbed() : openEmbed(embedId))}
        >
          <Link2/>
          Share link
        </button>
        {showSetup && (
          <button className="setup" type="button" onClick={() => { void onSetupHandlers() }}>
            Open torrents with Ripple
          </button>
        )}
        <AccountWidget/>
      </header>

      {embedOpen && (
        <EmbedBuilder
          torrents={torrents}
          torrent={torrents.find((t) => t.id === embedId) ?? null}
          dragging={target === 'pick'}
          onSelect={setEmbedId}
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

      {/* role=status rather than alert: the browser's budget drifts on its own, so this can appear and clear without the user doing anything */}
      {storage && lowStorage && !storageUnavailable && (
        <div className="storage-warning surface" role="status">
          <strong>Running out of room</strong>
          <span>
            Ripple has used {getHumanReadableByteString(storage.usedBytes, true)} of the
            {' '}{getHumanReadableByteString(storage.limitBytes, true)} your browser allows this
            site, counting everything it keeps here. Downloads stop when that runs out.
            Removing a torrent frees its files.
            {!storage.persisted && ' Storage here is best effort, so the browser can also clear it on its own when the device gets tight.'}
          </span>
        </div>
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
            <div className="stat">
              <label>Peak</label>
              <strong>{speed(peak)}</strong>
            </div>
            <div className="stat">
              <label>Active</label>
              <strong>{active} / {torrents.length}</strong>
            </div>
            <ConnectionStat reachable={reachable}/>
            {storage && <StorageStat storage={storage} low={lowStorage}/>}
            {quota && <QuotaStat quota={quota}/>}
            <SyncStat state={syncState}/>
          </div>
          <SpeedGraph history={history}/>
        </section>
      )}

      <main>
        {torrents.length === 0
          ? (
            <div className="empty">
              <h1>Download. Stream.<br/><em>In your browser.</em></h1>
              Ripple is a torrent client that runs entirely in your browser.<br/>
              Watch the video while it downloads, then save it to your disk.
              <div className="hints">
                <span>Paste a magnet link above, then press Add</span>
                <span>Or press Open file to pick a .torrent</span>
                <span>Or drop either one anywhere on this page</span>
              </div>
            </div>
          )
          : torrents.map((t) => (
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
              onEmbed={(t) => openEmbed(t.id)}
              onOptions={onOptions}
              selected={t.id === selectedId}
              onSelect={onSelect}
              savedToUserStorage={!!folder && permitted && savedToFolder.has(t.id)}
              rates={rowRates[t.id]}
            />
          ))}
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
