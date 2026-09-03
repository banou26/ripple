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
import { CHECKING_STATES, pauseLanded, createRecoveryTracker } from './recovery'
import { NO_INBOUND, countInbound } from './inbound'
import type { Totals, Uptime } from './uptime'

import { NO_TOTALS, NO_UPTIME, TOTAL_KEYS, accumulate, mergeTotals, sessionUptime, totalUptime, worthWriting } from './uptime'
import { isOriginFull, planEviction } from './storage-budget'
// aliased: `storage` at module scope here is the hybrid backend, and the ponyfill's is
// navigator.storage. Two different things that would otherwise want the same name.
import { storage as originStorage } from '@banou/ponyfill'
import { sweepProbes, sweepSaveRoot } from './opfs-sweep'
import { LIST_KEY, SHARED_ROOT, SYNCED_FILE_CAP, mergeEntry, ownsItsDirectory, resumeKey, savePathFor, staysEphemeral, syncedMetadata } from './library'
import { createHybridStorage, isGrantedSavePath, isSourceSavePath, sourceSavePathFor } from './hybrid-storage'
import { piecePlan, planIsDefault } from './piece-plan'
import { currentLocation, savePathIn } from './save-location'
import { RATE_LIMITS_KEY, isLimit, normalizeLimits } from './rate-limits'
import type { RateLimits } from './rate-limits'
import type { SourceRef } from './walk-source'

// the message channel is shared with @fkn/lib's socket relay, so a type missing here is dropped in silence
const OWN = new Set(['add-magnet', 'add-torrent-file', 'create-source', 'reserve-storage', 'start-source', 'read', 'cancel-read', 'remove', 'relocate', 'set-location', 'set-folder', 'set-plan', 'remove-missing', 'watch', 'unwatch', 'unwatch-owner', 'pause', 'resume', 'recheck', 'import-list', 'clear-list', 'start', 'retry', 'retry-now', 'flush-resume', 'inspect', 'set-flags', 'reannounce', 'queue-move', 'set-limits', 'set-session-limits', 'set-temporary'])

export type TorrentSnapshot = {
  handle: number
  /** Accumulated across sessions, unlike the engine's own counters on `status`. See uptime.ts. */
  uptime: Uptime
  /** Of that total, what THIS session contributed. Shown beside it, the way bytes already are. */
  sessionUptime: Uptime
  /** Every counter accumulated across sessions, bytes included. See uptime.ts. */
  totals: Totals
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

const torrentKey = (ih: string) => 'ripple:torrent:' + ih
/**
 * The handle a created torrent is read from. WRITTEN AND READ BY THE PAGE, never by this worker.
 *
 * Named here because `removeFromList` has to delete it, and a key that only one side knows about is
 * a key that outlives the thing it belongs to: a stale handle in IndexedDB holds a permission
 * reference to a folder for a torrent nobody has any more.
 */
const sourceKey = (ih: string) => 'ripple:source:' + ih
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
/**
 * The files each created torrent is served from, keyed by its save path, one handle per fileIndex.
 *
 * Kept here rather than in the storage backend for the same reason `folderHandle` is: a handle
 * arrives in a message and the backend is built once, before any of them exist. `hybrid-storage.ts`
 * explains at length why these are indexed rather than resolved by path.
 *
 * Not persisted from this side. The page owns the durable copy, because regaining a lapsed grant
 * needs a user gesture and a worker has none.
 */
/**
 * Per created torrent, one entry per file in the TORRENT's order, `null` at every pad file.
 *
 * The nulls hold their positions rather than being filtered out. libtorrent indexes a read by
 * position in its own file list, which carries the pads a hybrid or v2 torrent inserts, so a dense
 * array of real handles would serve one file's bytes for another from the first pad onward, with
 * nothing reporting an error and every piece failing.
 */
const sourceHandles = new Map<string, (SourceRef | null)[]>()
let readyPosted = false
const handles: number[] = []
const magnetByHandle = new Map<number, string>()
const infoHashByHandle = new Map<number, string>()
const savePathByHandle = new Map<number, string>()
// The paused flag of the blob last written for each handle, so a settled torrent is snapshotted
// once per pause state rather than once per torrent. See the pump for why that distinction matters.
const resumeSaved = new Map<number, boolean>()
const userPaused = new Set<number>()
/*
 * What Ripple wants the engine's pause flag to be, for torrents it has not been able to tell yet.
 *
 * libtorrent only takes commands for handles it has registered, which happens the first time its
 * alerts are pumped, so anything issued during the restore is silently discarded. Both directions
 * are recorded, because a resume blob carries libtorrent's `paused` flag and restores it on add:
 * without `wantStarted`, a torrent that was paused when its blob was written comes back stopped
 * with nothing in Ripple recording that it should be, and ten seconds later `recovery` reads that
 * as a failure. The library entry is the record of what the user chose, so it is what decides here
 * and the blob never does.
 */
const wantPaused = new Set<number>()
const wantStarted = new Set<number>()
// the two are opposites, so recording one always withdraws the other
const wantPause = (h: number) => { wantStarted.delete(h); wantPaused.add(h) }
const wantStart = (h: number) => { wantPaused.delete(h); wantStarted.add(h) }
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
      // the ACCUMULATED totals, not the engine's session-only counters; see uptime.ts
      uptime: uptimeOf(h),
      // and what this session put into them, so the panel can read "total (x this session)"
      sessionUptime: sessionUptimeOf(h),
      // the accumulated byte counters, for the same reason the seconds are accumulated: libtorrent's
      // own survive only in a resume blob a finished torrent stops being given
      totals: totalsOf(h),
    }
  })

/**
 * This torrent's run time across every session: what was stored, plus what this session has added.
 *
 * Computed on every broadcast rather than kept as a counter, because the engine's reading is the one
 * moving part and reading it is free. Written back to the library on a much slower cadence, since
 * the number on screen comes from here and only a crash can lose the difference.
 */
const uptimeOf = (h: number) => {
  const now = session?.status(h)
  const atAdd = uptimeAtAdd.get(h)
  if (!now || !atAdd) return uptimeStored.get(h) ?? NO_UPTIME
  return totalUptime(uptimeStored.get(h), atAdd, now)
}

/*
 * What this session has added, sent alongside the total so the panel can show both.
 *
 * NO_UPTIME before the torrent has been added, which is honest rather than a placeholder: with no
 * reading at add time there is no delta to take, and the engine's own figure is not the answer
 * because a resume blob may have restored seconds that belong to earlier sessions.
 */
const sessionUptimeOf = (h: number) => {
  const now = session?.status(h)
  const atAdd = uptimeAtAdd.get(h)
  return now && atAdd ? sessionUptime(atAdd, now) : NO_UPTIME
}

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
  await del(sourceKey(ih)).catch(() => {})
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
 * How often every torrent is asked for its peer list, for the live inbound count on the strip.
 *
 * Not the 500ms broadcast, which is what the INSPECTED torrent's peers ride. This asks every torrent
 * in the library, and a peer list is fifteen fields per peer: a library of thirty torrents with forty
 * peers each is over a thousand records crossing the wasm boundary per pass, to produce two small
 * integers. Two seconds is far inside how fast anybody reads a strip cell, and the last answer is
 * held between polls so the number never blinks.
 *
 * `peers()` posts a request and the answer lands with the next alert pump, so this is a post per
 * torrent rather than a synchronous read; `lastPeers` below reads whatever arrived.
 */
const PEER_POLL_MS = 2_000
let peersPolledAt = 0
let inboundNow = NO_INBOUND

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
  wantPaused.delete(h); wantStarted.delete(h); resumeRetry.delete(h)
  viewers.delete(h); pendingViewing.delete(h); needsPriorityReset.delete(h); planByHandle.delete(h)
  limitsByHandle.delete(h); pendingLimits.delete(h); pendingFlags.delete(h)
  uptimeAtAdd.delete(h); uptimeStored.delete(h)
  totalsAtAdd.delete(h); totalsStored.delete(h)
  ephemeralHandles.delete(h); cacheIdle.delete(h); lastReadAt.delete(h); needsRootEntry.delete(h)
}

// A read or a viewer means someone wants these bytes now, so an idle-paused cache torrent goes back
// to work. Without this a paused torrent would park a read on pieces that can never arrive.
const wake = (h: number) => {
  if (!cacheIdle.delete(h)) return
  wantStart(h)
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
 * Flag words to set once the engine has actually registered the handle.
 *
 * MEASURED IN THE ENGINE'S OWN SOURCE, because this reads like belt and braces and is not. In
 * `libtorrent-wasm`'s `wrapper.cpp`, `lt_torrent_set_flags` calls `lookup_handle(id)` and returns
 * -1 doing nothing when the id is not there, `register_handle` has exactly ONE call site, inside
 * `lt_session_pump_alerts` on `add_torrent_alert`, and the JS wrapper discards the return value. So
 * `setFlags` immediately after an add is a SILENT no-op: no throw, no console line, nothing.
 *
 * The same rule `pendingLimits` above exists for, and the same rule stated at `wantPaused`. It
 * matters most for `uploadMode`, which is the one thing standing between a read-only backend and a
 * write it must refuse, and a refused write reaches libtorrent as a fatal disk error.
 */
const pendingFlags = new Map<number, { flags: number, mask: number }>()

/**
 * What the engine's own run timers read when each torrent was added, and the totals last written.
 *
 * The first is what makes the accumulation a DELTA rather than a sum: a torrent restored from a
 * resume blob starts this session with libtorrent's counters already advanced, and the stored total
 * already contains those seconds. `uptime.ts` carries the argument.
 */
/**
 * How often the accumulated counters are allowed to reach the cloud.
 *
 * Not a display cadence: the numbers on screen come from the snapshot twice a second either way.
 * This only decides how often a whole-library upload is armed on behalf of figures that changed
 * without anything else changing. See the broadcast at the end of the persist loop.
 */
const COUNTER_BROADCAST_MS = 5 * 60_000
let lastCounterBroadcast = 0

const uptimeAtAdd = new Map<number, { activeSeconds: number, seedingSeconds: number }>()
const uptimeStored = new Map<number, { activeSeconds: number, seedingSeconds: number }>()

/*
 * The same two maps for the BYTE counters, kept apart from the seconds only because the seconds were
 * here first and are read by more places.
 *
 * `readingOf` is what makes the two comparable: libtorrent names these `allTimeDownload` and
 * `allTimeUpload` on its status, and the accumulator wants them under the names the library entry
 * uses, so the rename happens once here rather than at each of the four call sites.
 */
const totalsAtAdd = new Map<number, Totals>()
const totalsStored = new Map<number, Totals>()

const readingOf = (st: {
  activeSeconds: number, seedingSeconds: number, allTimeDownload: number, allTimeUpload: number, wasted: number,
}): Totals => ({
  activeSeconds: st.activeSeconds,
  seedingSeconds: st.seedingSeconds,
  downloaded: st.allTimeDownload,
  uploaded: st.allTimeUpload,
  wasted: st.wasted,
})

/** What an entry has stored, in the accumulator's shape. Absent fields are zero, not unknown. */
const storedTotals = (e: Partial<Persisted> | undefined): Totals => ({
  activeSeconds: e?.activeSeconds ?? 0,
  seedingSeconds: e?.seedingSeconds ?? 0,
  downloaded: e?.downloaded ?? 0,
  uploaded: e?.uploaded ?? 0,
  wasted: e?.wasted ?? 0,
})

const totalsOf = (h: number): Totals => {
  const now = session?.status(h)
  const atAdd = totalsAtAdd.get(h)
  if (!now || !atAdd) return totalsStored.get(h) ?? NO_TOTALS
  return accumulate(totalsStored.get(h), atAdd, readingOf(now))
}

const wantFlags = (h: number, flags: number, mask: number) => {
  const already = pendingFlags.get(h)
  // merged rather than replaced, so two callers before the first pump do not silently cancel
  pendingFlags.set(h, already
    ? { flags: (already.flags & ~mask) | (flags & mask), mask: already.mask | mask }
    : { flags: flags & mask, mask })
}

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
  /*
   * A created torrent never gets a resume blob.
   *
   * It has nothing to remember: it holds every byte from the moment it is added, and the have-set is
   * rediscovered by hashing the source, which is reads alone. What a blob WOULD carry is a paused
   * flag and a piece map describing somebody's own files, and both are liabilities. The restore path
   * for one of these is a fresh add behind a fresh permission grant, so a blob could only ever be
   * consulted in the one case it must not be: after the source moved.
   */
  if (isSourceSavePath(savePathByHandle.get(h))) return false
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

/**
 * `held` is a claim on the TORRENT without a claim on its bytes.
 *
 * A download page registers one for as long as it is open, so the budget pass can see that somebody
 * has this torrent in front of them, while the priority map and the idle pause still behave as
 * though nobody is watching. Without it the page's own torrent becomes an ordinary eviction
 * candidate fifteen seconds after it is added, and evicting it untracks the handle, which the page
 * cannot come back from: its add runs once per magnet and the row it was showing simply stops
 * existing.
 */
/**
 * `bulk` marks a claim that wants THROUGHPUT rather than low latency: a save to disk or a zip, as
 * opposed to playback. It decides whether this torrent gets piece deadlines, and that is worth far
 * more than it sounds. A deadline enlists libtorrent's time-critical rescue, which races several
 * peers for the same block and discards every copy that loses. MEASURED 2026-09-02 on a 1446 MB
 * torrent through the download page: 879 MB wasted and 1.617x the payload fetched with deadlines,
 * 8 MB and 1.011x without, the latter being exactly what the same torrent costs as a library add.
 * On a metered relay the user pays for both copies.
 */
type Viewer = { fileIndex: number, fromOffset: number, held?: boolean, bulk?: boolean }
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

/**
 * The claims that are actually asking for bytes.
 *
 * A held claim keeps the torrent alive without wanting any of it, so every priority and pause
 * decision is made from these alone and a page that is only holding reads exactly like no page at
 * all. Anything asking "is this torrent in front of somebody", the eviction pass above, reads
 * `viewers` instead, which is the whole point of the distinction.
 */
const activeViewers = (h: number): Viewer[] => {
  const watching = viewers.get(h)
  return watching ? [...watching.values()].filter((v) => !v.held) : []
}

const applyViewing = (h: number) => {
  if (!session) return
  // a handle the engine no longer has is not a torrent with no viewers, it is not a torrent at all;
  // parking it in pendingViewing would retry it on every pump for the life of the session
  if (!handles.includes(h)) { viewers.delete(h); pendingViewing.delete(h); return }
  const active = activeViewers(h)
  if (!active.length) {
    // back to an ordinary download: default priority everywhere, no deadlines, sequential off.
    // This is also what takes the skip mask off before it can be written into resume data.
    /*
     * Wait for the file layout before doing any of this.
     *
     * NOT for safety. An earlier version of this comment claimed
     * `lt_torrent_clear_piece_deadlines` walks the piece list and that the engine's own
     * `prioritizePieces` is layout-guarded for the same reason. Both are false, and the correction
     * is worth keeping because the false version reads like a rule somebody would apply elsewhere:
     * the C export reads no geometry at all (`wrapper.cpp`, no `geometry_for`, unlike
     * `reset_piece_deadline` and `prioritize_pieces` beside it), and `prioritizePieces` is guarded
     * only because it has to size `new Uint8Array(layout.numPieces)`. Calling this before metadata
     * is inert, not a trap.
     *
     * It is here for BEHAVIOUR. A download page registers a HELD claim the moment its handle
     * exists, which is before metadata, and a held claim is not an active viewer, so this branch
     * runs at `watch` time. Without the wait it would run once, drop the handle from
     * `pendingViewing`, and never come back, so the ephemeral idle-park below would never happen
     * for that torrent and a cache entry nobody is watching would keep downloading.
     *
     * Deferring instead is what the claimed path below already does: the pump re-runs everything in
     * `pendingViewing`, so this lands on the first pass after the metadata arrives.
     */
    if (!session.files(h)) { pendingViewing.add(h); return }
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
    //
    // Never before the layout has landed, though: a paused torrent connects to nobody, so parking
    // one that is still fetching its metadata stops it ever getting any. Every other caller of this
    // branch already has metadata by construction; a held claim registered the moment a handle
    // exists does not, and that is the one that would have hung the page it was protecting.
    if (ephemeralHandles.has(h) && !userPaused.has(h) && !cacheIdle.has(h)) {
      cacheIdle.add(h)
      wantPause(h)
      session.pauseTorrent(h)
      void persistResume(h)
    }
    return
  }
  wake(h)
  const files = session.files(h)
  if (!files) { pendingViewing.add(h); return }
  const claims = active.map(({ fileIndex, fromOffset }) => ({ fileIndex, offset: fromOffset }))
  // Skipping the unwatched files is not a bandwidth optimization: libtorrent's sequential cursor
  // sits at the first piece the torrent does not have, so without it the capacity beyond the
  // deadline window goes to the first file in the torrent rather than the one being watched.
  //
  // The window is sized from the piece length, not fixed: the band is picked in shuffled order and
  // the in-order walk skips it, so it wants to be barely wider than one demuxer read.
  //
  // Deadlines only when somebody is WAITING on one. `bulk` claims are saves and zips, which want the
  // priorities and the sequential order and nothing else; see the note on `Viewer`. Every active
  // claim has to agree, because one player watching the same torrent is enough to make the clock
  // real, and the priorities the window writes are shared by all of them.
  const timed = active.some((viewer) => !viewer.bulk)
  const planned = session.setStreamWindow(h, claims, {
    unclaimedPriority: PRIORITY.skip,
    windowPieces: windowPiecesFor(files.pieceLength),
    deadlineStepMs: deadlineStepMsFor(files.pieceLength, session.status(h)?.downloadRate || 3_000_000),
    deadlines: timed,
  })
  if (planned) pendingViewing.delete(h)
  else pendingViewing.add(h)
}

/**
 * Stop a torrent that was just added, the way pressing Pause stops one.
 *
 * Writing `paused: true` into the library entry alone is not enough and the gap is not cosmetic: the
 * entry only decides what a RESTORE does, so until the next reload the torrent would sit there
 * downloading with a row that says it is stopped. The engine has to be told, `recovery` has to be
 * told this is a deliberate stop rather than one it should retry, and `wantPause` has to record it
 * because `lt_torrent_pause` is a silent no-op against a handle the alert pump has not registered
 * yet, which is exactly the window an add is in.
 */
const pauseAdded = (h: number) => {
  userPaused.add(h)
  cacheIdle.delete(h)
  wantPause(h)
  recovery.forget(h)
  session?.pauseTorrent(h)
}

const watch = (viewer: string, h: number, fileIndex: number, fromOffset: number, held = false, bulk?: boolean) => {
  // A read is dispatched without waiting on the command queue, so one issued against a torrent the
  // budget pass has just evicted arrives here afterwards. Recreating the entry would resurrect a
  // dead handle, and the engine reuses a handle number for the same infohash, so the entry would
  // then attach to whatever is added under it next.
  if (!handles.includes(h)) return
  let watching = viewers.get(h)
  const first = !watching?.size
  if (!watching) viewers.set(h, watching = new Map())
  // Carried forward when the caller does not say, because the re-anchor path does not: every 8 MiB
  // chunk of an export calls this through `anchorSequential` with no flag, and a claim that forgot
  // it was bulk would put the deadlines straight back and take the waste with them.
  const kind = bulk ?? watching.get(viewer)?.bulk
  // `held: undefined` rather than `false`, so the entry a real claim writes is shaped exactly as it
  // was before holds existed and nothing downstream has to know the difference
  watching.set(viewer, {
    fileIndex,
    fromOffset,
    ...(held ? { held } : {}),
    ...(kind ? { bulk: kind } : {}),
  })
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
  // `current.held` too: a read IS the reader asking for bytes, so a claim that was only holding the
  // torrent has to be promoted here. Without it a read landing on the file the hold happened to name
  // takes the re-anchor test instead, keeps the claim held, and the swarm is never planned around a
  // download that has already started.
  if (!current || current.held || current.fileIndex !== fileIndex) { watch(viewer, h, fileIndex, offset); return }
  const r = filePieceRange(h, fileIndex)
  if (!r) return
  const span = { fileOffset: r.file.offset, pieceLength: r.pieceLength, p1: r.p1 }
  if (!shouldReanchor(span, current.fromOffset, offset, len)) return
  watch(viewer, h, fileIndex, offset)
}

// the directory existing is the signal, not what is inside it: OPFS creates the save path on add but its files only on the first write; on any error assume data is present
/**
 * Whether the origin still holds the bytes the library says it does, used to notice that a browser
 * cleared OPFS out from under the app.
 *
 * ONLY OPFS PATHS COUNT, and "no OPFS paths at all" is not evidence of anything. A `/native` or
 * `/source` path never exists in OPFS by construction: those bytes are in the user's own folder, or
 * are their own files that Ripple only reads. So a library made entirely of those would report
 * false, the restore loop would read that as cleared storage, and it would delete every resume blob
 * and set every entry to `started: false`: a whole library switched off by a check that was right
 * about OPFS and wrong about the question.
 *
 * That is reachable today with a library of folder-located torrents, and becomes the ordinary first
 * run once somebody can create a torrent from their own files and have nothing else. Returning true
 * when there is nothing to ask about is the safe direction: the cost of a false "not cleared" is one
 * torrent that has to recheck, and the cost of a false "cleared" is the library.
 */
const opfsHasData = async (savePaths: string[]): Promise<boolean> => {
  const opfsPaths = savePaths.filter((sp) => !isGrantedSavePath(sp))
  if (!opfsPaths.length) return true
  try {
    const root = await navigator.storage.getDirectory()
    for (const sp of new Set(opfsPaths)) {
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
    /**
     * `@banou/ponyfill` rather than `navigator.storage`, and this is the reader that matters most:
     * `planEviction` decides from it. The browser's own usage figure came back as 752 bytes for a
     * verified 1.78 GB on Chrome 151, which would have the budget pass conclude there is room
     * forever. What happens then is not a full disk, it is a write failing with QuotaExceededError,
     * which opfs-storage classifies as fatal and stops the torrent.
     */
    const { usage, quota } = await originStorage.estimate()
    // an unknown quota is not a full disk; use-storage-usage.ts guards the page side the same way
    if (!quota || usage === undefined) return null
    return { usedBytes: usage, limitBytes: quota }
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
  // Carried across the re-add for the same reason `wasPaused` is. `track` defaults it to false, so
  // a moved cache torrent used to come back as a library one in the engine while the list still had
  // it as cache: it stopped being idle-parked, and the budget pass went on treating it as an
  // eviction candidate, which is a torrent that looks kept and is deleted anyway.
  const wasEphemeral = ephemeralHandles.has(h)

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
  track(next, magnet, ih, savePath, wasEphemeral)
  // Upload only, for a folder. There is no way to write there that is safe for the user's own files,
  // so a torrent that could ask for a piece would eventually ask this backend to write and be
  // refused, which reaches libtorrent as a fatal disk error.
  // Recorded rather than set, for the reason `pendingFlags` gives: a flag word set before the engine
  // has pumped the add alert is discarded, silently. This line used to call setFlags directly and
  // therefore never applied, which left a folder-located torrent free to request a piece and ask a
  // read-only backend to write it.
  if (to === 'folder') wantFlags(next, TORRENT_FLAG.uploadMode, TORRENT_FLAG.uploadMode)
  if (wasPaused) { userPaused.add(next); wantPause(next) } else wantStart(next)
  recovery.hold(next, Date.now())
  // no message of its own: patchList broadcasts the list, and the next state tick carries the new
  // handle, so every tab learns about the move through the two channels it already watches
  await patchList(ih, { savePath, saveTo: to, started: true })
}

/**
 * Add a torrent that is served from the user's own files, and make it upload only.
 *
 * The order matters in two places. The handles are registered BEFORE the add, because the engine
 * constructs the torrent's storage inside that call and `onNewStorage` looks them up there. And
 * `uploadMode` is set immediately after, before the first alert pump, exactly as `relocate` does it:
 * this backend refuses every write by construction, so a torrent that could still request a piece
 * would eventually ask it to write and be refused, and a refused write reaches libtorrent as a fatal
 * disk error rather than as a skipped piece.
 */
const addSource = (
  live: Session,
  { infoHash, magnet, bytes, handles, paused }:
  { infoHash: string, magnet: string, bytes: Uint8Array, handles: (SourceRef | null)[], paused: boolean },
): number | null => {
  const savePath = sourceSavePathFor(infoHash)
  sourceHandles.set(savePath, handles)
  const h = live.addTorrentFile(bytes, savePath)
  if (addFailed(h)) { sourceHandles.delete(savePath); return null }
  track(h, magnet, infoHash, savePath, false)
  wantFlags(h, TORRENT_FLAG.uploadMode, TORRENT_FLAG.uploadMode)
  if (paused) { userPaused.add(h); wantPause(h) }
  recovery.hold(h, Date.now())
  return h
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
  const full = isOriginFull(space)
  if (full === storageFull) return
  storageFull = full
  post({ type: 'storage-full', full, usedBytes: space.usedBytes, limitBytes: space.limitBytes })
}

// Slow on purpose: this walks directories and its whole job is tidying, so it is never in the way
// of a download. It also runs from the budget pass when the origin is full, because bytes nothing
// owns are the one thing there that can always be given back.
const SWEEP_INTERVAL_MS = 10 * 60_000
const SWEEP_FIRST_MS = 60_000

/**
 * Save directories a page is WRITING into and the sweep must not touch.
 *
 * The orphan sweep deletes any hash-named child of the save root that no list entry and no live
 * handle claims (`planSweep`, `opfs-sweep.ts:65`, recursively, with failures swallowed). That is
 * exactly the state a created torrent's directory is in while its bytes are being copied in: the
 * copy happens BEFORE the add, so for the whole of it there is no entry and no handle.
 *
 * Without this, any pick that takes longer than a minute to copy can have its directory deleted out
 * from under it mid-write, and a multi-gigabyte copy is also precisely what makes the budget pass
 * call the origin full and run an extra sweep. The window is minutes, not milliseconds; a small
 * fixture never sees it.
 *
 * IN MEMORY on purpose. A tab that dies mid-copy loses its reservation, and the partial directory it
 * left behind then IS an orphan and should be reclaimed. Held by the page rather than inferred, and
 * re-asserted after a handover, because a new leader's worker starts with an empty set.
 */
const reservedHashes = new Set<string>()

let sweepRunning = false
const runOrphanSweep = async (): Promise<number> => {
  if (!session || sweepRunning) return 0
  sweepRunning = true
  try {
    const list = await loadList()
    const listedHashes = new Set(list.map((e) => e.infoHash.toLowerCase()))
    for (const ih of reservedHashes) listedHashes.add(ih.toLowerCase())
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
  /*
   * The last thing this pass actually measured, reported in `finally` rather than at the end.
   *
   * `reportSpace` used to sit on the happy path alone, and there are three ways out above it: an
   * origin that cannot be measured, a delete whose effect cannot be read back, and a throw anywhere
   * in the pass. All three skipped the one call that raises "Out of storage space", which is the
   * notice a player shows instead of stalling with nothing on screen. A pass that fails part way is
   * exactly when a full origin most needs saying, so the report is owed on every exit that still
   * knows an honest figure.
   */
  let measured: Space | null = null
  try {
    let space = await measureSpace()
    if (!space) return
    measured = space
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
      /*
       * From HERE until the delete is read back, nothing knows the origin's state, so there is no
       * honest figure to report and `measured` says so.
       *
       * Clearing it after `evict` instead would leave a real hole rather than a theoretical one:
       * `releaseStorage` awaits `patchList`, which is an IndexedDB read-modify-write, which is
       * exactly the kind of write that fails on a full origin. A throw there escapes to the catch
       * with the bytes ALREADY gone and the pre-delete figure still in hand, and `finally` would
       * then announce a full origin having just given up a torrent's worth of bytes: the one thing
       * the note on `reportSpace` says it must never do.
       */
      measured = null
      await evict(live, h, next)
      const after = await settleAfterDelete(before)
      // the delete landed and its effect cannot be read back, so there is still nothing honest to say
      if (!after) return
      space = after
      measured = after
    }
    // Out of torrents it may give up, but bytes nothing owns are always fair game and are exactly
    // what an account switch leaves behind, so sweep before calling the origin full.
    if (isOriginFull(space) && await runOrphanSweep()) {
      space = (await settleAfterDelete(space.usedBytes)) ?? space
    }
    measured = space
  } catch (err) {
    console.error('[worker] storage budget pass failed', String(err))
  } finally {
    budgetPassRunning = false
    if (measured) reportSpace(measured)
  }
}

const init = async () => {
  const origErr = console.error.bind(console)
  console.error = (...args: any[]) => { origErr(...args); try { post({ type: 'worker-error', args: args.map(String) }) } catch {} }

  if (!(await opfsAvailable())) {
    post({ type: 'storage-unavailable' })
    return
  }

  /**
   * The library, sent before the engine exists, because it does not need the engine.
   *
   * MEASURED, and the gap is the whole reason this line is here. On a reload the list is readable
   * from IndexedDB in ONE millisecond, and it used to be posted at 1555ms because it sat behind
   * `createSession`. That call is not slow for the reason it looks: the engine chunk fetches in 13ms
   * and the wasm compiles in about 115, while the remaining ~1.36 SECONDS is the relay port
   * reservation, two round trips to whichever region the tunnel landed in.
   *
   * The engine genuinely has to wait for that: libtorrent snapshots a listen socket's endpoint
   * between bind and listen and never refreshes it, so a port discovered later can never be
   * announced, which is why the reservation happens up front rather than in the background. The
   * LIBRARY has no such excuse, so it goes out now and the rows render while the engine is starting.
   *
   * Deliberately not awaited. Nothing on the path to `ready` may block: every command in every tab
   * parks behind that message, so a slow or broken IndexedDB here must cost a late list and nothing
   * else.
   */
  void loadList()
    .then((list) => { if (list.length) post({ type: 'list', list }) })
    .catch(() => { /* the post-restore list below is the second chance */ })

  // Started before the session is built so the read overlaps the wasm load, and bounded, because
  // nothing on the path to `ready` may hang: every command in every tab parks behind that message,
  // so a blocked IndexedDB here would freeze the whole app rather than merely lose a setting. A
  // timeout means unlimited, which is the same thing a first run means.
  const storedLimits = Promise.race([
    get(RATE_LIMITS_KEY).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2_000)),
  ])

  // persistent storage is asked for on the main thread, in use-storage-usage.ts: a worker's StorageManager has no persist
  storage = createHybridStorage(createResilientStorage(), () => folderHandle, (savePath) => sourceHandles.get(savePath) ?? null)
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
      /*
       * A created torrent is NOT added here, whatever its entry says.
       *
       * It can only be read through a permission grant that does not survive a reload, and regaining
       * one needs a user gesture, which a worker does not have. Adding it before the grant is back
       * would not degrade, it would go actively wrong: the first read throws, and native reads do not
       * pass through the retry guard in `createResilientStorage` (that wraps the OPFS delegate only),
       * so the throw reaches libtorrent as a FATAL disk error. `recovery` then latches that error
       * text and renders a red retrying row on a backoff up to five minutes, about a torrent where
       * nothing is wrong except that nobody has clicked Allow yet.
       *
       * So the page owns starting these: it holds the stored handle, it can ask for the grant, and it
       * sends `start-source` once it has one.
       */
      if (e.saveTo === 'source') continue
      const savePath = e.savePath || SHARED_ROOT
      const resume = (await get(resumeKey(e.infoHash)))
      const bytes = (await get(torrentKey(e.infoHash)))
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
      uptimeStored.set(h, { activeSeconds: e.activeSeconds ?? 0, seedingSeconds: e.seedingSeconds ?? 0 })
      totalsStored.set(h, storedTotals(e))
      /*
       * The ENTRY decides, both ways.
       *
       * A resume blob carries libtorrent's own `paused` flag and `addTorrentWithResume` restores
       * it, so a torrent that was stopped when its blob was written comes back stopped. That is
       * right for a pause the user asked for and wrong for every other kind: an idle-parked cache
       * torrent, or one parked and later kept, has `paused: false` in the list and a paused blob on
       * disk, and nothing here used to reconcile the two. Ten seconds later, exactly the hold
       * placed below, `recovery` read that as a torrent that had stopped on its own.
       *
       * Ephemeral entries are started too rather than left as they are. `applyViewing` re-parks
       * them on the first pump that has their layout, which costs a fraction of a second of
       * downloading, and it needs them running to get that layout at all: a paused torrent
       * connects to nobody, so one restored paused with no metadata could never fetch any and
       * would sit stopped for the life of the session.
       */
      if (e.paused) { userPaused.add(h); wantPause(h) } else wantStart(h)
      recovery.hold(h, Date.now())
    }
    if (changed) await set(LIST_KEY, list)
  } catch (err) { console.error('[worker] restore failed', err) }

  // ready posts before any IndexedDB read: a blocked or corrupted list read would leave every command queued behind a promise that never settles
  post({ type: 'ready' })
  readyPosted = true
  post({ type: 'list', list: await loadList().catch(() => []) })

  // One state straight away, because the interval below fires at 500ms and every restored torrent
  // would otherwise spend that half second on screen as a row with no numbers in it. The alerts have
  // not been pumped yet, so some statuses are still null here; that is exactly the state a row is
  // built to render, and the next tick fills them in.
  post({ type: 'state', torrents: snapshot(), reachable: session.reachable(), inboundNow, rateLimits: { ...sessionLimits } })

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
      // to be stopped here too, or every reload restarts the whole set at full speed.
      //
      // ACTIVE viewers, because a download page holds a claim from the moment its handle exists and
      // a plain size check would read that as "somebody is watching" and skip the very pass the
      // hold was asked for.
      if (!activeViewers(h).length) applyViewing(h)
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
    /*
     * The engine's run timers as they were when this torrent joined the session.
     *
     * Captured here rather than at the add, for the reason `pendingLimits` above is: a status does
     * not exist until the alert pump registers the handle. Everything after this is a delta against
     * it, which is what keeps a resume-restored counter from being counted a second time.
     */
    for (const h of handles) {
      if (uptimeAtAdd.has(h)) continue
      const st = session.status(h)
      if (!st) continue
      uptimeAtAdd.set(h, { activeSeconds: st.activeSeconds, seedingSeconds: st.seedingSeconds })
      // the byte counters rebase on the same pump and for the same reason: without a reading from
      // the moment this torrent joined, everything it moves before the first persist is lost
      totalsAtAdd.set(h, readingOf(st))
    }

    // Same gate, same reason, and see `pendingFlags` for why a flag set at add time never landed.
    // Safe to arrive a pump late: a torrent whose files are already on disk spends that pump
    // checking them, and a check neither downloads nor writes.
    for (const [h, want] of [...pendingFlags]) {
      if (!session.status(h)) continue
      pendingFlags.delete(h)
      session.setFlags(h, want.flags >>> 0, want.mask >>> 0)
    }

    /*
     * Metadata lands here, once, and is written to the library entry.
     *
     * `rootEntry` is what the torrent occupies inside its save path, so the orphan sweep can
     * account for it later even when it is no longer in the session to be asked. The rest is what
     * the torrent IS, and it is recorded for a reader that has no engine: another device signed
     * into the same account restores the list from the cloud and has only the magnet, so without
     * this its rows show eight hex characters and a size of zero.
     */
    for (const h of [...needsRootEntry]) {
      const [name] = rootEntriesOf(h)
      if (!name) continue
      needsRootEntry.delete(h)
      const ih = infoHashByHandle.get(h)
      if (!ih) continue
      const files = session.files(h)
      void patchList(ih, {
        rootEntry: name,
        name,
        /*
         * CONTENT bytes. `totalSize` is what the pieces cover, pads included, and this used to
         * write that over the content total `create-source` had already stored. A created hybrid
         * torrent then failed its own size check on the next load, threw inside `startFrom`, and sat
         * at "needs access" forever with the Allow button doing nothing and saying nothing.
         */
        size: files?.contentSize,
        /*
         * Capped, because this is mirrored into ONE json blob holding the whole library and a
         * torrent with thousands of files would dominate it. A reader must therefore treat a list
         * of exactly the cap as possibly incomplete, which is why `size` is stored separately
         * rather than summed from the list: the total stays right even when the list is cut.
         */
        // pads excluded: this list is read by people and by other devices, never by index
        files: files?.files.filter((f) => !f.pad).slice(0, SYNCED_FILE_CAP).map((f) => ({ name: f.path, size: f.size })),
        // Announced, not quiet. It was quiet while this wrote only rootEntry, which nothing renders
        // and no other device reads. It now carries the name, size and file list, and the cloud
        // write is scheduled off this broadcast: without it the metadata sits on disk until the
        // next page load, which is exactly the device that already knew it.
      }).catch(() => {})
    }

    for (const h of wantPaused) {
      const st = session.status(h)
      /*
       * A CHECK reports itself paused, and that is not the pause being asked for here.
       *
       * Without this guard the want is satisfied by the check and dropped, so nothing pauses the
       * torrent when the check finishes and it starts up: somebody's stopped torrent quietly begins
       * uploading again. Every restored torrent that has no resume blob checks, so this is not an
       * exotic path. Same reading of the same flag as `CHECKING_STATES` in recovery.ts, which is
       * where the constant lives.
       */
      if (!st || CHECKING_STATES.has(st.state)) continue
      /*
       * QUEUED IS NOT PAUSED, and reading it as such loses the pause.
       *
       * libtorrent's own queue parks whatever sits past its active limits, and a parked torrent
       * reports `paused` with `autoManaged` still set. Ripple's pause clears auto-management, so
       * `paused && !autoManaged` is the shape being asked for while `paused && autoManaged` is the
       * queue, which libtorrent unparks again a tick later. `snapshotState` draws that exact line to
       * render the Queued badge.
       *
       * Treating a queue park as satisfying the want drops it, and then nothing pauses the torrent
       * when the queue starts it again: the row goes back to Downloading on its own. Same shape as
       * the check above, where a torrent reporting itself paused mid-hash is not the pause either.
       */
      if (pauseLanded(st)) wantPaused.delete(h)
      else session.pauseTorrent(h)
    }
    for (const h of wantStarted) {
      // Stopped on purpose since the want was recorded, so the want is stale. Asked here rather
      // than withdrawn at every pause site, so this reads from the same two sets `recovery.observe`
      // is given below and cannot drift from them.
      if (userPaused.has(h) || cacheIdle.has(h)) { wantStarted.delete(h); continue }
      const st = session.status(h)
      // nothing can be told to a handle the engine has not registered yet, and a check reports
      // itself paused without that being something to correct: wait it out rather than resuming
      // twice a second for as long as the hashing takes
      if (!st || CHECKING_STATES.has(st.state)) continue
      if (!st.paused) { wantStarted.delete(h); continue }
      /*
       * Auto-management off and no error is the shape a stale blob comes back in, MEASURED: a
       * torrent restored from a blob written while it was parked reports `paused` with
       * `autoManaged` false and an empty error. Only that shape is corrected here.
       *
       * The other two are not Ripple's to undo. libtorrent's queue parks whatever sits past its
       * active limits and starts it again itself, so resuming that would fight it every half second
       * and jump the queue. An errored torrent belongs to `recovery`, which retries it on a growing
       * backoff rather than twice a second against a disk that is already refusing.
       */
      if (st.autoManaged || st.errorCode) { wantStarted.delete(h); continue }
      session.resumeTorrent(h)
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
    /*
     * The live inbound count, which the engine cannot be asked for directly.
     *
     * `Reachability.inbound` is a running total since the session started, by its own definition, and
     * it was read as a live peer count and reported as a bug twice. There is no session-level live
     * figure, so it is counted off the peer lists here, in the one place that already has every
     * handle.
     */
    if (now - peersPolledAt >= PEER_POLL_MS) {
      peersPolledAt = now
      for (const h of handles) void session.peers(h)
    }
    inboundNow = countInbound(handles.map((h) => session!.lastPeers(h)))

    post({ type: 'state', torrents: snapshot(), reachable: session.reachable(), inboundNow, detail: inspectDetail(now), rateLimits: { ...sessionLimits } })
    for (const h of handles) {
      const st = session.status(h)
      /*
       * Once per pause state, not once per torrent.
       *
       * A finished torrent's PIECES never change, which is what made one snapshot and then silence
       * look safe. Its `paused` flag does change, and the blob carries that too, so a torrent
       * parked as cache and then kept by the user had a blob still saying paused with nothing left
       * that would ever rewrite it: the 15s saver below is for state 3 alone. Every later reload
       * brought it back stopped, which is what made this bug repeat on every single refresh rather
       * than once.
       */
      if (!st || (st.state !== 4 && st.state !== 5) || resumeSaved.get(h) === st.paused || resumeInFlight.has(h)) continue
      const retry = resumeRetry.get(h)
      if (retry && now < retry.at) continue
      const pausedNow = st.paused
      void persistResume(h).then((saved) => {
        if (saved) { resumeSaved.set(h, pausedNow); resumeRetry.delete(h); return }
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
    /*
     * Fold this session's run time into the library, and REBASE.
     *
     * Both halves matter. Writing the total without moving the base would count the same seconds
     * again on the next write, and moving the base without writing would lose them. Done together
     * the invariant holds either side of it: total is always stored plus the delta since the last
     * rebase.
     *
     * Quiet, because a run time nobody is looking at changing by thirty seconds is not news any tab
     * needs re-rendering for, and every `list` broadcast arms a debounced cloud write.
     */
    let wroteCounters = false
    for (const h of handles) {
      const st = session.status(h)
      const ih = infoHashByHandle.get(h)
      const atAdd = uptimeAtAdd.get(h)
      if (!st || !ih || !atAdd) continue
      wroteCounters = true
      const total = totalUptime(uptimeStored.get(h), atAdd, st)
      if (!worthWriting(uptimeStored.get(h), total)) continue
      uptimeStored.set(h, total)
      uptimeAtAdd.set(h, { activeSeconds: st.activeSeconds, seedingSeconds: st.seedingSeconds })
      /*
       * The bytes ride the SAME gate, which is why there is no second threshold to pick.
       * `worthWriting` asks whether thirty seconds of running have gone by, and a torrent that is not
       * accumulating seconds is not moving bytes either, so one question answers both.
       */
      const reading = readingOf(st)
      const totals = accumulate(totalsStored.get(h), totalsAtAdd.get(h) ?? reading, reading)
      totalsStored.set(h, totals)
      totalsAtAdd.set(h, reading)
      void patchList(ih, {
        activeSeconds: total.activeSeconds,
        seedingSeconds: total.seedingSeconds,
        downloaded: totals.downloaded,
        uploaded: totals.uploaded,
        wasted: totals.wasted,
      }, true).catch(() => {})
    }

    /*
     * One LOUD broadcast every few minutes, which is the only thing that gets a counter into the cloud.
     *
     * The writes above are quiet on purpose: a run time nobody is looking at is not worth re-rendering
     * for, and every `list` message arms a debounced full-library upload. But the cloud hook only ever
     * learns the list from a `list` message, so with every counter write quiet it uploads whatever the
     * numbers were at the last add or pause. A torrent left seeding for a week would publish the
     * totals it had when it was added, and would go on doing so forever.
     *
     * Rare rather than never: a whole-library upload every five minutes while something is running is
     * a cost worth paying to have the figures agree between devices, where one per thirty seconds per
     * torrent is not. Nothing here is lost by the delay, because the numbers are on disk locally
     * either way and the merge that receives them takes a maximum.
     */
    if (wroteCounters && Date.now() - lastCounterBroadcast >= COUNTER_BROADCAST_MS) {
      lastCounterBroadcast = Date.now()
      void loadList().then((list) => post({ type: 'list', list })).catch(() => {})
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
          /**
           * And it has to START it, because a cache torrent is very likely parked.
           *
           * `applyViewing` idle-pauses an ephemeral torrent as soon as its last viewer leaves, and
           * promotion cleared the flag that made it a cache entry without touching the pause that
           * flag had already caused. So watching something in /embed, closing it, and then adding
           * the same magnet to the library gave a row that sat at Queued for good: not user-paused,
           * so no Resume was offered, and `recovery` reads `cacheIdle` as stopped on purpose and
           * leaves it alone.
           */
          wake(existing)
          await patchList(ih, { ephemeral: false, lastUsedAt: Date.now() })
        } else touchUsed(existing)
        post({ type: 'added', handle: existing, magnet: magnetByHandle.get(existing) || m.magnet })
      } else {
        // bytes already on disk stay where they were written, so a re-add never moves a torrent to
        // a fresh directory and orphans the old one
        const known = ih ? (await loadList()).find((e) => e.infoHash === ih) : undefined
        const savePath = m.savePath || known?.savePath || savePathFor(ih)
        // `known`, not the incoming flag alone: a torrent already in the library is not cache,
        // whatever opened it. The list has always applied this rule through mergeEntry; the engine
        // did not, so a watch link on a torrent the user owns used to hand its handle to
        // ephemeralHandles and get it idle-parked the moment the player closed.
        const ephemeral = staysEphemeral(known, m.ephemeral === true)
        const h = session.addMagnet(m.magnet, savePath)
        if (addFailed(h)) { post({ type: 'add-failed', message: 'That is not a valid magnet link' }); return }
        track(h, m.magnet, ih, savePath, ephemeral)
        // before needsPriorityReset, so the pass that clears the window has the plan to write back.
        // A re-add used to lose the file selection this device already had: the restore path reads
        // it back but nothing did on an add, so returning to a torrent through a link downloaded
        // everything again.
        planByHandle.set(h, { wanted: known?.wantedFiles, firstLast: known?.firstLast })
        /**
         * A hold settles this torrent's priorities the moment its layout lands.
         *
         * A magnet has no pieces until its metadata arrives, so nothing is transferred before this
         * fires and the gap costs nothing. What it buys is the pass at the bottom of the pump: with
         * no viewer it calls `applyViewing`, which writes the stored plan and, for a CACHE torrent,
         * parks it. That is what makes a page-opened torrent fetch its file list and then stop,
         * instead of pulling the whole release at full speed while a Download button sits unpressed.
         *
         * Asked for rather than applied to every add, because a torrent somebody is about to WATCH
         * wants none of it: the player claims its viewer a round trip after the same pump publishes
         * the layout, so a park here would land in between and cost the swarm it had just built for
         * nothing anybody would ever see.
         */
        if (m.hold === true) needsPriorityReset.add(h)
        // a re-add of something this device already knows keeps the ceiling it was given, matching
        // mergeEntry, which carries the limit forward rather than letting an add quietly uncap it
        wantLimits(h, { down: known?.downloadLimit, up: known?.uploadLimit })
        uptimeStored.set(h, { activeSeconds: known?.activeSeconds ?? 0, seedingSeconds: known?.seedingSeconds ?? 0 })
        totalsStored.set(h, storedTotals(known))
        recovery.hold(h, Date.now())
        const at = Date.now()
        // started/paused written explicitly: this add is what clears an eviction's tombstone
        // `paused` is a deliberate stop, so it takes the same route pressing Pause does rather than
        // just being written to the entry: the engine has to be told, and `recovery` has to be told
        // it is not a torrent that stopped on its own.
        if (m.paused === true) pauseAdded(h)
        if (ih) await upsertList({ infoHash: ih, magnet: m.magnet, savePath, addedAt: at, lastUsedAt: at, ephemeral, started: true, paused: m.paused === true })
        post({ type: 'added', handle: h, magnet: m.magnet })
        void runStorageBudget()
      }
    } else if (m.type === 'create-source') {
      /*
       * A torrent the person just made from their own file or folder.
       *
       * The metainfo arrives finished: the page walked the pick, hashed it, built the bencode and
       * checked the result back through the share dialog's own decoder before sending it. Nothing
       * here re-derives any of that, and nothing here writes to the source.
       *
       * The `.torrent` bytes are stored, and they are the only copy of this torrent's metadata that
       * will ever exist: a created torrent has no swarm to fetch metadata from, so a magnet alone
       * could never resolve it on the next load.
       */
      const ih: string = m.infoHash
      // named for what it holds: `handles` alone means ENGINE handles everywhere else in this file
      const fileHandles = (m.handles ?? []) as (SourceRef | null)[]
      const bytes = m.bytes as Uint8Array
      if (typeof ih !== 'string' || !ih || !fileHandles.length || !bytes?.byteLength) {
        post({ type: 'add-failed', message: 'That torrent could not be created' })
        return
      }
      // a `null` here is a PAD FILE and is expected; the page throws before sending if a real file
      // is missing, so what this guards against is a message with nothing usable in it at all
      if (!fileHandles.some((handle) => handle)) {
        post({ type: 'add-failed', message: 'Some of those files could not be opened' })
        return
      }
      // The handle count is NOT compared against `m.files` here: that list is capped when it is
      // written, so it is not the whole of the torrent. The comparison that matters happens in
      // hybrid-storage against libtorrent's own file list, which is authoritative and complete.
      await set(torrentKey(ih), bytes)
      const h = addSource(session, { infoHash: ih, magnet: m.magnet, bytes, handles: fileHandles, paused: false })
      if (h === null) {
        await del(torrentKey(ih)).catch(() => {})
        post({ type: 'add-failed', message: 'The engine refused the torrent that was just built' })
        return
      }
      const at = Date.now()
      await upsertList({
        infoHash: ih,
        magnet: m.magnet,
        savePath: sourceSavePathFor(ih),
        addedAt: at,
        lastUsedAt: at,
        // never cache, never evicted, and never moved: `saveTo: 'source'` is what says so
        ephemeral: false,
        /*
         * `started: false` for a source the page could NOT keep a handle for, which is what makes it
         * a ghost on the next load instead of nothing at all.
         *
         * A source entry is excluded from every live row on purpose, because the waiting list is
         * meant to carry it and offer the access button. That list reads the stored handle, so an
         * entry without one is dropped from it too and renders nowhere: not live, not starting, not
         * a ghost, and with no row there is nothing to remove it from the library with. Absent means
         * true, so an older client that does not send this keeps the behaviour it had.
         */
        started: m.reopenable !== false,
        paused: false,
        saveTo: 'source',
        // the format decides where the pads fall, and a later load has to rebuild the same file
        // list to keep the handle array index-aligned with libtorrent's
        format: m.format ?? 'v1',
        pieceLength: typeof m.pieceLength === 'number' ? m.pieceLength : undefined,
        ...syncedMetadata({ name: m.name, size: m.size, files: m.files }),
      })
      post({ type: 'added', handle: h, magnet: m.magnet })
    } else if (m.type === 'start-source') {
      /*
       * The same torrent on a later load, once the page has a live read grant again.
       *
       * The page drives this rather than the restore loop, because a picker grant does not survive a
       * reload and getting it back needs a user gesture that a worker cannot make. See the restore
       * loop for what adding one without a grant does, which is worse than not adding it.
       */
      const ih: string = m.infoHash
      // named for what it holds: `handles` alone means ENGINE handles everywhere else in this file
      const fileHandles = (m.handles ?? []) as (SourceRef | null)[]
      if (typeof ih !== 'string' || !ih || !fileHandles.length) return
      // as in create-source above, a `null` is a pad file rather than a file that failed to open
      if (!fileHandles.some((handle) => handle)) {
        post({ type: 'add-failed', message: 'Some of those files could not be opened' })
        return
      }
      // Already running is not an error. Every tab holding the stored handle regains the grant on
      // its own and asks, so the second and third asks are ordinary; answering with the handle it
      // already has lets the caller carry on without a special case.
      const running = [...infoHashByHandle.entries()].find(([, hash]) => hash === ih)
      if (running) { post({ type: 'added', handle: running[0], magnet: magnetByHandle.get(running[0]) ?? '' }); return }
      const bytes = (await get(torrentKey(ih)))
      if (!bytes?.byteLength) {
        post({ type: 'add-failed', message: 'The torrent this was built from is no longer stored' })
        return
      }
      const entry = (await loadList()).find((e) => e.infoHash === ih)
      const h = addSource(session, {
        infoHash: ih,
        magnet: entry?.magnet ?? m.magnet ?? '',
        bytes,
        handles: fileHandles,
        paused: entry?.paused === true,
      })
      if (h === null) { post({ type: 'add-failed', message: 'The engine refused that torrent' }); return }
      uptimeStored.set(h, { activeSeconds: entry?.activeSeconds ?? 0, seedingSeconds: entry?.seedingSeconds ?? 0 })
      totalsStored.set(h, storedTotals(entry))
      await patchList(ih, { started: true, lastUsedAt: Date.now() })
      post({ type: 'added', handle: h, magnet: entry?.magnet ?? '' })
    } else if (m.type === 'add-torrent-file') {
      // A .torrent only reveals its infohash after the add, so this one cannot be given a directory
      // of its own. It is a deliberate user action, so it is never a cache entry and the budget pass
      // never touches it, which is what makes sharing the root safe here.
      const savePath = m.savePath || SHARED_ROOT
      const bytes = m.bytes as Uint8Array
      const h = session.addTorrentFile(bytes, savePath)
      if (addFailed(h)) { post({ type: 'add-failed', message: 'That file is not a valid .torrent' }); return }
      // ephemeral is passed through now: a .torrent added ON THE USER'S BEHALF, as the first-run demo
      // is, belongs in the cache the budget pass may reclaim rather than in their library for good
      track(h, '', null, savePath, m.ephemeral === true)
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
      /*
       * The synthesized magnet is the torrent's identity everywhere (list, /embed URL, player match),
       * and it has to be a magnet a client can actually resolve.
       *
       * `session.infohash` answers with the v1 hash when there is one and the v2 hash otherwise, so a
       * V2-ONLY torrent comes back as 64 hex characters. Pasting those after `urn:btih:` produces a
       * string libtorrent's own parser rejects (`parse_magnet_uri` takes 40 hex or 32 base32 and
       * nothing else), which is silent until something feeds the magnet back in: moving the torrent
       * to a folder, which removes it and re-adds it from this string, and pressing Download on a
       * second device, which has the list and no `.torrent` bytes. Both answer "could not be read",
       * permanently, and the move has already deleted the browser copy by then.
       *
       * The v1 form is left EXACTLY as it was, because every entry already in somebody's library
       * carries that string and it is compared, not re-derived.
       */
      const v2 = session.infohashV2(h)
      const magnet = 'magnet:?' + [
        ...(ih.length === 40 ? [`xt=urn:btih:${ih}`] : []),
        // `1220` is the multihash prefix, sha2-256 of 32 bytes: part of the urn, never of the id
        ...(v2 ? [`xt=urn:btmh:1220${v2}`] : []),
      ].join('&')
      track(h, magnet, ih, savePath)
      await set(torrentKey(ih), bytes)
      const addedAt = Date.now()
      if (m.paused === true) pauseAdded(h)
      // `saveTo` here rather than through a following `set-location`: this handler is UNQUEUED, so a
      // command sent after it would run first and find no entry to patch. See client.addTorrentFile.
      const saveTo = m.saveTo === 'browser' || m.saveTo === 'folder' ? { saveTo: m.saveTo as SaveLocation } : {}
      await upsertList({ infoHash: ih, magnet, savePath, addedAt, lastUsedAt: addedAt, ephemeral: m.ephemeral === true, started: true, paused: m.paused === true, ...saveTo, ...(m.created === true ? { created: true } : {}) })
      /*
       * Released HERE and not by the page, because the gap is between the two.
       *
       * The page cannot know when to let go: this handler is unqueued and spends up to ten seconds
       * polling for the infohash, so a release sent right after the add runs on the command queue
       * FIRST, and the directory would sit unclaimed for that whole poll. The entry above is what
       * makes it claimed, so the reservation ends on the line after it and not before.
       */
      reservedHashes.delete(ih)
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
            /*
             * `deadlineMs: null` for a bulk reader, and it is the larger half of the fix.
             *
             * The default is 0, which asks libtorrent to treat every piece covering this read as due
             * NOW. An export reads 8 MiB at a time, so that is dozens of pieces marked maximally
             * urgent at once, and the time-critical rescue answers by requesting them from several
             * peers each and discarding the copies that arrive second. MEASURED on a 1446 MB torrent:
             * turning this one option off took the waste from 879 MB to 148 MB. The window ladder
             * above accounts for the rest.
             *
             * A player keeps the deadline. It is reading 2.5 MB at the playhead with a frame due, and
             * a duplicated block that arrives in time is exactly the trade the rescue exists to make.
             */
            const bulk = m.viewer ? viewers.get(m.handle)?.get(m.viewer)?.bulk === true : false
            const data = await session.read(m.handle, m.fileIndex, m.offset, m.len, {
              timeoutMs: READ_ATTEMPT_MS,
              ...(bulk ? { deadlineMs: null } : {}),
            })
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
            /*
             * Re-anchoring re-places the deadlines, so the next tick requests the freed blocks from
             * the fastest peers rather than the ones that just lost them.
             *
             * Only for a viewer that is STILL asking for bytes, and this guard is the whole
             * difference between stopping a download and appearing to. A read outlives the export
             * that issued it, and the `watch` below writes an entry with no held flag, so an
             * abandoned read PROMOTED the page's hold back into a live claim, woke the torrent and
             * carried on fetching the file somebody had just cancelled, for the life of the tab.
             * On unmount it was worse: it recreated a viewer the page had already unwatched, and a
             * torrent with a viewer is one the eviction pass may never reclaim.
             *
             * The promotion on a read's ENTRY is untouched, in anchorSequential, so a live reader
             * still turns its own hold into a claim. What cannot happen here is a read overruling a
             * decision made after it started.
             */
            const claim = m.viewer ? viewers.get(m.handle)?.get(m.viewer) : undefined
            if (m.prioritize !== false && m.viewer && claim && !claim.held) {
              watch(m.viewer, m.handle, m.fileIndex, m.offset)
            }
          }
        }
      // the handle check keeps a torrent that was given up mid-read from leaving an entry behind
      } finally { inFlight.delete(m.id); if (handles.includes(m.handle)) lastReadAt.set(m.handle, Date.now()) }
    } else if (m.type === 'cancel-read') {
      /**
       * The reader has gone away, so the read stops rather than going on planning the swarm.
       *
       * Dropping the id is the whole mechanism: the read loop above re-checks `inFlight` after every
       * attempt and returns the moment its id is missing, which happens at most one attempt later.
       *
       * What that prevents is not wasted work, it is a claim coming back from the dead. A stalled
       * read re-anchors its viewer between attempts, and an export's reads travel under the PAGE's
       * viewer id, so an abandoned read promoted the page's held claim back to an active one and the
       * torrent carried on downloading a file somebody had already cancelled.
       */
      readsByHandle.get(m.handle)?.delete(m.id)
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
    } else if (m.type === 'set-temporary') {
      /**
       * The one place a PERSON changes this, and the only writer that has to move both halves.
       *
       * The list entry and the engine's `ephemeralHandles` are two records of one fact, and the last
       * two bugs here were both of them drifting apart. So this writes both, in one handler, with no
       * await between them that a page could observe half of.
       *
       * `staysEphemeral` cannot serve this and must not be wired into it. That function answers
       * "does an ADD leave this in the cache", so it can clear the flag and can never set it:
       * routing a demote through it would be a silent no-op that looks like a working button.
       */
      if (typeof m.infoHash === 'string') {
        const temporary = m.temporary === true
        const h = handles.find((x) => infoHashByHandle.get(x) === m.infoHash)
        if (h !== undefined) {
          if (temporary) ephemeralHandles.add(h)
          else {
            ephemeralHandles.delete(h)
            // Kept, so the reason it was parked no longer applies. `wake` is what a read or a viewer
            // already uses for this: it clears the idle pause, resumes, and holds off recovery.
            // Without it a promoted torrent would sit paused for a rule it is no longer under, which
            // is the exact state this whole feature exists to make visible.
            wake(h)
          }
        }
        await patchList(m.infoHash, { ephemeral: temporary })
      }
    } else if (m.type === 'reserve-storage') {
      // a page is about to write into `/dl/<infoHash>` before any torrent exists there; see
      // `reservedHashes`. Idempotent, and releasing one that was never held is not an error.
      if (typeof m.infoHash === 'string' && m.infoHash) {
        if (m.on === false) reservedHashes.delete(m.infoHash)
        else reservedHashes.add(m.infoHash)
      }
    } else if (m.type === 'set-location') {
      // intent only. The move that follows is decided by a page, which is the realm that can see
      // whether the torrent has finished and whether the folder is reachable right now.
      if (typeof m.infoHash === 'string') await patchList(m.infoHash, { saveTo: m.to === 'folder' ? 'folder' : 'browser' })
    } else if (m.type === 'relocate') {
      /*
       * The lookup runs THIS WAY ROUND deliberately. It used to read the info hash out of the handle
       * it was sent, which resolves a stale number to whatever torrent this session gave it, and
       * then removed that torrent, deleted its resume blob and re-added it somewhere else. Resolving
       * the handle from the hash instead cannot name the wrong torrent: an absent one means the
       * torrent is not in this session, and doing nothing is the correct answer to that.
       */
      const ih = typeof m.infoHash === 'string' ? m.infoHash : null
      const to: SaveLocation = m.to === 'folder' ? 'folder' : 'browser'
      const h = ih ? handles.find((x) => infoHashByHandle.get(x) === ih) : undefined
      if (ih && h !== undefined) await relocate(session, h, ih, to)
    } else if (m.type === 'import-list') {
      const incoming: Persisted[] = Array.isArray(m.list) ? m.list : []
      let list: Persisted[] = []
      let changed = false
      await update<Persisted[]>(LIST_KEY, (prev) => {
        list = prev ?? []
        const byHash = new Map(list.map((e) => [e.infoHash, e]))
        for (const e of incoming) {
          if (!e || typeof e.infoHash !== 'string' || !e.magnet) continue
          const meta = syncedMetadata(e)
          const mine = byHash.get(e.infoHash)
          if (mine) {
            /*
             * Already here, so this device's entry wins: everything else on it describes what THIS
             * browser is doing and must not be replaced by another machine's view.
             *
             * Metadata is the exception, and only to FILL A GAP. An entry added before metadata was
             * synced, or on a device that never reached the swarm, has no name and no size, and the
             * incoming copy is the only place either exists. Never an overwrite: a local value was
             * read off the torrent itself and is at least as good as a mirrored one.
             */
            if (mine.name === undefined && meta.name !== undefined) { mine.name = meta.name; changed = true }
            if (mine.size === undefined && meta.size !== undefined) { mine.size = meta.size; changed = true }
            if (mine.files === undefined && meta.files !== undefined) { mine.files = meta.files; changed = true }
            /*
             * THE COUNTERS ARE THE SECOND EXCEPTION, and they are merged rather than filled.
             *
             * Local-wins is right for everything that describes what this browser is doing, and wrong
             * for a total that both machines have been adding to: whichever device mounted last would
             * discard the other's count and then publish that discard, which is worse than not
             * syncing at all because there would be something to lose.
             *
             * `mergeTotals` takes the HIGHEST of each, which is the merge the owner asked for and the
             * only one that survives this pipeline: read-once-per-mount and a blind whole-file write
             * make ordering unreliable, and a maximum is commutative, associative and idempotent, so
             * a write lost to a race is republished in full by the next one. See uptime.ts.
             */
            const merged = mergeTotals(storedTotals(mine), storedTotals(e))
            for (const key of TOTAL_KEYS) {
              if ((mine[key] ?? 0) === merged[key]) continue
              mine[key] = merged[key]
              changed = true
            }
            continue
          }
          // a library entry from another device, never a cache one: the cache is device-local and is not backed up
          // ...including the counters it arrives with: this device has never run it, so the other
          // machine's totals are the whole of what is known about it
          const entry: Persisted = { infoHash: e.infoHash, magnet: e.magnet, savePath: e.savePath || SHARED_ROOT, addedAt: e.addedAt || Date.now(), started: false, ephemeral: false, ...meta, ...storedTotals(e) }
          list.push(entry)
          byHash.set(entry.infoHash, entry)
          changed = true
        }
        return list
      })
      if (changed) post({ type: 'list', list })
    } else if (m.type === 'start') {
      const e = (await loadList()).find((x) => x.infoHash === m.infoHash)
      /*
       * A CREATED SOURCE IS NOT FETCHABLE, and adding one here is worse than doing nothing.
       *
       * Its bytes were never in a swarm: this device was the only seed, and its `savePath` is
       * `/source/<hash>`, which is not a directory but a key into handles the page registers for one
       * session through `create-source`. This handler registers none, so the storage resolves with
       * `handles: null` and the first read throws a FATAL disk error, which is a red retrying row
       * backing off to five minutes. Then the line below writes `started: true`, which hides the
       * entry from every list again, this time with the Remove option that was on its row gone with
       * it. The restore loop refuses these for the same reason; see the note there.
       *
       * The UI does not offer the button for one of these, and this is the second lock on the same
       * door: the message can also arrive from a stale tab or a keyboard shortcut.
       */
      if (e?.saveTo === 'source') {
        post({ type: 'add-failed', message: 'This torrent was made from files on this device, so there is nowhere to fetch it from. Create it again from the same files to share it.' })
        return
      }
      if (e) {
        const savePath = e.savePath || SHARED_ROOT
        const bytes = (await get(torrentKey(e.infoHash)))
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
        post({ type: 'state', torrents: snapshot(), reachable: session.reachable() })
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
      /*
       * RECORDED as well as sent, because the send can be a silent no-op.
       *
       * `lt_torrent_pause` starts with `lookup_handle`, and that registry is written in exactly one
       * place: `register_handle`, on `add_torrent_alert`, inside the alert pump. So a pause aimed at
       * a torrent whose add has not been pumped yet returns -1 and does nothing at all, and the JS
       * binding discards the return.
       *
       * MEASURED, and not exotic: when the tab hosting the engine closes, another is promoted and
       * restores the library, and a command from a THIRD tab arrives while that add is still in
       * flight. The trace at that instant reads `tracked=true hasStatus=false`, which is exactly the
       * window. Ripple knew about the handle, the engine did not, and the torrent went on downloading
       * with the row reading Downloading and nothing anywhere saying why.
       *
       * The want is what makes the pump try again once the handle exists.
       */
      wantPause(m.handle)
      recovery.forget(m.handle)
      session.pauseTorrent(m.handle)
      failReads(m.handle, 'torrent paused')
      void persistResume(m.handle)
      const ih = infoHashByHandle.get(m.handle)
      if (ih) await patchList(ih, { paused: true })
    } else if (m.type === 'resume') {
      userPaused.delete(m.handle)
      cacheIdle.delete(m.handle)
      wantStart(m.handle)
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
      // pausing takes a torrent out of the only rotation that starts checks, so wantPaused has to go
      // too. Neither want is recorded in its place: forceRecheck clears the pause itself, and a
      // check reports itself paused while it runs, so wantStarted would fight it for its whole run.
      userPaused.delete(m.handle)
      wantPaused.delete(m.handle)
      wantStarted.delete(m.handle)
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
      else watch(m.viewer, m.handle, m.fileIndex, m.fromOffset ?? 0, m.held === true, m.bulk === true ? true : undefined)
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
