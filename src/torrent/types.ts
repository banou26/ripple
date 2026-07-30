// 'missing'  = synced from another device, not downloaded on this one (no local files).
// 'retrying' = stopped by an error, or connected to nothing, with a retry scheduled.
export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error' | 'missing' | 'retrying'

export type TorrentFile = {
  name: string
  size: number
  progress: number
}

export type Torrent = {
  id: string
  magnet?: string
  infoHash?: string
  name: string
  size: number
  downloaded: number
  progress: number
  state: TorrentState
  down: number
  up: number
  peers: number
  seeds: number
  eta: string
  files?: TorrentFile[]
  // Present while state === 'retrying': why it stopped and how long until the next try.
  retry?: {
    reason: 'stopped' | 'stalled'
    attempt: number
    retryInSeconds: number
    message?: string
  }
}
