// libtorrent-wasm Session in a Web Worker over @fkn/lib/{net,dgram}; owns persistence (list + fast-resume in IndexedDB, data in OPFS)

import './node-shims'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { get, set, del, update } from 'idb-keyval'
import { createSession } from 'libtorrent-wasm'
import type { Session, TorrentFiles, TorrentStatus } from 'libtorrent-wasm'

import type { ObservedStatus, RecoveryState } from './recovery'

import { magnetInfoHash } from './magnet'
import { createResilientStorage } from './opfs-storage'
import { createRecoveryTracker } from './recovery'

const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'remove-missing', 'set-sequential', 'prioritize-file', 'prioritize-range', 'pause', 'resume', 'import-list', 'clear-list', 'start', 'retry', 'retry-now', 'flush-resume'])

export type TorrentSnapshot = {
  handle: number
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
  // Set while the torrent is stopped or stalled and waiting on the next retry.
  recovery: RecoveryState | null
  // True while the user is the reason it is paused, so the UI never offers to
  // "recover" a torrent that is paused exactly as asked.
  userPaused: boolean
}

const LIST_KEY = 'ripple:torrents'
const resumeKey = (ih: string) => 'ripple:resume:' + ih
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
// started === false marks a torrent synced from another device that this device
// hasn't downloaded yet: it lives in the list but is NOT added to the session (no
// swarm, no download) until the user starts it. Absent/true = active here.
// paused === true is a pause the user asked for, kept across reloads so auto-recovery
// never restarts a torrent that is stopped on purpose. Both are device-local and are
// deliberately left out of the cloud backup.
export type Persisted = { infoHash: string, magnet: string, savePath: string, addedAt: number, started?: boolean, paused?: boolean }

let session: Session | null = null
// Whether the page has been told the engine is usable. Decides whether a late failure is
// terminal or just one command going wrong.
let readyPosted = false
const handles: number[] = []
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const savePathByHandle = new Map<number, string>()
const resumeSaved = new Set<number>()
// Handles the user paused. Everything else that is stopped is a failure to recover from.
const userPaused = new Set<number>()
// Pauses a restore wants but the engine has not accepted yet, reconciled from the tick
// loop. libtorrent only takes commands for handles it has registered, which happens the
// first time its alerts are pumped, so a pause issued during the restore is silently
// discarded. Only pauses are tracked: everything else is auto-managed, and libtorrent
// starts it itself, in its own order, which is exactly what should happen.
const wantPaused = new Set<number>()
// Backoff for completion resume snapshots that failed to reach IndexedDB.
const resumeRetry = new Map<number, { tries: number, at: number }>()
const recovery = createRecoveryTracker()

// The engine's -1 (empty input) and -2 (unparseable magnet or torrent file) come back
// widened to the top of the unsigned range; real handles count up from 1. Tracking one
// leaves a row that can never resolve, persisted and restored on every reload.
const addFailed = (handle: number) => handle >= 0xFFFFFF00

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
      recovery: recovery.state(h),
      userPaused: userPaused.has(h),
    }
  })

// ---- persistence ----------------------------------------------------------
// update() keeps each read-modify-write in one IDB transaction, so interleaved async handlers can't drop entries
const loadList = async (): Promise<Persisted[]> => (await get(LIST_KEY)) ?? []
const upsertList = async (entry: Persisted) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => {
    list = prev ?? []
    const i = list.findIndex((e) => e.infoHash === entry.infoHash)
    if (i >= 0) list[i] = entry; else list.push(entry)
    return list
  })
  post({ type: 'list', list })
}
const patchList = async (ih: string, patch: Partial<Persisted>) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => {
    list = prev ?? []
    const i = list.findIndex((e) => e.infoHash === ih)
    if (i >= 0) list[i] = { ...list[i]!, ...patch }
    return list
  })
  post({ type: 'list', list })
}
const removeFromList = async (ih: string) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => (list = (prev ?? []).filter((e) => e.infoHash !== ih)))
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
  userPaused.delete(h); recovery.forget(h); resumeInFlight.delete(h); readsByHandle.delete(h)
  wantPaused.delete(h); resumeRetry.delete(h)
  for (const k of lastReadOffset.keys()) if (k.startsWith(h + ':')) lastReadOffset.delete(k)
}

// Reads park until the pieces they cover arrive, so a torrent that goes away or stops
// leaves its readers waiting on data that is never coming. Fail them explicitly: every
// caller (the player, the save-to-disk export, the folder sync) handles a rejection and
// none of them handles a promise that simply never settles.
const readsByHandle = new Map<number, Set<number>>()
const failReads = (h: number, error: string) => {
  const ids = readsByHandle.get(h)
  if (!ids?.size) return
  for (const id of ids) post({ type: 'read-error', id, error })
  ids.clear()
}

// saveResumeData waits on libtorrent to post the blob and gives up after 8s, which is
// longer than the loops that call this, so a second snapshot for the same torrent must
// not stack on the first. Reports whether the blob actually reached IndexedDB: a caller
// that records success from the call alone gets exactly one attempt per session.
const resumeInFlight = new Set<number>()
const persistResume = async (h: number): Promise<boolean> => {
  const ih = infoHashByHandle.get(h)
  if (!ih || !session || resumeInFlight.has(h)) return false
  resumeInFlight.add(h)
  try {
    await set(resumeKey(ih), await session.saveResumeData(h))
    return true
  } catch (err) {
    console.error('[worker] saving resume data failed', String(err))
    return false
  } finally { resumeInFlight.delete(h) }
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

// Does OPFS still hold the save paths these torrents were downloading into? Lets a
// restore tell a normal resume from "the list survived but the files were cleared/evicted"
// (e.g. the user cleared site storage). The directory existing is the signal, not what is
// inside it: OPFS creates the save path as soon as a torrent is added but its files only
// on the first write, so a torrent that has metadata and no bytes yet sits in an empty
// directory and must not read as wiped. On any OPFS error assume data is present, so a
// transient read failure never wrongly demotes torrents to "Files missing".
const opfsHasData = async (savePaths: string[]): Promise<boolean> => {
  try {
    const root = await navigator.storage.getDirectory()
    for (const sp of new Set(savePaths)) {
      let dir: FileSystemDirectoryHandle | null = root
      for (const seg of sp.split('/').filter(Boolean)) {
        dir = dir ? await dir.getDirectoryHandle(seg).catch(() => null) : null
      }
      if (dir) return true
    }
    return false
  } catch { return true }
}

// OPFS with a SyncAccessHandle is the only storage backend. Some contexts refuse
// it (Firefox private windows throw SecurityError from getDirectory(); others
// reject createSyncAccessHandle), which otherwise surfaces as a silent WASI EIO
// that pauses every torrent. Probe up front so the UI can say Ripple needs a
// normal (non-incognito) window instead of failing silently.
const opfsAvailable = async (): Promise<boolean> => {
  let root: FileSystemDirectoryHandle | undefined
  let probe: string | undefined
  try {
    root = await navigator.storage.getDirectory()
    probe = `.ripple-probe-${crypto.randomUUID()}`
    const file = await root.getFileHandle(probe, { create: true })
    const access = await (file as any).createSyncAccessHandle() as FileSystemSyncAccessHandle
    access.close()
    await root.removeEntry(probe).catch(() => {})
    return true
  } catch {
    if (root && probe) await root.removeEntry(probe).catch(() => {})
    return false
  }
}

// Why a stopped torrent is stopped, read off the status the engine reports for it.
// libtorrent keeps auto_managed set through an error (it drops an errored torrent from
// the rotation without clearing the flag), and Ripple's own pause clears it, so the pair
// separates all three cases: an error is a failure, auto-managed without one is the queue
// holding the torrent behind others, and neither is someone having pressed pause.
const observed = (st: TorrentStatus): ObservedStatus => ({
  paused: st.paused,
  state: st.state,
  totalDone: st.totalDone,
  downloadRate: st.downloadRate,
  numPeers: st.numPeers,
  queued: st.paused && st.autoManaged && !st.errorCode,
  error: st.error,
})

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  if (!(await opfsAvailable())) {
    post({ type: 'storage-unavailable' })
    return
  }

  // Asking for persistent storage happens on the main thread, in use-storage-usage.ts: a
  // worker's StorageManager has estimate, getDirectory and persisted, but no persist, so
  // the request cannot be made from here at all.

  const storage = createResilientStorage()
  session = await createSession({ net, dgram, storage, utpReceiveBufferBytes: 4_194_304 })
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
      if (addFailed(h)) continue
      track(h, e.magnet, e.infoHash, savePath)
      // A torrent the user paused comes back paused, and stays out of auto-recovery. The
      // pause is recorded rather than applied: the engine only accepts commands for a
      // handle it has registered, which happens when the first alert is pumped, and the
      // loop that does that has not started yet.
      if (e.paused) { userPaused.add(h); wantPaused.add(h) }
      recovery.hold(h, Date.now())
    }
    if (changed) await set(LIST_KEY, list)
  } catch (err) { console.error('[worker] restore failed', err) }

  // Ready first, and never behind an IndexedDB read: the session is live and usable at
  // this point, and a blocked or corrupted list read would otherwise leave every command
  // queued behind a promise that never settles.
  post({ type: 'ready' })
  readyPosted = true
  post({ type: 'list', list: await loadList().catch(() => []) })

  setInterval(() => {
    if (!session) return
    const now = Date.now()
    // Pumping the alerts is also what registers handles with the engine, so a command
    // recorded before the first pump is applied here rather than at the point it was
    // asked for, where it would have been silently dropped. The stream itself is drained
    // and dropped: every failure worth acting on arrives attributed on the status instead.
    session.popAlerts()
    for (const h of handles) session.postStatus(h)
    for (const h of wantPaused) {
      const st = session.status(h)
      if (!st) continue
      if (st.paused) wantPaused.delete(h)
      else session.pauseTorrent(h)
    }

    // Judge every torrent's health, then act on whatever is due. A stopped torrent
    // just needs resuming; a stalled one needs a stop first, since that is what makes
    // libtorrent announce to its trackers again instead of waiting out the interval.
    recovery.retain(new Set(handles))
    for (const h of handles) {
      const st = session.status(h)
      recovery.observe(h, st && observed(st), userPaused.has(h), now)
    }
    for (const { handle, reason } of recovery.due(now)) {
      if (reason === 'stalled') session.pauseTorrent(handle)
      session.resumeTorrent(handle)
    }

    post({ type: 'state', torrents: snapshot() })
    // Snapshot resume data once a torrent completes, so a reload right after finishing
    // still resumes from OPFS rather than re-downloading. Only a snapshot that actually
    // landed counts as done, and a failed one backs off: on a full origin (which is
    // exactly the state a just-finished torrent leaves) it would otherwise re-serialise
    // the whole info dict twice a second for the life of the page.
    for (const h of handles) {
      const st = session.status(h)
      if (!st || (st.state !== 4 && st.state !== 5) || resumeSaved.has(h) || resumeInFlight.has(h)) continue
      const retry = resumeRetry.get(h)
      if (retry && now < retry.at) continue
      void persistResume(h).then((saved) => {
        if (saved) { resumeSaved.add(h); resumeRetry.delete(h); return }
        const tries = (resumeRetry.get(h)?.tries ?? 0) + 1
        resumeRetry.set(h, { tries, at: Date.now() + Math.min(1_000 * 2 ** tries, 60_000) })
      })
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

  // Connectivity is back: retry everything that is waiting out a backoff right now
  // rather than sitting through the rest of it. The main thread forwards its own
  // online event too, since a worker does not always get one.
  self.addEventListener('online', () => recovery.retryNow(Date.now()))
}

// Takes the live session explicitly: the listener has already checked it exists, and the
// handlers await, so re-reading the module binding would need a null check per statement.
const handleMessage = async (session: Session, m: any) => {
  try {
    if (m.type === 'add-magnet') {
      const savePath = m.savePath || '/dl'
      const ih = magnetInfoHash(m.magnet)
      // /embed re-adds a magnet the init restore already holds; reuse the live handle instead of a duplicate add
      const existing = ih ? handles.find((h) => infoHashByHandle.get(h) === ih) : undefined
      if (existing !== undefined) {
        post({ type: 'added', handle: existing, magnet: magnetByHandle.get(existing) || m.magnet })
      } else {
        const h = session.addMagnet(m.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That is not a valid magnet link' }); return }
        track(h, m.magnet, ih, savePath)
        // Every torrent is added stopped and started by libtorrent's own queue, so give
        // it a moment before the health check has an opinion about it.
        recovery.hold(h, Date.now())
        if (ih) await upsertList({ infoHash: ih, magnet: m.magnet, savePath, addedAt: Date.now() })
        post({ type: 'added', handle: h, magnet: m.magnet })
      }
    } else if (m.type === 'add-torrent-file') {
      const savePath = m.savePath || '/dl'
      const bytes = m.bytes as Uint8Array
      const h = session.addTorrentFile(bytes, savePath)
      if (addFailed(h)) { post({ type: 'add-failed', message: 'That file is not a valid .torrent' }); return }
      track(h, '', null, savePath)
      recovery.hold(h, Date.now())
      // infohash lands with the add alert (popped by the 500ms loop) - poll for it.
      let ih: string | null = null
      for (let i = 0; i < 40 && !(ih = session.infohash(h)); i++) await new Promise((r) => setTimeout(r, 250))
      // A remove or an account switch during that poll already tore this handle down;
      // re-tracking it now would resurrect a torrent with no persisted entry behind it.
      if (!handles.includes(h)) return
      if (!ih) {
        session.removeTorrent(h, true)
        untrack(h)
        post({ type: 'add-failed', message: 'Could not read that torrent' })
        return
      }
      // The synthesized magnet is the torrent's identity everywhere (list, /embed
      // URL, player match); the raw .torrent bytes stay the restore source.
      const magnet = 'magnet:?xt=urn:btih:' + ih
      track(h, magnet, ih, savePath)
      await set(torrentKey(ih), bytes)
      await upsertList({ infoHash: ih, magnet, savePath, addedAt: Date.now() })
      post({ type: 'added', handle: h, magnet })
    } else if (m.type === 'read') {
      // A torrent the user paused is downloading nothing and nothing here will change
      // that, so a read of bytes it does not have would park until the caller's own
      // timeout. Answer immediately instead. Only a deliberate pause qualifies: libtorrent
      // reports a torrent it parked behind others, and one that is checking its files, as
      // paused too, and both of those do come back on their own.
      if (userPaused.has(m.handle) && !hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'torrent paused' })
        return
      }
      if (m.prioritize !== false) anchorSequential(m.handle, m.fileIndex, m.offset)
      // Quiet readers must never block on (or wait for) missing pieces; fail
      // fast so a background queue can retry once the data lands.
      else if (!hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'not downloaded' })
        return
      }
      let inFlight = readsByHandle.get(m.handle)
      if (!inFlight) readsByHandle.set(m.handle, inFlight = new Set())
      inFlight.add(m.id)
      try {
        const data = await session.read(m.handle, m.fileIndex, m.offset, m.len)
        // failReads may have answered this id already while it was parked on pieces.
        if (!inFlight.has(m.id)) return
        post({ type: 'read-result', id: m.id, data }, [data.buffer])
      } finally { inFlight.delete(m.id) }
    } else if (m.type === 'remove') {
      const ih = infoHashByHandle.get(m.handle)
      failReads(m.handle, 'torrent removed')
      session.removeTorrent(m.handle, !!m.deleteFiles)
      untrack(m.handle)
      if (ih) await removeFromList(ih)
    } else if (m.type === 'import-list') {
      // Union by infoHash; cloud-synced entries land as started:false ghosts, never auto-downloaded
      const incoming: Persisted[] = Array.isArray(m.list) ? m.list : []
      let list: Persisted[] = []
      let changed = false
      await update<Persisted[]>(LIST_KEY, (prev) => {
        list = prev ?? []
        const have = new Set(list.map((e) => e.infoHash))
        for (const e of incoming) {
          if (!e || typeof e.infoHash !== 'string' || !e.magnet || have.has(e.infoHash)) continue
          list.push({ infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath || '/dl', addedAt: e.addedAt || Date.now(), started: false })
          have.add(e.infoHash)
          changed = true
        }
        return list
      })
      if (changed) post({ type: 'list', list })
    } else if (m.type === 'start') {
      // The user asked to download a synced "Files missing" torrent: add it to the
      // session now and mark it started so it survives reloads as an active torrent.
      const e = (await loadList()).find((x) => x.infoHash === m.infoHash)
      if (e) {
        const savePath = e.savePath || '/dl'
        // Stored .torrent bytes give instant metadata; a cloud-synced ghost has only the magnet
        const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
        const h = bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That torrent could not be read' }); return }
        track(h, e.magnet, e.infoHash, savePath)
        recovery.hold(h, Date.now())
        // Post state before flipping the entry so the live row dedups the ghost in the same render
        post({ type: 'state', torrents: snapshot() })
        await upsertList({ ...e, started: true, paused: false })
      }
    } else if (m.type === 'remove-missing') {
      // A ghost started moments earlier still has a live handle; tear it down too or it keeps downloading with no persisted entry
      if (typeof m.infoHash === 'string') {
        const h = handles.find((x) => infoHashByHandle.get(x) === m.infoHash)
        if (h !== undefined) { failReads(h, 'torrent removed'); session.removeTorrent(h, true); untrack(h) }
        await removeFromList(m.infoHash)
      }
    } else if (m.type === 'clear-list') {
      // Account switch: drop the device-local list and its resume/torrent blobs; OPFS bytes stay on disk
      for (const h of [...handles]) { failReads(h, 'torrent removed'); session.removeTorrent(h, false); untrack(h) }
      let dropped: Persisted[] = []
      await update<Persisted[]>(LIST_KEY, (prev) => { dropped = prev ?? []; return [] })
      for (const e of dropped) {
        await del(resumeKey(e.infoHash)).catch(() => {})
        await del(torrentKey(e.infoHash)).catch(() => {})
      }
      post({ type: 'list', list: [] })
    } else if (m.type === 'pause') {
      // Remember the pause was asked for, here and across reloads, so auto-recovery
      // leaves it alone instead of reading it as a torrent that fell over.
      userPaused.add(m.handle)
      recovery.forget(m.handle)
      session.pauseTorrent(m.handle)
      // Anything still parked on pieces is waiting on a download that just stopped.
      failReads(m.handle, 'torrent paused')
      void persistResume(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: true })
    } else if (m.type === 'resume') {
      userPaused.delete(m.handle)
      recovery.forget(m.handle)
      session.resumeTorrent(m.handle)
      // The next status update still reports it paused, so keep the health check off it
      // until the engine has caught up rather than flashing "Retrying" over a fresh start.
      recovery.hold(m.handle, Date.now())
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: false })
    } else if (m.type === 'recheck') {
      // The engine forgets every piece before it starts hashing, so the saved blob now
      // describes a have-set that no longer exists. Dropping it is what stops a reload
      // mid-check from restoring that blob and trusting it again, which is the exact
      // failure a recheck is asked for. Clearing resumeSaved lets the finished torrent
      // snapshot itself again afterwards rather than leaving the key deleted for good.
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await del(resumeKey(ih)).catch(() => {})
      resumeSaved.delete(m.handle)
      // Every have-bit is about to be cleared, so a read parked on one would sit there
      // until the client's own timeout rather than the check finishing.
      failReads(m.handle, 'torrent rechecking')
      // A check is only ever scheduled for a torrent that is neither paused nor errored,
      // so a rechecked torrent starts again whether or not it was paused. wantPaused has
      // to go with it: a restore-time pause that has not drained yet would be re-applied
      // by the next tick, and pausing a torrent takes it out of the only rotation that
      // starts checks, leaving the row on "Checking" with nothing running.
      userPaused.delete(m.handle)
      wantPaused.delete(m.handle)
      recovery.forget(m.handle)
      session.forceRecheck(m.handle)
      recovery.hold(m.handle, Date.now())
      if (ih) await patchList(ih, { paused: false })
    } else if (m.type === 'retry-now') {
      // The page saw connectivity return. Collapse every pending backoff so the
      // library picks straight back up instead of waiting out the schedule.
      recovery.retryNow(Date.now())
    } else if (m.type === 'retry') {
      // One torrent, asked for by hand. Only the schedule moves: the next tick performs
      // whatever action the recorded reason calls for, which is the point. A stalled
      // torrent is not paused, so resuming it here would do nothing at all.
      recovery.retry(m.handle, Date.now())
    } else if (m.type === 'flush-resume') {
      // The page is going away: snapshot every in-progress torrent so the next load
      // resumes from what is on disk rather than rechecking or re-downloading it.
      await Promise.all(handles.map((h) => persistResume(h)))
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
}

// Command handlers read, modify and write one shared IndexedDB list across awaits, so two
// of them interleaving can drop an entry or post a stale list. An account switch racing
// its own import used to be able to post an empty list last, which then uploaded an empty
// library over a good cloud backup. Run them one at a time.
//
// Reads stay off the queue: they are pure, they can park for as long as the pieces take,
// and playback must never wait behind a list mutation. add-torrent-file stays off it too,
// since its infohash poll can hold the lane for ten seconds; it guards itself instead by
// re-checking the handle is still tracked before it commits anything.
const UNQUEUED = new Set(['read', 'add-torrent-file'])
let commands: Promise<void> = Promise.resolve()

self.addEventListener('message', (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !OWN.has(m.type)) return
  const live = session
  if (!live) { post({ type: 'error', message: 'worker not initialized' }); return }
  if (UNQUEUED.has(m.type)) { void handleMessage(live, m); return }
  commands = commands.then(() => handleMessage(live, m))
})

// A failure before ready means no session will ever exist here, which the page has to be
// told about: reported as a plain error it was only logged, and every command sat forever
// on a promise that could never resolve. After ready it is one command's problem, not the
// engine's.
init().catch((e: any) => post({ type: readyPosted ? 'error' : 'fatal', message: String(e?.stack ?? e) }))
