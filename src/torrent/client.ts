import { relayWorker } from '@fkn/lib'

import type { TorrentSnapshot } from './worker'

export type { TorrentSnapshot }

export type TorrentBackend = 'libtorrent' | 'webtorrent'

export type TorrentClient = {
  ready: Promise<void>
  onState: (cb: (torrents: TorrentSnapshot[]) => void) => () => void
  addMagnet: (magnet: string, savePath?: string) => void
  addTorrentFile: (bytes: Uint8Array, savePath?: string) => void
  read: (handle: number, fileIndex: number, offset: number, len: number) => Promise<Uint8Array>
  pause: (handle: number) => void
  resume: (handle: number) => void
  remove: (handle: number, deleteFiles?: boolean) => void
  setSequential: (handle: number, on: boolean) => void
  prioritizeRange: (handle: number, fileIndex: number, offset: number, len: number) => void
  destroy: () => void
}

export const createTorrentClient = (backend: TorrentBackend = 'libtorrent'): TorrentClient => {
  const worker = backend === 'webtorrent'
    ? new Worker(new URL('./webtorrent-worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  // Bridge the worker's @webvpn/{net,dgram} socket calls to the main-thread
  // @fkn/lib broker iframe (→ WebVPN). This and our own listener coexist:
  // relayWorker handles the osra socket envelopes, we handle our typed messages.
  relayWorker(worker)

  worker.addEventListener('error', (e) => console.warn('[torrent worker] load/runtime error:', e.message, e.filename + ':' + e.lineno))

  const stateCbs = new Set<(t: TorrentSnapshot[]) => void>()
  const reads = new Map<number, { resolve: (b: Uint8Array) => void, reject: (e: any) => void }>()
  let readId = 0
  let resolveReady!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })

  worker.addEventListener('message', (e) => {
    const m = e.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'ready') resolveReady()
    else if (m.type === 'state') stateCbs.forEach((cb) => cb(m.torrents))
    else if (m.type === 'read-result') { reads.get(m.id)?.resolve(m.data); reads.delete(m.id) }
    else if (m.type === 'read-error') { reads.get(m.id)?.reject(new Error(m.error)); reads.delete(m.id) }
    else if (m.type === 'error' || m.type === 'worker-error') console.warn('[torrent worker]', m.message ?? m.args)
  })

  return {
    ready,
    onState: (cb) => { stateCbs.add(cb); return () => { stateCbs.delete(cb) } },
    addMagnet: (magnet, savePath) => worker.postMessage({ type: 'add-magnet', magnet, savePath }),
    addTorrentFile: (bytes, savePath) => worker.postMessage({ type: 'add-torrent-file', bytes, savePath }, [bytes.buffer]),
    read: (handle, fileIndex, offset, len) =>
      new Promise<Uint8Array>((resolve, reject) => {
        const id = ++readId
        reads.set(id, { resolve, reject })
        worker.postMessage({ type: 'read', id, handle, fileIndex, offset, len })
      }),
    pause: (handle) => worker.postMessage({ type: 'pause', handle }),
    resume: (handle) => worker.postMessage({ type: 'resume', handle }),
    remove: (handle, deleteFiles = false) => worker.postMessage({ type: 'remove', handle, deleteFiles }),
    setSequential: (handle, on) => worker.postMessage({ type: 'set-sequential', handle, on }),
    prioritizeRange: (handle, fileIndex, offset, len) => worker.postMessage({ type: 'prioritize-range', handle, fileIndex, offset, len }),
    destroy: () => worker.terminate(),
  }
}
