export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error' | 'missing' | 'retrying' | 'checking'

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
  retry?: {
    reason: 'stopped' | 'stalled'
    attempt: number
    retryInSeconds: number
    message?: string
  }
}
