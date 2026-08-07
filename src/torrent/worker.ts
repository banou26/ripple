import './node-shims'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { get, set, del, update } from 'idb-keyval'
import { createSession, PRIORITY } from 'libtorrent-wasm'
import type { Session, TorrentFiles, TorrentStatus } from 'libtorrent-wasm'

import type { ObservedStatus, RecoveryState } from './recovery'

import { magnetInfoHash } from './magnet'
import { shouldReanchor, windowPieces } from './stream-plan'
import { createResilientStorage } from './opfs-storage'
import { createRecoveryTracker } from './recovery'

// the message channel is shared with @fkn/lib's socket relay, so a type missing here is dropped in silence
const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'remove-missing', 'watch', 'unwatch', 'unwatch-owner', 'pause', 'resume', 'recheck', 'import-list', 'clear-list', 'start', 'retry', 'retry-now', 'flush-resume'])

export type TorrentSnapshot = {
  handle: number
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
  recovery: RecoveryState | null
  userPaused: boolean
}

const LIST_KEY = 'ripple:torrents'
const resumeKey = (ih: string) => 'ripple:resume:' + ih
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
// started === false is a torrent synced from another device and NOT added to the session; both flags are device-local and deliberately left out of the cloud backup
// absent or true means active here; paused === true is a pause the user asked for, kept across reloads so auto-recovery never restarts a torrent stopped on purpose
export type Persisted = { infoHash: string, magnet: string, savePath: string, addedAt: number, started?: boolean, paused?: boolean }

let session: Session | null = null
let readyPosted = false
const handles: number[] = []
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const savePathByHandle = new Map<number, string>()
const resumeSaved = new Set<number>()
const userPaused = new Set<number>()
// libtorrent only takes commands for handles it has registered, which happens the first time its alerts are pumped, so a pause issued during the restore is silently discarded
const wantPaused = new Set<number>()
const resumeRetry = new Map<number, { tries: number, at: number }>()
const recovery = createRecoveryTracker()

// the engine's -1 (empty input) and -2 (unparseable magnet or torrent file) come back widened to the top of the unsigned range; real handles count up from 1
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
  viewers.delete(h); pendingViewing.delete(h); needsPriorityReset.delete(h)
}

// Piece priorities ride along inside resume data, so a torrent whose resume was saved while a file
// was being streamed comes back with every other file still skipped. Put them back to default once
// the layout lands, unless a viewer got there first and already planned a window.
const needsPriorityReset = new Set<number>()

const readsByHandle = new Map<number, Set<number>>()
const failReads = (h: number, error: string) => {
  const ids = readsByHandle.get(h)
  if (!ids?.size) return
  for (const id of ids) post({ type: 'read-error', id, error })
  ids.clear()
}

// saveResumeData gives up after 8s, longer than the loops that call this, so a second snapshot must not stack on the first
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

type Viewer = { fileIndex: number, fromOffset: number }
const viewers = new Map<number, Map<string, Viewer>>()
// the layout arrives with the torrent-ready record, later than the first watch, so a plan that
// could not be built yet is retried from the pump instead of being dropped
const pendingViewing = new Set<number>()

const applyViewing = (h: number) => {
  if (!session) return
  const watching = viewers.get(h)
  if (!watching?.size) {
    // back to an ordinary download: default priority everywhere, no deadlines, sequential off.
    // This is also what takes the skip mask off before it can be written into resume data.
    pendingViewing.delete(h)
    session.clearStreamWindow(h)
    return
  }
  const files = session.files(h)
  if (!files) { pendingViewing.add(h); return }
  const claims = [...watching.values()].map(({ fileIndex, fromOffset }) => ({ fileIndex, offset: fromOffset }))
  // Skipping the unwatched files is not a bandwidth optimization: libtorrent's sequential cursor
  // sits at the first piece the torrent does not have, so without it the capacity beyond the
  // deadline window goes to the first file in the torrent rather than the one being watched.
  const planned = session.setStreamWindow(h, claims, {
    unclaimedPriority: PRIORITY.skip,
    windowPieces: windowPieces(files.pieceLength),
  })
  if (planned) pendingViewing.delete(h)
  else pendingViewing.add(h)
}

const watch = (viewer: string, h: number, fileIndex: number, fromOffset: number) => {
  let watching = viewers.get(h)
  if (!watching) viewers.set(h, watching = new Map())
  watching.set(viewer, { fileIndex, fromOffset })
  applyViewing(h)
}

const unwatch = (matches: (viewer: string) => boolean) => {
  for (const [h, watching] of viewers) {
    let changed = false
    for (const viewer of [...watching.keys()]) if (matches(viewer)) { watching.delete(viewer); changed = true }
    if (!watching.size) viewers.delete(h)
    if (changed) applyViewing(h)
  }
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

const anchorSequential = (viewer: string | undefined, h: number, fileIndex: number, offset: number) => {
  if (!viewer) return
  const current = viewers.get(h)?.get(viewer)
  if (!current || current.fileIndex !== fileIndex) { watch(viewer, h, fileIndex, offset); return }
  const r = filePieceRange(h, fileIndex)
  if (!r) return
  const span = { fileOffset: r.file.offset, pieceLength: r.pieceLength, p1: r.p1 }
  if (!shouldReanchor(span, current.fromOffset, offset)) return
  watch(viewer, h, fileIndex, offset)
}

// the directory existing is the signal, not what is inside it: OPFS creates the save path on add but its files only on the first write; on any error assume data is present
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

// Firefox private windows throw SecurityError from getDirectory(), others reject createSyncAccessHandle, which otherwise surfaces as a silent WASI EIO
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

// libtorrent keeps auto_managed set through an error and Ripple's own pause clears it, so paused + autoManaged + no error is the queue, not a user pause
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

  // persistent storage is asked for on the main thread, in use-storage-usage.ts: a worker's StorageManager has no persist
  const storage = createResilientStorage()
  session = await createSession({ net, dgram, storage, utpReceiveBufferBytes: 4_194_304 })
  for (let i = 0; i < 30; i++) session.tick()

  try {
    const list = await loadList()
    const cleared = !(await opfsHasData(list.map((e) => e.savePath || '/dl')))
    let changed = false
    for (const e of list) {
      if (e.started === false) continue
      const savePath = e.savePath || '/dl'
      const resume = (await get(resumeKey(e.infoHash))) as Uint8Array | undefined
      const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
      if (cleared && resume && resume.byteLength) {
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
      needsPriorityReset.add(h)
      if (e.paused) { userPaused.add(h); wantPaused.add(h) }
      recovery.hold(h, Date.now())
    }
    if (changed) await set(LIST_KEY, list)
  } catch (err) { console.error('[worker] restore failed', err) }

  // ready posts before any IndexedDB read: a blocked or corrupted list read would leave every command queued behind a promise that never settles
  post({ type: 'ready' })
  readyPosted = true
  post({ type: 'list', list: await loadList().catch(() => []) })

  setInterval(() => {
    if (!session) return
    const now = Date.now()
    // called for the side effect: pumping the alerts is what registers handles with the engine, so commands recorded before the first pump (wantPaused) are applied here
    // the stream itself is deliberately drained and dropped, since every failure worth acting on arrives attributed on the status instead
    session.popAlerts()
    for (const h of handles) session.postStatus(h)

    // both of these need the file layout, which only exists once the torrent-ready record has been
    // decoded, so they wait here rather than being dropped at the call that wanted them
    for (const h of [...needsPriorityReset]) {
      if (!session.files(h)) continue
      needsPriorityReset.delete(h)
      if (!viewers.get(h)?.size) session.clearStreamWindow(h)
    }
    for (const h of [...pendingViewing]) applyViewing(h)

    for (const h of wantPaused) {
      const st = session.status(h)
      if (!st) continue
      if (st.paused) wantPaused.delete(h)
      else session.pauseTorrent(h)
    }

    // a stalled torrent needs the stop first, since that is what makes libtorrent announce to its trackers again instead of waiting out the interval
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

  setInterval(() => {
    if (!session) return
    for (const h of handles) {
      const st = session.status(h)
      if (st && st.state === 3) persistResume(h)
    }
  }, 15000)

  self.addEventListener('online', () => recovery.retryNow(Date.now()))
}

const handleMessage = async (session: Session, m: any) => {
  try {
    if (m.type === 'add-magnet') {
      const savePath = m.savePath || '/dl'
      const ih = magnetInfoHash(m.magnet)
      const existing = ih ? handles.find((h) => infoHashByHandle.get(h) === ih) : undefined
      if (existing !== undefined) {
        post({ type: 'added', handle: existing, magnet: magnetByHandle.get(existing) || m.magnet })
      } else {
        const h = session.addMagnet(m.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That is not a valid magnet link' }); return }
        track(h, m.magnet, ih, savePath)
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
      // the infohash lands with the add alert, popped by the 500ms loop
      let ih: string | null = null
      for (let i = 0; i < 40 && !(ih = session.infohash(h)); i++) await new Promise((r) => setTimeout(r, 250))
      // a remove or an account switch during the poll already tore this handle down, and re-tracking would resurrect a torrent with no persisted entry
      if (!handles.includes(h)) return
      if (!ih) {
        session.removeTorrent(h, true)
        untrack(h)
        post({ type: 'add-failed', message: 'Could not read that torrent' })
        return
      }
      // the synthesized magnet is the torrent's identity everywhere (list, /embed URL, player match)
      const magnet = 'magnet:?xt=urn:btih:' + ih
      track(h, magnet, ih, savePath)
      await set(torrentKey(ih), bytes)
      await upsertList({ infoHash: ih, magnet, savePath, addedAt: Date.now() })
      post({ type: 'added', handle: h, magnet })
    } else if (m.type === 'read') {
      if (userPaused.has(m.handle) && !hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'torrent paused' })
        return
      }
      if (m.prioritize !== false) anchorSequential(m.viewer, m.handle, m.fileIndex, m.offset)
      else if (!hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'not downloaded' })
        return
      }
      let inFlight = readsByHandle.get(m.handle)
      if (!inFlight) readsByHandle.set(m.handle, inFlight = new Set())
      inFlight.add(m.id)
      try {
        // under the caller's own 120s ceiling in client.ts, so a read that is never going to land
        // is answered with a real error instead of the client giving up on a still-parked engine
        const data = await session.read(m.handle, m.fileIndex, m.offset, m.len, { timeoutMs: 110_000 })
        // failReads may have answered this id already while it was parked on pieces
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
      const e = (await loadList()).find((x) => x.infoHash === m.infoHash)
      if (e) {
        const savePath = e.savePath || '/dl'
        const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
        const h = bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That torrent could not be read' }); return }
        track(h, e.magnet, e.infoHash, savePath)
        recovery.hold(h, Date.now())
        // post state before flipping the entry so the live row dedups the ghost in the same render
        post({ type: 'state', torrents: snapshot() })
        await upsertList({ ...e, started: true, paused: false })
      }
    } else if (m.type === 'remove-missing') {
      if (typeof m.infoHash === 'string') {
        const h = handles.find((x) => infoHashByHandle.get(x) === m.infoHash)
        if (h !== undefined) { failReads(h, 'torrent removed'); session.removeTorrent(h, true); untrack(h) }
        await removeFromList(m.infoHash)
      }
    } else if (m.type === 'clear-list') {
      // the list and its resume/torrent blobs go, OPFS bytes deliberately stay on disk
      for (const h of [...handles]) { failReads(h, 'torrent removed'); session.removeTorrent(h, false); untrack(h) }
      let dropped: Persisted[] = []
      await update<Persisted[]>(LIST_KEY, (prev) => { dropped = prev ?? []; return [] })
      for (const e of dropped) {
        await del(resumeKey(e.infoHash)).catch(() => {})
        await del(torrentKey(e.infoHash)).catch(() => {})
      }
      post({ type: 'list', list: [] })
    } else if (m.type === 'pause') {
      userPaused.add(m.handle)
      recovery.forget(m.handle)
      session.pauseTorrent(m.handle)
      failReads(m.handle, 'torrent paused')
      void persistResume(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: true })
    } else if (m.type === 'resume') {
      userPaused.delete(m.handle)
      recovery.forget(m.handle)
      session.resumeTorrent(m.handle)
      recovery.hold(m.handle, Date.now())
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: false })
    } else if (m.type === 'recheck') {
      // the engine forgets every piece before it starts hashing, so the saved blob now describes a have-set that no longer exists
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await del(resumeKey(ih)).catch(() => {})
      // lets the finished torrent snapshot itself again after the check, rather than leaving the resume key deleted for good
      resumeSaved.delete(m.handle)
      failReads(m.handle, 'torrent rechecking')
      // pausing takes a torrent out of the only rotation that starts checks, so wantPaused has to go too
      userPaused.delete(m.handle)
      wantPaused.delete(m.handle)
      recovery.forget(m.handle)
      session.forceRecheck(m.handle)
      recovery.hold(m.handle, Date.now())
      if (ih) await patchList(ih, { paused: false })
    } else if (m.type === 'retry-now') {
      recovery.retryNow(Date.now())
    } else if (m.type === 'retry') {
      // only the schedule moves: a stalled torrent is not paused, so resuming it here would do nothing at all
      recovery.retry(m.handle, Date.now())
    } else if (m.type === 'flush-resume') {
      await Promise.all(handles.map((h) => persistResume(h)))
    } else if (m.type === 'watch') {
      watch(m.viewer, m.handle, m.fileIndex, m.fromOffset ?? 0)
    } else if (m.type === 'unwatch') {
      unwatch((viewer) => viewer === m.viewer)
    } else if (m.type === 'unwatch-owner') {
      // viewer ids are prefixed with the id of the tab that handed them out
      unwatch((viewer) => viewer.startsWith(m.owner + ':'))
    }
  } catch (err: any) {
    if (m.type === 'read') post({ type: 'read-error', id: m.id, error: String(err?.stack ?? err) })
    else post({ type: 'error', message: String(err?.stack ?? err) })
  }
}

// command handlers read, modify and write one shared IndexedDB list across awaits, so two of them interleaving can drop an entry or post a stale list
// add-torrent-file is unqueued because its infohash poll can hold the lane for ten seconds; it guards itself instead, with the handle re-check after the poll
// read is unqueued because reads are pure, can park indefinitely, and playback must never wait behind a list mutation
const UNQUEUED = new Set(['read', 'add-torrent-file'])
let commands: Promise<void> = Promise.resolve()

self.addEventListener('message', (e: MessageEvent) => {
  const m = e.data
  if (!m || typeof m !== 'object' || typeof m.type !== 'string' || !OWN.has(m.type)) return
  const live = session
  if (!live) {
    if (m.type === 'read') post({ type: 'read-error', id: m.id, error: 'the engine is still starting' })
    else post({ type: 'error', message: 'worker not initialized' })
    return
  }
  if (UNQUEUED.has(m.type)) { void handleMessage(live, m); return }
  commands = commands.then(() => handleMessage(live, m))
})

// before ready no session will ever exist here, so the page has to be told; after ready it is one command's problem, not the engine's
init().catch((e: any) => post({ type: readyPosted ? 'error' : 'fatal', message: String(e?.stack ?? e) }))
