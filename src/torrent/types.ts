import type { SaveLocation } from './library'

export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error' | 'missing' | 'retrying' | 'checking'

export type TorrentFile = {
  name: string
  size: number
  progress: number
}

export type TorrentStats = {
  /** Bytes moved across every session. What a share ratio must be computed from. */
  allTimeDownload: number
  allTimeUpload: number
  /** Bytes moved since this session started. */
  sessionDownload: number
  sessionUpload: number
  /** Bytes that arrived and could not be used: failed hashes plus data already held. */
  wasted: number
  /** The whole SWARM per the tracker, as opposed to who we are connected to. -1 before an answer. */
  swarmSeeds: number
  swarmPeers: number
  numConnections: number
  connectionsLimit: number
  /** Complete copies the reachable peers add up to. Below 1 means nobody visible has all of it. */
  availability: number
  activeSeconds: number
  seedingSeconds: number
  /** Unix seconds, 0 for something that has not happened. */
  addedAt: number
  completedAt: number
  lastSeenComplete: number
  hadIncoming: boolean
  savePath: string
  pieceLength: number
  numPieces: number
  numPiecesHave: number
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
  /**
   * Everything a details pane shows and a row does not, straight off the engine. Null for a
   * library ghost, which has no engine state to report.
   */
  stats: TorrentStats | null
  /**
   * Where this torrent's files are meant to live, when it has said something of its own.
   *
   * Absent means "whatever the global default is", which is a different fact from choosing browser
   * storage explicitly, so it is not filled in with a default here. It is also not where the files
   * ARE: that is `stats.savePath`, and the two disagree for as long as a move is pending.
   */
  saveTo?: SaveLocation
  files?: TorrentFile[]
  retry?: {
    reason: 'stopped' | 'stalled'
    attempt: number
    retryInSeconds: number
    message?: string
  }
}
