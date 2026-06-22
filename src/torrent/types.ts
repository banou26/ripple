// 'missing' = synced from another device, not downloaded on this one (no local files).
export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error' | 'missing'

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
}
