import type { Torrent, TorrentFile } from '../torrent/types'
import type { PeerInfo, TrackerInfo } from '../torrent/worker'

import { useState } from 'react'

import { PEER_FLAG, PEER_SOURCE } from 'libtorrent-wasm'

import { useTorrentDetail } from '../torrent/use-torrent-detail'
import { getHumanReadableByteString } from '../utils/bytes'

/**
 * Everything about one torrent, for people who want to know.
 *
 * Deliberately behind a closed disclosure. A torrent client's detail view is the part that makes it
 * look complicated, and someone who just wants to watch a file should never have to scroll past a
 * peer table to reach the play button. Open it and it is all there; leave it shut and the row is
 * exactly what it was, including the cost, since the engine computes none of this until a panel
 * asks (see TorrentDetail in worker.ts).
 */

const TABS = ['general', 'files', 'peers', 'trackers'] as const
type Tab = (typeof TABS)[number]

const TAB_LABEL: Record<Tab, string> = {
  general: 'Overview',
  files: 'Files',
  peers: 'Peers',
  trackers: 'Trackers',
}

const speed = (bytesPerSecond: number) => `${getHumanReadableByteString(bytesPerSecond, true)}/s`
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
  return `${Math.round(s / 3600)}h`
}

const Row = ({ label, value, mono }: { label: string, value: React.ReactNode, mono?: boolean }) => (
  <div className="fact">
    <label>{label}</label>
    <span className={mono ? 'mono' : undefined}>{value}</span>
  </div>
)

const General = ({ t }: { t: Torrent }) => {
  const remaining = Math.max(0, t.size - t.downloaded)
  return (
    <div className="facts">
      <Row label="Size" value={getHumanReadableByteString(t.size, true)}/>
      <Row label="Downloaded" value={`${getHumanReadableByteString(t.downloaded, true)} · ${pct(t.progress)}`}/>
      <Row label="Remaining" value={remaining === 0 ? 'Nothing, it is complete' : getHumanReadableByteString(remaining, true)}/>
      <Row label="Download" value={speed(t.down)}/>
      <Row label="Upload" value={speed(t.up)}/>
      {/* seeds is carried all the way from the engine and has never been shown anywhere */}
      <Row label="Connected" value={`${t.peers} peers, ${t.seeds} of them seeds`}/>
      <Row label="Time left" value={t.state === 'downloading' && t.eta !== '-' ? t.eta : '-'}/>
      <Row label="Files" value={String(t.files?.length ?? 0)}/>
      {t.infoHash && <Row label="Info hash" value={t.infoHash} mono/>}
      {t.retry && (
        <Row
          label="Retrying"
          value={`attempt ${t.retry.attempt}${t.retry.message ? `, ${t.retry.message}` : ''}`}
        />
      )}
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
            <span className="num">{getHumanReadableByteString(f.size, true)}</span>
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

export const TorrentDetailPanel = ({
  t, handle, saving, onSave,
}: {
  t: Torrent
  /** The engine handle, or null for a torrent that is not in the session (a library ghost). */
  handle: number | null
  saving: Record<number, number>
  onSave: (index: number) => void
}) => {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('general')
  // null while shut, which is what stops the engine computing any of this for a closed panel
  const detail = useTorrentDetail(open ? handle : null)

  return (
    <details
      className="detail"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      {/* a native summary carries its own keyboard handling and its own expanded state, which is
          why this is not a button with a chevron */}
      <summary>Details</summary>
      {/* Rendered only while open. A closed <details> keeps its children in the DOM rather than
          unmounting them, so without this every row in the library carries a hidden copy of its
          whole file list, and any query for text on the page matches the shut panel as readily as
          the visible row. */}
      {open && (
        <>
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
              </button>
            ))}
          </div>
          <div className="pane">
            {tab === 'general' && <General t={t}/>}
            {tab === 'files' && <Files files={t.files ?? []} saving={saving} onSave={onSave}/>}
            {tab === 'peers' && <Peers peers={detail.peers} loaded={detail.loaded}/>}
            {tab === 'trackers' && <Trackers trackers={detail.trackers} loaded={detail.loaded}/>}
          </div>
        </>
      )}
    </details>
  )
}
