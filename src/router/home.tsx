import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import type { QuotaStatus } from '../torrent/use-quota'
import type { StorageUsage } from '../torrent/use-storage-usage'
import type { SyncStatus } from '../torrent/use-cloud-backup'

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
import { pickVideoFile, watchHref } from '../torrent/watch'
import { getHumanReadableByteString } from '../utils/bytes'
import { isAppInstalled, setupHandlers } from '../utils/pwa'

const isMagnet = (s: string): boolean => /^magnet:\?/i.test(s.trim())

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

const SyncStat = ({ status }: { status: SyncStatus }) => {
  if (status === 'off') return null
  const label = status === 'syncing' ? 'Syncing…' : status === 'error' ? 'Sync failed' : 'Synced'
  return (
    <div className={'stat sync' + (status === 'error' ? ' error' : '')}>
      <label>Library</label>
      <strong className={status === 'synced' ? 'ok' : undefined}>{label}</strong>
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

const style = css`
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

    form {
      flex: 1;
      display: flex;
      gap: 8px;
      min-width: 240px;

      input {
        flex: 1;
        min-width: 0;
        background: rgba(22, 19, 28, 0.8);
        border: 1px solid #2c2737;
        border-radius: 999px;
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
      }

      button {
        flex: none;
        border-radius: 999px;
        padding: 8px 18px;
        font-size: 0.85rem;
        font-weight: 700;

        &.primary {
          border: none;
          background: #fff;
          color: #16131c;
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);

          &:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
          }

          &:active {
            transform: scale(0.98);
          }
        }

        &.ghost {
          border: 1px solid #3a3447;
          background: none;
          color: #f4f2f8;

          &:hover {
            background: #241e30;
            border-color: rgba(249, 115, 22, 0.45);
          }
        }
      }
    }

    .setup {
      flex: none;
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 0.85rem;
      font-weight: 700;
      border: 1px solid #3a3447;
      background: none;
      color: #f4f2f8;

      &:hover {
        background: #241e30;
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
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 0.78rem;
        font-weight: 700;
        border: 1px solid #3a3447;
        background: none;
        color: #f4f2f8;

        &:hover {
          background: #241e30;
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
    border-radius: 14px;
    border: 1px solid rgba(249, 115, 22, 0.45);
    display: flex;
    flex-direction: column;
    gap: 4px;

    strong { color: #fbbf24; font-size: 0.95rem; }
    span { color: #8b8499; font-size: 0.85rem; line-height: 1.6; }

    button {
      align-self: flex-start;
      margin-top: 6px;
      border-radius: 999px;
      padding: 6px 16px;
      font-size: 0.8rem;
      font-weight: 700;
      border: 1px solid #3a3447;
      background: none;
      color: #f4f2f8;

      &:hover {
        background: #241e30;
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
    border-radius: 14px;

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
    flex: none;
    border-radius: 14px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;

    &:hover {
      border-color: rgba(249, 115, 22, 0.35);
      transform: translateY(-1px);
      box-shadow:
        0 0 0 1px rgba(249, 115, 22, 0.12),
        0 8px 20px -6px rgba(0, 0, 0, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.04);
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
      border-radius: 999px;
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

    .bar {
      height: 6px;
      border-radius: 999px;
      background: rgba(44, 39, 55, 0.9);
      overflow: hidden;

      .fill {
        height: 100%;
        border-radius: 999px;
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
    }

    .actions {
      flex: none;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;

      a, button {
        border-radius: 999px;
        padding: 6px 14px;
        font-size: 0.8rem;
        font-weight: 700;
      }

      .primary {
        border: none;
        background: #fff;
        color: #16131c;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
        transition: transform 120ms ease, box-shadow 120ms ease;

        &:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
        }
      }

      button {
        border: 1px solid #3a3447;
        background: none;
        color: #f4f2f8;

        &:hover {
          background: #241e30;
          border-color: rgba(249, 115, 22, 0.35);
        }

        &:disabled {
          opacity: 0.6;
          cursor: default;
        }
      }
    }

    .files {
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

      .file {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 0;
        border-top: 1px solid rgba(44, 39, 55, 0.9);
        font-size: 0.8rem;

        &:first-of-type {
          margin-top: 8px;
        }

        .name {
          flex: 1;
          min-width: 0;
          overflow-wrap: anywhere;
          color: #b6b0c4;
        }

        .size {
          flex: none;
          color: #8b8499;
          font-variant-numeric: tabular-nums;
        }

        button {
          flex: none;
          border: 1px solid #3a3447;
          border-radius: 999px;
          background: none;
          color: #f4f2f8;
          padding: 4px 12px;
          font-size: 0.75rem;

          &:hover {
            background: #241e30;
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
        border-radius: 999px;
        border: 1px solid #2c2737;
        background: rgba(30, 26, 40, 0.66);
        font-size: 0.78rem;
        color: #a39db3;
      }
    }
  }

  .drop {
    position: fixed;
    inset: 12px;
    z-index: 20;
    display: grid;
    place-items: center;
    border: 2px dashed rgba(249, 115, 22, 0.55);
    border-radius: 18px;
    background: rgba(249, 115, 22, 0.06);
    color: #fbbf24;
    font-size: 1.15rem;
    font-weight: 800;
    letter-spacing: 0.02em;
    pointer-events: none;
    opacity: 0;
    transition: opacity 150ms ease;
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
        border-radius: 999px;
        border: 1px solid #2c2737;
        background: none;
        color: #8b8499;

        &:hover {
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
    border-radius: 12px;
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

    .torrent .actions {
      flex-basis: 100%;
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
}

const MissingRow = ({ t, onStart, onRemove }: Pick<RowProps, 't' | 'onStart' | 'onRemove'>) => (
  <div className="torrent surface missing">
    <div className="title">
      <strong>{t.name}</strong>
      <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
    </div>
    <div className="row">
      <div className="meta">
        <span>Files aren't on this device · download to fetch them</span>
      </div>
      <div className="actions">
        <button className="primary" onClick={() => onStart(t)}>Download</button>
        <button onClick={() => onRemove(t)}>Remove</button>
      </div>
    </div>
  </div>
)

const TorrentRow = ({ t, saving, onToggle, onSave, onSaveZip, onRecheck, onRemove, onStart, onPause }: RowProps) => {
  if (t.state === 'missing') return <MissingRow t={t} onStart={onStart} onRemove={onRemove}/>
  const href = watchHref(t)
  const mainIndex = pickVideoFile(t.files)
  const multi = (t.files?.length ?? 0) > 1
  const mainSaving = saving[savingKey(t.id, multi ? -1 : mainIndex)]
  const complete = t.progress >= 1
  return (
    <div className="torrent surface">
      <div className="title">
        <strong>{t.name}</strong>
        <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
        <span className="pct">{(t.progress * 100).toFixed(t.progress < 1 ? 1 : 0)}%</span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${Math.min(100, t.progress * 100)}%` }}/>
      </div>
      <div className="row">
        <div className="meta">
          <span>{getHumanReadableByteString(t.downloaded, true)} / {getHumanReadableByteString(t.size, true)}</span>
          <span>↓ {speed(t.down)}</span>
          <span>↑ {speed(t.up)}</span>
          <span>{t.peers} peers</span>
          {t.state === 'downloading' && t.eta !== '-' && <span>{t.eta} left</span>}
          {t.retry && <span className="retry">{retryLine(t, t.retry)}</span>}
        </div>
        <div className="actions">
          {href && <Link className="primary" to={href}>Watch</Link>}
          {!!t.files?.length && complete && (
            <button onClick={() => multi ? onSaveZip(t) : onSave(t, mainIndex)} disabled={mainSaving != null}>
              {mainSaving != null ? `Saving ${Math.round(mainSaving * 100)}%` : multi ? 'Save as zip' : 'Save to disk'}
            </button>
          )}
          {t.state !== 'checking' && (
            <button onClick={() => onToggle(t)}>
              {t.state === 'retrying' ? 'Retry now' : t.state === 'paused' || t.state === 'queued' ? 'Resume' : 'Pause'}
            </button>
          )}
          {t.state === 'retrying' && <button onClick={() => onPause(t)}>Pause</button>}
          {!!t.files?.length && t.state !== 'checking' && (
            <button onClick={() => onRecheck(t)}>Recheck</button>
          )}
          <button onClick={() => onRemove(t)}>Remove</button>
        </div>
      </div>
      {(t.files?.length ?? 0) > 1 && (
        <details className="files">
          <summary>{t.files!.length} files</summary>
          {t.files!.map((f, i) => {
            const s = saving[savingKey(t.id, i)]
            return (
              <div className="file" key={i}>
                <span className="name">{f.name}</span>
                <span className="size">{getHumanReadableByteString(f.size, true)}</span>
                <button onClick={() => onSave(t, i)} disabled={s != null}>
                  {s != null ? `${Math.round(s * 100)}%` : 'Save'}
                </button>
              </div>
            )
          })}
        </details>
      )}
    </div>
  )
}

const Home = () => {
  const { torrents, addMagnet, addTorrentFile, pause, resume, retry, recheck, remove, start, removeMissing, storageUnavailable, workerError, client } = useTorrents()
  const [input, setInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState<Record<string, number>>({})
  const [offline, setOffline] = useState(() => navigator.onLine === false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

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

  const [showSetup] = useState(() => !isAppInstalled())
  const onSetupHandlers = useCallback(async () => {
    const outcome = await setupHandlers()
    if (outcome === 'installed') showToast('Ripple installed. Torrent files and magnet links open here now.')
    else if (outcome === 'magnet-registered') showToast('Confirm the prompt to route magnet links to Ripple.')
    else if (outcome === 'already-installed') showToast('Ripple is already set up on this device.')
    else showToast('Use your browser menu to install Ripple as an app.')
  }, [showToast])

  const commitMagnet = useCallback((raw: string): boolean => {
    const text = raw.trim()
    if (!isMagnet(text)) return false
    const ih = magnetInfoHash(text)
    // Re-adding would join the swarm and start downloading; a synced "Files missing" torrent must only start from its explicit Download button
    if (ih && torrentsRef.current.some((t) => t.magnet && magnetInfoHash(t.magnet) === ih)) {
      showToast('Already in your list')
      return true
    }
    addMagnet(text)
    showToast('Magnet added')
    return true
  }, [addMagnet, showToast])

  const addTorrentFiles = useCallback(async (files: Iterable<File>) => {
    for (const file of [...files]) {
      if (!/\.torrent$/i.test(file.name)) continue
      addTorrentFile(new Uint8Array(await file.arrayBuffer()))
      showToast(`${file.name} added`)
    }
  }, [addTorrentFile, showToast])

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      const text = e.clipboardData?.getData('text') ?? ''
      if (isMagnet(text)) { e.preventDefault(); commitMagnet(text) }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [commitMagnet])

  // dragenter/dragleave fire per element, so a depth counter keeps the overlay from flickering while the drag crosses children
  const [dragging, setDragging] = useState(false)
  useEffect(() => {
    let depth = 0
    const onDragEnter = () => { if (++depth === 1) setDragging(true) }
    const onDragLeave = () => { if (--depth <= 0) { depth = 0; setDragging(false) } }
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files?.length) addTorrentFiles(e.dataTransfer.files)
      else commitMagnet(e.dataTransfer?.getData('text') ?? '')
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [addTorrentFiles, commitMagnet])

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

  const onRemove = (t: Torrent) => {
    if (t.state === 'missing') { if (t.infoHash) removeMissing(t.infoHash) }
    else remove(Number(t.id), true)
  }

  const onRecheck = (t: Torrent) => {
    recheck(Number(t.id))
    showToast(`Checking ${t.name} against the files on disk`)
  }

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

  // The backoff is what makes retrying safe: this effect re-runs twice a second from the state tick, so a bare retry would hammer the disk
  const syncAtRef = useRef(new Map<string, number>())
  // In-flight copies are tracked apart from the backoff: a copy can run longer than the retry window while this effect re-runs twice a second, and a swap-file
  // writable leaves the destination at its old size until close(), so the size-based idempotence check cannot catch a second pass over the same files
  const syncingRef = useRef(new Set<string>())
  const folderGenerationRef = useRef(0)
  useEffect(() => { folderGenerationRef.current++; syncAtRef.current.clear() }, [folder, permitted])
  // Both maps are keyed by the session handle, which names a different torrent after the engine moves to another tab
  useEffect(() => client.onEngineReset(() => { syncAtRef.current.clear(); syncingRef.current.clear() }), [client])
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

  const [history, setHistory] = useState<number[]>([])
  useEffect(() => {
    setHistory((prev) => [...prev.slice(-(HISTORY - 1)), torrents.reduce((n, t) => n + t.down, 0)])
  }, [torrents])

  const totalDown = torrents.reduce((n, t) => n + t.down, 0)
  const totalUp = torrents.reduce((n, t) => n + t.up, 0)
  const peak = Math.max(...history, 0)
  const active = torrents.filter((t) => t.state === 'downloading').length

  const hasLive = torrents.some((t) => t.state !== 'missing')
  const quota = useQuota(hasLive)
  const syncStatus = useCloudBackup()
  const retrying = torrents.filter((t) => t.state === 'retrying').length
  const storage = useStorageUsage(torrents.length)
  const lowStorage = !!storage && storage.limitBytes - storage.usedBytes < LOW_STORAGE_BYTES

  return (
    <div css={style} data-drag={dragging || undefined}>
      <div className="drop">Drop to add</div>
      <header>
        <span className="wordmark">Ripple</span>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (commitMagnet(input)) setInput('')
            else if (input.trim()) showToast('Not a magnet link')
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a magnet link"
            spellCheck={false}
            disabled={storageUnavailable}
          />
          <button className="primary" type="submit" disabled={storageUnavailable}>Add</button>
          <button className="ghost" type="button" onClick={() => fileInputRef.current?.click()} disabled={storageUnavailable}>.torrent</button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".torrent,application/x-bittorrent"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.currentTarget.files?.length) addTorrentFiles(e.currentTarget.files)
              e.currentTarget.value = ''
            }}
          />
        </form>
        {showSetup && (
          <button className="setup" type="button" onClick={() => { void onSetupHandlers() }}>
            Open torrents with Ripple
          </button>
        )}
        <AccountWidget/>
      </header>

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
            {storage && <StorageStat storage={storage} low={lowStorage}/>}
            {quota && <QuotaStat quota={quota}/>}
            <SyncStat status={syncStatus}/>
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
                <span>Paste a magnet link</span>
                <span>Drop a .torrent anywhere</span>
                <span>Press Ctrl+V to add instantly</span>
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
            />
          ))}
      </main>

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
            </div>
          )}
        </div>
      </footer>

      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  )
}

export default Home
