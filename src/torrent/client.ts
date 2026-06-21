import { relayWorker } from '@fkn/lib'

import type { Persisted, TorrentSnapshot } from './worker'

export type { Persisted, TorrentSnapshot }

export type TorrentClient = {
  ready: Promise<void>
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  onList: (cb: (list: Persisted[]) => void) => () => void
  importList: (list: Persisted[]) => void
  clearList: () => void
  addMagnet: (magnet: string, savePath?: string) => void
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => void
  read: (handle: number, fileIndex: number, offset: number, len: number, prioritize?: boolean) => Promise<Uint8Array>
  pause: (handle: number) => void
  resume: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  setSequential: (handle: number, on: boolean) => void
  prioritizeFile: (handle: number, fileIndex: number, fromOffset?: number) => void
  prioritizeRange: (handle: number, fileIndex: number, offset: number, len: number) => void
  destroy: () => void
}

export const createTorrentClient = (): TorrentClient => {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // Bridge the worker's @webvpn/{net,dgram} socket calls to the main-thread
  // @fkn/lib broker iframe (→ WebVPN). This and our own listener coexist:
  // relayWorker handles the osra socket envelopes, we handle our typed messages.
  // The abort on destroy is load-bearing: a leaked relay listener keeps
  // forwarding broker messages to the dead worker, transferring (and thereby
  // neutering) MessagePorts meant for the next client's worker.
  const relayAbort = new AbortController()
  relayWorker(worker, { unregisterSignal: relayAbort.signal })

  worker.addEventListener('error', (e) => console.warn('[torrent worker] load/runtime error:', e.message, e.filename + ':' + e.lineno))

  const stateCbs = new Set<(t: TorrentSnapshot[]) => void>()
  const listCbs = new Set<(l: Persisted[]) => void>()
  const reads = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: any) => void }>()
  let readId = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  // The worker drops commands until its session exists; queue them behind ready
  // so an add right after page load isn't silently lost.
  const send = (msg: any, transfer?: Transferable[]) => { ready.then(() => worker.postMessage(msg, transfer ?? [])) }

  worker.addEventListener('message', (e) => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') resolveReady()
    else if (m.type === 'state') stateCbs.forEach((cb) => cb(m.torrents))
    else if (m.type === 'list') listCbs.forEach((cb) => cb(m.list))
    else if (m.type === 'read-result') { reads.get(m.id)?.resolve(m.data); reads.delete(m.id) }
    else if (m.type === 'read-error') { reads.get(m.id)?.reject(new Error(m.error)); reads.delete(m.id) }
    else if (m.type === 'error' || m.type === 'worker-error') console.warn('[torrent worker]', m.message ?? m.args)
  })

  return {
    ready,
    onState: (cb) => { stateCbs.add(cb); return () => { stateCbs.delete(cb) } },
    onList: (cb) => { listCbs.add(cb); return () => { listCbs.delete(cb) } },
    importList: (list) => send({ type: 'import-list', list }),
    clearList: () => send({ type: 'clear-list' }),
    addMagnet: (magnet, savePath) => send({ type: 'add-magnet', magnet, savePath }),
    addTorrentFile: (bytes, savePath) => send({ type: 'add-torrent-file', bytes, savePath }, [bytes.buffer]),
    read: (handle, fileIndex, offset, len, prioritize = true) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = ++readId
        reads.set(id, { resolve, reject })
        send({ type: 'read', id, handle, fileIndex, offset, len, prioritize })
      }),
    pause: (handle) => send({ type: 'pause', handle }),
    resume: (handle) => send({ type: 'resume', handle }),
    remove: (handle, deleteFiles = false) => send({ type: 'remove', handle, deleteFiles }),
    setSequential: (handle, on) => send({ type: 'set-sequential', handle, on }),
    prioritizeFile: (handle, fileIndex, fromOffset = 0) => send({ type: 'prioritize-file', handle, fileIndex, fromOffset }),
    prioritizeRange: (handle, fileIndex, offset, len) => send({ type: 'prioritize-range', handle, fileIndex, offset, len }),
    destroy: () => { relayAbort.abort(); worker.terminate() },
  }
}
