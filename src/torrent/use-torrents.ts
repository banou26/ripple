import type { Torrent, TorrentState } from './types'
import type { TorrentClient, TorrentSnapshot } from './client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { createTorrentClient } from './client'
import { getBackend } from './backend'

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
  if (!status || status.state === 5 || status.state === 4) return '-'
  const remain = status.totalWanted - status.totalDone
  if (remain <= 0) return '-'
  if (status.downloadRate <= 0) return 'queued'
  const s = Math.round(remain / status.downloadRate)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

// Map the worker's Session snapshot to the UI Torrent shape (bytes / bytes-per-sec).
export const snapshotToTorrent = (s: TorrentSnapshot): Torrent => {
  const st = s.status
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path.split('/')[0] ?? 'Fetching metadata…'
  const progress = st?.progress ?? 0
  return {
    id: String(s.handle),
    magnet: s.magnet,
    name,
    size: s.files?.totalSize ?? s.bitfield?.length ?? 0,
    downloaded: st?.totalDone ?? 0,
    progress,
    state: st ? (st.paused ? 'paused' : (STATE[st.state] ?? 'downloading')) : (s.files ? 'queued' : 'downloading'),
    down: st?.downloadRate ?? 0,
    up: st?.uploadRate ?? 0,
    peers: st?.numPeers ?? 0,
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st),
    files: s.files?.files.map((f) => ({ name: f.path, size: f.size, progress })),
  }
}

export type UseTorrents = {
  torrents: Torrent[]
  addMagnet: (magnet: string) => void
  addTorrentFile: (bytes: Uint8Array) => void
  pause: (handle: number) => void
  resume: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  clientRef: { current: TorrentClient | null }
}

// Drives a single libtorrent-wasm worker for the page and exposes its live
// torrent list mapped to the UI shape, plus addMagnet.
export const useTorrents = (): UseTorrents => {
  const clientRef = useRef<TorrentClient | null>(null)
  const [torrents, setTorrents] = useState<Torrent[]>([])
  useEffect(() => {
    const client = createTorrentClient(getBackend())
    clientRef.current = client
    const off = client.onState((snaps) => setTorrents(snaps.map(snapshotToTorrent)))
    return () => { off(); client.destroy(); clientRef.current = null }
  }, [])
  const addMagnet = useCallback((magnet: string) => clientRef.current?.addMagnet(magnet), [])
  const addTorrentFile = useCallback((bytes: Uint8Array) => clientRef.current?.addTorrentFile(bytes), [])
  const pause = useCallback((handle: number) => clientRef.current?.pause(handle), [])
  const resume = useCallback((handle: number) => clientRef.current?.resume(handle), [])
  const remove = useCallback((handle: number, deleteFiles?: boolean) => clientRef.current?.remove(handle, deleteFiles), [])
  return { torrents, addMagnet, addTorrentFile, pause, resume, remove, clientRef }
}
