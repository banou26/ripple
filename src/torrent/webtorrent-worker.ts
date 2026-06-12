// WebTorrent backend running in a Web Worker. We consume the fork's PREBUILT
// bundle (dist/webtorrent.min.js) - self-contained, with @webvpn/{net,dgram} →
// @fkn/lib baked in (rebuilt against the local @fkn/lib so the relayWorker
// handshake matches). Speaks the SAME postMessage protocol + emits the SAME
// TorrentSnapshot as the libtorrent worker, so client.ts is backend-agnostic.
// Storage is a single OPFS file per torrent (OPFSSingleFileStore), not per piece.
//
// IMPORTANT: do NOT shim `window` here. WebTorrent's window accesses are guarded,
// but @fkn/lib decides worker-relay-vs-iframe by `window` on every socket - a
// shim flips it onto the (impossible-in-a-worker) iframe path and no peer
// sockets ever open.

import './node-shims'
import { Buffer } from 'buffer'
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer

import { get, set, del } from 'idb-keyval'
import type { TorrentFiles, TorrentStatus } from 'libtorrent-wasm'

let WebTorrent: any = null

import { OPFSSingleFileStore } from './opfs-single-file-store'
import type { TorrentSnapshot } from './worker'

const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'set-sequential', 'prioritize-file', 'prioritize-range', 'pause', 'resume'])

// wss for WebRTC peers + http trackers; the magnet's own tr= trackers (incl. udp,
// which @webvpn/dgram tunnels) are merged in by WebTorrent on top of these.
const TRACKERS = [
  'd3NzOi8vdHJhY2tlci53ZWJ0b3JyZW50LmRldg==',
  'd3NzOi8vdHJhY2tlci5maWxlcy5mbTo3MDczL2Fubm91bmNl',
  'd3NzOi8vdHJhY2tlci5vcGVud2VicnRjLmNvbTo0NDM=',
].map(atob)

const LIST_KEY = 'ripple:torrents'
// Raw .torrent bytes, shared with the libtorrent worker so metadata survives
// switching engines.
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
type Persisted = { infoHash: string, magnet: string, savePath: string, addedAt: number }

const infoHashOf = (magnet: string): string | null => {
  const m = magnet.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

let client: any = null

let handleSeq = 0
const handles: number[] = []
const torrentByHandle = new Map<number, any>()
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const metaSaved = new Set<number>()

const post = (msg: any, transfer?: Transferable[]) => (self as any).postMessage(msg, transfer ?? [])

// Surface worker-side failures to the main thread (the libtorrent worker does
// the same) so client.ts can log them.
const origErr = console.error.bind(console)
console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }
self.addEventListener('error', (e: any) => { try { post({ type: 'worker-error', args: ['error: ' + (e?.message ?? e)] }) } catch {} })
self.addEventListener('unhandledrejection', (e: any) => { try { post({ type: 'worker-error', args: ['reject: ' + String(e?.reason)] }) } catch {} })

const loadList = async (): Promise<Persisted[]> => (await get(LIST_KEY)) ?? []
const upsertList = async (entry: Persisted) => {
  const list = await loadList()
  const i = list.findIndex((e) => e.infoHash === entry.infoHash)
  if (i >= 0) list[i] = entry; else list.push(entry)
  await set(LIST_KEY, list)
}
const removeFromList = async (ih: string) => {
  await set(LIST_KEY, (await loadList()).filter((e) => e.infoHash !== ih))
  await del(torrentKey(ih)).catch(() => {})
}

const countBits = (buf: Uint8Array): number => {
  let n = 0
  for (let i = 0; i < buf.length; i++) { let b = buf[i]!; while (b) { n += b & 1; b >>= 1 } }
  return n
}

const snapshotOne = (h: number): TorrentSnapshot => {
  const t = torrentByHandle.get(h)
  const magnet = magnetByHandle.get(h) ?? ''
  if (!t || !t.ready || !t.files?.length) {
    const status: TorrentStatus = {
      state: 2, progress: t?.progress ?? 0, totalDone: t?.downloaded ?? 0, totalWanted: t?.length ?? 0,
      downloadRate: t?.downloadSpeed ?? 0, uploadRate: t?.uploadSpeed ?? 0, numPeers: t?.numPeers ?? 0,
      numSeeds: t?.numPeers ?? 0, numPiecesTotal: 0, numPiecesHave: 0, hasMetadata: false, paused: !!t?.paused,
    }
    return { handle: h, magnet, files: null, status, bitfield: null }
  }
  const files: TorrentFiles = {
    storageIndex: h,
    pieceLength: t.pieceLength,
    numPieces: t.pieces.length,
    totalSize: t.length,
    files: t.files.map((f: any) => ({ path: f.path, size: f.length, offset: f.offset })),
  }
  const bitBuf: Uint8Array | null = t.bitfield?.buffer ? new Uint8Array(t.bitfield.buffer) : null
  const status: TorrentStatus = {
    state: t.done ? 5 : 3,
    progress: t.progress,
    totalDone: t.downloaded,
    totalWanted: t.length,
    downloadRate: t.downloadSpeed,
    uploadRate: t.uploadSpeed,
    numPeers: t.numPeers,
    numSeeds: t.numPeers,
    numPiecesTotal: t.pieces.length,
    numPiecesHave: bitBuf ? countBits(bitBuf) : Math.round(t.progress * t.pieces.length),
    hasMetadata: true,
    paused: !!t.paused,
  }
  const bitfield = bitBuf
    ? { numPieces: t.pieces.length, pieceLength: t.pieceLength, length: t.length, pieces: bitBuf }
    : null
  return { handle: h, magnet, files, status, bitfield }
}

const snapshot = (): TorrentSnapshot[] => handles.map(snapshotOne)

const wireTorrent = (h: number, t: any) => {
  const cacheMeta = () => {
    const ih = infoHashByHandle.get(h) ?? t.infoHash?.toLowerCase()
    if (metaSaved.has(h) || !t.torrentFile || !ih) return
    metaSaved.add(h)
    set(torrentKey(ih), new Uint8Array(t.torrentFile)).catch(() => {})
  }
  t.on('metadata', cacheMeta)
  t.on('ready', cacheMeta)
  t.on('error', (err: any) => console.error('[wt]', String(err?.message ?? err)))
  t.on('warning', (w: any) => console.error('[wt] warning', String(w?.message ?? w).slice(0, 120)))
}

const addTorrent = (torrentId: string | Uint8Array, magnet: string, ih: string | null): number => {
  const h = ++handleSeq
  const opts = { announce: TRACKERS, store: OPFSSingleFileStore }
  const t = client.add(torrentId as any, opts as any)
  handles.push(h)
  torrentByHandle.set(h, t)
  magnetByHandle.set(h, magnet)
  if (ih) infoHashByHandle.set(h, ih)
  wireTorrent(h, t)
  return h
}

const untrack = (h: number) => {
  const i = handles.indexOf(h); if (i >= 0) handles.splice(i, 1)
  torrentByHandle.delete(h); magnetByHandle.delete(h); infoHashByHandle.delete(h); metaSaved.delete(h)
}

const readRange = async (h: number, fileIndex: number, offset: number, len: number): Promise<Uint8Array> => {
  const t = torrentByHandle.get(h)
  if (!t) throw new Error('torrent not ready')
  const file = t.files?.[fileIndex]
  if (!file) throw new Error('file not found')
  const end = Math.min(offset + len, file.length) - 1
  if (end < offset) return new Uint8Array(0)
  const chunks: Uint8Array[] = []
  for await (const chunk of file[Symbol.asyncIterator]({ start: offset, end })) {
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk))
  }
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  return out
}

const init = async () => {
  try {
    // @ts-ignore - the prebuilt fork bundle ships no types.
    WebTorrent = (await import('@banou/webtorrent/dist/webtorrent.min.js')).default
    // Disable the Node-only subsystems (their deps are stubbed in-browser):
    // DHT, local service discovery, NAT traversal, µTP.
    client = new WebTorrent({ utp: false, dht: false, lsd: false, natUpnp: false, natPmp: false, tracker: { announce: TRACKERS } })
  } catch (err) {
    console.error('[wt worker] failed to create WebTorrent client', String((err as any)?.stack ?? err))
    post({ type: 'error', message: String((err as any)?.stack ?? err) })
    return
  }
  try {
    for (const e of await loadList()) {
      // Resume offline if we cached the .torrent metadata; else re-fetch via magnet.
      const meta = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
      addTorrent(meta && meta.byteLength ? meta : e.magnet, e.magnet, e.infoHash)
    }
  } catch (err) { console.error('[wt worker] restore failed', String((err as any)?.stack ?? err)) }

  post({ type: 'ready' })
  setInterval(() => { try { post({ type: 'state', torrents: snapshot() }) } catch {} }, 500)
}

self.addEventListener('message', async (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !OWN.has(m.type)) return
  if (!client) { post({ type: 'error', message: 'webtorrent client not ready' }); return }
  try {
    if (m.type === 'add-magnet') {
      const ih = infoHashOf(m.magnet)
      const h = addTorrent(m.magnet, m.magnet, ih)
      if (ih) await upsertList({ infoHash: ih, magnet: m.magnet, savePath: m.savePath || '/dl', addedAt: Date.now() })
      post({ type: 'added', handle: h, magnet: m.magnet })
    } else if (m.type === 'add-torrent-file') {
      const bytes = m.bytes as Uint8Array
      const h = addTorrent(bytes, '', null)
      const t = torrentByHandle.get(h)
      // Synthesized magnet = the same identity string the libtorrent worker
      // produces for this torrent (list, /embed URL, player match).
      const finalize = async () => {
        const ih = t.infoHash?.toLowerCase()
        if (!ih || magnetByHandle.get(h)) return
        const magnet = 'magnet:?xt=urn:btih:' + ih
        infoHashByHandle.set(h, ih)
        magnetByHandle.set(h, magnet)
        await set(torrentKey(ih), bytes)
        await upsertList({ infoHash: ih, magnet, savePath: m.savePath || '/dl', addedAt: Date.now() })
      }
      if (t.infoHash) await finalize()
      else t.once('metadata', finalize)
      post({ type: 'added', handle: h, magnet: magnetByHandle.get(h) ?? '' })
    } else if (m.type === 'read') {
      const data = await readRange(m.handle, m.fileIndex, m.offset, m.len)
      post({ type: 'read-result', id: m.id, data }, [data.buffer])
    } else if (m.type === 'remove') {
      const t = torrentByHandle.get(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (t) await new Promise<void>((res) => client.remove(t.infoHash, { destroyStore: !!m.deleteFiles }, () => res()))
      untrack(m.handle)
      if (ih) await removeFromList(ih)
    } else if (m.type === 'pause') {
      torrentByHandle.get(m.handle)?.pause()
    } else if (m.type === 'resume') {
      torrentByHandle.get(m.handle)?.resume()
    } else if (m.type === 'prioritize-file') {
      // The whole torrent is selected at priority 0 (sequential strategy);
      // lifting the watched file to 1 makes its pieces fill first, in order.
      torrentByHandle.get(m.handle)?.files?.[m.fileIndex]?.select(1)
    }
    // set-sequential / prioritize-range: WebTorrent's strategy is already
    // sequential and createReadStream prioritizes the covering pieces, so
    // these are no-ops here.
  } catch (err: any) {
    if (m.type === 'read') post({ type: 'read-error', id: m.id, error: String(err?.stack ?? err) })
    else post({ type: 'error', message: String(err?.stack ?? err) })
  }
})

init().catch((e: any) => post({ type: 'error', message: String(e?.stack ?? e) }))
