// libtorrent-wasm Session running in a Web Worker, with @webvpn/{net,dgram} as
// the transport (relayed to the main-thread @fkn/lib iframe via relayWorker).
// Owns persistence: the torrent list + per-torrent fast-resume blobs live in
// IndexedDB so the list survives reloads and libtorrent resumes from OPFS
// instead of re-downloading.

import './node-shims'

import * as net from '@webvpn/net'
import * as dgram from '@webvpn/dgram'
import { get, set, del } from 'idb-keyval'
import { createSession } from 'libtorrent-wasm'
import type { Session, TorrentFiles, TorrentStatus } from 'libtorrent-wasm'
import { OPFSStorage } from 'libtorrent-wasm/opfs'

const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'set-sequential', 'prioritize-file', 'prioritize-range', 'pause', 'resume', 'import-list', 'clear-list'])

export type TorrentSnapshot = {
  handle: number
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
}

const LIST_KEY = 'ripple:torrents'
const resumeKey = (ih: string) => 'ripple:resume:' + ih
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
export type Persisted = { infoHash: string, magnet: string, savePath: string, addedAt: number }

const infoHashOf = (magnet: string): string | null => {
  const m = magnet.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

let session: Session | null = null
const handles: number[] = []
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const savePathByHandle = new Map<number, string>()
const resumeSaved = new Set<number>()

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

// ---- persistence ----------------------------------------------------------
const loadList = async (): Promise<Persisted[]> => (await get(LIST_KEY)) ?? []
const upsertList = async (entry: Persisted) => {
  const list = await loadList()
  const i = list.findIndex((e) => e.infoHash === entry.infoHash)
  if (i >= 0) list[i] = entry; else list.push(entry)
  await set(LIST_KEY, list)
  post({ type: 'list', list })
}
const removeFromList = async (ih: string) => {
  const list = (await loadList()).filter((e) => e.infoHash !== ih)
  await set(LIST_KEY, list)
  await del(resumeKey(ih)).catch(() => {})
  await del(torrentKey(ih)).catch(() => {})
  post({ type: 'list', list })
}

const track = (h: number, magnet: string, ih: string | null, savePath: string) => {
  if (!handles.includes(h)) handles.push(h)
  magnetByHandle.set(h, magnet)
  if (ih) infoHashByHandle.set(h, ih)
  savePathByHandle.set(h, savePath)
}
const untrack = (h: number) => {
  const i = handles.indexOf(h); if (i >= 0) handles.splice(i, 1)
  magnetByHandle.delete(h); infoHashByHandle.delete(h); savePathByHandle.delete(h); resumeSaved.delete(h)
  for (const k of lastReadOffset.keys()) if (k.startsWith(h + ':')) lastReadOffset.delete(k)
}

const persistResume = async (h: number) => {
  const ih = infoHashByHandle.get(h)
  if (!ih || !session) return
  try { await set(resumeKey(ih), await session.saveResumeData(h)) } catch {}
}

const filePieceRange = (h: number, fileIndex: number) => {
  const files = session?.files(h)
  const file = files?.files[fileIndex]
  if (!files || !file || file.size <= 0) return null
  const p0 = Math.floor(file.offset / files.pieceLength)
  const p1 = Math.floor((file.offset + file.size - 1) / files.pieceLength)
  return { file, pieceLength: files.pieceLength, p0, p1 }
}

const prioritizeFile = (h: number, fileIndex: number, fromOffset = 0) => {
  const r = filePieceRange(h, fileIndex)
  if (!session || !r) return
  const pAt = Math.floor((r.file.offset + Math.min(fromOffset, r.file.size - 1)) / r.pieceLength)
  const prios = new Uint8Array(r.p1 + 1).fill(4)
  for (let p = r.p0; p <= r.p1; p++) prios[p] = p >= pAt ? 7 : 1
  session.prioritizePieces(h, prios)
}

const hasBytes = (h: number, fileIndex: number, offset: number, len: number) => {
  const files = session?.files(h)
  const file = files?.files[fileIndex]
  const bf = session?.bitfield(h)
  if (!files || !file || !bf) return false
  const p0 = Math.floor((file.offset + offset) / files.pieceLength)
  const p1 = Math.floor((file.offset + Math.min(offset + len, file.size) - 1) / files.pieceLength)
  for (let p = p0; p <= p1; p++) if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) return false
  return true
}

// A read far from the previous one is a seek: re-anchor piece priorities so
// sequential filling continues from the playhead instead of the file start.
const ANCHOR_JUMP = 16_777_216
const lastReadOffset = new Map<string, number>()
const anchorSequential = (h: number, fileIndex: number, offset: number) => {
  const key = h + ':' + fileIndex
  const last = lastReadOffset.get(key)
  lastReadOffset.set(key, offset)
  if (last !== undefined && Math.abs(offset - last) < ANCHOR_JUMP) return
  prioritizeFile(h, fileIndex, offset)
}

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  session = await createSession({ net, dgram, storage: new OPFSStorage() })
  for (let i = 0; i < 30; i++) session.tick()

  // Restore the persisted list. With a saved fast-resume blob, add via resume so
  // libtorrent trusts the on-disk pieces (no recheck / no network re-download).
  try {
    for (const e of await loadList()) {
      const savePath = e.savePath || '/dl'
      const resume = (await get(resumeKey(e.infoHash))) as Uint8Array | undefined
      const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
      const h = resume && resume.byteLength
        ? session.addTorrentWithResume(resume, savePath)
        : bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
      track(h, e.magnet, e.infoHash, savePath)
    }
  } catch (err) { console.error('[worker] restore failed', err) }

  post({ type: 'list', list: await loadList() })
  post({ type: 'ready' })

  setInterval(() => {
    if (!session) return
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
    post({ type: 'state', torrents: snapshot() })
    // Snapshot resume data the first time a torrent completes, so a reload right
    // after finishing still resumes from OPFS rather than re-downloading.
    for (const h of handles) {
      const st = session.status(h)
      if (st && (st.state === 4 || st.state === 5) && !resumeSaved.has(h)) {
        resumeSaved.add(h); persistResume(h)
      }
    }
  }, 500)

  // Periodic resume snapshot for in-progress torrents.
  setInterval(() => {
    if (!session) return
    for (const h of handles) {
      const st = session.status(h)
      if (st && st.state === 3) persistResume(h)
    }
  }, 15000)
}

self.addEventListener('message', async (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !OWN.has(m.type)) return
  if (!session) { post({ type: 'error', message: 'worker not initialized' }); return }
  try {
    if (m.type === 'add-magnet') {
      const savePath = m.savePath || '/dl'
      const h = session.addMagnet(m.magnet, savePath)
      const ih = infoHashOf(m.magnet)
      track(h, m.magnet, ih, savePath)
      if (ih) await upsertList({ infoHash: ih, magnet: m.magnet, savePath, addedAt: Date.now() })
      post({ type: 'added', handle: h, magnet: m.magnet })
    } else if (m.type === 'add-torrent-file') {
      const savePath = m.savePath || '/dl'
      const bytes = m.bytes as Uint8Array
      const h = session.addTorrentFile(bytes, savePath)
      track(h, '', null, savePath)
      // infohash lands with the add alert (popped by the 500ms loop) - poll for it.
      let ih: string | null = null
      for (let i = 0; i < 40 && !(ih = session.infohash(h)); i++) await new Promise((r) => setTimeout(r, 250))
      // The synthesized magnet is the torrent's identity everywhere (list, /embed
      // URL, player match); the raw .torrent bytes stay the restore source.
      const magnet = ih ? 'magnet:?xt=urn:btih:' + ih : ''
      track(h, magnet, ih, savePath)
      if (ih) {
        await set(torrentKey(ih), bytes)
        await upsertList({ infoHash: ih, magnet, savePath, addedAt: Date.now() })
      }
      post({ type: 'added', handle: h, magnet })
    } else if (m.type === 'read') {
      if (m.prioritize !== false) anchorSequential(m.handle, m.fileIndex, m.offset)
      // Quiet readers must never block on (or wait for) missing pieces; fail
      // fast so a background queue can retry once the data lands.
      else if (!hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'not downloaded' })
        return
      }
      const data = await session.read(m.handle, m.fileIndex, m.offset, m.len)
      post({ type: 'read-result', id: m.id, data }, [data.buffer])
    } else if (m.type === 'remove') {
      const ih = infoHashByHandle.get(m.handle)
      session.removeTorrent(m.handle, !!m.deleteFiles)
      untrack(m.handle)
      if (ih) await removeFromList(ih)
    } else if (m.type === 'import-list') {
      // Merge a cloud-restored list into the local one: add torrents we don't
      // already have (union by infoHash, never dropping local entries).
      const incoming: Persisted[] = Array.isArray(m.list) ? m.list : []
      const have = new Set((await loadList()).map((e) => e.infoHash))
      for (const e of incoming) {
        if (!e || typeof e.infoHash !== 'string' || !e.magnet || have.has(e.infoHash)) continue
        const savePath = e.savePath || '/dl'
        const h = session.addMagnet(e.magnet, savePath)
        track(h, e.magnet, e.infoHash, savePath)
        await upsertList({ infoHash: e.infoHash, magnet: e.magnet, savePath, addedAt: e.addedAt || Date.now() })
        have.add(e.infoHash)
      }
    } else if (m.type === 'clear-list') {
      // Drop the device-local list (used on account switch so one account's
      // library is never carried into another's). Keeps the OPFS bytes on disk.
      for (const h of [...handles]) { session.removeTorrent(h, false); untrack(h) }
      await set(LIST_KEY, [])
      post({ type: 'list', list: [] })
    } else if (m.type === 'pause') {
      session.pauseTorrent(m.handle)
      persistResume(m.handle)
    } else if (m.type === 'resume') {
      session.resumeTorrent(m.handle)
    } else if (m.type === 'set-sequential') {
      session.setSequential(m.handle, m.on)
    } else if (m.type === 'prioritize-file') {
      // The offset is the player's linear time->byte estimate; the next read's
      // anchorSequential re-corrects it with the remuxer's true byte position.
      prioritizeFile(m.handle, m.fileIndex, m.fromOffset ?? 0)
    } else if (m.type === 'prioritize-range') {
      session.prioritizeRange(m.handle, m.fileIndex, m.offset, m.len)
    }
  } catch (err: any) {
    if (m.type === 'read') post({ type: 'read-error', id: m.id, error: String(err?.stack ?? err) })
    else post({ type: 'error', message: String(err?.stack ?? err) })
  }
})

init().catch((e: any) => post({ type: 'error', message: String(e?.stack ?? e) }))
