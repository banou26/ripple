import type { Torrent } from '../torrent/types'
import type { TorrentBackend } from '../torrent/backend'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useTorrents } from '../torrent/use-torrents'
import { useFolder } from '../torrent/use-folder'
import { saveTorrentFileToDisk } from '../torrent/save-file'
import { syncTorrentToDirectory } from '../torrent/sync'
import { pickVideoFile, watchHref } from '../torrent/watch'
import { getBackend, setBackend } from '../torrent/backend'
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

const HISTORY = 120

const style = css`
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background: #16131c;
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  a {
    text-decoration: none;
  }

  button {
    font-family: inherit;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }

  header {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px 16px;
    padding: 10px 16px;
    background: #1e1a28;
    border-bottom: 1px solid #2c2737;

    .wordmark {
      font-size: 1.25rem;
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
        background: #16131c;
        border: 1px solid #2c2737;
        border-radius: 8px;
        padding: 8px 12px;
        color: #f4f2f8;
        font-size: 0.9rem;
        outline: none;
        transition: border-color 120ms ease;

        &::placeholder {
          color: #8b8499;
        }

        &:focus {
          border-color: #f97316;
        }
      }

      button {
        flex: none;
        border-radius: 8px;
        padding: 8px 16px;
        font-size: 0.85rem;
        font-weight: 700;

        &.primary {
          border: none;
          background: #fff;
          color: #16131c;
        }

        &.ghost {
          border: 1px solid #3a3447;
          background: none;
          color: #f4f2f8;

          &:hover {
            background: #241e30;
          }
        }
      }
    }
  }

  .stats {
    flex: none;
    display: flex;
    align-items: stretch;
    gap: 24px;
    margin: 14px 16px 0;
    padding: 14px 18px;
    background: #1e1a28;
    border: 1px solid #2c2737;
    border-radius: 10px;

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

      polygon {
        fill: rgba(249, 115, 22, 0.14);
      }
    }
  }

  main {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
  }

  .torrent {
    flex: none;
    background: #1e1a28;
    border: 1px solid #2c2737;
    border-radius: 10px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 9px;
    transition: border-color 120ms ease;

    &:hover {
      border-color: #3a3447;
    }

    .title {
      display: flex;
      align-items: baseline;
      gap: 10px;

      strong {
        flex: 1;
        font-size: 0.95rem;
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
      font-size: 0.65rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 3px 8px;
      border-radius: 6px;
      background: #2c2737;
      color: #a39db3;

      &.downloading { color: #fbbf24; background: #fbbf2419; }
      &.seeding { color: #2dd4bf; background: #2dd4bf19; }
      &.done { color: #c084fc; background: #c084fc19; }
      &.error { color: #ef4444; background: #ef444419; }
    }

    .bar {
      height: 5px;
      border-radius: 999px;
      background: #2c2737;
      overflow: hidden;

      .fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #fbbf24, #f97316);
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
        border-radius: 7px;
        padding: 6px 12px;
        font-size: 0.8rem;
        font-weight: 700;
      }

      .primary {
        border: none;
        background: #fff;
        color: #16131c;
      }

      button {
        border: 1px solid #3a3447;
        background: none;
        color: #f4f2f8;

        &:hover {
          background: #241e30;
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
      }

      .file {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 0;
        border-top: 1px solid #2c2737;
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
          border-radius: 7px;
          background: none;
          color: #f4f2f8;
          padding: 4px 10px;
          font-size: 0.75rem;

          &:hover {
            background: #241e30;
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
    margin: auto;
    text-align: center;
    color: #8b8499;
    font-size: 0.9rem;
    line-height: 1.7;
    padding: 24px;

    h1 {
      margin: 0 0 10px;
      font-size: 1.5rem;
      font-weight: 900;
      letter-spacing: -0.01em;

      em {
        font-style: normal;
        background: linear-gradient(90deg, #fbbf24, #f97316, #c084fc);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
      }
    }
  }

  footer {
    flex: none;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 18px;
    padding: 8px 16px;
    background: #1e1a28;
    border-top: 1px solid #2c2737;
    font-size: 0.78rem;
    color: #8b8499;

    a {
      color: #8b8499;

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

    .folder, .engine {
      display: flex;
      align-items: center;
      gap: 7px;

      .warn {
        color: #fbbf24;
      }

      button {
        font-size: 0.75rem;
        padding: 4px 10px;
        border-radius: 7px;
        border: 1px solid #2c2737;
        background: none;
        color: #8b8499;

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
    background: #1e1a28;
    border: 1px solid #2c2737;
    border-radius: 8px;
    padding: 10px 18px;
    font-size: 0.85rem;
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4);
    z-index: 10;
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
      <polygon points={`${((offset / (HISTORY - 1)) * w).toFixed(2)},${h} ${points} ${w},${h}`}/>
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
    <div className="torrent">
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
  useEffect(() => {
    const onDragOver = (e: DragEvent) => e.preventDefault()
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer?.files?.length) addTorrentFiles(e.dataTransfer.files)
      else commitMagnet(e.dataTransfer?.getData('text') ?? '')
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => { window.removeEventListener('dragover', onDragOver); window.removeEventListener('drop', onDrop) }
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

  const backend = getBackend()
  const [confirmEngine, setConfirmEngine] = useState<TorrentBackend | null>(null)

  // Each engine has its own storage layout, so the other engine's downloads
  // start over; warn unless the list is empty.
  const switchEngine = (engine: TorrentBackend) => {
    if (engine === backend) return
    if (torrents.length) setConfirmEngine(engine)
    else setBackend(engine)
  }

  return (
    <div css={style}>
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
        <section className="stats">
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
          </div>
          <SpeedGraph history={history}/>
        </section>
      )}

      <main>
        {torrents.length === 0
          ? (
            <div className="empty">
              <h1>Download. Stream. <em>In your browser.</em></h1>
              Ripple is a torrent client that runs entirely in your browser.<br/>
              Paste a magnet link, drop a .torrent file anywhere on this page,<br/>
              watch the video while it downloads, then save it to your disk.
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
          <div className="engine">
            {confirmEngine
              ? (
                <>
                  <span className="warn">Switching engines resets the downloaded files</span>
                  <button className="on" onClick={() => setBackend(confirmEngine)}>Switch</button>
                  <button onClick={() => setConfirmEngine(null)}>Cancel</button>
                </>
              )
              : (
                <>
                  <span>Engine</span>
                  <button
                    className={backend === 'libtorrent' ? 'on' : ''}
                    onClick={() => switchEngine('libtorrent')}
                  >
                    libtorrent
                  </button>
                  <button
                    className={backend === 'webtorrent' ? 'on' : ''}
                    onClick={() => switchEngine('webtorrent')}
                  >
                    WebTorrent
                  </button>
                </>
              )}
          </div>
        </div>
      </footer>

      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  )
}

export default Home
