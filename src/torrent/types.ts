import type { SaveLocation } from './library'

// `starting` is a library row the ENGINE has not reported yet, which on a reload is its state for
// well over a second: the session cannot be built until the relay grants a listen port, and that is
// two round trips. It is not `missing`, which means the files are not on this device at all, and it
// is not `queued`, which is a real position in libtorrent's queue. It is "we know this torrent, ask
// again in a moment", and everything that needs an engine handle is unavailable while it lasts.
export type TorrentState = 'downloading' | 'seeding' | 'paused' | 'queued' | 'done' | 'error' | 'missing' | 'retrying' | 'checking' | 'starting'

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
   * When this torrent was added, in MILLISECONDS, or absent where nothing recorded it.
   *
   * Taken from the library entry rather than from `stats.addedAt`, which is unix SECONDS, is 0 for
   * something that never happened, and is null for a ghost. The entry has it for every row a person
   * can see, which is what a sort needs: a key that exists for live rows and not for ghosts would
   * quietly bunch every ghost together at one end for a reason nobody could read off the screen.
   */
  addedAt?: number
  /**
   * The same answer as `eta`, as a NUMBER, or absent when there is nothing to estimate.
   *
   * `eta` is formatted for a person and sorts like nonsense: as text, "10m 00s" comes before "9s".
   * Absent for anything complete, paused or stalled, which is correct rather than a gap; those sort
   * last on this key because "no estimate" is not "arriving soon".
   */
  etaSeconds?: number
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
  /**
   * True for a torrent a PAGE asked for rather than the person: its bytes are a cache the engine may
   * reclaim, and it is not part of the library.
   *
   * The engine's own distinction, surfaced rather than re-derived, because "did this row exist before
   * I touched it" cannot be answered by watching the list: an ephemeral add lands in it too, and a
   * moment later the two are indistinguishable.
   */
  ephemeral?: boolean
  /** File indices this torrent is downloading, absent meaning all of them. */
  wantedFiles?: number[]
  /** qBittorrent's "Download first and last pieces first". */
  firstLast?: boolean
  /**
   * This torrent's own speed ceilings in bytes per second, absent where it has never been given one.
   *
   * Remembered rather than reported. The engine has no readable answer for these: its getters are
   * sync calls into a context that only runs inside a tick, so what is shown is what was asked for.
   * Absent and 0 are different, and 0 is a torrent deliberately exempted from a limit.
   */
  downloadLimit?: number
  uploadLimit?: number
  files?: TorrentFile[]
  retry?: {
    reason: 'stopped' | 'stalled'
    attempt: number
    retryInSeconds: number
    message?: string
  }
}
