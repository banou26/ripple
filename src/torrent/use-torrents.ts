import type { Torrent, TorrentState } from './types'
import type { Persisted, TorrentClient, TorrentSnapshot } from './client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { createTorrentClient } from './client'
import { DEMO_SEEDED_KEY } from './constants'
import { magnetInfoHash } from './magnet'
import { cloudRestoreSettled } from './use-cloud-backup'

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
    infoHash: magnetInfoHash(s.magnet) ?? undefined,
    name,
    size: s.files?.totalSize ?? s.bitfield?.length ?? 0,
    downloaded: st?.totalDone ?? 0,
    progress,
    state: st ? (st.paused ? 'paused' : (STATE[st.state] ?? 'downloading')) : (s.files ? 'queued' : 'downloading'),
    down: s.displayDownloadRate,
    up: st?.uploadRate ?? 0,
    peers: st?.numPeers ?? 0,
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st),
    files: s.files?.files.map((f) => ({ name: f.path, size: f.size, progress })),
  }
}

// A torrent synced from another device that isn't downloaded here: rendered as a
// "Files missing" row from the persisted list alone (it has no live session handle).
const ghostToTorrent = (e: Persisted): Torrent => ({
  id: 'missing:' + e.infoHash,
  magnet: e.magnet,
  infoHash: e.infoHash,
  name: magnetParam(e.magnet, 'dn') ?? e.infoHash.slice(0, 8),
  size: 0,
  downloaded: 0,
  progress: 0,
  state: 'missing',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
})

export type UseTorrents = {
  torrents: Torrent[]
  addMagnet: (magnet: string) => void
  addTorrentFile: (bytes: Uint8Array) => void
  pause: (handle: number) => void
  resume: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  // True once the worker reports it cannot open OPFS (private/incognito window).
  storageUnavailable: boolean
  clientRef: { current: TorrentClient | null }
}

// Public-domain Blender demo: the bundled .torrent gives instant metadata and its webseed carries the download with zero peers
const DEMO_TORRENT_URL = new URL('../assets/sintel.torrent', import.meta.url)
const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
// Longest a new user waits on a stalled cloud restore before the demo seeds anyway
const DEMO_GRACE = 8_000

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
  const [snaps, setSnaps] = useState<TorrentSnapshot[]>([])
  const [list, setList] = useState<Persisted[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  useEffect(() => {
    const client = createTorrentClient()
    clientRef.current = client
    const offUnavailable = client.onStorageUnavailable(() => setStorageUnavailable(true))
    // Demo seeding waits for the cloud restore to settle and judges the persisted list, so a restored library is never buried under the demo
    let checkedDemo = false
    const libraryCount = { current: 0 }
    const offList = client.onList((l) => { libraryCount.current = l.length; setList(l) })
    const offState = client.onState((s) => {
      setSnaps(s)
      if (checkedDemo) return
      checkedDemo = true
      void Promise.race([cloudRestoreSettled, new Promise<void>((r) => setTimeout(r, DEMO_GRACE))])
        .then(() => {
          try {
            if (localStorage.getItem(DEMO_SEEDED_KEY)) return
            localStorage.setItem(DEMO_SEEDED_KEY, '1')
            if (libraryCount.current === 0) addDemo(client)
          } catch { /* storage unavailable - skip the demo */ }
        })
    })
    return () => { offUnavailable(); offList(); offState(); client.destroy(); clientRef.current = null }
  }, [])

  // Live session torrents plus "Files missing" ghosts for synced entries not yet
  // started here (deduped against anything already live by infoHash).
  const torrents = useMemo(() => {
    const live = snaps.map(snapshotToTorrent)
    const liveHashes = new Set(live.map((t) => t.infoHash).filter(Boolean))
    const ghosts = list
      .filter((e) => e.started === false && !liveHashes.has(e.infoHash))
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(ghostToTorrent)
    return [...live, ...ghosts]
  }, [snaps, list])

  const addMagnet = useCallback((magnet: string) => clientRef.current?.addMagnet(magnet), [])
  const addTorrentFile = useCallback((bytes: Uint8Array) => clientRef.current?.addTorrentFile(bytes), [])
  const pause = useCallback((handle: number) => clientRef.current?.pause(handle), [])
  const resume = useCallback((handle: number) => clientRef.current?.resume(handle), [])
  const remove = useCallback((handle: number, deleteFiles?: boolean) => clientRef.current?.remove(handle, deleteFiles), [])
  const start = useCallback((infoHash: string) => clientRef.current?.start(infoHash), [])
  const removeMissing = useCallback((infoHash: string) => clientRef.current?.removeMissing(infoHash), [])
  return { torrents, addMagnet, addTorrentFile, pause, resume, remove, start, removeMissing, storageUnavailable, clientRef }
}
