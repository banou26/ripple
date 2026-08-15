import './node-shims'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { get, set, del, update } from 'idb-keyval'
import { createSession, PRIORITY, TORRENT_FLAG } from 'libtorrent-wasm'
import type { PeerInfo, Reachability, Session, TorrentFiles, TorrentStatus, TrackerInfo } from 'libtorrent-wasm'

import type { ObservedStatus, RecoveryState } from './recovery'
import type { MeasurableStorage } from './opfs-storage'
import type { EvictionCandidate } from './storage-budget'
import type { Persisted, SaveLocation } from './library'

import { magnetInfoHash } from './magnet'
import { deadlineStepMsFor, shouldReanchor, windowPiecesFor } from './stream-plan'
import { createResilientStorage } from './opfs-storage'
import { createRecoveryTracker } from './recovery'
import { evictionFloor, planEviction } from './storage-budget'
import { sweepProbes, sweepSaveRoot } from './opfs-sweep'
import { SHARED_ROOT, mergeEntry, ownsItsDirectory, savePathFor } from './library'
import { createHybridStorage } from './hybrid-storage'
import { piecePlan, planIsDefault } from './piece-plan'
import { currentLocation, savePathIn } from './save-location'
import { RATE_LIMITS_KEY, isLimit, normalizeLimits } from './rate-limits'
import type { RateLimits } from './rate-limits'

// the message channel is shared with @fkn/lib's socket relay, so a type missing here is dropped in silence
const OWN = new Set(['add-magnet', 'add-torrent-file', 'read', 'remove', 'relocate', 'set-location', 'set-folder', 'set-plan', 'remove-missing', 'watch', 'unwatch', 'unwatch-owner', 'pause', 'resume', 'recheck', 'import-list', 'clear-list', 'start', 'retry', 'retry-now', 'flush-resume', 'inspect', 'set-flags', 'reannounce', 'queue-move', 'set-limits', 'set-session-limits'])

export type TorrentSnapshot = {
  handle: number
  magnet: string
  files: TorrentFiles | null
  status: TorrentStatus | null
  bitfield: { numPieces: number, pieceLength: number, length: number, pieces: Uint8Array } | null
  recovery: RecoveryState | null
  userPaused: boolean
}

/**
 * The per-peer and per-tracker detail for ONE torrent, and only while something is looking at it.
 *
 * Deliberately not part of {@link TorrentSnapshot}. A library of thirty torrents with forty peers
 * each would put twelve hundred rows through the message channel twice a second, all to render one
 * panel that is usually closed. So the panel names its subject with `inspect` and the engine
 * computes this for that torrent alone; `inspect(null)` when it closes, and the cost goes back to
 * nothing.
 */
export type TorrentDetail = {
  handle: number
  peers: PeerInfo[]
  trackers: TrackerInfo[]
}

const LIST_KEY = 'ripple:torrents'
const resumeKey = (ih: string) => 'ripple:resume:' + ih
const torrentKey = (ih: string) => 'ripple:torrent:' + ih
// started === false is a torrent synced from another device and NOT added to the session; both flags are device-local and deliberately left out of the cloud backup
// absent or true means active here; paused === true is a pause the user asked for, kept across reloads so auto-recovery never restarts a torrent stopped on purpose
// ephemeral === true is a torrent the PLAYER asked for rather than the user: its bytes are a cache the engine may reclaim, and only those are ever auto-deleted
// lastUsedAt orders that cache. It is device-local too, and written without broadcasting the list, or every playback would schedule a cloud backup write
export type { Persisted }
/** Where inbound peers can reach this session, if anywhere. Re-exported so the UI can read it. */
export type { Reachability }
/** The rows a detail panel draws. Re-exported for the same reason. */
export type { PeerInfo, TrackerInfo }

let session: Session | null = null
let storage: MeasurableStorage | null = null
/**
 * The directory the user granted, as handed over by a page.
 *
 * The engine reads a folder-backed torrent's files through this, so it has to live where the engine
 * does. A File System Access grant belongs to a realm, and the tab that owns the engine is not
 * necessarily the tab the user clicked Allow in, so this is pushed IN by whichever page has a
 * permitted handle rather than restored here. Absent is an ordinary state, not a fault: a grant is
 * per session and comes back needing a gesture after every reload.
 */
let folderHandle: FileSystemDirectoryHandle | null = null
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

// the rule itself is in library.ts, where it can be tested: every field of it decides something the
// user can lose
const upsertList = async (entry: Persisted) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => {
    list = prev ?? []
    const i = list.findIndex((e) => e.infoHash === entry.infoHash)
    const merged = mergeEntry(i >= 0 ? list[i] : null, entry)
    if (i >= 0) list[i] = merged; else list.push(merged)
    return list
  })
  post({ type: 'list', list })
}

// `quiet` skips the broadcast: a lastUsedAt touch changes nothing any tab renders, and every `list`
// message arms a debounced cloud backup write
const patchList = async (ih: string, patch: Partial<Persisted>, quiet = false) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => {
    list = prev ?? []
    const i = list.findIndex((e) => e.infoHash === ih)
    if (i >= 0) list[i] = { ...list[i]!, ...patch }
    return list
  })
  if (!quiet) post({ type: 'list', list })
}

const touchUsed = (h: number) => {
  const ih = infoHashByHandle.get(h)
  if (ih) void patchList(ih, { lastUsedAt: Date.now() }, true).catch(() => {})
}
const removeFromList = async (ih: string) => {
  let list: Persisted[] = []
  await update<Persisted[]>(LIST_KEY, (prev) => (list = (prev ?? []).filter((e) => e.infoHash !== ih)))
  await del(resumeKey(ih)).catch(() => {})
  await del(torrentKey(ih)).catch(() => {})
  post({ type: 'list', list })
}

// Torrents the player asked for rather than the user. Their bytes are the cache the budget pass
// reclaims from, and they are the only ones it will ever delete.
const ephemeralHandles = new Set<number>()
// Stopped because nobody is watching, which is NOT the user's pause: it stays out of `userPaused`
// and out of the persisted `paused` flag, so it never looks like a decision the user made.
const cacheIdle = new Set<number>()
// When a torrent last served a read. Save-to-disk, the zip export and the auto-save folder mirror
// all read without registering a viewer, so a viewer check alone would call them idle and delete
// the file out from under them mid-copy.
const lastReadAt = new Map<number, number>()
// Waiting to have their one top-level name written into the list, which needs the file layout.
const needsRootEntry = new Set<number>()

// The torrent a detail panel is showing, or null when none is. See TorrentDetail for why this is
// scoped to one rather than computed for the whole library.
let inspecting: number | null = null
let trackersPolledAt = 0
// Trackers move on the announce interval, which is minutes, so re-asking twice a second would be
// pure waste. Peers ride the ordinary 500ms broadcast because they genuinely change that fast.
const TRACKER_POLL_MS = 5_000

/**
 * The detail for the inspected torrent, or null.
 *
 * The engine's peers() and trackers() are asynchronous: they post a request and the answer lands
 * with the next alert pump, because the synchronous getters underneath are sync_calls on an
 * io_context that only this thread ticks and would deadlock. So this asks and does NOT wait, then
 * reads the last answer that arrived. The panel runs one broadcast behind, which at 500ms nobody
 * can see, and the alternative is blocking the tick loop on a round trip through itself.
 */
const inspectDetail = (now: number): TorrentDetail | null => {
  const handle = inspecting
  if (handle == null || !handles.includes(handle)) return null
  void session!.peers(handle)
  if (now - trackersPolledAt >= TRACKER_POLL_MS) {
    trackersPolledAt = now
    void session!.trackers(handle)
  }
  return { handle, peers: session!.lastPeers(handle), trackers: session!.lastTrackers(handle) }
}

/** The names this torrent occupies directly inside its save path. Empty until the layout lands. */
const rootEntriesOf = (h: number): string[] => {
  const files = session?.files(h)
  if (!files) return []
  const names = files.files.map((f) => f.path.split('/').filter(Boolean)[0]).filter(Boolean) as string[]
  return [...new Set(names)]
}

const track = (h: number, magnet: string, ih: string | null, savePath: string, ephemeral = false) => {
  if (!handles.includes(h)) handles.push(h)
  magnetByHandle.set(h, magnet)
  if (ih) { infoHashByHandle.set(h, ih); needsRootEntry.add(h) }
  savePathByHandle.set(h, savePath)
  if (ephemeral) ephemeralHandles.add(h); else ephemeralHandles.delete(h)
}
const untrack = (h: number) => {
  const i = handles.indexOf(h); if (i >= 0) handles.splice(i, 1)
  magnetByHandle.delete(h); infoHashByHandle.delete(h); savePathByHandle.delete(h); resumeSaved.delete(h)
  userPaused.delete(h); recovery.forget(h); resumeInFlight.delete(h); readsByHandle.delete(h)
  wantPaused.delete(h); resumeRetry.delete(h)
  viewers.delete(h); pendingViewing.delete(h); needsPriorityReset.delete(h); planByHandle.delete(h)
  limitsByHandle.delete(h); pendingLimits.delete(h)
  ephemeralHandles.delete(h); cacheIdle.delete(h); lastReadAt.delete(h); needsRootEntry.delete(h)
}

// A read or a viewer means someone wants these bytes now, so an idle-paused cache torrent goes back
// to work. Without this a paused torrent would park a read on pieces that can never arrive.
const wake = (h: number) => {
  if (!cacheIdle.delete(h)) return
  wantPaused.delete(h)
  session?.resumeTorrent(h)
  recovery.hold(h, Date.now())
}

// Piece priorities ride along inside resume data, so a torrent whose resume was saved while a file
// was being streamed comes back with every other file still skipped. Put them back to default once
// the layout lands, unless a viewer got there first and already planned a window.
const needsPriorityReset = new Set<number>()

/**
 * What each torrent's piece priorities should be when nobody is watching it.
 *
 * Kept here AND in the list entry, because the engine's copy does not survive: `applyViewing` calls
 * `clearStreamWindow` for any torrent with no viewers, which fills the whole map with normal, and
 * that runs on restore too. A selection living only in libtorrent's head was therefore undone by the
 * next reload, quietly turning "just this subtitle" back into the whole torrent.
 */
const planByHandle = new Map<number, { wanted?: number[], firstLast?: boolean }>()

/**
 * The session-wide ceilings currently in force, and the only record of them that exists.
 *
 * The engine cannot be asked. `Session.setRateLimits` is write-only by construction, because the
 * matching getters are sync calls into an io_context that only runs inside a tick, so asking from
 * here would block the thread that has to tick for the answer. Anything the UI shows is derived from
 * this object, never from the engine.
 *
 * Owned by the WORKER rather than pushed down by a page, and that is what makes it survive. The
 * engine moves between tabs, and a page that pushed a setting into the tab that used to hold the
 * engine has no idea the engine has gone: there is no re-push on handover today, which is why
 * `setFolder` has to be offered by every tab continuously. Reading this out of IndexedDB in the
 * worker ties its lifetime to the session's by construction, so there is no window in which an
 * engine is running without the limits the user chose, whichever tab happens to be hosting it and
 * whether or not that tab has a settings screen at all. An `/embed` tab has none.
 */
let sessionLimits: RateLimits = { down: 0, up: 0 }

/**
 * Per-torrent ceilings waiting for a handle the engine will admit.
 *
 * NOT applied at add time, which looks like it should work and silently does not:
 * `lt_torrent_set_download_limit` looks the handle up and returns -1 for one libtorrent has not
 * registered yet, registration only happens when the add alert is pumped, and the JS wrapper
 * discards that return value. There is no throw and nothing in any console. The symptom is a limit
 * that is ignored on a fresh add and works after a reload, which is a miserable thing to chase.
 *
 * The gate is `status(h)` being non-null, which means registered, and deliberately NOT `files(h)`,
 * which means metadata has arrived. The piece plan needs the file layout; a rate limit needs only a
 * handle. Waiting for metadata would leave a cold magnet running uncapped for the tens of seconds
 * during which someone who just set a cap is watching it.
 */
const limitsByHandle = new Map<number, { down?: number, up?: number }>()
const pendingLimits = new Set<number>()

/**
 * Remember what this torrent should be held to, and apply it as soon as the engine will accept it.
 *
 * Returns whether anything was recorded, so a caller can tell "nothing to do" from "done".
 *
 * Merged field by field rather than by spreading the pair, because a spread carries an explicit
 * `undefined` over the top of a real value: changing only the upload ceiling would quietly forget
 * the download one this map was holding.
 */
const wantLimits = (h: number, limits: { down?: number, up?: number }): boolean => {
  const merged = { ...limitsByHandle.get(h) }
  if (isLimit(limits.down)) merged.down = limits.down
  if (isLimit(limits.up)) merged.up = limits.up
  if (!isLimit(merged.down) && !isLimit(merged.up)) return false
  limitsByHandle.set(h, merged)
  pendingLimits.add(h)
  return true
}

const applyLimits = (h: number) => {
  const limits = limitsByHandle.get(h)
  if (!session || !limits) return
  if (isLimit(limits.down)) session.setDownloadLimit(h, limits.down)
  if (isLimit(limits.up)) session.setUploadLimit(h, limits.up)
}

// one attempt is short enough that a plan that starved a read gets rewritten quickly; the product
// stays under the caller's own 120s ceiling in client.ts
const READ_ATTEMPT_MS = 6_000
const READ_ATTEMPTS = 18
// How many of a stalled read's missing pieces get taken back from their peers per attempt. A read
// covers a handful of pieces at the sizes that occur in the wild, so this is a bound for the small-
// piece case rather than a policy; anything past it is left alone and named in the stall message.
const CANCEL_PER_STALL = 16

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
    const blob = await session.saveResumeData(h)
    // a snapshot that lands after the torrent was given up describes files that no longer exist,
    // and the next reload would restore a have-set the disk cannot back
    if (!handles.includes(h)) return false
    await set(resumeKey(ih), blob)
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

/**
 * Write this torrent's own priorities over the default map.
 *
 * Silent when there is nothing to say, so an ordinary torrent costs no vector copy across the
 * boundary. The layout is required rather than waited for: with no file list there are no piece
 * ranges to compute, and `needsPriorityReset` brings the handle back once the metadata lands.
 */
const applyPiecePlan = (h: number) => {
  const plan = planByHandle.get(h)
  if (!session || !plan || planIsDefault(plan)) return
  const files = session.files(h)
  if (!files) return
  session.prioritizePieces(h, piecePlan({
    files: files.files,
    pieceLength: files.pieceLength,
    numPieces: Math.ceil(files.totalSize / files.pieceLength),
    wanted: plan.wanted,
    firstLast: plan.firstLast,
  }))
}

const applyViewing = (h: number) => {
  if (!session) return
  // a handle the engine no longer has is not a torrent with no viewers, it is not a torrent at all;
  // parking it in pendingViewing would retry it on every pump for the life of the session
  if (!handles.includes(h)) { viewers.delete(h); pendingViewing.delete(h); return }
  const watching = viewers.get(h)
  if (!watching?.size) {
    // back to an ordinary download: default priority everywhere, no deadlines, sequential off.
    // This is also what takes the skip mask off before it can be written into resume data.
    pendingViewing.delete(h)
    session.clearStreamWindow(h)
    // clearStreamWindow just wrote normal over every piece, so anything the person chose has to be
    // written back on top of it. This is the only place that happens, which is why it is also what
    // makes a selection survive a reload.
    applyPiecePlan(h)
    // Clearing the window also puts every OTHER file in the torrent back to normal priority, so a
    // player closing on one episode of a pack turns into a full speed download of the whole pack
    // that nobody asked for and no screen shows. For a cache torrent that is bytes the budget pass
    // then has to reclaim, and metered quota spent on them first, so stop it instead.
    if (ephemeralHandles.has(h) && !userPaused.has(h) && !cacheIdle.has(h)) {
      cacheIdle.add(h)
      wantPaused.add(h)
      session.pauseTorrent(h)
      void persistResume(h)
    }
    return
  }
  wake(h)
  const files = session.files(h)
  if (!files) { pendingViewing.add(h); return }
  const claims = [...watching.values()].map(({ fileIndex, fromOffset }) => ({ fileIndex, offset: fromOffset }))
  // Skipping the unwatched files is not a bandwidth optimization: libtorrent's sequential cursor
  // sits at the first piece the torrent does not have, so without it the capacity beyond the
  // deadline window goes to the first file in the torrent rather than the one being watched.
  //
  // The window is sized from the piece length, not fixed: the band is picked in shuffled order and
  // the in-order walk skips it, so it wants to be barely wider than one demuxer read.
  const planned = session.setStreamWindow(h, claims, {
    unclaimedPriority: PRIORITY.skip,
    windowPieces: windowPiecesFor(files.pieceLength),
    deadlineStepMs: deadlineStepMsFor(files.pieceLength, session.status(h)?.downloadRate || 3_000_000),
  })
  if (planned) pendingViewing.delete(h)
  else pendingViewing.add(h)
}

const watch = (viewer: string, h: number, fileIndex: number, fromOffset: number) => {
  // A read is dispatched without waiting on the command queue, so one issued against a torrent the
  // budget pass has just evicted arrives here afterwards. Recreating the entry would resurrect a
  // dead handle, and the engine reuses a handle number for the same infohash, so the entry would
  // then attach to whatever is added under it next.
  if (!handles.includes(h)) return
  let watching = viewers.get(h)
  const first = !watching?.size
  if (!watching) viewers.set(h, watching = new Map())
  watching.set(viewer, { fileIndex, fromOffset })
  if (first) touchUsed(h)
  applyViewing(h)
}

const unwatch = (matches: (viewer: string) => boolean) => {
  for (const [h, watching] of viewers) {
    let changed = false
    for (const viewer of [...watching.keys()]) if (matches(viewer)) { watching.delete(viewer); changed = true }
    // when it stopped being watched is the truest thing to order the cache by
    if (!watching.size) { viewers.delete(h); if (changed) touchUsed(h) }
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

// which pieces of a read's range are still missing, so a stalled read can say what it is waiting on
const missingPieces = (h: number, fileIndex: number, offset: number, len: number): number[] => {
  const files = session?.files(h)
  const file = files?.files[fileIndex]
  const bf = session?.bitfield(h)
  if (!files || !file || !bf) return []
  const p0 = Math.floor((file.offset + offset) / files.pieceLength)
  const p1 = Math.floor((file.offset + Math.min(offset + len, file.size) - 1) / files.pieceLength)
  const out: number[] = []
  for (let p = p0; p <= p1; p++) if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) out.push(p)
  return out
}

/**
 * What the torrents someone is watching still have to write, from the bitfield.
 *
 * NOT `totalWanted - totalDone`. The streaming plan skips every unwatched file, which shrinks
 * `totalWanted` to the watched selection, while `totalDone` keeps counting every piece the torrent
 * holds including the skipped ones. On a season pack that downloaded a few episodes before anyone
 * pressed play the subtraction is negative, clamps to zero, and reserves nothing for exactly the
 * file that is about to write gigabytes.
 *
 * Pieces are counted once per torrent however many viewers claim them, and a piece straddling the
 * end of the watched file is counted whole, which errs towards reserving too much.
 */
const remainingForViewers = (): number => {
  if (!session) return 0
  let total = 0
  for (const [h, watching] of viewers) {
    if (!watching.size || !handles.includes(h)) continue
    const files = session.files(h)
    const bf = session.bitfield(h)
    if (!files) continue
    if (!bf) {
      // layout but no bitfield: reserve the whole of what is claimed rather than nothing
      for (const { fileIndex } of watching.values()) total += files.files[fileIndex]?.size ?? 0
      continue
    }
    const missing = new Set<number>()
    for (const { fileIndex } of watching.values()) {
      const r = filePieceRange(h, fileIndex)
      if (!r) continue
      for (let p = r.p0; p <= r.p1; p++) if (!((bf.pieces[p >> 3] ?? 0) & (0x80 >> (p & 7)))) missing.add(p)
    }
    total += missing.size * files.pieceLength
  }
  return total
}

const anchorSequential = (viewer: string | undefined, h: number, fileIndex: number, offset: number, len: number) => {
  if (!viewer || !handles.includes(h)) return
  const current = viewers.get(h)?.get(viewer)
  if (!current || current.fileIndex !== fileIndex) { watch(viewer, h, fileIndex, offset); return }
  const r = filePieceRange(h, fileIndex)
  if (!r) return
  const span = { fileOffset: r.file.offset, pieceLength: r.pieceLength, p1: r.p1 }
  if (!shouldReanchor(span, current.fromOffset, offset, len)) return
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

// How often the origin's storage budget is checked. The engine runs in exactly one tab, so this
// runs once per browser however many tabs are open.
const EVICT_INTERVAL_MS = 10_000
// How long after its last read a torrent still counts as in use. Save-to-disk, the zip export and
// the auto-save folder mirror all read without registering a viewer, and a copy that pauses between
// chunks must not be deleted out from under itself.
const READ_GRACE_MS = 60_000
// A torrent used this recently is in use, whoever is holding it. /embed re-opening one it played
// before touches it and only then attaches a viewer, once the layout arrives, and a pass landing
// inside that gap would delete exactly the thing the person just asked to watch.
const RECENT_USE_MS = 15_000
// A delete lands asynchronously, so the estimate is given time to move before the next eviction is
// decided against it. Without this one pass reads its own stale usage and cascades through the cache.
const RECLAIM_POLL_MS = 250
const RECLAIM_WAIT_MS = 4_000

type Space = { usedBytes: number, limitBytes: number }

const measureSpace = async (): Promise<Space | null> => {
  try {
    const estimate = await navigator.storage.estimate()
    // an unknown quota is not a full disk; use-storage-usage.ts guards the page side the same way
    if (estimate.usage === undefined || !estimate.quota) return null
    return { usedBytes: estimate.usage, limitBytes: estimate.quota }
  } catch { return null }
}

const settleAfterDelete = async (before: number): Promise<Space | null> => {
  for (let waited = 0; waited < RECLAIM_WAIT_MS; waited += RECLAIM_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, RECLAIM_POLL_MS))
    const now = await measureSpace()
    if (!now || now.usedBytes < before) return now
  }
  return measureSpace()
}

/**
 * Give up the bytes and keep the row.
 *
 * The list entry SURVIVES. It is the user's library row and it is mirrored to their other devices,
 * so removing it would propagate a deletion they never asked for; only the bytes behind it were ever
 * replaceable, and the row goes back to the same "files missing" state a wiped site leaves, with the
 * same Download button.
 *
 * Order is not arrangeable. The torrent is removed BEFORE anything else so libtorrent closes its
 * sync access handles and deletes the files itself: while those handles are open, OPFS refuses the
 * removal outright, and a file deleted out from under a live torrent is re-created empty on the next
 * read (`opfs.ts` opens with `create: true` and zero-fills a short read), so the engine would hand
 * back zeros with no error anywhere.
 *
 * The resume blob has to go with it, and this is the one step where forgetting is silent rather than
 * loud: `check()` answers no_error when no file holds bytes, which means "trust what you have" and
 * NOT "verify", so a surviving have-set is believed rather than caught.
 */
const releaseStorage = async (live: Session, h: number, ih: string, reason: string, patch: Partial<Persisted> = {}) => {
  failReads(h, reason)
  live.removeTorrent(h, true)
  untrack(h)
  // the saved have-set now describes files that do not exist
  await del(resumeKey(ih)).catch(() => {})
  await patchList(ih, { started: false, paused: false, ...patch })
}

const evict = (live: Session, h: number, ih: string) =>
  releaseStorage(live, h, ih, 'torrent removed to make room')

/**
 * Point a torrent at the other storage, with its files already there.
 *
 * The COPY is not done here. A page does it, because the mirror that writes into the user's folder
 * already exists there, already verifies content, and already has the directory handle. By the time
 * this runs the bytes are in both places, and all that is left is to make the engine agree.
 *
 * `deleteFiles` is the line to read twice. It is true only when leaving BROWSER storage, where the
 * copy being dropped is Ripple's own. Leaving a folder passes false, because those files are the
 * user's and the hybrid backend refuses to delete them anyway: two independent guards on the one
 * mistake in here that cannot be undone.
 *
 * The resume blob always goes. It describes a have-set for files at the old path, and after the move
 * it is a claim about somewhere else. Without it the re-add asks the storage to check, which for a
 * folder means hashing what is there and building the have-set from it: reads only, no network.
 */
const relocate = async (live: Session, h: number, ih: string, to: SaveLocation) => {
  const from = currentLocation(savePathByHandle.get(h))
  if (from === to) return
  const magnet = magnetByHandle.get(h) ?? ''
  const savePath = savePathIn(to, ih)
  const wasPaused = userPaused.has(h)

  failReads(h, 'files moved')
  live.removeTorrent(h, from === 'browser')
  untrack(h)
  await del(resumeKey(ih)).catch(() => {})

  const next = live.addMagnet(magnet, savePath)
  if (addFailed(next)) {
    post({ type: 'add-failed', message: 'Moving the files left the torrent unaddable' })
    await patchList(ih, { savePath, saveTo: to, started: false })
    return
  }
  track(next, magnet, ih, savePath)
  // Upload only, for a folder. There is no way to write there that is safe for the user's own files,
  // so a torrent that could ask for a piece would eventually ask this backend to write and be
  // refused, which reaches libtorrent as a fatal disk error.
  if (to === 'folder') live.setFlags(next, TORRENT_FLAG.uploadMode, TORRENT_FLAG.uploadMode)
  if (wasPaused) { userPaused.add(next); wantPaused.add(next) }
  recovery.hold(next, Date.now())
  // no message of its own: patchList broadcasts the list, and the next state tick carries the new
  // handle, so every tab learns about the move through the two channels it already watches
  await patchList(ih, { savePath, saveTo: to, started: true })
}

const collectCandidates = async (list: Persisted[], now: number): Promise<EvictionCandidate[]> => {
  const byHash = new Map(list.map((e) => [e.infoHash, e]))
  const out: EvictionCandidate[] = []
  for (const h of [...handles]) {
    const ih = infoHashByHandle.get(h)
    if (!ih) continue
    const entry = byHash.get(ih)
    // only what the player asked for, and only where deleting a directory can reach nothing else
    if (!entry?.ephemeral || !ownsItsDirectory(entry.savePath, ih)) continue
    if (viewers.get(h)?.size || readsByHandle.get(h)?.size) continue
    if (now - (lastReadAt.get(h) ?? 0) < READ_GRACE_MS) continue
    const usedAt = entry.lastUsedAt ?? entry.addedAt
    if (now - usedAt < RECENT_USE_MS) continue
    const bytesOnDisk = (await storage?.usageOf(entry.savePath)) ?? 0
    if (bytesOnDisk <= 0) continue
    out.push({ infoHash: ih, usedAt, bytesOnDisk })
  }
  return out
}

// Reported from the estimate AFTER a pass, never from the plan: a pass that just freed 10 GB
// announcing the origin as full is worse than saying nothing.
let storageFull = false
const reportSpace = (space: Space) => {
  const full = space.limitBytes - space.usedBytes < evictionFloor(space.limitBytes)
  if (full === storageFull) return
  storageFull = full
  post({ type: 'storage-full', full, usedBytes: space.usedBytes, limitBytes: space.limitBytes })
}

// Slow on purpose: this walks directories and its whole job is tidying, so it is never in the way
// of a download. It also runs from the budget pass when the origin is full, because bytes nothing
// owns are the one thing there that can always be given back.
const SWEEP_INTERVAL_MS = 10 * 60_000
const SWEEP_FIRST_MS = 60_000

let sweepRunning = false
const runOrphanSweep = async (): Promise<number> => {
  if (!session || sweepRunning) return 0
  sweepRunning = true
  try {
    const list = await loadList()
    const listedHashes = new Set(list.map((e) => e.infoHash.toLowerCase()))
    const claimedNames = new Set<string>()
    let attributable = true

    // Anything in the session counts as known even before its entry lands: add-magnet writes the
    // list after the engine has already created the directory, and a sweep inside that window would
    // delete the torrent it is being asked to start.
    for (const h of handles) {
      const ih = infoHashByHandle.get(h)
      if (ih) listedHashes.add(ih.toLowerCase())
      if ((savePathByHandle.get(h) ?? SHARED_ROOT) !== SHARED_ROOT) continue
      const names = rootEntriesOf(h)
      // in the shared root and no layout yet: its folder cannot be told from an orphan
      if (!names.length) { attributable = false; continue }
      for (const name of names) claimedNames.add(name)
    }

    for (const e of list) {
      const savePath = e.savePath || SHARED_ROOT
      // a save path outside the root this sweeps is territory it knows nothing about
      if (savePath !== SHARED_ROOT && !savePath.startsWith(SHARED_ROOT + '/')) { attributable = false; continue }
      if (savePath !== SHARED_ROOT) continue
      if (e.rootEntry) { claimedNames.add(e.rootEntry); continue }
      const live = handles.some((h) => infoHashByHandle.get(h) === e.infoHash)
      // Should be running but is not, and never recorded what it occupies. A torrent that has never
      // started here has written nothing, so only one that was expected to be live is a problem.
      if (!live && e.started !== false) attributable = false
    }

    const root = await navigator.storage.getDirectory()
    const removed = await sweepSaveRoot(root, SHARED_ROOT, { listedHashes, claimedNames, attributable })
    await sweepProbes(root).catch(() => 0)
    // one line, only when something actually went: this deletes data, so it leaves a trace
    if (removed.length) console.log('[worker] removed storage nothing owns', removed)
    return removed.length
  } catch (err) {
    console.error('[worker] orphan sweep failed', String(err))
    return 0
  } finally { sweepRunning = false }
}

let budgetPassRunning = false
const runStorageBudget = async () => {
  const live = session
  if (!live || budgetPassRunning) return
  budgetPassRunning = true
  try {
    let space = await measureSpace()
    if (!space) return
    const pendingBytes = remainingForViewers()
    let candidates = await collectCandidates(await loadList(), Date.now())
    // One at a time, re-measured in between. The plan's sizes decide the ORDER and whether to start
    // at all; the browser's own accounting decides when there is enough room. A size that is wrong
    // then costs one extra pass rather than the whole cache.
    while (candidates.length) {
      const [next] = planEviction({ ...space, pendingBytes, candidates })
      if (!next) break
      candidates = candidates.filter((c) => c.infoHash !== next)
      const h = handles.find((x) => infoHashByHandle.get(x) === next)
      if (h === undefined) continue
      // Re-checked at the moment of deletion, not only when the list was collected: measuring every
      // candidate and waiting out each previous delete takes seconds, and a player can attach inside
      // that window. Commands do not queue behind this pass, so nothing else would notice.
      if (viewers.get(h)?.size || readsByHandle.get(h)?.size) continue
      const before = space.usedBytes
      await evict(live, h, next)
      const after = await settleAfterDelete(before)
      if (!after) return
      space = after
    }
    // Out of torrents it may give up, but bytes nothing owns are always fair game and are exactly
    // what an account switch leaves behind, so sweep before calling the origin full.
    if (space.limitBytes - space.usedBytes < evictionFloor(space.limitBytes) && await runOrphanSweep()) {
      space = (await settleAfterDelete(space.usedBytes)) ?? space
    }
    reportSpace(space)
  } catch (err) {
    console.error('[worker] storage budget pass failed', String(err))
  } finally { budgetPassRunning = false }
}

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  if (!(await opfsAvailable())) {
    post({ type: 'storage-unavailable' })
    return
  }

  // Started before the session is built so the read overlaps the wasm load, and bounded, because
  // nothing on the path to `ready` may hang: every command in every tab parks behind that message,
  // so a blocked IndexedDB here would freeze the whole app rather than merely lose a setting. A
  // timeout means unlimited, which is the same thing a first run means.
  const storedLimits = Promise.race([
    get(RATE_LIMITS_KEY).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
  ])

  // persistent storage is asked for on the main thread, in use-storage-usage.ts: a worker's StorageManager has no persist
  storage = createHybridStorage(createResilientStorage(), () => folderHandle)
  session = await createSession({ net, dgram, storage, utpReceiveBufferBytes: 4_194_304 })
  for (let i = 0; i < 30; i++) session.tick()

  // before the restore loop below adds anything, so a stored ceiling is in force from the first byte
  // rather than from a tick later
  sessionLimits = normalizeLimits(await storedLimits)
  session.setRateLimits({ download: sessionLimits.down, upload: sessionLimits.up })



  try {
    const list = await loadList()
    const cleared = !(await opfsHasData(list.map((e) => e.savePath || SHARED_ROOT)))
    let changed = false
    for (const e of list) {
      if (e.started === false) continue
      const savePath = e.savePath || SHARED_ROOT
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
      track(h, e.magnet, e.infoHash, savePath, e.ephemeral === true)
      // before needsPriorityReset, so the pass that clears the window has the plan to write back
      planByHandle.set(h, { wanted: e.wantedFiles, firstLast: e.firstLast })
      needsPriorityReset.add(h)
      // the resume blob does carry a limit, which is exactly why this does not rely on it: ripple
      // deletes the blob on a recheck and on the cleared-storage path, and falls back to addMagnet
      // when there is none, so the entry is the only record that is always there
      wantLimits(h, { down: e.downloadLimit, up: e.uploadLimit })
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
      // applyViewing, not clearStreamWindow alone: a restored cache torrent nobody is watching has
      // to be stopped here too, or every reload restarts the whole set at full speed
      if (!viewers.get(h)?.size) applyViewing(h)
    }
    for (const h of [...pendingViewing]) applyViewing(h)

    // a ceiling needs a REGISTERED handle and nothing more, so this gate is status rather than the
    // files() the two loops above wait on. Registration happens when the add alert is pumped, a few
    // lines up, so this normally lands on the very next pass.
    for (const h of [...pendingLimits]) {
      if (!session.status(h)) continue
      pendingLimits.delete(h)
      applyLimits(h)
    }

    // record what each torrent occupies inside its save path, so the orphan sweep can account for
    // it later even when it is no longer in the session to be asked
    for (const h of [...needsRootEntry]) {
      const [name] = rootEntriesOf(h)
      if (!name) continue
      needsRootEntry.delete(h)
      const ih = infoHashByHandle.get(h)
      if (ih) void patchList(ih, { rootEntry: name }, true).catch(() => {})
    }

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
      // an idle-paused cache torrent is stopped on purpose too, so recovery must not read it as a
      // failure and start it again five seconds later
      recovery.observe(h, st && observed(st), userPaused.has(h) || cacheIdle.has(h), now)
    }
    for (const { handle, reason } of recovery.due(now)) {
      if (reason === 'stalled') session.pauseTorrent(handle)
      session.resumeTorrent(handle)
    }

    // the limits ride the existing broadcast rather than getting a channel of their own, so every
    // tab renders the value actually in force. idb-keyval has no change notification, so without
    // this two settings panels would silently disagree.
    post({ type: 'state', torrents: snapshot(), reachable: session!.reachable(), detail: inspectDetail(now), rateLimits: { ...sessionLimits } })
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

  setInterval(() => { void runStorageBudget() }, EVICT_INTERVAL_MS)
  void runStorageBudget()

  // the first pass waits for metadata to land, or every magnet still resolving reads as a torrent
  // that cannot be accounted for and the shared root is skipped for nothing
  setTimeout(() => {
    void runOrphanSweep()
    setInterval(() => { void runOrphanSweep() }, SWEEP_INTERVAL_MS)
  }, SWEEP_FIRST_MS)

  self.addEventListener('online', () => recovery.retryNow(Date.now()))
}

const handleMessage = async (session: Session, m: any) => {
  try {
    if (m.type === 'add-magnet') {
      const ih = magnetInfoHash(m.magnet)
      const existing = ih ? handles.find((h) => infoHashByHandle.get(h) === ih) : undefined
      if (existing !== undefined) {
        if (ih && !m.ephemeral) {
          // a deliberate re-add promotes a cache entry to a library one, which is the only gesture
          // there is for keeping something the budget pass would otherwise be free to reclaim
          ephemeralHandles.delete(existing)
          await patchList(ih, { ephemeral: false, lastUsedAt: Date.now() })
        } else touchUsed(existing)
        post({ type: 'added', handle: existing, magnet: magnetByHandle.get(existing) || m.magnet })
      } else {
        // bytes already on disk stay where they were written, so a re-add never moves a torrent to
        // a fresh directory and orphans the old one
        const known = ih ? (await loadList()).find((e) => e.infoHash === ih) : undefined
        const savePath = m.savePath || known?.savePath || savePathFor(ih)
        const ephemeral = m.ephemeral === true
        const h = session.addMagnet(m.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That is not a valid magnet link' }); return }
        track(h, m.magnet, ih, savePath, ephemeral)
        // a re-add of something this device already knows keeps the ceiling it was given, matching
        // mergeEntry, which carries the limit forward rather than letting an add quietly uncap it
        wantLimits(h, { down: known?.downloadLimit, up: known?.uploadLimit })
        recovery.hold(h, Date.now())
        const at = Date.now()
        // started/paused written explicitly: this add is what clears an eviction's tombstone
        if (ih) await upsertList({ infoHash: ih, magnet: m.magnet, savePath, addedAt: at, lastUsedAt: at, ephemeral, started: true, paused: false })
        post({ type: 'added', handle: h, magnet: m.magnet })
        void runStorageBudget()
      }
    } else if (m.type === 'add-torrent-file') {
      // A .torrent only reveals its infohash after the add, so this one cannot be given a directory
      // of its own. It is a deliberate user action, so it is never a cache entry and the budget pass
      // never touches it, which is what makes sharing the root safe here.
      const savePath = m.savePath || SHARED_ROOT
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
      const addedAt = Date.now()
      await upsertList({ infoHash: ih, magnet, savePath, addedAt, lastUsedAt: addedAt, ephemeral: false, started: true, paused: false })
      post({ type: 'added', handle: h, magnet })
    } else if (m.type === 'read') {
      // The engine reuses a handle number for the same infohash, so a read that arrives after the
      // budget pass evicted its torrent would otherwise attach to whatever is added under it next.
      if (!handles.includes(m.handle)) {
        post({ type: 'read-error', id: m.id, error: 'torrent removed' })
        return
      }
      // wanting bytes is what puts a torrent back to work, whether or not the reader is a player
      wake(m.handle)
      lastReadAt.set(m.handle, Date.now())
      if (userPaused.has(m.handle) && !hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'torrent paused' })
        return
      }
      if (m.prioritize !== false) anchorSequential(m.viewer, m.handle, m.fileIndex, m.offset, m.len)
      else if (!hasBytes(m.handle, m.fileIndex, m.offset, m.len)) {
        post({ type: 'read-error', id: m.id, error: 'not downloaded' })
        return
      }
      let inFlight = readsByHandle.get(m.handle)
      if (!inFlight) readsByHandle.set(m.handle, inFlight = new Set())
      inFlight.add(m.id)
      try {
        // A read is the ONLY thing that re-plans priorities (anchorSequential is called from here
        // and nowhere else), so a read parked on a piece the plan does not cover freezes the plan
        // that starved it: a self-sustaining stall while the engine happily downloads elsewhere.
        // Retry in bounded attempts and force the plan forward between them.
        for (let attempt = 0; ; attempt++) {
          try {
            const data = await session.read(m.handle, m.fileIndex, m.offset, m.len, { timeoutMs: READ_ATTEMPT_MS })
            // failReads may have answered this id already while it was parked on pieces
            if (!inFlight.has(m.id)) return
            post({ type: 'read-result', id: m.id, data }, [data.buffer])
            return
          } catch (err) {
            if (!inFlight.has(m.id)) return
            if (attempt + 1 >= READ_ATTEMPTS || !/did not arrive/.test(String(err))) throw err
            const missing = missingPieces(m.handle, m.fileIndex, m.offset, m.len)
            post({
              type: 'read-stalled',
              id: m.id, handle: m.handle, fileIndex: m.fileIndex, offset: m.offset, len: m.len,
              waitedMs: (attempt + 1) * READ_ATTEMPT_MS,
              missing,
              cancelled: Math.min(missing.length, CANCEL_PER_STALL),
              downloadRate: session.status(m.handle)?.downloadRate ?? null,
              numPeers: session.status(m.handle)?.numPeers ?? null,
            })
            // Take the blocking pieces back from whatever peers are sitting on them.
            //
            // Nothing else does, and that is the whole reason a read can stall while the torrent
            // runs at full speed. Once every block of a piece is outstanding, libtorrent's rescue
            // for a late time-critical piece is gated behind `m_average_piece_time > 0`, which
            // stays 0 until a deadlined piece has completed ONCE, so it is inert for exactly the
            // first pieces of a file. `cancel_non_critical` would reclaim them but deliberately
            // skips pieces with a deadline, i.e. the ones playback is blocked on. And the sequential
            // walk cannot cover for it either: `piece_picker::pick_pieces` skips `top_priority`
            // pieces in its in-order loop, and a deadline sets exactly that priority, so the walk
            // steps over the window and downloads the rest of the file instead. That is what
            // "168 MB downloaded, still 0:00" is: the head is stranded, everything after it is not.
            //
            // Cancelling only drops OUTSTANDING requests, so no received block is thrown away, and
            // it is done after a full attempt has already elapsed rather than on a merely slow peer.
            for (const piece of missing.slice(0, CANCEL_PER_STALL)) {
              session.cancelPieceRequests(m.handle, piece)
            }
            // re-anchoring re-places the deadlines, so the next tick requests the freed blocks from
            // the fastest peers rather than the ones that just lost them
            if (m.prioritize !== false && m.viewer) watch(m.viewer, m.handle, m.fileIndex, m.offset)
          }
        }
      // the handle check keeps a torrent that was given up mid-read from leaving an entry behind
      } finally { inFlight.delete(m.id); if (handles.includes(m.handle)) lastReadAt.set(m.handle, Date.now()) }
    } else if (m.type === 'remove') {
      const ih = infoHashByHandle.get(m.handle)
      failReads(m.handle, 'torrent removed')
      session.removeTorrent(m.handle, !!m.deleteFiles)
      untrack(m.handle)
      if (ih) await removeFromList(ih)
    } else if (m.type === 'set-plan') {
      // Stored as well as applied, and that is the point rather than bookkeeping: the engine's copy
      // is overwritten by clearStreamWindow on the next restore, so a selection kept only there is
      // undone by a reload with nothing on screen to say so.
      const wanted = Array.isArray(m.wanted) ? m.wanted.map((n: unknown) => Number(n) | 0) : undefined
      const firstLast = m.firstLast === true
      planByHandle.set(m.handle, { wanted, firstLast })
      applyPiecePlan(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { wantedFiles: wanted, firstLast })
    } else if (m.type === 'set-folder') {
      // A page with a permitted handle offers it; a page that lost the grant offers null. Last one
      // wins, deliberately, because the newest offer is the one whose grant was checked most recently.
      folderHandle = (m.handle as FileSystemDirectoryHandle | null) ?? null
    } else if (m.type === 'set-location') {
      // intent only. The move that follows is decided by a page, which is the realm that can see
      // whether the torrent has finished and whether the folder is reachable right now.
      if (typeof m.infoHash === 'string') await patchList(m.infoHash, { saveTo: m.to === 'folder' ? 'folder' : 'browser' })
    } else if (m.type === 'relocate') {
      const ih = infoHashByHandle.get(m.handle)
      const to: SaveLocation = m.to === 'folder' ? 'folder' : 'browser'
      if (ih) await relocate(session, m.handle, ih, to)
    } else if (m.type === 'import-list') {
      const incoming: Persisted[] = Array.isArray(m.list) ? m.list : []
      let list: Persisted[] = []
      let changed = false
      await update<Persisted[]>(LIST_KEY, (prev) => {
        list = prev ?? []
        const have = new Set(list.map((e) => e.infoHash))
        for (const e of incoming) {
          if (!e || typeof e.infoHash !== 'string' || !e.magnet || have.has(e.infoHash)) continue
          // a library entry from another device, never a cache one: the cache is device-local and is not backed up
          list.push({ infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath || SHARED_ROOT, addedAt: e.addedAt || Date.now(), started: false, ephemeral: false })
          have.add(e.infoHash)
          changed = true
        }
        return list
      })
      if (changed) post({ type: 'list', list })
    } else if (m.type === 'start') {
      const e = (await loadList()).find((x) => x.infoHash === m.infoHash)
      if (e) {
        const savePath = e.savePath || SHARED_ROOT
        const bytes = (await get(torrentKey(e.infoHash))) as Uint8Array | undefined
        const h = bytes && bytes.byteLength
          ? session.addTorrentFile(bytes, savePath)
          : session.addMagnet(e.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That torrent could not be read' }); return }
        // Pressing Download is the user claiming this torrent, so it stops being cache. Without the
        // promotion an evicted item re-downloads straight back into the front of the eviction queue
        // and the button spends the user's metered quota in a loop.
        track(h, e.magnet, e.infoHash, savePath, false)
        // the entry is already in hand, so the ceiling it carries comes back with it. The piece plan
        // is NOT seeded here, which is a live bug of its own rather than a precedent to copy.
        wantLimits(h, { down: e.downloadLimit, up: e.uploadLimit })
        recovery.hold(h, Date.now())
        // post state before flipping the entry so the live row dedups the ghost in the same render
        post({ type: 'state', torrents: snapshot(), reachable: session!.reachable() })
        await upsertList({ ...e, started: true, paused: false, ephemeral: false, lastUsedAt: Date.now() })
      }
    } else if (m.type === 'remove-missing') {
      if (typeof m.infoHash === 'string') {
        const h = handles.find((x) => infoHashByHandle.get(x) === m.infoHash)
        if (h !== undefined) { failReads(h, 'torrent removed'); session.removeTorrent(h, true); untrack(h) }
        await removeFromList(m.infoHash)
      }
    } else if (m.type === 'clear-list') {
      // The list, its resume/torrent blobs AND the payload. This used to leave the bytes on disk so
      // that switching back to the account that owns them adopted the data instead of downloading
      // it again, but the list is the only record there is: once the entry is gone nothing can show
      // that data, restart it, export it or reclaim it, and it counts against the origin's budget
      // for good. The orphan sweep would take it minutes later regardless, so it goes here, at the
      // moment and for the reason a person could understand.
      for (const h of [...handles]) { failReads(h, 'torrent removed'); session.removeTorrent(h, true); untrack(h) }
      let dropped: Persisted[] = []
      await update<Persisted[]>(LIST_KEY, (prev) => { dropped = prev ?? []; return [] })
      for (const e of dropped) {
        await del(resumeKey(e.infoHash)).catch(() => {})
        await del(torrentKey(e.infoHash)).catch(() => {})
      }
      post({ type: 'list', list: [] })
    } else if (m.type === 'pause') {
      userPaused.add(m.handle)
      // whatever happens next, it is the user's decision now and not an idle cache torrent's
      cacheIdle.delete(m.handle)
      recovery.forget(m.handle)
      session.pauseTorrent(m.handle)
      failReads(m.handle, 'torrent paused')
      void persistResume(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: true })
    } else if (m.type === 'resume') {
      userPaused.delete(m.handle)
      cacheIdle.delete(m.handle)
      wantPaused.delete(m.handle)
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
      cacheIdle.delete(m.handle)
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
      // a move carrying a read length is a reader advancing, so it takes the same re-anchor test a read
      // takes; without one it is a user seek, which moves the anchor unconditionally
      if (m.readLen != null) anchorSequential(m.viewer, m.handle, m.fileIndex, m.fromOffset ?? 0, m.readLen)
      else watch(m.viewer, m.handle, m.fileIndex, m.fromOffset ?? 0)
    } else if (m.type === 'unwatch') {
      unwatch((viewer) => viewer === m.viewer)
    } else if (m.type === 'set-flags') {
      // The engine owns the result, not the caller: some combinations are refused and `paused` is
      // also driven by auto-management, so nothing is echoed back here. The next status broadcast
      // carries the torrent's real flags and the UI reads its checkboxes from that.
      session.setFlags(m.handle, m.flags >>> 0, m.mask >>> 0)
      // a flag change is worth persisting, and the engine sets need_save_resume for exactly that
      void persistResume(m.handle)
    } else if (m.type === 'reannounce') {
      session.forceReannounce(m.handle)
    } else if (m.type === 'queue-move') {
      session.moveInQueue(m.handle, m.where)
    } else if (m.type === 'set-limits') {
      // Stored as well as applied, for the same reason the piece plan is: the engine's copy does not
      // outlive the session, and a handle names a different torrent after a handover, so a ceiling
      // kept only in libtorrent's head is gone on the next reload with nothing on screen to say so.
      const down = isLimit(m.down) ? m.down : undefined
      const up = isLimit(m.up) ? m.up : undefined
      // only clear the pending flag when something was actually recorded, or a command carrying
      // nothing usable would drop a ceiling that a restore had queued and never applied yet
      if (wantLimits(m.handle, { down, up }) && session.status(m.handle)) {
        pendingLimits.delete(m.handle)
        applyLimits(m.handle)
      }
      const ih = infoHashByHandle.get(m.handle)
      if (ih) {
        const patch: Partial<Persisted> = {}
        if (down !== undefined) patch.downloadLimit = down
        if (up !== undefined) patch.uploadLimit = up
        if (Object.keys(patch).length) await patchList(ih, patch)
      }
    } else if (m.type === 'set-session-limits') {
      // The worker is the only writer of this key, deliberately. It runs on the same serialized
      // command lane as every other list mutation, so applying and persisting are one act and two
      // tabs cannot interleave a read-modify-write of it.
      if (isLimit(m.down)) sessionLimits.down = m.down
      if (isLimit(m.up)) sessionLimits.up = m.up
      session.setRateLimits({ download: sessionLimits.down, upload: sessionLimits.up })
      await set(RATE_LIMITS_KEY, { ...sessionLimits })
    } else if (m.type === 'inspect') {
      // a panel closing must clear this, or the engine keeps paying for a list nobody reads
      const next = typeof m.handle === 'number' ? m.handle : null
      if (next !== inspecting) {
        inspecting = next
        // the new subject's trackers are wanted immediately rather than up to TRACKER_POLL_MS later
        trackersPolledAt = 0
      }
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
