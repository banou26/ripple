import type { Persisted, TorrentSnapshot as WorkerTorrentSnapshot } from './worker'
import type { Transport, TransportFactory, TransportHost } from './engine-protocol'

import { relayWorker } from '@fkn/lib'

import { createChannelTransport, serveFollowers } from './engine-share'
import { createRecentRateTracker } from './recent-rate'
import { electEngineOwner } from './engine-election'
import { ENGINE_RESET, hasWebLocks } from './engine-protocol'

export type { Persisted }
export type TorrentSnapshot = WorkerTorrentSnapshot & { displayDownloadRate: number }

// A read waits for the covering pieces to land, which is exactly right when the player
// seeks into a part that has not downloaded yet, and exactly wrong when they never
// arrive: the promise would never settle and the caller would sit there forever. Every
// caller retries, so bound the wait and let them ask again.
const READ_TIMEOUT = 120_000

export type TorrentClient = {
  ready: Promise<void>
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  onList: (cb: (list: Persisted[]) => void) => () => void
  // Fires when the worker cannot open OPFS (e.g. a private/incognito window); the
  // session is never created, so the UI should tell the user rather than hang.
  onStorageUnavailable: (cb: () => void) => () => void
  // Fires when the worker reported a problem. `fatal` separates the two very different
  // outcomes: a module that never loaded, or a session that could not be built, means
  // nothing will ever work and the UI has to say so. An uncaught throw in a worker that
  // is already running costs only the reads that were in flight.
  onWorkerError: (cb: (error: { message: string, fatal: boolean }) => void) => () => void
  // Fires when an add did not produce a torrent. Adds are optimistic (the UI confirms
  // before the engine has parsed anything), so this is the only failure channel.
  onAddFailed: (cb: (message: string) => void) => () => void
  // Whether this tab is the one hosting the engine. Side effects that must happen once for
  // the whole browser rather than once per tab hang off this.
  onOwnership: (cb: (owned: boolean) => void) => () => void
  owns: () => boolean
  // The engine behind this client was replaced, so everything derived from the old one is
  // stale: torrent handles above all, since they are a counter inside a libtorrent session
  // and the same number means a different torrent in the next one.
  onEngineReset: (cb: () => void) => () => void
  importList: (list: Persisted[]) => void
  clearList: () => void
  addMagnet: (magnet: string, savePath?: string) => void
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => void
  // Start downloading a synced "Files missing" torrent (keyed by infoHash, since
  // it has no session handle yet); removeMissing drops one without a handle.
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  read: (handle: number, fileIndex: number, offset: number, len: number, prioritize?: boolean) => Promise<Uint8Array>
  pause: (handle: number) => void
  resume: (handle: number) => void
  // Skip the wait for a torrent that is already retrying on a backoff.
  retry: (handle: number) => void
  // Verify a torrent's pieces against what is on disk, and re-download whatever does not
  // match. Runs in the engine, reported through the usual state updates.
  recheck: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  setSequential: (handle: number, on: boolean) => void
  prioritizeFile: (handle: number, fileIndex: number, fromOffset?: number) => void
  prioritizeRange: (handle: number, fileIndex: number, offset: number, len: number) => void
  destroy: () => void
}

// What the leader-side server needs on top of the public surface: raw access in both
// directions, so it can relay commands and rebroadcast worker messages without a
// translation table that could fall out of step with the client.
export type EngineClient = TorrentClient & {
  sendRaw: (msg: any) => void
  onRaw: (cb: (msg: any) => void) => () => void
  latestList: () => Persisted[] | null
  latestState: () => WorkerTorrentSnapshot[] | null
  // Whether the engine behind this client has a session yet. The leader answers a new
  // follower with a snapshot only once this is true, because a follower that is told the
  // engine is ready flushes its held commands, and the worker drops every command that
  // arrives before its session exists.
  started: () => boolean
  // `owns` says whether the new transport is this tab's own worker, which decides the
  // upkeep commands and what onOwnership reports. Passed rather than inferred, so a third
  // transport could never be mistaken for the owning one.
  useTransport: (factory: TransportFactory, owns: boolean) => void
}

// The engine in a dedicated worker in this tab. The only place a Worker is constructed, and
// the only path that can hold the OPFS sync handles the session needs.
const workerTransport: TransportFactory = (host: TransportHost): Transport => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // Bridges the worker's @fkn/lib/{net,dgram} sockets to the broker iframe; the abort on destroy is load-bearing (a leaked relay neuters MessagePorts meant for the next worker)
  const relayAbort = new AbortController()
  relayWorker(worker, { unregisterSignal: relayAbort.signal })
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
  const workerErrorCbs = new Set<(error: { message: string, fatal: boolean }) => void>()
  const addFailedCbs = new Set<(message: string) => void>()
  const ownershipCbs = new Set<(owned: boolean) => void>()
  const engineResetCbs = new Set<() => void>()
  const rawCbs = new Set<(msg: any) => void>()
  const reads = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: any) => void, timer: number }>()
  const recentRate = createRecentRateTracker()
  let readId = 0
  let resolveReady!: () => void
  // Public and one-shot: callers use it to know the engine came up at all, and an engine
  // that is later replaced does not un-happen that.
  const ready = new Promise<void>((r) => { resolveReady = r })
  // Internal and re-armable. Commands wait on this, so a handover parks them until the new
  // engine has a session rather than firing them at a worker that drops everything until it
  // does.
  let openGate!: () => void
  let gate!: Promise<void>
  const armGate = () => { gate = new Promise<void>((r) => { openGate = r }) }
  armGate()
  // Set once the engine can never serve anything again. Reads reject against it instead
  // of hanging, and `ready` is released so queued commands drain rather than pile up.
  let fatal: Error | null = null
  let started = false
  let transport: Transport | null = null
  // True only while this tab hosts the worker. Commands that exist to look after the engine
  // itself, rather than to do what a user asked, are pointless from a borrowing tab.
  let owned = false
  // The engine only pushes on change, so a component that subscribes after the fact would
  // see nothing until something moved. With one engine shared across routes that is every
  // remount: the library, the storage notice and the engine banner would all come back
  // empty on a route change and stay that way. Latch the last of each and replay it.
  let lastList: Persisted[] | null = null
  let lastState: TorrentSnapshot[] | null = null
  let lastRawState: WorkerTorrentSnapshot[] | null = null
  let storageIsUnavailable = false
  // Only a fatal one is latched: a transient throw must not come back as a banner on the
  // next remount, long after the engine recovered from it.
  let fatalMessage: string | null = null

  const settleRead = (id: number) => {
    const pending = reads.get(id)
    if (pending) { clearTimeout(pending.timer); reads.delete(id) }
    return pending
  }

  const failReads = (error: Error) => {
    for (const id of [...reads.keys()]) settleRead(id)?.reject(error)
  }

  // Only for an engine that is genuinely gone for good. One that is still ticking, or one
  // that is about to be replaced by a handover, must never land here: `fatal` is permanent
  // and silently swallows every later command.
  const die = (error: Error) => {
    if (fatal) return
    fatal = error
    resolveReady()
    openGate()
    failReads(error)
  }

  // A different engine is behind this client now. Everything the old one told us is void:
  // its handles name other torrents in the new session, its reads have no one to answer
  // them, and an error it reported was its own. Clearing `fatal` is the load-bearing part.
  // Without it a tab that saw one leader fail stays dead for good, and if it later wins the
  // lock its own perfectly healthy worker is never sent a single command.
  const resetEngineState = (reason: string) => {
    failReads(new Error(reason))
    started = false
    fatal = null
    fatalMessage = null
    storageIsUnavailable = false
    lastState = null
    lastRawState = null
    lastList = null
    // Keyed by handle, so across a handover it would credit one torrent's bytes to another.
    recentRate.retain(new Set())
    armGate()
    engineResetCbs.forEach((cb) => cb())
  }

  const reportWorkerError = (message: string, isFatal: boolean) => {
    if (isFatal) fatalMessage = message
    workerErrorCbs.forEach((cb) => cb({ message, fatal: isFatal }))
  }

  // The engine drops commands until its session exists, so hold them until it has one. Waits
  // again rather than once: a handover re-arms the gate, and a command caught mid-handover
  // has to reach the new engine, not be fired at the gap between them.
  const send = (msg: any, transfer?: Transferable[]) => {
    const attempt = () => {
      if (fatal) return
      if (!started) { void gate.then(attempt); return }
      transport?.post(msg, transfer ?? [])
    }
    void gate.then(attempt)
  }

  const host: TransportHost = {
    error: (message, isFatal) => {
      console.warn('[torrent engine] load/runtime error:', message)
      // Before ready the module never loaded, so nothing will ever work. After ready a
      // dedicated worker survives an uncaught throw and both its loops keep ticking, so the
      // only real casualties are the reads that were in flight.
      const permanent = isFatal || !started
      if (permanent) die(new Error(message))
      else failReads(new Error(message))
      reportWorkerError(message, permanent)
    },
    message: (m) => {
      if (!m || typeof m !== 'object') return
      rawCbs.forEach((cb) => cb(m))
      if (m.type === 'ready') { started = true; resolveReady(); openGate() }
      else if (m.type === ENGINE_RESET) {
        // Another tab took the engine over. Every read caller retries, so failing now is far
        // better than each of them sitting out the two minute timeout.
        resetEngineState('the engine was taken over by another tab')
      } else if (m.type === 'storage-unavailable') {
        // No session was ever built, so nothing queued behind `ready` can ever run.
        storageIsUnavailable = true
        die(new Error('storage unavailable'))
        storageUnavailableCbs.forEach((cb) => cb())
      } else if (m.type === 'state') {
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
      // The session could not be built at all, so nothing will ever work here.
      else if (m.type === 'fatal') {
        die(new Error(m.message))
        reportWorkerError(m.message, true)
      } else if (m.type === 'error' || m.type === 'worker-error') console.warn('[torrent engine]', m.message ?? m.args)
    },
  }

  // Connectivity came back. The engine reconnects to peers on its own schedule, but a
  // torrent it stopped over an error, or one whose swarm went away, needs a nudge. Only the
  // tab hosting the engine sends it: every tab sees the same event, and the others would
  // just be nagging the owner about news it already had.
  const onOnline = () => { if (owned) send({ type: 'retry-now' }) }
  window.addEventListener('online', onOnline)

  // Last chance to snapshot fast-resume state. Without it a tab close mid-download
  // costs up to 15s of progress, and the next load rechecks or re-downloads it. A borrowing
  // tab closing is not the engine closing, so it has nothing to flush.
  const onPageHide = () => { if (owned) send({ type: 'flush-resume' }) }
  window.addEventListener('pagehide', onPageHide)

  return {
    ready,
    // Each replays the latest value it has, so a fresh subscriber is never left staring at
    // an empty library or a dismissed warning. Safe to fire synchronously: every caller
    // subscribes from inside a useEffect body.
    onState: (cb) => { stateCbs.add(cb); if (lastState) cb(lastState); return () => { stateCbs.delete(cb) } },
    onList: (cb) => { listCbs.add(cb); if (lastList) cb(lastList); return () => { listCbs.delete(cb) } },
    onStorageUnavailable: (cb) => { storageUnavailableCbs.add(cb); if (storageIsUnavailable) cb(); return () => { storageUnavailableCbs.delete(cb) } },
    onWorkerError: (cb) => { workerErrorCbs.add(cb); if (fatalMessage) cb({ message: fatalMessage, fatal: true }); return () => { workerErrorCbs.delete(cb) } },
    onAddFailed: (cb) => { addFailedCbs.add(cb); return () => { addFailedCbs.delete(cb) } },
    onOwnership: (cb) => { ownershipCbs.add(cb); cb(owned); return () => { ownershipCbs.delete(cb) } },
    onEngineReset: (cb) => { engineResetCbs.add(cb); return () => { engineResetCbs.delete(cb) } },
    onRaw: (cb) => { rawCbs.add(cb); return () => { rawCbs.delete(cb) } },
    latestList: () => lastList,
    latestState: () => lastRawState,
    started: () => started,
    owns: () => owned,
    sendRaw: (msg) => send(msg),
    useTransport: (factory, owns) => {
      const previous = transport
      // A swap is a change of engine, not just of route to it, so everything the old one
      // said has to go with it.
      resetEngineState('the engine behind this tab was replaced')
      transport = factory(host)
      owned = owns
      previous?.destroy()
      ownershipCbs.forEach((cb) => cb(owned))
    },
    importList: (list) => send({ type: 'import-list', list }),
    clearList: () => send({ type: 'clear-list' }),
    addMagnet: (magnet, savePath) => send({ type: 'add-magnet', magnet, savePath }),
    addTorrentFile: (bytes, savePath) => send({ type: 'add-torrent-file', bytes, savePath }, [bytes.buffer]),
    start: (infoHash) => send({ type: 'start', infoHash }),
    removeMissing: (infoHash) => send({ type: 'remove-missing', infoHash }),
    read: (handle, fileIndex, offset, len, prioritize = true) => {
      if (fatal) return Promise.reject(fatal)
      return new Promise<Uint8Array>((resolve, reject) => {
        const id = ++readId
        const timer = window.setTimeout(
          () => settleRead(id)?.reject(new Error(`read timed out after ${READ_TIMEOUT}ms`)),
          READ_TIMEOUT,
        )
        reads.set(id, { resolve, reject, timer })
        send({ type: 'read', id, handle, fileIndex, offset, len, prioritize })
      })
    },
    pause: (handle) => send({ type: 'pause', handle }),
    resume: (handle) => send({ type: 'resume', handle }),
    retry: (handle) => send({ type: 'retry', handle }),
    recheck: (handle) => send({ type: 'recheck', handle }),
    remove: (handle, deleteFiles = false) => send({ type: 'remove', handle, deleteFiles }),
    setSequential: (handle, on) => send({ type: 'set-sequential', handle, on }),
    prioritizeFile: (handle, fileIndex, fromOffset = 0) => send({ type: 'prioritize-file', handle, fileIndex, fromOffset }),
    prioritizeRange: (handle, fileIndex, offset, len) => send({ type: 'prioritize-range', handle, fileIndex, offset, len }),
    destroy: () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
      die(new Error('torrent client destroyed'))
      transport?.destroy()
      transport = null
    },
  }
}

// Kept outside the client so tearing the client down also stops answering other tabs.
let stopServing: (() => void) | null = null

let shared: TorrentClient | null = null

// One engine per browser, shared by every route and every tab.
//
// A libtorrent session holds an exclusive OPFS lock on each file it is writing, so exactly
// one may run. That used to mean exactly one usable tab, with the rest showing a takeover
// prompt. Now a Web Lock picks which tab hosts the worker and the others borrow it over a
// BroadcastChannel, so every tab is usable and the engine survives closing any one of them.
//
// Sharing one within a document matters for the same reason: building a second session for
// the player meant a route change tore the first down and started another over the same
// files, and the handover lost the race often enough that torrents landed stopped on a disk
// error.
export const getTorrentClient = (): TorrentClient => {
  if (shared) return shared
  const client = createTorrentClient()
  shared = client

  if (!hasWebLocks()) {
    // Nothing to arbitrate with, so fall back to the old rule: this tab runs the engine, and
    // the single-tab guard in Mount is what stops a second one from starting.
    client.useTransport(workerTransport, true)
    return client
  }

  // Borrow first. If no other tab holds the lock this lasts a moment, and if one does it
  // lasts until that tab closes.
  client.useTransport(createChannelTransport, false)

  // A tab whose own engine cannot start must not sit on the lock: it would look healthy
  // while every other tab waits behind it for an engine that is never coming. Give the lock
  // back and go be a follower, so the next tab gets its turn. Bounded, because a browser
  // where OPFS is unavailable at all (a private window) fails identically in every tab, and
  // an unbounded version would hand the lock around the origin forever.
  const MAX_ATTEMPTS = 3
  let attempts = 0
  let election = electEngineOwner()

  const takeOver = () => {
    if (shared !== client) return
    attempts += 1
    // Listening before the transport swap: the worker's `ready` is what tells followers the
    // engine is up, and a server started after it would miss that message entirely.
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
    // Out of attempts: keep the lock and keep the error on screen. Passing it around would
    // only reproduce it in the next tab and clear the message that explains it.
    if (attempts >= MAX_ATTEMPTS) return
    standDown()
  })

  void election.elected.then(takeOver)

  return client
}

// Only for giving up the engine entirely.
export const destroyTorrentClient = () => {
  stopServing?.()
  stopServing = null
  shared?.destroy()
  shared = null
}
