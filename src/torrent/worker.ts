// libtorrent-wasm Session running in a Web Worker, with @webvpn/{net,dgram} as
// the transport (relayed to the main-thread @fkn/lib iframe via relayWorker).
// Owns persistence: the torrent list + per-torrent fast-resume blobs live in
// IndexedDB so the list survives reloads and libtorrent resumes from OPFS
// instead of re-downloading.

import './node-shims'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { get, set, del } from 'idb-keyval'
import { createSession } from 'libtorrent-wasm'
import type { Session, TorrentFiles, TorrentStatus } from 'libtorrent-wasm'
import { OPFSStorage } from 'libtorrent-wasm/opfs'

const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'remove-missing', 'set-sequential', 'prioritize-file', 'prioritize-range', 'pause', 'resume', 'import-list', 'clear-list', 'start'])

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
// started === false marks a torrent synced from another device that this device
// hasn't downloaded yet: it lives in the list but is NOT added to the session (no
// swarm, no download) until the user starts it. Absent/true = active here.
export type Persisted = { infoHash: string, magnet: string, savePath: string, addedAt: number, started?: boolean }

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

// Does OPFS still hold any downloaded data under these save paths? Lets a restore
// tell a normal resume from "the list survived but the files were cleared/evicted"
// (e.g. the user cleared site storage). On any OPFS error assume data is present, so
// a transient read failure never wrongly demotes torrents to "Files missing".
const opfsHasData = async (savePaths: string[]): Promise<boolean> => {
  try {
    const root = await navigator.storage.getDirectory()
    for (const sp of new Set(savePaths)) {
      let dir: FileSystemDirectoryHandle | null = root
      for (const seg of sp.split('/').filter(Boolean)) {
        dir = dir ? await dir.getDirectoryHandle(seg).catch(() => null) : null
      }
      if (!dir) continue
      for await (const _ of (dir as any).keys()) return true
    }
    return false
  } catch { return true }
}

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  session = await createSession({ net, dgram, storage: new OPFSStorage() })
  for (let i = 0; i < 30; i++) session.tick()

  // Restore the persisted list. With a saved fast-resume blob, add via resume so
  // libtorrent trusts the on-disk pieces (no recheck / no network re-download).
  try {
    const list = await loadList()
    // If the list survived but OPFS holds no data, the files were cleared/evicted -
    // demote torrents that had real data (a resume blob) to "Files missing" rather
    // than silently re-downloading everything from scratch.
    const cleared = !(await opfsHasData(list.map((e) => e.savePath || '/dl')))
    let changed = false
    for (const e of list) {
      // Synced-but-not-started torrents stay out of the session (rendered as
      // "Files missing" ghosts) until the user downloads them.
      if (e.started === false) continue
      const savePath = e.savePath || '/dl'
      const resume = (await get(resumeKey(e.infoHash))) as Uint8Array | undefined
      const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
      if (cleared && resume && resume.byteLength) {
        // The resume blob describes OPFS pieces that are gone; drop it so a reload
        // mid-redownload can't trust a stale have-set against files that aren't there.
        await del(resumeKey(e.infoHash)).catch(() => {})
        e.started = false; changed = true; continue
      }
      const h = resume && resume.byteLength
        ? session.addTorrentWithResume(resume, savePath)
        : bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
      track(h, e.magnet, e.infoHash, savePath)
    }
    if (changed) await set(LIST_KEY, list)
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
      // Merge a cloud-restored list into the local one (union by infoHash, never
      // dropping local entries). Synced torrents are recorded as started:false -
      // NOT added to the session - so a device that didn't download them shows
      // "Files missing" instead of instantly re-downloading from the swarm.
      const incoming: Persisted[] = Array.isArray(m.list) ? m.list : []
      const have = new Set((await loadList()).map((e) => e.infoHash))
      for (const e of incoming) {
        if (!e || typeof e.infoHash !== 'string' || !e.magnet || have.has(e.infoHash)) continue
        const savePath = e.savePath || '/dl'
        await upsertList({ infoHash: e.infoHash, magnet: e.magnet, savePath, addedAt: e.addedAt || Date.now(), started: false })
        have.add(e.infoHash)
      }
    } else if (m.type === 'start') {
      // The user asked to download a synced "Files missing" torrent: add it to the
      // session now and mark it started so it survives reloads as an active torrent.
      const e = (await loadList()).find((x) => x.infoHash === m.infoHash)
      if (e) {
        const savePath = e.savePath || '/dl'
        // Prefer the stored .torrent bytes (kept in IndexedDB even when OPFS was
        // cleared) for instant metadata; a cloud-synced ghost has only the magnet.
        const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
        const h = bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
        track(h, e.magnet, e.infoHash, savePath)
        // Surface the live torrent BEFORE flipping the list entry: the live row
        // carries the same infoHash, so it dedups the ghost in the same render and
        // the row swaps in place instead of blinking out until the next tick.
        post({ type: 'state', torrents: snapshot() })
        await upsertList({ ...e, started: true })
      }
    } else if (m.type === 'remove-missing') {
      // Usually a pure ghost with no session handle, so just drop the list entry.
      // But if it was started moments earlier (Download then Remove in the same
      // beat), tear the live torrent down too, else it keeps downloading with no
      // persisted entry and is lost on the next reload.
      if (typeof m.infoHash === 'string') {
        const h = handles.find((x) => infoHashByHandle.get(x) === m.infoHash)
        if (h !== undefined) { session.removeTorrent(h, true); untrack(h) }
        await removeFromList(m.infoHash)
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
