import type { Torrent, TorrentState } from './types'
import type { InboundNow } from './inbound'
import type { Persisted, Reachability, TorrentClient, TorrentSnapshot } from './client'
import type { IntlShape } from 'react-intl'
import type { EngineTransport } from './vpn-config'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'

import { intl } from '../i18n'
import { getTorrentClient } from './client'
import { DEMO_MAGNET, DEMO_SAVE_PATH, DEMO_SEEDED_KEY } from './constants'
import { NO_INBOUND } from './inbound'
import { magnetInfoHash, magnetParam } from './magnet'
import { noPeersFound } from './no-peers'
import { CHECKING_STATES, pauseLanded } from './recovery'
import { heldBytes } from './downloaded-ranges'
import { cloudRestoreSettled } from './use-cloud-backup'
import { keepSyncedTorrentFile } from './torrent-file-sync'
import { holdWhileStored } from '../utils/page-work'
import { writeDuration } from './uptime'

// keys are libtorrent torrent_status state_t; 4 is `finished`, every chosen file and not every piece, which uploads what it has
const STATE: Record<number, TorrentState> = {
  1: 'checking',
  2: 'downloading',
  3: 'downloading',
  4: 'seeding',
  5: 'seeding',
  7: 'checking',
}

/**
 * Every byte the torrent wanted is on disk: libtorrent's `finished` and `seeding`.
 *
 * Read on PAUSED torrents, which is the whole reason it exists, and safe there because the state is
 * a property of the torrent rather than of the session running it: pausing does not reset it, so a
 * stopped torrent keeps saying it has everything.
 *
 * Not derived from `totalDone >= totalWanted`, which looks like the same question and is not: the
 * streaming plan skips every unwatched file, shrinking `totalWanted` to the watched selection while
 * `totalDone` keeps counting every piece held. A season pack with one episode fetched satisfies it.
 */
const COMPLETE = new Set([4, 5])

/**
 * Bytes of the selection still to come. Not `totalWanted - totalDone`: `totalDone` counts a skipped file that is
 * held, so a pack with one such file as large as what is left read as nothing left. An engine from before
 * `totalWantedDone`, which a tab can still borrow during a rollout, gets the old subtraction.
 */
const leftOf = (status: NonNullable<TorrentSnapshot['status']>): number =>
  status.totalWanted - (status.totalWantedDone ?? status.totalDone)

/**
 * The chosen files' bytes and how many of them are held, counted over the person's own files from the pieces held, or
 * undefined to go by the engine's totals.
 *
 * Only for a padded torrent with files left out, and not during a check, whose progress is the check's own. There
 * libtorrent counts the padding inside the chosen pieces in `totalWanted` and never in `totalWantedDone`: a hybrid of
 * 16 KiB pieces with one file left out reported 344 064 against 301 000 once finished, so it read 87% and its Remaining
 * never reached nothing.
 */
const chosenContent = (s: TorrentSnapshot, wanted: number[] | undefined): { size: number, held: number } | undefined => {
  const { files, bitfield, status } = s
  if (!wanted || !files || !bitfield || !status || CHECKING_STATES.has(status.state) || !files.files.some((f) => f.pad)) return undefined
  const chosen = new Set(wanted)
  const content = files.files.filter((f, index) => !f.pad && chosen.has(index))
  return { size: content.reduce((sum, f) => sum + f.size, 0), held: content.reduce((sum, f) => sum + heldBytes(bitfield, f), 0) }
}

/**
 * Seconds remaining, or undefined where there is nothing to estimate.
 *
 * The same arithmetic `fmtEta` formats, kept beside it so the two can never disagree about whether
 * an estimate exists. Undefined rather than 0 or Infinity for "no estimate": a sort has to be able
 * to put those last rather than treat them as arriving instantly or never.
 */
const etaSecondsOf = (status: TorrentSnapshot['status'], remain: number): number | undefined => {
  if (!status || status.state === 5 || status.state === 4 || CHECKING_STATES.has(status.state)) return undefined
  if (remain <= 0 || status.downloadRate <= 0) return undefined
  return Math.round(remain / status.downloadRate)
}

const fmtEta = (status: TorrentSnapshot['status'], remain: number, words: IntlShape): string => {
  if (!status || status.state === 5 || status.state === 4 || CHECKING_STATES.has(status.state)) return '-'
  if (remain <= 0) return '-'
  if (status.downloadRate <= 0) return words.formatMessage({ id: 'queued', defaultMessage: 'queued' })
  const s = Math.round(remain / status.downloadRate)
  if (s < 60) return writeDuration({ seconds: s })
  if (s < 3600) return writeDuration({ minutes: Math.floor(s / 60), seconds: s % 60 })
  return writeDuration({ hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60) })
}

/**
 * The state alone, without building a whole Torrent for it.
 *
 * Split out so a caller that only needs to know what a torrent is DOING does not pay for the name
 * parsing and info-hash extraction below, and more importantly so there is one derivation rather
 * than two: the shell-update handler asks this on every engine tick, and a second copy of these
 * rules would drift from the one the list renders.
 */
export const snapshotState = (s: TorrentSnapshot): TorrentState => {
  const st = s.status
  const retrying = s.recovery && !s.userPaused
  /**
   * A finished torrent that does not run is `completed` whoever stopped it: the person's Stop, libtorrent's queue
   * parking it past `active_seeds`, or `applyViewing` parking a cache torrent nobody watches. Its row offers Start.
   * An unfinished one is `paused` when the person stopped it and `queued` otherwise. The person's pause counts before
   * the engine has applied it: a reload brings a torrent back unreported, or running, until the next pump pauses it.
   */
  const complete = !!st && COMPLETE.has(st.state)
  const stopped: TorrentState = complete ? 'completed' : s.userPaused ? 'paused' : 'queued'
  /*
   * A check waiting its turn (libtorrent runs one at a time) reports itself paused with auto-management
   * still set, and is still a check. A pause that landed clears auto-management, and libtorrent then
   * leaves the check where it is until a resume, so that one reads as stopped, which offers the Resume.
   */
  const base: TorrentState = st
    ? (CHECKING_STATES.has(st.state) && !pauseLanded(st) ? 'checking' : st.paused || s.userPaused ? stopped : (STATE[st.state] ?? 'downloading'))
    : (s.userPaused ? 'paused' : s.files ? 'queued' : 'downloading')
  return retrying ? 'retrying' : base
}

/**
 * Whether the session is moving bytes for this torrent, which is what the strip's ACTIVE counts.
 *
 * Downloading and SEEDING. It used to be downloading alone, so a library seeding at a quarter of a
 * megabyte per second read `Active 0 / 1`, which is the strip stating that nothing is happening
 * while something plainly is. That reading cost a real diagnosis: the torrent was uploading to forty
 * peers and the only three numbers a person looks at first (`Download 0 B/s`, `Peak 0 B/s`,
 * `Active 0 / 1`) all agreed that it was idle.
 *
 * Deliberately NOT `checking`, which is work that moves no bytes and already announces itself on the
 * row, and not `starting` or `retrying`, which are waiting rather than transferring.
 */
export const isActive = (state: TorrentState): boolean =>
  state === 'downloading' || state === 'seeding'

/** `s` as a row, its words written by `words`, and its figures counted over `wanted`, the files its library entry chose. */
export const snapshotToTorrent = (s: TorrentSnapshot, now = Date.now(), words = intl, wanted?: number[]): Torrent => {
  const st = s.status
  const name = magnetParam(s.magnet, 'dn') ?? s.files?.files[0]?.path.split('/')[0] ?? words.formatMessage({ id: 'Fetching metadata…', defaultMessage: 'Fetching metadata…' })
  const content = chosenContent(s, wanted)
  const progress = content ? (content.size ? content.held / content.size : 1) : (st?.progress ?? 0)
  const left = content ? content.size - content.held : st ? leftOf(st) : 0
  return {
    id: String(s.handle),
    magnet: s.magnet,
    infoHash: magnetInfoHash(s.magnet) ?? undefined,
    name,
    /*
     * CONTENT bytes, not the padded total. `totalSize` is what the pieces cover, which for a v2 or
     * hybrid torrent includes every pad file, so a row would read a tenth larger than the files it
     * describes while `downloaded` counted only the real bytes: 512 KiB of 293 KiB, at 100 per cent.
     */
    size: s.files?.contentSize ?? s.bitfield?.length ?? 0,
    downloaded: st?.totalDone ?? 0,
    progress,
    state: snapshotState(s),
    down: s.displayDownloadRate,
    up: st?.uploadRate ?? 0,
    peers: st?.numPeers ?? 0,
    seeds: st?.numSeeds ?? 0,
    eta: fmtEta(st, left, words),
    etaSeconds: etaSecondsOf(st, left),
    // seconds off the engine, milliseconds everywhere a person sees a date; 0 means never happened
    addedAt: st?.addedAt ? st.addedAt * 1000 : undefined,
    flags: st?.flags ?? 0,
    queuePosition: st?.queuePosition ?? -1,
    stats: st
      ? {
        // the ACCUMULATED totals win over the engine's own, exactly as activeSeconds does below:
        // libtorrent's ride in a resume blob a finished torrent stops being given, so a library left
        // seeding reported its upload resetting on every reload
        allTimeDownload: s.totals?.downloaded ?? st.allTimeDownload,
        allTimeUpload: s.totals?.uploaded ?? st.allTimeUpload,
        sessionDownload: st.sessionDownload,
        sessionUpload: st.sessionUpload,
        wasted: s.totals?.wasted ?? st.wasted,
        swarmSeeds: st.swarmSeeds,
        swarmPeers: st.swarmPeers,
        numConnections: st.numConnections,
        connectionsLimit: st.connectionsLimit,
        availability: st.availability,
        /*
         * The ACCUMULATED totals, not the engine's session-only counters.
         *
         * libtorrent's own numbers restart whenever a torrent is added without a resume blob that
         * carries them, which for a finished torrent is every reload: its blob is written once and
         * never again. `uptime.ts` keeps the running totals in the library entry instead.
         */
        activeSeconds: s.uptime?.activeSeconds ?? st.activeSeconds,
        seedingSeconds: s.uptime?.seedingSeconds ?? st.seedingSeconds,
        // absent on a snapshot from an older engine, where zero reads as "nothing yet this session"
        sessionActiveSeconds: s.sessionUptime?.activeSeconds ?? 0,
        sessionSeedingSeconds: s.sessionUptime?.seedingSeconds ?? 0,
        completedAt: st.completedAt,
        lastSeenComplete: st.lastSeenComplete,
        hadIncoming: st.hadIncoming,
        savePath: st.savePath,
        pieceLength: s.files?.pieceLength ?? s.bitfield?.pieceLength ?? 0,
        numPieces: st.numPiecesTotal,
        numPiecesHave: st.numPiecesHave,
        // a padded torrent with files left out but no stored selection, such as a player's, stays short of its
        // totalWanted by the pads inside its chosen pieces
        remaining: COMPLETE.has(st.state) ? 0 : Math.max(0, left),
      }
      : null,
    bitfield: s.bitfield ?? undefined,
    // pads stay in the array so `files[i]` is still the engine's file i, and carry a flag so nothing
    // a person sees, saves or archives includes them; see `contentFiles`
    files: s.files?.files.map((f, index) => ({ name: f.path, size: f.size, offset: f.offset, index, pad: f.pad })),
    noPeers: noPeersFound(s, now),
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

/**
 * Whether this entry is a created source the WAITING LIST will carry, so it needs no row of its own.
 *
 * `saveTo: 'source'` means the bytes live outside the origin and the page holds the way back to
 * them. Such an entry is deliberately left out of the live rows, the starting rows and the ghosts,
 * because what it is waiting for is a permission grant, which needs a click, and `useCreatedSources`
 * surfaces it as something to click instead.
 *
 * `started !== false` IS THE SECOND HALF, and without it an entry can render NOWHERE. The waiting
 * list reads the handle the page stored to re-open the pick, and drops any entry it cannot find one
 * for. An entry excluded here as well is then in no list at all: not live, not starting, not a
 * ghost, and with no row there is nothing to remove it from the library with. The publish path
 * writes `started: false` for exactly the case where no handle could be kept, which sends the entry
 * to the ghost branch, where it carries its name and size and offers "Remove from the library".
 *
 * Reachable before this on the shipping Firefox path: a pick that cannot be re-opened whose copy
 * into browser storage does not fit, which is an ordinary outcome rather than an exotic one.
 */
export const waitsForItsSource = (e: Persisted): boolean =>
  e.saveTo === 'source' && e.started !== false

/**
 * The rows for library entries the engine does not have, which is two kinds and one exclusion.
 *
 * GHOSTS are `started === false`: not on this device, and offered "Download to this device".
 * STARTING rows are on their way. The library arrives from IndexedDB in about a millisecond while
 * the engine needs over a second to exist, almost all of it waiting on the relay for a listen port,
 * and without these the page shows an empty library for that whole time and then everything at once,
 * which reads as a slow app rather than as one still connecting.
 *
 * THE EXCLUSION is a torrent created from this device's own files while it is out of the engine. It
 * is not a ghost: pressing "Download to this device" on one would try to fetch the person's own
 * files from strangers who do not have them, and what actually happens is a fatal disk error. And it
 * is not starting: the restore loop deliberately does not add these, so a row saying it is on its
 * way would say so forever. What it is waiting for is a permission grant, which needs a click, so
 * `useCreatedSources` surfaces it as something to click and it becomes an ordinary live row the
 * moment the grant is back.
 *
 * A FUNCTION rather than three statements inside the memo, because the exclusion is the part that
 * goes wrong and a memo cannot be tested without a client, a worker and a session. See
 * {@link waitsForItsSource} for the half of it that took a shipped bug to find.
 */
export const rowsForEntriesNotInTheEngine = (
  list: Persisted[],
  liveHashes: Set<string | undefined>,
): Torrent[] => {
  const absent = list.filter((e) => !waitsForItsSource(e) && !liveHashes.has(e.infoHash))
  const byAge = (a: Persisted, b: Persisted) => a.addedAt - b.addedAt
  return [
    ...absent.filter((e) => e.started !== false).sort(byAge).map(startingToTorrent),
    ...absent.filter((e) => e.started === false).sort(byAge).map(ghostToTorrent),
  ]
}

export const ghostToTorrent = (e: Persisted): Torrent => ({
  id: 'missing:' + e.infoHash,
  magnet: e.magnet,
  infoHash: e.infoHash,
  /*
   * Stored metadata first, because it is the only source that survives the trip to another device.
   *
   * A torrent restored from the cloud has no engine, no local .torrent and usually no `dn` on its
   * magnet: the demo entry is `magnet:?xt=urn:btih:08ada5a7...` with nothing else. That is how a row
   * ended up showing eight hex characters where a title belongs, which reads as some other torrent
   * rather than as this one waiting. `rootEntry` stays after it as the older field that carried the
   * same name for entries written before metadata was synced.
   */
  name: e.name ?? magnetParam(e.magnet, 'dn') ?? e.rootEntry ?? e.infoHash.slice(0, 8),
  size: e.size ?? 0,
  downloaded: 0,
  progress: 0,
  state: 'missing',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  addedAt: e.addedAt,
  // a ghost is not in the session, so it has no flags, no queue position and no stats to have
  flags: 0,
  queuePosition: -1,
  stats: null,
  saveTo: e.saveTo,
  created: e.created === true,
  ...(e.private === true ? { private: true } : {}),
  // a ghost's list came from `Persisted`, which the writer already stripped of pads, so every entry
  // here is content and its position is its index
  files: e.files?.map((f, index) => ({ name: f.name, size: f.size, index })),
})

/**
 * A library row whose engine handle does not exist yet.
 *
 * Everything measurable is zero because nothing has measured it: the name comes off the magnet, and
 * the id is prefixed so it can never be parsed into a handle. That prefix is the safety property.
 * Every control on a live row does `Number(t.id)`, and an id that yields NaN sends a command naming
 * no torrent, so the row renders its identity and offers nothing that needs the engine.
 */
const startingToTorrent = (e: Persisted): Torrent => ({
  ...ghostToTorrent(e),
  id: 'starting:' + e.infoHash,
  state: 'starting',
})

/**
 * The library's rows: what the engine runs, with what its library entry knows, then the entries it does not run. Its
 * figures are counted over the files each entry chose, and its text written by `words`.
 */
export const libraryRows = (snaps: TorrentSnapshot[], list: Persisted[], words: IntlShape, now = Date.now()): Torrent[] => {
  // the intent lives in the library row and the engine knows nothing about it, so it is attached
  // here; snapshotToTorrent is given only the chosen files, which its figures are counted over
  const entryByHash = new Map(list.map((e) => [e.infoHash, e]))
  const live = snaps.map((s) => {
    const hash = magnetInfoHash(s.magnet)
    const entry = hash ? entryByHash.get(hash) : undefined
    const t = snapshotToTorrent(s, now, words, entry?.wantedFiles)
    return entry
      ? {
        ...t,
        saveTo: entry.saveTo,
        created: entry.created === true,
        ...(entry.private === true ? { private: true } : {}),
        ephemeral: entry.ephemeral === true,
        // the entry's clock wins over the engine's: it survives a restart, it is already in
        // milliseconds, and it is the one a ghost row has too, so a sort on it is not comparing
        // two different clocks depending on whether the engine has got to a row yet
        addedAt: entry.addedAt ?? t.addedAt,
        wantedFiles: entry.wantedFiles,
        firstLast: entry.firstLast === true,
        forced: entry.forced === true,
        downloadLimit: entry.downloadLimit,
        uploadLimit: entry.uploadLimit,
      }
      : t
  })
  const liveHashes = new Set(live.map((t) => t.infoHash).filter(Boolean))
  return [...live, ...rowsForEntriesNotInTheEngine(list, liveHashes)]
}

export type UseTorrents = {
  torrents: Torrent[]
  /** The library as stored, which carries entries no engine row exists for. */
  list: Persisted[]
  addMagnet: (magnet: string) => void
  addTorrentFile: TorrentClient['addTorrentFile']
  pause: (handle: number) => void
  resume: (handle: number) => void
  retry: (handle: number) => void
  recheck: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  start: (infoHash: string) => void
  startMany: (infoHashes: string[]) => void
  removeMissing: (infoHash: string) => void
  storageUnavailable: boolean
  workerError: string | null
  /** Null until the engine has reported once; see ConnectionStat for what the fields mean. */
  reachable: Reachability | null
  /** What the running engine reaches its peers through. Null until one has said. */
  transport: EngineTransport | null
  /** Peers dialled IN right now, which is not the running total `reachable` carries. */
  inboundNow: InboundNow
  /** How many nodes the DHT knows. Null until an engine has said. */
  dhtNodes: number | null
  /** A first visit in this browser, with an empty library: offer the sample torrent. */
  sampleOffered: boolean
  /** Answers the offer for good in this browser; true adds the sample. */
  answerSample: (add: boolean) => void
  client: TorrentClient
}

// the bundled Sintel .torrent gives instant metadata and its webseed carries the download with zero peers, which is why tests can rely on it with no swarm
const DEMO_TORRENT_URL = new URL('../assets/sintel.torrent', import.meta.url)
// longest a new user waits on a stalled cloud restore before the sample is offered anyway
const DEMO_GRACE = 8_000

/**
 * Started, since somebody asked for it, and TEMPORARY: its bytes are a cache the budget pass may
 * take back, and `backupOf` keeps it out of the synced library, so it never becomes a row with no
 * files on another device.
 */
const addDemo = (client: TorrentClient) =>
  fetch(DEMO_TORRENT_URL)
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status))
      client.addTorrentFile(new Uint8Array(await res.arrayBuffer()), { savePath: DEMO_SAVE_PATH, ephemeral: true })
    })
    .catch(() => client.addMagnet(DEMO_MAGNET, { savePath: DEMO_SAVE_PATH, ephemeral: true }))

const sampleAnswered = () => { try { localStorage.setItem(DEMO_SEEDED_KEY, '1') } catch { } }

export const useTorrents = (): UseTorrents => {
  const client = getTorrentClient()
  // a row's text is written as the list is built, so a language picked builds it again
  const words = useIntl()
  const [snaps, setSnaps] = useState<TorrentSnapshot[]>([])
  const [list, setList] = useState<Persisted[]>([])
  const [storageUnavailable, setStorageUnavailable] = useState(false)
  const [workerError, setWorkerError] = useState<string | null>(null)
  const [reachable, setReachable] = useState<Reachability | null>(null)
  const [transport, setTransport] = useState<EngineTransport | null>(null)
  const [inboundNow, setInboundNow] = useState<InboundNow>(NO_INBOUND)
  const [dhtNodes, setDhtNodes] = useState<number | null>(null)
  const [sampleOffered, setSampleOffered] = useState(false)
  useEffect(() => {
    const offReachable = client.onReachable(setReachable)
    const offTransport = client.onTransport(setTransport)
    const offInbound = client.onInboundNow(setInboundNow)
    const offDht = client.onDhtNodes(setDhtNodes)
    const offUnavailable = client.onStorageUnavailable(() => setStorageUnavailable(true))
    const offWorkerError = client.onWorkerError(({ message, fatal }) => { if (fatal) setWorkerError(message) })
    /*
     * The engine snapshots go too, not just the error flags.
     *
     * Every live row is keyed by a HANDLE, and a handle is a counter inside the session that minted
     * it, so once that session is gone the numbers on screen name whatever the next one happens to
     * assign them. `client.ts` refuses to send a handle command across that boundary, which makes the
     * buttons safe, but leaving them on screen still offers actions that quietly do nothing.
     *
     * Dropping the snapshots hands every started library entry to the `starting` branch below, which
     * is the presentation the app already uses at boot while the engine is coming up: the row keeps
     * its name and its place and says Connecting, with no button to press, and turns back into a live
     * row the moment the new engine posts state. A handover therefore looks like a fresh start, which
     * is what it is.
     *
     * `list` is deliberately NOT cleared. It comes from IndexedDB, it does not belong to any engine,
     * and clearing it would blank the library instead of showing it reconnecting.
     */
    const offReset = client.onEngineReset(() => { setWorkerError(null); setStorageUnavailable(false); setSnaps([]) })
    let checkedDemo = false
    const offList = client.onList((l) => {
      setList(l)
      // a torrent of one's own answers the offer for good; a temporary one (the sample, or a link
      // still waiting on its add dialog) does not, so a link turned down brings the offer back
      if (l.some((e) => !e.ephemeral)) { sampleAnswered(); setSampleOffered(false) }
    })
    const offState = client.onState((s) => {
      setSnaps(s)
      if (checkedDemo) return
      // only the engine owner decides: the cloud restore waited on below runs there alone
      if (!client.owns()) return
      checkedDemo = true
      void Promise.race([cloudRestoreSettled, new Promise<void>((r) => setTimeout(r, DEMO_GRACE))])
        .then(() => {
          try {
            if (!localStorage.getItem(DEMO_SEEDED_KEY)) setSampleOffered(true)
          } catch { }
        })
    })
    return () => { offReachable(); offTransport(); offInbound(); offDht(); offUnavailable(); offWorkerError(); offReset(); offList(); offState() }
  }, [client])

  const torrents = useMemo(() => libraryRows(snaps, list, words), [snaps, list, words])

  const addMagnet = useCallback((magnet: string) => { holdWhileStored(); return client.addMagnet(magnet) }, [client])
  const addTorrentFile = useCallback<TorrentClient['addTorrentFile']>((bytes, options) => { holdWhileStored(); return client.addTorrentFile(bytes, options) }, [client])
  const pause = useCallback((handle: number) => client.pause(handle), [client])
  const resume = useCallback((handle: number) => client.resume(handle), [client])
  const retry = useCallback((handle: number) => client.retry(handle), [client])
  const recheck = useCallback((handle: number) => client.recheck(handle), [client])
  const remove = useCallback((handle: number, deleteFiles?: boolean) => client.remove(handle, deleteFiles), [client])
  // with the account's .torrent kept first when this device has none, so the engine has the file list from the start
  const start = useCallback((infoHash: string) => { void keepSyncedTorrentFile(infoHash).then(() => client.start(infoHash)) }, [client])
  // each row's kept the same way, all at once, so the wait is as bounded as one row's
  const startMany = useCallback((infoHashes: string[]) => {
    void Promise.all(infoHashes.map((infoHash) => keepSyncedTorrentFile(infoHash))).then(() => client.startMany(infoHashes))
  }, [client])
  const removeMissing = useCallback((infoHash: string) => client.removeMissing(infoHash), [client])
  const answerSample = useCallback((add: boolean) => {
    sampleAnswered()
    setSampleOffered(false)
    if (add) void addDemo(client)
  }, [client])
  return { torrents, list, inboundNow, dhtNodes, addMagnet, addTorrentFile, pause, resume, retry, recheck, remove, start, startMany, removeMissing, storageUnavailable, workerError, reachable, transport, sampleOffered, answerSample, client }
}
