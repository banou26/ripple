import type { Persisted, TorrentSnapshot as WorkerTorrentSnapshot } from './worker'
import type { Transport, TransportFactory, TransportHost } from './engine-protocol'

import { relayWorker } from '@fkn/lib'

import { createChannelTransport, serveFollowers } from './engine-share'
import { createRecentRateTracker } from './recent-rate'
import { electEngineOwner } from './engine-election'
import { ENGINE_RESET, hasWebLocks, newClientId } from './engine-protocol'

export type { Persisted }
export type TorrentSnapshot = WorkerTorrentSnapshot & { displayDownloadRate: number }

// a read waits for the covering pieces to land, which never settles if they never arrive; every caller retries
const READ_TIMEOUT = 120_000

export type TorrentClient = {
  ready: Promise<void>
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  onList: (cb: (list: Persisted[]) => void) => () => void
  onStorageUnavailable: (cb: () => void) => () => void
  onWorkerError: (cb: (error: { message: string, fatal: boolean }) => void) => () => void
  onAddFailed: (cb: (message: string) => void) => () => void
  onOwnership: (cb: (owned: boolean) => void) => () => void
  owns: () => boolean
  onEngineReset: (cb: () => void) => () => void
  importList: (list: Persisted[]) => void
  clearList: () => void
  addMagnet: (magnet: string, savePath?: string) => void
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => void
  start: (infoHash: string) => void
  removeMissing: (infoHash: string) => void
  read: (handle: number, fileIndex: number, offset: number, len: number, prioritize?: boolean, viewer?: string) => Promise<Uint8Array>
  newViewerId: () => string
  watch: (viewer: string, handle: number, fileIndex: number, fromOffset?: number) => void
  unwatch: (viewer: string) => void
  pause: (handle: number) => void
  resume: (handle: number) => void
  retry: (handle: number) => void
  recheck: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  destroy: () => void
}

export type EngineClient = TorrentClient & {
  sendRaw: (msg: any) => void
  onRaw: (cb: (msg: any) => void) => () => void
  latestList: () => Persisted[] | null
  latestState: () => WorkerTorrentSnapshot[] | null
  started: () => boolean
  useTransport: (factory: TransportFactory, owns: boolean) => void
}

const workerTransport: TransportFactory = (host: TransportHost): Transport => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // the abort on destroy is load-bearing: a leaked relay neuters MessagePorts meant for the next worker
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
  // names this tab to the others, and prefixes the viewer ids its players hand out
  const docId = newClientId()
  let readId = 0
  let viewerId = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  let openGate!: () => void
  let gate!: Promise<void>
  const armGate = () => { gate = new Promise<void>((r) => { openGate = r }) }
  armGate()
  let fatal: Error | null = null
  let started = false
  let transport: Transport | null = null
  let owned = false
  let lastList: Persisted[] | null = null
  let lastState: TorrentSnapshot[] | null = null
  let lastRawState: WorkerTorrentSnapshot[] | null = null
  let storageIsUnavailable = false
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
    openGate()
    failReads(error)
  }

  // clearing `fatal` is the load-bearing part: without it a tab that saw one leader fail stays dead for good
  const resetEngineState = (reason: string) => {
    failReads(new Error(reason))
    started = false
    fatal = null
    fatalMessage = null
    storageIsUnavailable = false
    lastState = null
    lastRawState = null
    lastList = null
    // keyed by handle, so across a handover it would credit one torrent's bytes to another
    recentRate.retain(new Set())
    armGate()
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
      if (!started) { void gate.then(attempt); return }
      transport?.post(msg, transfer ?? [])
    }
    void gate.then(attempt)
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
      if (m.type === 'ready') { started = true; resolveReady(); openGate() }
      else if (m.type === ENGINE_RESET) {
        resetEngineState('the engine was taken over by another tab')
      } else if (m.type === 'storage-unavailable') {
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
      resetEngineState('the engine behind this tab was replaced')
      transport = factory(host, docId)
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
    newViewerId: () => `${docId}:${++viewerId}`,
    watch: (viewer, handle, fileIndex, fromOffset = 0) => send({ type: 'watch', viewer, handle, fileIndex, fromOffset }),
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
