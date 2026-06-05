// libtorrent-wasm Session running in a Web Worker, with @webvpn/{net,dgram} as
// the transport (relayed to the main-thread @fkn/lib iframe via relayWorker).
// Mirrors libtorrent-wasm/src/app/worker.ts but drives the high-level Session
// API (files/read/bitfield/status) instead of the raw module.

import './node-shims'

import * as net from '@webvpn/net'
import * as dgram from '@webvpn/dgram'
import { createSession } from 'libtorrent-wasm'
import type { Session, TorrentFiles, TorrentStatus, PieceBitfield } from 'libtorrent-wasm'
import { OPFSStorage } from 'libtorrent-wasm/opfs'

// Messages we own. relayWorker handles the osra socket envelopes separately, so
// we only act on our whitelisted types and ignore everything else.
const OWN = new Set(['add-magnet', 'read', 'remove', 'set-sequential', 'prioritize-range'])

export type TorrentSnapshot = {
  handle: number
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
}

let session: Session | null = null
const handles: number[] = []
const magnetByHandle = new Map<number, string>()

const post = (msg: any, transfer?: Transferable[]) => (self as any).postMessage(msg, transfer ?? [])

const snapshot = (): TorrentSnapshot[] =>
  handles.map((h) => {
    const bf = session!.bitfield(h)
    return {
      handle: h,
      magnet: magnetByHandle.get(h) ?? '',
      files: session!.files(h),
      status: session!.status(h),
      bitfield: bf ? { numPieces: bf.numPieces, pieceLength: bf.pieceLength, length: bf.length, pieces: bf.pieces } : null,
    }
  })

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  session = await createSession({ net, dgram, storage: new OPFSStorage() })
  // Bring up the listen sockets so the FKN transport init runs.
  for (let i = 0; i < 30; i++) session.tick()
  post({ type: 'ready' })

  // Pump the engine + push a state snapshot. popAlerts() decodes the binary
  // records into the Session's caches AND resolves any pending read() waiters.
  setInterval(() => {
    if (!session) return
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
    post({ type: 'state', torrents: snapshot() })
  }, 500)
}

self.addEventListener('message', async (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !OWN.has(m.type)) return
  if (!session) { post({ type: 'error', message: 'worker not initialized' }); return }
  try {
    if (m.type === 'add-magnet') {
      const h = session.addMagnet(m.magnet, m.savePath || '/dl')
      if (!handles.includes(h)) { handles.push(h); magnetByHandle.set(h, m.magnet) }
      post({ type: 'added', handle: h, magnet: m.magnet })
    } else if (m.type === 'read') {
      const data = await session.read(m.handle, m.fileIndex, m.offset, m.len)
      post({ type: 'read-result', id: m.id, data }, [data.buffer])
    } else if (m.type === 'remove') {
      session.removeTorrent(m.handle)
      const i = handles.indexOf(m.handle); if (i >= 0) handles.splice(i, 1)
      magnetByHandle.delete(m.handle)
    } else if (m.type === 'set-sequential') {
      session.setSequential(m.handle, m.on)
    } else if (m.type === 'prioritize-range') {
      session.prioritizeRange(m.handle, m.fileIndex, m.offset, m.len)
    }
  } catch (err: any) {
    if (m.type === 'read') post({ type: 'read-error', id: m.id, error: String(err?.stack ?? err) })
    else post({ type: 'error', message: String(err?.stack ?? err) })
  }
})

init().catch((e: any) => post({ type: 'error', message: String(e?.stack ?? e) }))
