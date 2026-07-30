import type { Torrent, TorrentState } from './types'
import type { Persisted, TorrentClient, TorrentSnapshot } from './client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getTorrentClient } from './client'
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
  1: 'checking',    // checking files
  2: 'downloading', // downloading metadata
  3: 'downloading',
  4: 'done',        // finished
  5: 'seeding',
  7: 'checking',    // checking resume data
}

// libtorrent holds a checking torrent paused for as long as the check runs, so this has to
// be read before `paused` or a recheck would spend its whole duration labelled "Queued".
const CHECKING = new Set([1, 7])

const fmtEta = (status: TorrentSnapshot['status']): string => {
  if (!status || status.state === 5 || status.state === 4 || CHECKING.has(status.state)) return '-'
  const remain = status.totalWanted - status.totalDone
  if (remain <= 0) return '-'
  if (status.downloadRate <= 0) return 'queued'
  const s = Math.round(remain / status.downloadRate)
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'
}

// Map the worker's Session snapshot to the UI Torrent shape (bytes / bytes-per-sec).
export const snapshotToTorrent = (s: TorrentSnapshot, now = Date.now()): Torrent => {
  const st = s.status
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path.split('/')[0] ?? 'Fetching metadata…'
  const progress = st?.progress ?? 0
  // A torrent the engine stopped, or one connected to nothing, is being retried on a
  // backoff. Say so instead of showing it as "Paused", which reads as the user's doing
  // and as something only the user can undo.
  const retrying = s.recovery && !s.userPaused
  // Stopped without being asked to, and without the engine wanting it retried, means
  // libtorrent's own queue is holding it back until a slot frees. That is "Queued", not
  // "Paused": nothing here stopped it and nothing here has to start it again.
  const stopped: TorrentState = s.userPaused ? 'paused' : 'queued'
  const base: TorrentState = st
    ? (CHECKING.has(st.state) ? 'checking' : st.paused ? stopped : (STATE[st.state] ?? 'downloading'))
    : (s.files ? 'queued' : 'downloading')
  return {
    id: String(s.handle),
    magnet: s.magnet,
    infoHash: magnetInfoHash(s.magnet) ?? undefined,
    name,
    size: s.files?.totalSize ?? s.bitfield?.length ?? 0,
    downloaded: st?.totalDone ?? 0,
    progress,
    state: retrying ? 'retrying' : base,
    down: s.displayDownloadRate,
    up: st?.uploadRate ?? 0,
    peers: st?.numPeers ?? 0,
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st),
    files: s.files?.files.map((f) => ({ name: f.path, size: f.size, progress })),
    retry: s.recovery && !s.userPaused
      ? {
        reason: s.recovery.reason,
        attempt: s.recovery.attempt,
        retryInSeconds: Math.max(0, Math.round((s.recovery.retryAt - now) / 1000)),
        message: s.recovery.message,
      }
      : undefined,
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
  retry: (handle: number) => void
  recheck: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  // True once the worker reports it cannot open OPFS (private/incognito window).
  storageUnavailable: boolean
  // Set when the engine died outright; nothing works until the page is reloaded. A worker
  // that threw once and kept running is not this: it recovers on its own.
  workerError: string | null
  client: TorrentClient
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
  const client = getTorrentClient()
  const [snaps, setSnaps] = useState<TorrentSnapshot[]>([])
  const [list, setList] = useState<Persisted[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
  useEffect(() => {
    const offUnavailable = client.onStorageUnavailable(() => setStorageUnavailable(true))
    const offWorkerError = client.onWorkerError(({ message, fatal }) => { if (fatal) setWorkerError(message) })
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
    // The engine is shared across routes and outlives this component, so leaving the
    // library page only drops the subscriptions. It keeps downloading.
    return () => { offUnavailable(); offWorkerError(); offList(); offState() }
  }, [client])

  // Live session torrents plus "Files missing" ghosts for synced entries not yet
  // started here (deduped against anything already live by infoHash).
  const torrents = useMemo(() => {
    // One clock for the whole list, so every retry countdown in a render agrees.
    const now = Date.now()
    const live = snaps.map((s) => snapshotToTorrent(s, now))
    const liveHashes = new Set(live.map((t) => t.infoHash).filter(Boolean))
    const ghosts = list
      .filter((e) => e.started === false && !liveHashes.has(e.infoHash))
      .sort((a, b) => a.addedAt - b.addedAt)
      .map(ghostToTorrent)
    return [...live, ...ghosts]
  }, [snaps, list])

  const addMagnet = useCallback((magnet: string) => client.addMagnet(magnet), [client])
  const addTorrentFile = useCallback((bytes: Uint8Array) => client.addTorrentFile(bytes), [client])
  const pause = useCallback((handle: number) => client.pause(handle), [client])
  const resume = useCallback((handle: number) => client.resume(handle), [client])
  const retry = useCallback((handle: number) => client.retry(handle), [client])
  const recheck = useCallback((handle: number) => client.recheck(handle), [client])
  const remove = useCallback((handle: number, deleteFiles?: boolean) => client.remove(handle, deleteFiles), [client])
  const start = useCallback((infoHash: string) => client.start(infoHash), [client])
  const removeMissing = useCallback((infoHash: string) => client.removeMissing(infoHash), [client])
  return { torrents, addMagnet, addTorrentFile, pause, resume, retry, recheck, remove, start, removeMissing, storageUnavailable, workerError, client }
}
