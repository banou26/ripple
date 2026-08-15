import type { Torrent, TorrentFile, TorrentStats } from '../torrent/types'
import type { PeerInfo, TrackerInfo } from '../torrent/worker'

import { css } from '@emotion/react'

import { CONTROL_BG, CONTROL_HOVER_BG } from '../theme'
import { useCallback, useEffect, useRef, useState } from 'react'

import { PEER_FLAG, PEER_SOURCE } from 'libtorrent-wasm'

import { useTorrentDetail } from '../torrent/use-torrent-detail'
import { getHumanReadableByteString } from '../utils/bytes'

/**
 * Everything about the selected torrent, docked along the bottom of the page.
 *
 * Docked rather than folded into each row, which is what this used to be. A per-row disclosure puts
 * the detail in a different place every time, pushes the rest of the library down the page when it
 * opens, and gives thirty rows thirty copies of a panel that is almost always shut. One dock at a
 * fixed place, showing whatever is selected, is what every desktop client settled on and it is the
 * right shape for the same reasons.
 *
 * It costs nothing while nothing is selected: the engine computes peers and trackers for ONE
 * torrent and only while something is asking, so an empty selection means an idle engine.
 */

const TABS = ['general', 'files', 'peers', 'trackers'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  general: 'General',
  files: 'Content',
  peers: 'Peers',
  trackers: 'Trackers',
}

const HEIGHT_KEY = 'ripple:dock-height'
const MIN_HEIGHT = 140
const MAX_HEIGHT = 720
const DEFAULT_HEIGHT = 300

const bytes = (n: number) => getHumanReadableByteString(n, true)
const speed = (n: number) => `${bytes(n)}/s`
const pct = (fraction: number) => `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.01 ? 2 : 0)}%`

/** `Pack/Season 1/E01.mkv` reads as `E01.mkv` with the rest kept, quieter, in front of it. */
const splitPath = (path: string): [string, string] => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? ['', path] : [path.slice(0, cut + 1), path.slice(cut + 1)]
}

const seconds = (s: number): string => {
  if (s < 0) return '-'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
  return `${Math.floor(s / 86_400)}d ${Math.round((s % 86_400) / 3600)}h`
}

/** Unix SECONDS, which is what libtorrent deals in; 0 means it has not happened. */
const when = (unixSeconds: number): string =>
  unixSeconds > 0 ? new Date(unixSeconds * 1000).toLocaleString() : 'Not yet'

/**
 * Uploaded over downloaded, across every session.
 *
 * Infinity rather than a number when nothing was ever downloaded but something was uploaded, which
 * is a real state for a torrent seeded from files already on disk, and 0 when nothing has moved
 * either way. Dividing without the guard prints NaN on a brand new torrent.
 */
const ratio = (s: TorrentStats): string => {
  if (s.allTimeDownload === 0) return s.allTimeUpload > 0 ? '∞' : '0.00'
  return (s.allTimeUpload / s.allTimeDownload).toFixed(2)
}

const Fact = ({ label, value, mono }: { label: string, value: React.ReactNode, mono?: boolean }) => (
  <div className="fact">
    <label>{label}</label>
    <span className={mono ? 'mono' : undefined}>{value}</span>
  </div>
)

const General = ({ t }: { t: Torrent }) => {
  const s = t.stats
  const remaining = Math.max(0, t.size - t.downloaded)
  return (
    <div className="general">
      <section>
        <h3>Transfer</h3>
        <div className="facts">
          <Fact label="Time active" value={s ? seconds(s.activeSeconds) : '-'}/>
          <Fact label="Time left" value={t.state === 'downloading' && t.eta !== '-' ? t.eta : '-'}/>
          <Fact label="Connections" value={s ? `${s.numConnections}${s.connectionsLimit > 0 ? ` of ${s.connectionsLimit}` : ''}` : '-'}/>
          {/* all-time, not this session: a ratio from session figures is wrong for anything ever restarted */}
          <Fact label="Downloaded" value={s ? `${bytes(s.allTimeDownload)} (${bytes(s.sessionDownload)} this session)` : bytes(t.downloaded)}/>
          <Fact label="Uploaded" value={s ? `${bytes(s.allTimeUpload)} (${bytes(s.sessionUpload)} this session)` : '-'}/>
          <Fact label="Seeds" value={s ? `${t.seeds} connected${s.swarmSeeds >= 0 ? ` of ${s.swarmSeeds} known` : ''}` : String(t.seeds)}/>
          <Fact label="Download speed" value={speed(t.down)}/>
          <Fact label="Upload speed" value={speed(t.up)}/>
          <Fact label="Peers" value={s ? `${t.peers} connected${s.swarmPeers >= 0 ? ` of ${s.swarmPeers} known` : ''}` : String(t.peers)}/>
          <Fact label="Share ratio" value={s ? ratio(s) : '-'}/>
          {/* hash failures plus bytes that arrived after we already had them */}
          <Fact label="Wasted" value={s ? bytes(s.wasted) : '-'}/>
          <Fact label="Remaining" value={remaining === 0 ? 'Nothing, it is complete' : bytes(remaining)}/>
          <Fact label="Seeding for" value={s ? seconds(s.seedingSeconds) : '-'}/>
          {/* Below 1 means no combination of the peers we can see holds a whole copy. Negative is
              libtorrent's "not known yet", which happens before metadata or before any peer has
              sent a bitfield, and printing it as -1.00 reads as a real measurement of nothing. */}
          <Fact label="Availability" value={s && s.availability >= 0 ? s.availability.toFixed(2) : '-'}/>
          <Fact label="Inbound peers" value={s ? (s.hadIncoming ? 'Yes, peers have dialled in' : 'None yet') : '-'}/>
        </div>
      </section>
      <section>
        <h3>Information</h3>
        <div className="facts">
          <Fact label="Total size" value={bytes(t.size)}/>
          <Fact
            label="Pieces"
            value={s && s.numPieces ? `${s.numPieces} x ${bytes(s.pieceLength)} (have ${s.numPiecesHave})` : '-'}
          />
          <Fact label="Progress" value={pct(t.progress)}/>
          <Fact label="Added on" value={s ? when(s.addedAt) : '-'}/>
          <Fact label="Completed on" value={s ? when(s.completedAt) : '-'}/>
          <Fact label="Last seen complete" value={s ? when(s.lastSeenComplete) : '-'}/>
          <Fact label="Files" value={String(t.files?.length ?? 0)}/>
          <Fact label="Save path" value={s?.savePath || '-'} mono/>
          {t.infoHash && <Fact label="Info hash" value={t.infoHash} mono/>}
          {t.retry && (
            <Fact
              label="Retrying"
              value={`attempt ${t.retry.attempt}${t.retry.message ? `, ${t.retry.message}` : ''}`}
            />
          )}
        </div>
      </section>
    </div>
  )
}

const Files = ({
  files, saving, onSave,
}: {
  files: TorrentFile[]
  saving: Record<number, number>
  onSave: (index: number) => void
}) => {
  if (!files.length) return <p className="none">No file list yet. It arrives with the torrent's metadata.</p>
  return (
    <div className="rows">
      {/* No per-file progress bar on purpose: TorrentFile.progress is the torrent's overall
          progress copied onto every file, so a bar here would claim a precision that is not real. */}
      {files.map((f, i) => {
        const [dir, name] = splitPath(f.name)
        const s = saving[i]
        return (
          <div className="row file" key={i}>
            <span className="name">
              {dir && <span className="dim">{dir}</span>}{name}
            </span>
            <span className="num">{bytes(f.size)}</span>
            <button type="button" onClick={() => onSave(i)} disabled={s != null}>
              {s != null ? `${Math.round(s * 100)}%` : 'Save'}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The short badges after a peer's address.
 *
 * Chosen for what a person can act on or be curious about, not for completeness: libtorrent tracks
 * about twenty flags and most of them describe choking state machinery. Transport and direction are
 * the two that explain the numbers next to them.
 */
const peerTags = (p: PeerInfo): string[] => {
  const tags: string[] = []
  tags.push(p.flags & PEER_FLAG.utpSocket ? 'uTP' : 'TCP')
  // the source is what libtorrent actually recorded; the flag is how the socket was opened, and the
  // two can disagree for a peer we later reconnected to
  if (!(p.flags & PEER_FLAG.localConnection) || p.source & PEER_SOURCE.incoming) tags.push('incoming')
  if (p.flags & (PEER_FLAG.rc4Encrypted | PEER_FLAG.plaintextEncrypted)) tags.push('encrypted')
  if (p.flags & PEER_FLAG.seed) tags.push('seed')
  if (p.source & PEER_SOURCE.dht) tags.push('DHT')
  else if (p.source & PEER_SOURCE.pex) tags.push('PEX')
  else if (p.source & PEER_SOURCE.tracker) tags.push('tracker')
  return tags
}

const Peers = ({ peers, loaded }: { peers: PeerInfo[], loaded: boolean }) => {
  if (!loaded) return <p className="none">Asking the engine…</p>
  if (!peers.length) return <p className="none">Nobody is connected right now.</p>
  // busiest first, because that is the one a person is looking for
  const sorted = [...peers].sort((a, b) => (b.downloadRate + b.uploadRate) - (a.downloadRate + a.uploadRate))
  return (
    <div className="rows">
      <div className="row head">
        <span className="name">Address</span>
        <span className="client">Client</span>
        <span className="num">Has</span>
        <span className="num">Down</span>
        <span className="num">Up</span>
        <span className="num">Got</span>
        <span className="num">Sent</span>
      </div>
      {sorted.map((p) => (
        <div className="row" key={p.endpoint}>
          <span className="name">
            <span className="mono">{p.endpoint}</span>
            <span className="tags">{peerTags(p).map((tag) => <span className="tag" key={tag}>{tag}</span>)}</span>
          </span>
          {/* arbitrary text a stranger chose, so it is rendered as text and never as markup */}
          <span className="client" title={p.client}>{p.client || 'unknown'}</span>
          <span className="num">{pct(p.progress)}</span>
          <span className="num">{p.downloadRate ? speed(p.downloadRate) : '-'}</span>
          <span className="num">{p.uploadRate ? speed(p.uploadRate) : '-'}</span>
          <span className="num">{p.totalDownload ? bytes(p.totalDownload) : '-'}</span>
          <span className="num">{p.totalUpload ? bytes(p.totalUpload) : '-'}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * A tracker's state in one word.
 *
 * `fails` is -1 when the tracker has never been contacted, which is a genuinely different thing
 * from zero failures and would read as "Working" if the two were collapsed.
 */
const trackerState = (tr: TrackerInfo): { label: string, tone: 'ok' | 'warn' | 'idle' } => {
  if (tr.updating) return { label: 'Announcing…', tone: 'idle' }
  if (tr.fails < 0) return { label: 'Not contacted', tone: 'idle' }
  if (tr.fails === 0) return { label: 'Working', tone: 'ok' }
  return { label: `Failed ${tr.fails}×`, tone: 'warn' }
}

const Trackers = ({ trackers, loaded }: { trackers: TrackerInfo[], loaded: boolean }) => {
  if (!loaded) return <p className="none">Asking the engine…</p>
  if (!trackers.length) {
    return (
      <p className="none">
        This torrent has no trackers. It finds peers through the DHT and through other peers instead.
      </p>
    )
  }
  const sorted = [...trackers].sort((a, b) => a.tier - b.tier)
  return (
    <div className="rows">
      <div className="row head">
        <span className="name">Tracker</span>
        <span className="client">Status</span>
        <span className="num">Tier</span>
        <span className="num">Seeds</span>
        <span className="num">Peers</span>
        <span className="num">Next</span>
      </div>
      {sorted.map((tr) => {
        const state = trackerState(tr)
        return (
          <div className="row" key={tr.url}>
            <span className="name mono" title={tr.url}>{tr.url}</span>
            <span className={`client ${state.tone}`} title={tr.message || undefined}>{state.label}</span>
            <span className="num">{tr.tier}</span>
            {/* -1 means never scraped: a 0 there would read as a tracker that answered and knows of nobody */}
            <span className="num">{tr.seeders < 0 ? '-' : tr.seeders}</span>
            <span className="num">{tr.leechers < 0 ? '-' : tr.leechers}</span>
            <span className="num">{seconds(tr.nextAnnounceIn)}</span>
          </div>
        )
      })}
    </div>
  )
}

const readHeight = (): number => {
  try {
    const stored = Number(localStorage.getItem(HEIGHT_KEY))
    if (Number.isFinite(stored) && stored >= MIN_HEIGHT && stored <= MAX_HEIGHT) return stored
  } catch { /* private mode, or storage blocked */ }
  return DEFAULT_HEIGHT
}

export const dockStyle = css`
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid rgba(58, 52, 71, 0.9);
  background: rgba(30, 26, 40, 0.96);
  backdrop-filter: blur(8px);

  .grip {
    flex: none;
    height: 7px;
    margin-top: -4px;
    cursor: ns-resize;
    touch-action: none;

    &::after {
      content: '';
      display: block;
      width: 46px;
      height: 3px;
      margin: 2px auto 0;
      border-radius: 2px;
      background: #3a3447;
      transition: background 120ms ease;
    }

    &:hover::after,
    &[data-dragging]::after {
      background: #f97316;
    }
  }

  header {
    flex: none;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 16px 8px;

    .title {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 0.85rem;
      font-weight: 700;
      color: #f4f2f8;
    }

    .close {
      flex: none;
      border: 1px solid #3a3447;
      border-radius: 4px;
      background: ${CONTROL_BG};
      color: #a39db3;
      padding: 3px 11px;
      font-size: 0.75rem;

      &:hover {
        background: ${CONTROL_HOVER_BG};
        color: #f4f2f8;
      }
    }
  }

  .tabs {
    flex: none;
    display: flex;
    gap: 4px;
    margin: 0 16px 8px;
    padding: 3px;
    border-radius: 6px;
    background: rgba(22, 19, 28, 0.8);
    width: fit-content;
    max-width: calc(100% - 32px);
    flex-wrap: wrap;

    button {
      border: none;
      border-radius: 4px;
      background: none;
      color: #a39db3;
      padding: 4px 14px;
      font-size: 0.75rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;

      &:hover {
        color: #f4f2f8;
      }

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

  .pane {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 0 16px 14px;
  }

  .none {
    margin: 6px 0 2px;
    color: #8b8499;
    font-size: 0.8rem;
  }

  .general {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    gap: 0 28px;
  }

  section h3 {
    margin: 4px 0 2px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #8b8499;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 0 24px;
  }

  .fact {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 4px 0;
    border-bottom: 1px solid rgba(44, 39, 55, 0.7);
    font-size: 0.78rem;

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
    padding: 6px 0;
    border-top: 1px solid rgba(44, 39, 55, 0.9);
    font-size: 0.78rem;

    &:first-of-type {
      border-top: none;
    }

    /* sticky so a long swarm keeps its column names while it scrolls */
    &.head {
      position: sticky;
      top: 0;
      z-index: 1;
      background: #1e1a28;
      border-top: none;
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
      width: 72px;
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
      padding: 3px 12px;
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

  @media (max-width: 700px) {
    .general {
      grid-template-columns: 1fr;
    }

    .row .client {
      display: none;
    }
  }
`

export const TorrentDetailDock = ({
  t, handle, saving, onSave, onClose,
}: {
  t: Torrent
  /** The engine handle, or null for a torrent that is not in the session (a library ghost). */
  handle: number | null
  saving: Record<number, number>
  onSave: (index: number) => void
  onClose: () => void
}) => {
  const [tab, setTab] = useState<Tab>('general')
  const [height, setHeight] = useState(readHeight)
  const dragging = useRef(false)
  const detail = useTorrentDetail(handle)

  /**
   * Resizing by pointer, on the window rather than on the grip.
   *
   * Pointer capture would keep the events coming, but the grip is 7px tall and a fast drag leaves
   * it behind before capture is established. Listening on the window for the duration is what makes
   * the drag survive the pointer outrunning the handle.
   */
  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    dragging.current = true
    const startY = e.clientY
    const startHeight = height
    const move = (ev: PointerEvent) => {
      // dragging UP grows the dock, since it is anchored to the bottom of the page
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + (startY - ev.clientY)))
      setHeight(next)
    }
    const up = () => {
      dragging.current = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setHeight((h) => {
        try { localStorage.setItem(HEIGHT_KEY, String(h)) } catch { /* storage blocked */ }
        return h
      })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [height])

  // Escape closes it, which is the shortcut anyone tries first on a panel like this
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // `target` is the window itself for a window-dispatched event, and Window has no closest(),
      // so this has to be checked for an Element rather than cast to one
      const target = e.target
      // never steal Escape from a field or a dialog that is using it
      if (target instanceof Element && target.closest('input, textarea, dialog, [role="menu"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <section css={dockStyle} style={{ height }} aria-label={`Details for ${t.name}`}>
      <div
        className="grip"
        data-dragging={dragging.current || undefined}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the details panel"
      />
      <header>
        <span className="title" title={t.name}>{t.name}</span>
        <button type="button" className="close" onClick={onClose}>Close</button>
      </header>
      <div className="tabs" role="group" aria-label="Torrent details">
        {TABS.map((name) => (
          <button
            type="button"
            key={name}
            data-on={tab === name || undefined}
            aria-pressed={tab === name}
            onClick={() => setTab(name)}
          >
            {TAB_LABEL[name]}
            {name === 'peers' && detail.peers.length > 0 && <span className="count">{detail.peers.length}</span>}
            {name === 'files' && !!t.files?.length && <span className="count">{t.files.length}</span>}
          </button>
        ))}
      </div>
      <div className="pane">
        {tab === 'general' && <General t={t}/>}
        {tab === 'files' && <Files files={t.files ?? []} saving={saving} onSave={onSave}/>}
        {tab === 'peers' && <Peers peers={detail.peers} loaded={detail.loaded}/>}
        {tab === 'trackers' && <Trackers trackers={detail.trackers} loaded={detail.loaded}/>}
      </div>
    </section>
  )
}
