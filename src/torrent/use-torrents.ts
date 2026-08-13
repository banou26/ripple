import type { Torrent, TorrentState } from './types'
import type { Persisted, TorrentClient, TorrentSnapshot } from './client'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { getTorrentClient } from './client'
import { DEMO_SEEDED_KEY } from './constants'
import { magnetInfoHash, magnetParam } from './magnet'
import { cloudRestoreSettled } from './use-cloud-backup'

// keys are libtorrent torrent_status state_t
const STATE: Record<number, TorrentState> = {
  1: 'checking',
  2: 'downloading',
  3: 'downloading',
  4: 'done',
  5: 'seeding',
  7: 'checking',
}

// libtorrent holds a checking torrent paused, so this MUST be read before `paused`
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

export const snapshotToTorrent = (s: TorrentSnapshot, now = Date.now()): Torrent => {
  const st = s.status
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path.split('/')[0] ?? 'Fetching metadata…'
  const progress = st?.progress ?? 0
  const retrying = s.recovery && !s.userPaused
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
  storageUnavailable: boolean
  workerError: string | null
  client: TorrentClient
}

// the bundled Sintel .torrent gives instant metadata and its webseed carries the download with zero peers, which is why tests can rely on it with no swarm
const DEMO_TORRENT_URL = new URL('../assets/sintel.torrent', import.meta.url)
const DEMO_MAGNET = 'magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337&tr=udp%3A%2F%2Fexplodie.org%3A6969&tr=udp%3A%2F%2Ftracker.torrent.eu.org%3A451&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F'
// longest a new user waits on a stalled cloud restore before the demo seeds anyway
const DEMO_GRACE = 8_000

const addDemo = (client: TorrentClient) =>
  fetch(DEMO_TORRENT_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status))
      client.addTorrentFile(new Uint8Array(await res.arrayBuffer()))
    })
    .catch(() => client.addMagnet(DEMO_MAGNET))

export const useTorrents = (): UseTorrents => {
  const client = getTorrentClient()
  const [snaps, setSnaps] = useState<TorrentSnapshot[]>([])
  const [list, setList] = useState<Persisted[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
  useEffect(() => {
    const offUnavailable = client.onStorageUnavailable(() => setStorageUnavailable(true))
    const offWorkerError = client.onWorkerError(({ message, fatal }) => { if (fatal) setWorkerError(message) })
    const offReset = client.onEngineReset(() => { setWorkerError(null); setStorageUnavailable(false) })
    let checkedDemo = false
    const libraryCount = { current: 0 }
    const offList = client.onList((l) => { libraryCount.current = l.length; setList(l) })
    const offState = client.onState((s) => {
      setSnaps(s)
      if (checkedDemo) return
      // only the engine owner may seed: the cloud restore waited on below runs there alone
      if (!client.owns()) return
      checkedDemo = true
      void Promise.race([cloudRestoreSettled, new Promise<void>((r) => setTimeout(r, DEMO_GRACE))])
        .then(() => {
          try {
            if (localStorage.getItem(DEMO_SEEDED_KEY)) return
            localStorage.setItem(DEMO_SEEDED_KEY, '1')
            if (libraryCount.current === 0) addDemo(client)
          } catch { }
        })
    })
    return () => { offUnavailable(); offWorkerError(); offReset(); offList(); offState() }
  }, [client])

  const torrents = useMemo(() => {
    // one clock for the whole list, so every retry countdown in a render agrees
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
