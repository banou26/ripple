import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import type { QuotaStatus } from '../torrent/use-quota'

import { useTorrents } from '../torrent/use-torrents'
import { useFolder } from '../torrent/use-folder'
import { useQuota } from '../torrent/use-quota'
import { saveTorrentFileToDisk } from '../torrent/save-file'
import { syncTorrentToDirectory } from '../torrent/sync'
import { pickVideoFile, watchHref } from '../torrent/watch'
import { getHumanReadableByteString } from '../utils/bytes'

const isMagnet = (s: string): boolean => /^magnet:\?/i.test(s.trim())
const magnetInfoHash = (s: string): string | null => {
  const m = s.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

const STATE_LABEL: Record<Torrent['state'], string> = {
  downloading: 'Downloading',
  seeding: 'Seeding',
  paused: 'Paused',
  queued: 'Queued',
  done: 'Done',
  error: 'Error',
}

const speed = (bps: number) => `${getHumanReadableByteString(bps, true)}/s`

const rate = (bytesPerSecond: number): string => {
  const mbs = bytesPerSecond / 1_000_000
  if (mbs >= 1000) return `${Math.round(mbs / 1000)} GB/s`
  if (mbs >= 1) return `${Math.round(mbs)} MB/s`
  return `${Math.round(bytesPerSecond / 1000)} KB/s`
}

// FKN cloud-egress quota readout: torrent traffic relays through FKN, so over the daily free-tier
// volume the transfer is throttled. Premium lifts it; the extension/desktop paths aren't metered.
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

const HISTORY = 120

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
      gap: 26px;
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
      &.done { color: #c084fc; background: #c084fc14; border-color: #c084fc30; }
      &.error { color: #ef4444; background: #ef444414; border-color: #ef444430; }
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

const savingKey = (id: string, fileIndex: number) => `${id}:${fileIndex}`

type RowProps = {
  t: Torrent
  saving: Record<string, number>
  onToggle: (t: Torrent) => void
  onSave: (t: Torrent, fileIndex: number) => void
  onRemove: (t: Torrent) => void
}

const TorrentRow = ({ t, saving, onToggle, onSave, onRemove }: RowProps) => {
  const href = watchHref(t)
  const mainIndex = pickVideoFile(t.files)
  const mainSaving = saving[savingKey(t.id, mainIndex)]
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
        </div>
        <div className="actions">
          {href && <Link className="primary" to={href}>Watch</Link>}
          {!!t.files?.length && (
            <button onClick={() => onSave(t, mainIndex)} disabled={mainSaving != null}>
              {mainSaving != null ? `Saving ${Math.round(mainSaving * 100)}%` : 'Save to disk'}
            </button>
          )}
          <button onClick={() => onToggle(t)}>{t.state === 'paused' ? 'Resume' : 'Pause'}</button>
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
  const { torrents, addMagnet, addTorrentFile, pause, resume, remove, clientRef } = useTorrents()
  const [input, setInput] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [saving, setSaving] = useState<Record<string, number>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  // Read torrents from a ref inside stable callbacks so the global paste/drop
  // listeners don't re-subscribe on every 500ms state tick.
  const torrentsRef = useRef(torrents)
  torrentsRef.current = torrents

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const commitMagnet = useCallback((raw: string): boolean => {
    const text = raw.trim()
    if (!isMagnet(text)) return false
    const ih = magnetInfoHash(text)
    const dup = !!ih && torrentsRef.current.some((t) => t.magnet && magnetInfoHash(t.magnet) === ih)
    addMagnet(text)
    showToast(dup ? 'Already in your list' : 'Magnet added')
    return true
  }, [addMagnet, showToast])

  const addTorrentFiles = useCallback(async (files: Iterable<File>) => {
    for (const file of [...files]) {
      if (!/\.torrent$/i.test(file.name)) continue
      addTorrentFile(new Uint8Array(await file.arrayBuffer()))
      showToast(`${file.name} added`)
    }
  }, [addTorrentFile, showToast])

  // Global paste: Ctrl/Cmd+V anywhere outside a text field instantly adds a
  // magnet (the paste event carries the text with no permission prompt).
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

  // Drop a .torrent file (or a dragged magnet link) anywhere on the page.
  // dragenter/dragleave fire per element, so a depth counter keeps the
  // overlay from flickering while the drag crosses children.
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

  const onToggle = (t: Torrent) =>
    t.state === 'paused' ? resume(Number(t.id)) : pause(Number(t.id))

  // Removing also wipes the OPFS data - there's no UI to reclaim it otherwise.
  const onRemove = (t: Torrent) => remove(Number(t.id), true)

  // Streams one file out of OPFS to the user's disk. Called synchronously
  // from the click so showSaveFilePicker keeps the user gesture.
  const onSave = (t: Torrent, fileIndex: number) => {
    const client = clientRef.current
    const file = t.files?.[fileIndex]
    if (!client || !file) return
    const key = savingKey(t.id, fileIndex)
    setSaving((s) => ({ ...s, [key]: 0 }))
    saveTorrentFileToDisk(client, Number(t.id), fileIndex, file.name, file.size, (f) => setSaving((s) => ({ ...s, [key]: f })))
      .catch(() => {})
      .finally(() => setSaving((s) => { const { [key]: _, ...rest } = s; return rest }))
  }

  const { supported: folderSupported, folder, permitted, pick: pickFolder, allow: allowFolder, clear: clearFolder } = useFolder()

  // Auto-copy finished torrents into the chosen folder. The synced set only
  // dedups this session; the sync itself skips files already on disk.
  const syncedRef = useRef(new Set<string>())
  useEffect(() => { syncedRef.current.clear() }, [folder])
  useEffect(() => {
    const client = clientRef.current
    if (!client || !folder || !permitted) return
    for (const t of torrents) {
      if (t.state !== 'done' && t.state !== 'seeding') continue
      if (!t.files?.length || syncedRef.current.has(t.id)) continue
      syncedRef.current.add(t.id)
      syncTorrentToDirectory(client, t, folder)
        .then((written) => { if (written) showToast(`${t.name} saved to ${folder.name}`) })
        .catch(() => showToast(`Saving ${t.name} to ${folder.name} failed`))
    }
  }, [torrents, folder, permitted, clientRef, showToast])

  // Rolling window of total download speed, one sample per state tick.
  const [history, setHistory] = useState<number[]>([])
  useEffect(() => {
    setHistory((prev) => [...prev.slice(-(HISTORY - 1)), torrents.reduce((n, t) => n + t.down, 0)])
  }, [torrents])

  const totalDown = torrents.reduce((n, t) => n + t.down, 0)
  const totalUp = torrents.reduce((n, t) => n + t.up, 0)
  const peak = Math.max(...history, 0)
  const active = torrents.filter((t) => t.state === 'downloading').length

  const quota = useQuota(torrents.length > 0)

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
          />
          <button className="primary" type="submit">Add</button>
          <button className="ghost" type="button" onClick={() => fileInputRef.current?.click()}>.torrent</button>
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
      </header>

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
            {quota && <QuotaStat quota={quota}/>}
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
              onRemove={onRemove}
            />
          ))}
      </main>

      <footer>
        <a href="https://fkn.app" target="_blank" rel="noreferrer">Powered by FKN</a>
        <Link to="/legal">Legal</Link>
        <Link to="/privacy">Privacy</Link>
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
