import type { Persisted, Reachability, TorrentDetail, TorrentSnapshot as WorkerTorrentSnapshot } from './worker'
import type { RateLimits } from './rate-limits'

import { normalizeLimits } from './rate-limits'
import type { SaveLocation } from './library'
import type { Transport, TransportFactory, TransportHost } from './engine-protocol'

import { relayWorker } from '@fkn/lib'

import { createChannelTransport, serveFollowers } from './engine-share'
import { createRecentRateTracker } from './recent-rate'
import { electEngineOwner } from './engine-election'
import { ENGINE_RESET, hasWebLocks, newClientId } from './engine-protocol'
import { createGate } from './gate'

export type { Persisted, Reachability, TorrentDetail }
export type TorrentSnapshot = WorkerTorrentSnapshot & { displayDownloadRate: number }

// a read waits for the covering pieces to land, which never settles if they never arrive; every caller retries
const READ_TIMEOUT = 120_000

export type TorrentClient = {
  ready: Promise<void>
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  onList: (cb: (list: Persisted[]) => void) => () => void
  onStorageUnavailable: (cb: () => void) => () => void
  /** The origin is out of room and the engine has nothing left it is allowed to reclaim. */
  onStorageFull: (cb: (full: boolean) => void) => () => void
  onWorkerError: (cb: (error: { message: string, fatal: boolean }) => void) => () => void
  onAddFailed: (cb: (message: string) => void) => () => void
  /** Where inbound peers can reach this session. Latched, so a late subscriber gets the last value. */
  onReachable: (cb: (reachable: Reachability) => void) => () => void
  /**
   * Peers and trackers for the one torrent {@link inspect} named, on every state broadcast.
   *
   * Not latched, unlike onReachable: a latched value would hand a newly opened panel the previous
   * torrent's peers, and a stale peer list is indistinguishable from a live one.
   */
  onDetail: (cb: (detail: TorrentDetail | null) => void) => () => void
  /**
   * Name the torrent whose detail should be computed, or null for none.
   *
   * The engine does the work for exactly one torrent, so this is not a subscription that stacks:
   * the last caller wins. A panel must clear it on close or the engine keeps paying for a list
   * nobody is reading.
   */
  inspect: (handle: number | null) => void
  /**
   * Turn libtorrent flags on and off: `mask` names the bits to touch, `flags` their new value.
   *
   * Fire and forget by design. The engine owns the outcome (it refuses some combinations, and
   * drives `paused` itself), so a caller reads the result off the next state broadcast rather than
   * assuming its request landed. Use `TORRENT_FLAG` from libtorrent-wasm for the bits.
   */
  setFlags: (handle: number, flags: number, mask: number) => void
  /** Announce to this torrent's trackers now. libtorrent rate limits it internally. */
  reannounce: (handle: number) => void
  moveInQueue: (handle: number, where: 'top' | 'up' | 'down' | 'bottom') => void
  /** Bytes per second, 0 for unlimited. Omit a side to leave it alone. Kept across reloads. */
  setLimits: (handle: number, limits: { down?: number, up?: number }) => void
  /**
   * The ceilings for everything at once, bytes per second, 0 for unlimited. Omit a side to leave it
   * alone.
   *
   * Held by the engine's own worker rather than by any page, so it survives the engine moving to
   * another tab. There is no getter to pair with this: subscribe with {@link onRateLimits} instead,
   * which reports what is actually in force.
   */
  setSessionLimits: (limits: { down?: number, up?: number }) => void
  /** The session ceilings in force, replayed immediately to a new subscriber once anything is known. */
  onRateLimits: (cb: (limits: RateLimits) => void) => () => void
  onOwnership: (cb: (owned: boolean) => void) => () => void
  owns: () => boolean
  onEngineReset: (cb: () => void) => () => void
  importList: (list: Persisted[]) => void
  clearList: () => void
  /**
   * `ephemeral` marks a torrent the PLAYER asked for rather than the user. Its bytes become a cache
   * the engine may reclaim under storage pressure, so only the player passes it; every path where a
   * person deliberately added something leaves it off, and a deliberate add clears it for good.
   */
  /**
   * `hold` fetches the torrent's file list and then stops, transferring nothing until somebody
   * watches or reads it. For a page that offers a Download button rather than starting one.
   */
  addMagnet: (magnet: string, options?: { savePath?: string, ephemeral?: boolean, hold?: boolean }) => void
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => void
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  read: (handle: number, fileIndex: number, offset: number, len: number, prioritize?: boolean, viewer?: string) => Promise<Uint8Array>
  newViewerId: () => string
  /**
   * Move a viewer's anchor. Pass `readLen` when the move came from a read rather than from a user seek:
   * it routes through the same re-anchor test a read takes, which debounces small moves and refuses to
   * follow a demuxer index probe at the file's tail. A seek has neither of those and wants neither.
   */
  /**
   * `held` registers the claim WITHOUT asking for any bytes: nothing is prioritised and a cache
   * torrent stays parked. It is how a page says "this is open in front of somebody" so the storage
   * budget does not reclaim a torrent whose page is still on screen.
   */
  watch: (viewer: string, handle: number, fileIndex: number, fromOffset?: number, readLen?: number, held?: boolean) => void
  unwatch: (viewer: string) => void
  pause: (handle: number) => void
  resume: (handle: number) => void
  retry: (handle: number) => void
  recheck: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  /**
   * Point a torrent at the other storage, with its files already copied there.
   *
   * The copy is the CALLER's job, because the code that writes into the user's folder lives in the
   * page along with the directory handle and already verifies what it wrote. This is only the engine
   * half: drop the old copy where dropping it is ours to do, forget the resume data, and re-add
   * against the new path so the storage is asked what it holds.
   */
  relocate: (handle: number, to: SaveLocation) => void
  /**
   * Record where a torrent's files belong, without moving anything.
   *
   * Separate from `relocate` because the two answer different questions. This is the user's intent,
   * which is worth remembering the moment they express it even when it cannot be acted on yet: a
   * folder cannot hold a download in progress, so choosing one for something still downloading is
   * stored now and carried out when it finishes.
   */
  setLocation: (infoHash: string, to: SaveLocation) => void
  /**
   * How this torrent should be downloaded when nobody is watching it: which files, and whether to
   * take the head and tail of each ahead of the middle.
   *
   * `wanted` is file indices, and leaving it out means all of them, which is NOT the same as an
   * empty array. Both are stored on the library entry as well as applied, because the engine's copy
   * does not survive a reload: the pass that hands a torrent back to ordinary downloading rewrites
   * the whole priority map.
   */
  setPlan: (handle: number, plan: { wanted?: number[], firstLast?: boolean }) => void
  /**
   * Offer the engine the directory the user granted, or null once it is gone.
   *
   * The engine reads a folder-backed torrent through this, so it has to reach the realm the engine
   * runs in, which is not necessarily the tab the user clicked Allow in. Every tab with a permitted
   * handle offers it, and the newest offer wins.
   */
  setFolder: (handle: FileSystemDirectoryHandle | null) => void
  destroy: () => void
}

export type EngineClient = TorrentClient & {
  sendRaw: (msg: any) => void
  onRaw: (cb: (msg: any) => void) => () => void
  latestList: () => Persisted[] | null
  latestState: () => WorkerTorrentSnapshot[] | null
  latestReachable: () => Reachability | null
  /** For the leader replaying state to a follower that just joined. Null before the first broadcast. */
  latestRateLimits: () => RateLimits | null
  started: () => boolean
  useTransport: (factory: TransportFactory, owns: boolean) => void
}

const workerTransport: TransportFactory = (host: TransportHost): Transport => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // the abort on destroy is load-bearing: a leaked relay neuters MessagePorts meant for the next worker
  const relayAbort = new AbortController()
  // relayWorker returns a promise, and this is the ONE call that bridges the worker's osra
  // transport to the broker. Dropping its rejection leaves a worker whose every socket call parks
  // with no listening, no error and nothing on screen, which is precisely the state that made a
  // missing relay port present as a transport fault and cost a long diagnosis.
  relayWorker(worker, { unregisterSignal: relayAbort.signal })
    .catch((e: unknown) => host.error(`relayWorker: ${e instanceof Error ? e.message : String(e)}`, true))
  const onError = (e: ErrorEvent) => host.error(`${e.message} (${e.filename}:${e.lineno})`, false)
  const onMessage = (e: MessageEvent) => host.message(e.data)
  worker.addEventListener('error', onError)
  worker.addEventListener('message', onMessage)
  return {
    post: (msg, transfer) => worker.postMessage(msg, transfer),
    destroy: () => {
      worker.removeEventListener('error', onError)
      worker.removeEventListener('message', onMessage)
      relayAbort.abort()
      worker.terminate()
    },
  }
}

const createTorrentClient = (): EngineClient => {
  const stateCbs = new Set<(t: TorrentSnapshot[]) => void>()
  const listCbs = new Set<(l: Persisted[]) => void>()
  const storageUnavailableCbs = new Set<() => void>()
  const storageFullCbs = new Set<(full: boolean) => void>()
  const workerErrorCbs = new Set<(error: { message: string, fatal: boolean }) => void>()
  const addFailedCbs = new Set<(message: string) => void>()
  const ownershipCbs = new Set<(owned: boolean) => void>()
  const engineResetCbs = new Set<() => void>()
  const rawCbs = new Set<(msg: any) => void>()
  const reachableCbs = new Set<(r: Reachability) => void>()
  const rateLimitsCbs = new Set<(limits: RateLimits) => void>()
  const detailCbs = new Set<(d: TorrentDetail | null) => void>()
  const reads = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: any) => void, timer: number }>()
  const recentRate = createRecentRateTracker()
  // names this tab to the others, and prefixes the viewer ids its players hand out
  const docId = newClientId()
  let readId = 0
  let viewerId = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  const gate = createGate()
  let fatal: Error | null = null
  let started = false
  let transport: Transport | null = null
  let owned = false
  let lastList: Persisted[] | null = null
  let lastState: TorrentSnapshot[] | null = null
  let lastRawState: WorkerTorrentSnapshot[] | null = null
  let lastReachable: Reachability | null = null
  // the engine is the only place these are true, and it cannot be asked, so this latches whatever
  // the last broadcast said rather than mirroring a copy the page keeps
  let lastRateLimits: RateLimits | null = null
  let storageIsUnavailable = false
  let storageIsFull = false
  let fatalMessage: string | null = null

  const settleRead = (id: number) => {
    const pending = reads.get(id)
    if (pending) { clearTimeout(pending.timer); reads.delete(id) }
    return pending
  }

  const failReads = (error: Error) => {
    for (const id of [...reads.keys()]) settleRead(id)?.reject(error)
  }

  // only for an engine that is genuinely gone for good: `fatal` is permanent and silently swallows every later command
  const die = (error: Error) => {
    if (fatal) return
    fatal = error
    resolveReady()
    gate.open()
    failReads(error)
  }

  // clearing `fatal` is the load-bearing part: without it a tab that saw one leader fail stays dead for good
  const resetEngineState = (reason: string) => {
    failReads(new Error(reason))
    started = false
    fatal = null
    fatalMessage = null
    storageIsUnavailable = false
    storageIsFull = false
    lastState = null
    lastRawState = null
    // a new engine reserves its own port, so the old one describes a session that no longer exists
    lastReachable = null
    lastList = null
    // keyed by handle, so across a handover it would credit one torrent's bytes to another
    recentRate.retain(new Set())
    gate.arm()
    engineResetCbs.forEach((cb) => cb())
  }

  const reportWorkerError = (message: string, isFatal: boolean) => {
    if (isFatal) fatalMessage = message
    workerErrorCbs.forEach((cb) => cb({ message, fatal: isFatal }))
  }

  // waits on the gate again rather than once: a command caught mid-handover has to reach the new engine, not the gap between them
  const send = (msg: any, transfer?: Transferable[]) => {
    const attempt = () => {
      if (fatal) return
      if (!started) { gate.wait(attempt); return }
      transport?.post(msg, transfer ?? [])
    }
    gate.wait(attempt)
  }

  const host: TransportHost = {
    error: (message, isFatal) => {
      console.warn('[torrent engine] load/runtime error:', message)
      const permanent = isFatal || !started
      if (permanent) die(new Error(message))
      else failReads(new Error(message))
      reportWorkerError(message, permanent)
    },
    message: (m) => {
      if (!m || typeof m !== 'object') return
      rawCbs.forEach((cb) => cb(m))
      if (m.type === 'ready') { started = true; resolveReady(); gate.open() }
      else if (m.type === ENGINE_RESET) {
        resetEngineState('the engine was taken over by another tab')
      } else if (m.type === 'storage-unavailable') {
        storageIsUnavailable = true
        die(new Error('storage unavailable'))
        storageUnavailableCbs.forEach((cb) => cb())
      } else if (m.type === 'storage-full') {
        // recoverable, unlike storage-unavailable: the engine keeps running and says so again when
        // room appears, so this must never reach die()
        storageIsFull = !!m.full
        storageFullCbs.forEach((cb) => cb(storageIsFull))
      } else if (m.type === 'state') {
        if (m.reachable) { lastReachable = m.reachable; reachableCbs.forEach((cb) => cb(m.reachable)) }
        // absent rather than unlimited when a synthesized state reply omits it, so a tab that has
        // just joined keeps showing the last real answer instead of flashing "Unlimited"
        if (m.rateLimits) {
          lastRateLimits = normalizeLimits(m.rateLimits)
          rateLimitsCbs.forEach((cb) => cb(lastRateLimits!))
        }
        // null is a real answer: it means nothing is inspected, and a panel reads it as "no data yet"
        detailCbs.forEach((cb) => cb(m.detail ?? null))
        const handles = new Set<number>()
        const at = performance.now()
        lastRawState = m.torrents as WorkerTorrentSnapshot[]
        const torrents = lastRawState.map((torrent): TorrentSnapshot => {
          handles.add(torrent.handle)
          const stopped = torrent.status?.paused || torrent.status?.state === 4 || torrent.status?.state === 5
          if (stopped) recentRate.reset(torrent.handle)
          return {
            ...torrent,
            displayDownloadRate: stopped
              ? 0
              : torrent.status
                ? recentRate.sample(torrent.handle, torrent.status.totalDone, at) ?? torrent.status.downloadRate
                : 0,
          }
        })
        recentRate.retain(handles)
        lastState = torrents
        stateCbs.forEach((cb) => cb(torrents))
      } else if (m.type === 'list') { lastList = m.list; listCbs.forEach((cb) => cb(m.list)) }
      else if (m.type === 'read-result') settleRead(m.id)?.resolve(m.data)
      else if (m.type === 'read-error') settleRead(m.id)?.reject(new Error(m.error))
      else if (m.type === 'add-failed') addFailedCbs.forEach((cb) => cb(m.message))
      else if (m.type === 'fatal') {
        die(new Error(m.message))
        reportWorkerError(m.message, true)
      } else if (m.type === 'error' || m.type === 'worker-error') console.warn('[torrent engine]', m.message ?? m.args)
    },
  }

  const onOnline = () => { if (owned) send({ type: 'retry-now' }) }
  window.addEventListener('online', onOnline)

  // last chance to snapshot fast-resume state: without it a tab close mid-download costs up to 15s of progress
  const onPageHide = () => { if (owned) send({ type: 'flush-resume' }) }
  window.addEventListener('pagehide', onPageHide)

  return {
    ready,
    // each replays its latched value to a new subscriber synchronously, which is safe only because every caller subscribes from inside a useEffect body
    onState: (cb) => { stateCbs.add(cb); if (lastState) cb(lastState); return () => { stateCbs.delete(cb) } },
    onList: (cb) => { listCbs.add(cb); if (lastList) cb(lastList); return () => { listCbs.delete(cb) } },
    onStorageUnavailable: (cb) => { storageUnavailableCbs.add(cb); if (storageIsUnavailable) cb(); return () => { storageUnavailableCbs.delete(cb) } },
    onStorageFull: (cb) => { storageFullCbs.add(cb); if (storageIsFull) cb(true); return () => { storageFullCbs.delete(cb) } },
    onWorkerError: (cb) => { workerErrorCbs.add(cb); if (fatalMessage) cb({ message: fatalMessage, fatal: true }); return () => { workerErrorCbs.delete(cb) } },
    onAddFailed: (cb) => { addFailedCbs.add(cb); return () => { addFailedCbs.delete(cb) } },
    onReachable: (cb) => { reachableCbs.add(cb); if (lastReachable) cb(lastReachable); return () => { reachableCbs.delete(cb) } },
    onDetail: (cb) => { detailCbs.add(cb); return () => { detailCbs.delete(cb) } },
    inspect: (handle) => send({ type: 'inspect', handle }),
    setFlags: (handle, flags, mask) => send({ type: 'set-flags', handle, flags, mask }),
    reannounce: (handle) => send({ type: 'reannounce', handle }),
    moveInQueue: (handle, where) => send({ type: 'queue-move', handle, where }),
    setLimits: (handle, limits) => send({ type: 'set-limits', handle, ...limits }),
    setSessionLimits: (limits) => send({ type: 'set-session-limits', ...limits }),
    onRateLimits: (cb) => { rateLimitsCbs.add(cb); if (lastRateLimits) cb(lastRateLimits); return () => { rateLimitsCbs.delete(cb) } },
    onOwnership: (cb) => { ownershipCbs.add(cb); cb(owned); return () => { ownershipCbs.delete(cb) } },
    onEngineReset: (cb) => { engineResetCbs.add(cb); return () => { engineResetCbs.delete(cb) } },
    onRaw: (cb) => { rawCbs.add(cb); return () => { rawCbs.delete(cb) } },
    latestList: () => lastList,
    latestState: () => lastRawState,
    latestReachable: () => lastReachable,
    latestRateLimits: () => lastRateLimits,
    started: () => started,
    owns: () => owned,
    sendRaw: (msg) => send(msg),
    useTransport: (factory, owns) => {
      const previous = transport
      // Taken BEFORE the reset and before the swap: a follower queues every command until a leader
      // speaks, and this call is what happens when THIS document becomes that leader. Dropping the
      // backlog here loses whatever the page asked for during its own election, silently and with no
      // error anywhere. `/embed` calls addMagnet on mount, which is inside that window, so losing it
      // means the engine never hears about the torrent and the player waits on metadata forever.
      const carried = previous?.pending?.() ?? []
      resetEngineState('the engine behind this tab was replaced')
      transport = factory(host, docId)
      owned = owns
      previous?.destroy()
      ownershipCbs.forEach((cb) => cb(owned))
      for (const msg of carried) transport.post(msg, [])
    },
    importList: (list) => send({ type: 'import-list', list }),
    clearList: () => send({ type: 'clear-list' }),
    addMagnet: (magnet, options) => send({ type: 'add-magnet', magnet, savePath: options?.savePath, ephemeral: options?.ephemeral === true, hold: options?.hold === true }),
    addTorrentFile: (bytes, savePath) => send({ type: 'add-torrent-file', bytes, savePath }, [bytes.buffer]),
    start: (infoHash) => send({ type: 'start', infoHash }),
    removeMissing: (infoHash) => send({ type: 'remove-missing', infoHash }),
    read: (handle, fileIndex, offset, len, prioritize = true, viewer) => {
      if (fatal) return Promise.reject(fatal)
      return new Promise<Uint8Array>((resolve, reject) => {
        const id = ++readId
        const timer = window.setTimeout(
          () => settleRead(id)?.reject(new Error(`read timed out after ${READ_TIMEOUT}ms`)),
          READ_TIMEOUT,
        )
        reads.set(id, { resolve, reject, timer })
        send({ type: 'read', id, handle, fileIndex, offset, len, prioritize, viewer })
      })
    },
    pause: (handle) => send({ type: 'pause', handle }),
    resume: (handle) => send({ type: 'resume', handle }),
    retry: (handle) => send({ type: 'retry', handle }),
    recheck: (handle) => send({ type: 'recheck', handle }),
    remove: (handle, deleteFiles = false) => send({ type: 'remove', handle, deleteFiles }),
    relocate: (handle, to) => send({ type: 'relocate', handle, to }),
    setLocation: (infoHash, to) => send({ type: 'set-location', infoHash, to }),
    setPlan: (handle, plan) => send({ type: 'set-plan', handle, wanted: plan.wanted, firstLast: plan.firstLast === true }),
    setFolder: (handle) => send({ type: 'set-folder', handle }),
    newViewerId: () => `${docId}:${++viewerId}`,
    watch: (viewer, handle, fileIndex, fromOffset = 0, readLen, held) => send({ type: 'watch', viewer, handle, fileIndex, fromOffset, readLen, held: held === true }),
    unwatch: (viewer) => send({ type: 'unwatch', viewer }),
    destroy: () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
      die(new Error('torrent client destroyed'))
      transport?.destroy()
      transport = null
    },
  }
}

let stopServing: (() => void) | null = null

let shared: TorrentClient | null = null

// a libtorrent session holds an exclusive OPFS lock on each file it is writing, so exactly one may run per browser
export const getTorrentClient = (): TorrentClient => {
  if (shared) return shared
  const client = createTorrentClient()
  shared = client

  if (!hasWebLocks()) {
    client.useTransport(workerTransport, true)
    return client
  }

  client.useTransport(createChannelTransport, false)

  // bounded, because a browser where OPFS is unavailable at all fails identically in every tab and would hand the lock around the origin forever
  const MAX_ATTEMPTS = 3
  let attempts = 0
  let election = electEngineOwner()

  const takeOver = () => {
    if (shared !== client) return
    attempts += 1
    // listen before the transport swap: the worker's `ready` is what tells followers the engine is up, and a server started after it would miss that message
    stopServing = serveFollowers(client)
    client.useTransport(workerTransport, true)
  }

  const standDown = () => {
    stopServing?.()
    stopServing = null
    election.abandon()
    client.useTransport(createChannelTransport, false)
    election = electEngineOwner()
    void election.elected.then(takeOver)
  }

  client.onWorkerError(({ fatal }) => {
    if (!fatal || !client.owns() || shared !== client) return
    if (attempts >= MAX_ATTEMPTS) return
    standDown()
  })

  void election.elected.then(takeOver)

  return client
}

export const destroyTorrentClient = () => {
  stopServing?.()
  stopServing = null
  shared?.destroy()
  shared = null
}
