import type { Torrent } from '../torrent/types'

import { css } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

import { useTorrents } from '../torrent/use-torrents'
import { saveTorrentFileToDisk } from '../torrent/save-file'
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

const style = css`
  position: relative;
  overflow: hidden;
  min-height: 100vh;
  background: radial-gradient(1100px 500px at 75% -5%, #2b1f3f 0%, transparent 60%), #16131c;
  color: #f4f2f8;
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;

  a {
    text-decoration: none;
  }

  .shell {
    position: relative;
    max-width: 880px;
    margin: 0 auto;
    padding: 24px 24px 64px;
  }

  .glow {
    position: absolute;
    width: 440px;
    height: 440px;
    border-radius: 50%;
    filter: blur(95px);
    pointer-events: none;
  }

  .glow.amber {
    background: #f59e0b;
    opacity: 0.22;
    top: -120px;
    left: -140px;
  }

  .glow.plum {
    background: #7c3aed;
    opacity: 0.25;
    top: 60px;
    right: -180px;
  }

  .glow.teal {
    background: #14b8a6;
    opacity: 0.13;
    top: 560px;
    left: 30%;
  }

  header {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;

    .wordmark {
      font-size: 1.5rem;
      font-weight: 900;
      letter-spacing: 0.06em;
      background: linear-gradient(90deg, #fbbf24, #f97316);
      background-clip: text;
      -webkit-background-clip: text;
      color: transparent;
    }

    nav a {
      color: #c9c4d4;
      font-size: 0.95rem;
      font-weight: 500;

      &:hover {
        color: #f4f2f8;
      }
    }
  }

  .hero {
    position: relative;
    text-align: center;
    padding: 64px 0 40px;

    h1 {
      margin: 0 auto 18px;
      font-size: clamp(1.8rem, 5vw, 3rem);
      font-weight: 900;
      line-height: 1.05;
      letter-spacing: -0.01em;
      text-transform: uppercase;

      em {
        font-style: normal;
        background: linear-gradient(90deg, #fbbf24, #f97316, #c084fc);
        background-clip: text;
        -webkit-background-clip: text;
        color: transparent;
      }
    }

    > p {
      margin: 0 auto;
      max-width: 560px;
      font-size: 1.05rem;
      line-height: 1.65;
      color: #b6b0c4;
    }
  }

  .add {
    position: relative;
    display: flex;
    gap: 10px;
    max-width: 640px;
    margin: 0 auto;

    input {
      flex: 1;
      min-width: 0;
      background: #1e1a28;
      border: 1px solid #2c2737;
      border-radius: 999px;
      padding: 12px 20px;
      color: #f4f2f8;
      font-size: 0.95rem;
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
      border-radius: 999px;
      padding: 12px 22px;
      font-size: 0.9rem;
      font-weight: 700;
      cursor: pointer;
      transition: transform 120ms ease, background 120ms ease;

      &.primary {
        border: none;
        background: #fff;
        color: #16131c;

        &:hover {
          transform: translateY(-1px);
        }
      }

      &.ghost {
        border: 1px solid #3a3447;
        background: none;
        color: #f4f2f8;

        &:hover {
          background: #221d2e;
        }
      }
    }
  }

  .drop-hint {
    margin: 12px 0 0;
    text-align: center;
    color: #8b8499;
    font-size: 0.85rem;
  }

  .torrents {
    position: relative;
    margin-top: 44px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .torrent {
    background: #1e1a28;
    border: 1px solid #2c2737;
    border-radius: 16px;
    padding: 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    transition: border-color 120ms ease;

    &:hover {
      border-color: #3a3447;
    }

    .title {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;

      strong {
        font-size: 1rem;
        overflow-wrap: anywhere;
      }
    }

    .badge {
      flex: none;
      font-size: 0.68rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      padding: 4px 9px;
      border-radius: 999px;
      background: #2c2737;
      color: #a39db3;

      &.downloading { color: #fbbf24; background: #fbbf2419; }
      &.seeding { color: #2dd4bf; background: #2dd4bf19; }
      &.done { color: #c084fc; background: #c084fc19; }
      &.error { color: #ef4444; background: #ef444419; }
    }

    .bar {
      height: 6px;
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

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 16px;
      color: #a39db3;
      font-size: 0.85rem;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;

      a, button {
        border-radius: 999px;
        padding: 8px 16px;
        font-size: 0.85rem;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease;
      }

      .primary {
        border: none;
        background: #fff;
        color: #16131c;

        &:hover {
          transform: translateY(-1px);
        }
      }

      button {
        border: 1px solid #3a3447;
        background: none;
        color: #f4f2f8;

        &:hover {
          background: #221d2e;
        }

        &:disabled {
          opacity: 0.6;
          cursor: default;
        }
      }
    }
  }

  .empty {
    border: 1px dashed #2c2737;
    border-radius: 16px;
    padding: 40px 24px;
    text-align: center;
    color: #8b8499;
    font-size: 0.95rem;
    line-height: 1.6;
  }

  footer {
    position: relative;
    margin-top: 64px;
    padding-top: 22px;
    border-top: 1px solid #2c2737;
    display: flex;
    align-items: center;
    gap: 22px;
    font-size: 0.9rem;

    a {
      color: #8b8499;

      &:hover {
        color: #c9c4d4;
      }
    }

    .engine {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #8b8499;
      font-size: 0.85rem;

      button {
        font-size: 0.8rem;
        padding: 5px 12px;
        border-radius: 999px;
        border: 1px solid #2c2737;
        background: none;
        color: #8b8499;
        cursor: pointer;

        &.on {
          color: #f4f2f8;
          border-color: #f97316;
        }
      }
    }
  }

  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    background: #1e1a28;
    border: 1px solid #2c2737;
    border-radius: 999px;
    padding: 10px 18px;
    font-size: 0.9rem;
    box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4);
    z-index: 10;
  }
`

type CardProps = {
  t: Torrent
  saving?: number
  onToggle: (t: Torrent) => void
  onSave: (t: Torrent) => void
  onRemove: (t: Torrent) => void
}

const TorrentCard = ({ t, saving, onToggle, onSave, onRemove }: CardProps) => {
  const href = watchHref(t)
  return (
    <div className="torrent">
      <div className="title">
        <strong>{t.name}</strong>
        <span className={`badge ${t.state}`}>{STATE_LABEL[t.state]}</span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${Math.min(100, t.progress * 100)}%` }}/>
      </div>
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
          <button onClick={() => onSave(t)} disabled={saving != null}>
            {saving != null ? `Saving ${Math.round(saving * 100)}%` : 'Save to disk'}
          </button>
        )}
        <button onClick={() => onToggle(t)}>{t.state === 'paused' ? 'Resume' : 'Pause'}</button>
        <button onClick={() => onRemove(t)}>Remove</button>
      </div>
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

  // Streams the torrent's main file out of OPFS to the user's disk. Called
  // synchronously from the click so showSaveFilePicker keeps the user gesture.
  const onSave = (t: Torrent) => {
    const client = clientRef.current
    if (!client || !t.files?.length) return
    const idx = pickVideoFile(t.files)
    const file = t.files[idx]
    if (!file) return
    setSaving((s) => ({ ...s, [t.id]: 0 }))
    saveTorrentFileToDisk(client, Number(t.id), idx, file.name, file.size, (f) => setSaving((s) => ({ ...s, [t.id]: f })))
      .catch(() => {})
      .finally(() => setSaving((s) => { const { [t.id]: _, ...rest } = s; return rest }))
  }

  const backend = getBackend()

  return (
    <div css={style}>
      <div className="glow amber"/>
      <div className="glow plum"/>
      <div className="glow teal"/>
      <div className="shell">
        <header>
          <span className="wordmark">Ripple</span>
          <nav>
            <a href="https://fkn.app" target="_blank" rel="noreferrer">FKN</a>
          </nav>
        </header>

        <section className="hero">
          <h1>Download. Stream.<br/><em>In your browser.</em></h1>
          <p>
            Ripple is a torrent client that runs entirely in your browser.
            Paste a magnet link or drop a .torrent file, watch the video while
            it downloads, then save it to your disk.
          </p>
        </section>

        <form
          className="add"
          onSubmit={(e) => {
            e.preventDefault()
            if (commitMagnet(input)) setInput('')
            else if (input.trim()) showToast('Not a magnet link')
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste a magnet link"
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
        <p className="drop-hint">or drop a .torrent file anywhere on this page</p>

        <section className="torrents">
          {torrents.length === 0
            ? (
              <div className="empty">
                Nothing here yet.<br/>
                Add a torrent above and it will download, stream and seed right here.
              </div>
            )
            : torrents.map((t) => (
              <TorrentCard
                key={t.id}
                t={t}
                saving={saving[t.id]}
                onToggle={onToggle}
                onSave={onSave}
                onRemove={onRemove}
              />
            ))}
        </section>

        <footer>
          <a href="https://fkn.app" target="_blank" rel="noreferrer">Powered by FKN</a>
          <div className="engine">
            <span>Engine</span>
            <button
              className={backend === 'libtorrent' ? 'on' : ''}
              onClick={() => backend !== 'libtorrent' && setBackend('libtorrent')}
            >
              libtorrent
            </button>
            <button
              className={backend === 'webtorrent' ? 'on' : ''}
              onClick={() => backend !== 'webtorrent' && setBackend('webtorrent')}
            >
              WebTorrent
            </button>
          </div>
        </footer>
      </div>

      {toast && <div role="status" className="toast">{toast}</div>}
    </div>
  )
}

export default Home
