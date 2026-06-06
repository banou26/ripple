import { useCallback, useEffect, useRef, useState } from 'react'

import type { Torrent, TorrentState } from '../ui/types'
import { createTorrentClient } from './client'
import type { TorrentClient, TorrentSnapshot } from './client'

const BYTES_PER_MB = 1024 * 1024

const magnetParam = (magnet: string, key: string): string | undefined => {
  const m = magnet.match(new RegExp('[?&]' + key + '=([^&]+)'))
  if (!m) return undefined
  try { return decodeURIComponent(m[1]!.replace(/\+/g, ' ')) } catch { return m[1] }
}

// libtorrent torrent_status state_t → the UI's coarse state.
const STATE: Record<number, TorrentState> = {
  1: 'queued',      // checking files
  2: 'downloading', // downloading metadata
  3: 'downloading',
  4: 'done',        // finished
  5: 'seeding',
  7: 'queued',      // checking resume data
}

const fmtEta = (status: TorrentSnapshot['status']): string => {
  if (!status || status.state === 5 || status.state === 4) return '—'
  const remain = status.totalWanted - status.totalDone
  if (remain <= 0) return '—'
  if (status.downloadRate <= 0) return 'queued'
  const s = Math.round(remain / status.downloadRate)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

// Map the worker's Session snapshot to the UI Torrent shape. The Session works
// in bytes / bytes-per-sec; the UI works in MB / KB-per-sec (per the design).
export const snapshotToTorrent = (s: TorrentSnapshot): Torrent => {
  const st = s.status
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path ?? 'Fetching metadata…'
  const totalBytes = s.files?.totalSize ?? s.bitfield?.length ?? 0
  const progress = st?.progress ?? 0
  const numPeers = st?.numPeers ?? 0
  return {
    id: String(s.handle),
    magnet: s.magnet,
    name,
    size: totalBytes / BYTES_PER_MB,
    downloaded: (st?.totalDone ?? 0) / BYTES_PER_MB,
    progress,
    state: st ? (STATE[st.state] ?? 'downloading') : (s.files ? 'queued' : 'downloading'),
    down: (st?.downloadRate ?? 0) / 1024,
    up: (st?.uploadRate ?? 0) / 1024,
    // No µTP/TCP split surfaced by the engine yet — report all as connected.
    peers: { total: numPeers, utp: 0, tcp: numPeers },
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st),
    ratio: 0,
    added: 'now',
    tracker: magnetParam(s.magnet, 'tr') ?? '—',
    flag: '',
    files: s.files?.files.map((f) => ({ name: f.path, size: f.size / BYTES_PER_MB, bytes: f.size, progress })),
  }
}

export type UseTorrents = {
  torrents: Torrent[]
  addMagnet: (magnet: string) => void
  clientRef: { current: TorrentClient | null }
}

// Drives a single libtorrent-wasm worker for the page and exposes its live
// torrent list mapped to the UI shape, plus addMagnet.
export const useTorrents = (): UseTorrents => {
  const clientRef = useRef<TorrentClient | null>(null)
  const [torrents, setTorrents] = useState<Torrent[]>([])
  useEffect(() => {
    const client = createTorrentClient()
    clientRef.current = client
    const off = client.onState((snaps) => setTorrents(snaps.map(snapshotToTorrent)))
    return () => { off(); client.destroy(); clientRef.current = null }
  }, [])
  const addMagnet = useCallback((magnet: string) => clientRef.current?.addMagnet(magnet), [])
  return { torrents, addMagnet, clientRef }
}
