import type { Torrent, TorrentState } from './types'
import type { TorrentClient, TorrentSnapshot } from './client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { createTorrentClient } from './client'

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

// Public-domain demo (Blender Foundation) with an HTTP webseed, seeded once
// into a brand-new user's list. The bundled .torrent gives instant metadata
// (a bare magnet would need a live swarm peer for it), so the webseed alone
// carries the download even with zero peers.
const DEMO_TORRENT_URL = new URL('../assets/sintel.torrent', import.meta.url)
const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
const DEMO_SEEDED_KEY = 'ripple:demo-seeded'

const addDemo = (client: TorrentClient) =>
  fetch(DEMO_TORRENT_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status))
      client.addTorrentFile(new Uint8Array(await res.arrayBuffer()))
    })
    .catch(() => client.addMagnet(DEMO_MAGNET))

// Drives a single libtorrent-wasm worker for the page and exposes its live
// torrent list mapped to the UI shape, plus addMagnet.
export const useTorrents = (): UseTorrents => {
  const clientRef = useRef<TorrentClient | null>(null)
  const [torrents, setTorrents] = useState<Torrent[]>([])
  useEffect(() => {
    const client = createTorrentClient()
    clientRef.current = client
    // Workers restore the persisted list before 'ready', so the first state
    // snapshot is authoritative: empty + never-seeded = brand-new user. The
    // flag is set once ever, so removing the demo sticks.
    let checkedDemo = false
    const off = client.onState((snaps) => {
      if (!checkedDemo) {
        checkedDemo = true
        try {
          if (!localStorage.getItem(DEMO_SEEDED_KEY)) {
            localStorage.setItem(DEMO_SEEDED_KEY, '1')
            if (!snaps.length) addDemo(client)
          }
        } catch { /* storage unavailable - skip the demo */ }
      }
      setTorrents(snaps.map(snapshotToTorrent))
    })
    return () => { off(); client.destroy(); clientRef.current = null }
  }, [])
  const addMagnet = useCallback((magnet: string) => clientRef.current?.addMagnet(magnet), [])
  const addTorrentFile = useCallback((bytes: Uint8Array) => clientRef.current?.addTorrentFile(bytes), [])
  const pause = useCallback((handle: number) => clientRef.current?.pause(handle), [])
  const resume = useCallback((handle: number) => clientRef.current?.resume(handle), [])
  const remove = useCallback((handle: number, deleteFiles?: boolean) => clientRef.current?.remove(handle, deleteFiles), [])
  return { torrents, addMagnet, addTorrentFile, pause, resume, remove, clientRef }
}
