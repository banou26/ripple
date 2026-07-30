import type { Persisted, TorrentSnapshot as WorkerTorrentSnapshot } from './worker'

import { relayWorker } from '@fkn/lib'

import { createRecentRateTracker } from './recent-rate'

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
  remove: (handle: number, deleteFiles?: boolean) => void
  setSequential: (handle: number, on: boolean) => void
  prioritizeFile: (handle: number, fileIndex: number, fromOffset?: number) => void
  prioritizeRange: (handle: number, fileIndex: number, offset: number, len: number) => void
  destroy: () => void
}

const createTorrentClient = (): TorrentClient => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // Bridges the worker's @fkn/lib/{net,dgram} sockets to the broker iframe; the abort on destroy is load-bearing (a leaked relay neuters MessagePorts meant for the next worker)
  const relayAbort = new AbortController()
  relayWorker(worker, { unregisterSignal: relayAbort.signal })

  const stateCbs = new Set<(t: TorrentSnapshot[]) => void>()
  const listCbs = new Set<(l: Persisted[]) => void>()
  const storageUnavailableCbs = new Set<() => void>()
  const workerErrorCbs = new Set<(error: { message: string, fatal: boolean }) => void>()
  const addFailedCbs = new Set<(message: string) => void>()
  const reads = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: any) => void, timer: number }>()
  const recentRate = createRecentRateTracker()
  let readId = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  // Set once the worker can never serve anything again. Reads reject against it instead
  // of hanging, and `ready` is released so queued commands drain rather than pile up.
  let fatal: Error | null = null
  let started = false
  // The worker only pushes on change, so a component that subscribes after the fact would
  // see nothing until something moved. With one engine shared across routes that is every
  // remount: the library, the storage notice and the engine banner would all come back
  // empty on a route change and stay that way. Latch the last of each and replay it.
  let lastList: Persisted[] | null = null
  let lastState: TorrentSnapshot[] | null = null
  let storageIsUnavailable = false
  // Only a fatal one is latched: a transient throw must not come back as a banner on the
  // next remount, long after the worker recovered from it.
  let fatalMessage: string | null = null

  const settleRead = (id: number) => {
    const pending = reads.get(id)
    if (pending) { clearTimeout(pending.timer); reads.delete(id) }
    return pending
  }

  const failReads = (error: Error) => {
    for (const id of [...reads.keys()]) settleRead(id)?.reject(error)
  }

  // Only for a worker that is genuinely gone. An engine that is still ticking must never
  // land here: `fatal` is permanent and silently swallows every later command.
  const die = (error: Error) => {
    if (fatal) return
    fatal = error
    resolveReady()
    failReads(error)
  }

  const reportWorkerError = (message: string, isFatal: boolean) => {
    if (isFatal) fatalMessage = message
    workerErrorCbs.forEach((cb) => cb({ message, fatal: isFatal }))
  }

  // The worker drops commands until its session exists; queue them behind ready
  // so an add right after page load isn't silently lost.
  const send = (msg: any, transfer?: Transferable[]) => { void ready.then(() => { if (!fatal) worker.postMessage(msg, transfer ?? []) }) }

  worker.addEventListener('error', (e) => {
    const message = `${e.message} (${e.filename}:${e.lineno})`
    console.warn('[torrent worker] load/runtime error:', message)
    // Before ready the module never loaded, so nothing will ever work. After ready a
    // dedicated worker survives an uncaught throw and both its loops keep ticking, so the
    // only real casualties are the reads that were in flight.
    if (!started) die(new Error(message))
    else failReads(new Error(message))
    reportWorkerError(message, !started)
  })

  worker.addEventListener('message', (e) => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') { started = true; resolveReady() }
    else if (m.type === 'storage-unavailable') {
      // No session was ever built, so nothing queued behind `ready` can ever run.
      storageIsUnavailable = true
      die(new Error('storage unavailable'))
      storageUnavailableCbs.forEach((cb) => cb())
    } else if (m.type === 'state') {
      const handles = new Set<number>()
      const at = performance.now()
      const torrents = (m.torrents as WorkerTorrentSnapshot[]).map((torrent): TorrentSnapshot => {
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
    } else if (m.type === 'error' || m.type === 'worker-error') console.warn('[torrent worker]', m.message ?? m.args)
  })

  // Connectivity came back. The engine reconnects to peers on its own schedule, but a
  // torrent it stopped over an error, or one whose swarm went away, needs a nudge.
  const onOnline = () => send({ type: 'retry-now' })
  window.addEventListener('online', onOnline)

  // Last chance to snapshot fast-resume state. Without it a tab close mid-download
  // costs up to 15s of progress, and the next load rechecks or re-downloads it.
  const onPageHide = () => send({ type: 'flush-resume' })
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
    remove: (handle, deleteFiles = false) => send({ type: 'remove', handle, deleteFiles }),
    setSequential: (handle, on) => send({ type: 'set-sequential', handle, on }),
    prioritizeFile: (handle, fileIndex, fromOffset = 0) => send({ type: 'prioritize-file', handle, fileIndex, fromOffset }),
    prioritizeRange: (handle, fileIndex, offset, len) => send({ type: 'prioritize-range', handle, fileIndex, offset, len }),
    destroy: () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pagehide', onPageHide)
      die(new Error('torrent client destroyed'))
      relayAbort.abort()
      worker.terminate()
    },
  }
}

let shared: TorrentClient | null = null

// One engine per page, shared by every route.
//
// A libtorrent session holds an exclusive OPFS lock on each file it is writing. Building
// a second one for the player meant a route change tore the first down and started
// another over the same files, and the handover lost the race often enough that torrents
// landed stopped on a disk error. Sharing one also means the library keeps downloading
// while a video plays, instead of the session restarting from scratch on every
// navigation.
export const getTorrentClient = (): TorrentClient => (shared ??= createTorrentClient())

// Only for giving up the engine entirely (another tab took over as the active window).
export const destroyTorrentClient = () => {
  shared?.destroy()
  shared = null
}
