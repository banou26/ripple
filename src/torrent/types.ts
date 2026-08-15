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
  /**
   * libtorrent's flag word for this torrent, read through `TORRENT_FLAG` from libtorrent-wasm.
   *
   * 0 for a library ghost, which is a torrent this device knows about but has not added to the
   * session, so it has no flags to have. Anything offering a control per flag has to treat that as
   * "no torrent here" rather than as "every option off".
   */
  flags: number
  /** Position in libtorrent's queue, or -1 when the torrent is not queued at all. */
  queuePosition: number
  files?: TorrentFile[]
  retry?: {
    reason: 'stopped' | 'stalled'
    attempt: number
    retryInSeconds: number
    message?: string
  }
}
