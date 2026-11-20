import type { IntlShape } from 'react-intl'

import type { SaveLocation } from '../torrent/library'
import type { Torrent } from '../torrent/types'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useIntl } from 'react-intl'
import { useLocation } from 'react-router-dom'

import { runningTorrentClient } from '../torrent/client'
import { moveTorrentFiles } from '../torrent/move-files'
import { currentLocation, intendedLocation, mirrorsToFolder, moveReadiness, readGlobalDefault } from '../torrent/save-location'
import { copyKey, holdsChosen, syncTorrentToDirectory } from '../torrent/sync'
import { finished, leavesFilesOut } from '../torrent/types'
import { useFolder } from '../torrent/use-folder'
import { useTorrents } from '../torrent/use-torrents'

// A torrent already copied to the folder is parked on DONE, and a failed copy or move waits SYNC_RETRY before the next attempt
const DONE = Number.POSITIVE_INFINITY
const SYNC_RETRY = 30_000
// A tab not running the engine only checks the copy, which stops at the first file not there, so it looks again sooner
const CHECK_RETRY = 3_000

// Resolves to null when another tab already holds it, which is a skip rather than a success or a failure
const copyUnderLock = (torrent: Torrent, copy: () => Promise<number>): Promise<number | null> => {
  const key = torrent.infoHash
  if (!navigator.locks || !key) return copy()
  return navigator.locks.request(
    `ripple:folder-sync:${key}`,
    { ifAvailable: true },
    (lock) => (lock ? copy() : Promise.resolve(null)),
  )
}

let saved: ReadonlySet<string> = new Set()
const savedHeard = new Set<() => void>()
const setSaved = (next: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
  saved = next(saved)
  for (const heard of savedHeard) heard()
}

/**
 * Which torrents have actually landed in the person's folder, by `copyKey`, so a file chosen since is not counted as
 * there. It decides whether "Remove from the library" is offered at all, since keeping the files is only a real choice
 * once the files are somewhere the person can open.
 */
export const useSavedToFolder = (): ReadonlySet<string> => useSyncExternalStore(
  (heard) => {
    savedHeard.add(heard)
    return () => { savedHeard.delete(heard) }
  },
  () => saved,
)

const listeners = new Set<(text: string) => void>()

/** What a move or a copy into the folder says when it lands or fails, for the page that shows it; with none, unsaid. */
export const onFolderNews = (listener: (text: string) => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const tell = (text: string) => { for (const listener of listeners) listener(text) }

/** What a move says once it landed. */
export const movedNews = (intl: IntlShape, name: string, to: SaveLocation, folder: string): string => (to === 'folder'
  ? intl.formatMessage({ id: '{name} moved to {folder}', defaultMessage: '{name} moved to {folder}' }, { name, folder })
  : intl.formatMessage({ id: '{name} moved into browser storage', defaultMessage: '{name} moved into browser storage' }, { name }))

const Work = () => {
  const intl = useIntl()
  const { torrents, client } = useTorrents()
  const { folder, permitted } = useFolder()

  /**
   * Hand the engine the folder, from whichever tab actually holds the grant.
   *
   * A File System Access grant belongs to a realm, and the engine runs in whichever tab won the
   * election, which is not necessarily this one. Every tab offers what it has and the newest offer
   * wins, so a grant given anywhere reaches the engine. Offering null when the grant goes is just as
   * important: a stale handle would have the engine reading against permission it no longer has.
   * An engine started by a handover or a restart has none of it, so each new one is offered it again.
   */
  useEffect(() => {
    const offer = () => client.setFolder(folder && permitted ? folder : null)
    offer()
    return client.onEngineReset(offer)
  }, [client, folder, permitted])

  /**
   * Moves in flight, by info hash, with where each goes, so the effect below cannot start the same one twice.
   * A move that worked keeps its mark until its row reports the new place: until then the row still reads the old one,
   * and a second move would read files the engine already dropped.
   */
  const movingRef = useRef(new Map<string, SaveLocation>())
  // When a failed move may be tried again, by info hash: like a failed copy, it waits SYNC_RETRY rather than the next tick
  const moveAtRef = useRef(new Map<string, number>())

  const runMove = async (t: Torrent, to: SaveLocation) => {
    const infoHash = t.infoHash
    if (!folder || !permitted || !infoHash || movingRef.current.has(infoHash)) return
    if (Date.now() < (moveAtRef.current.get(infoHash) ?? 0)) return
    movingRef.current.set(infoHash, to)
    try {
      await moveTorrentFiles({ client, torrent: t, folder, to })
      tell(movedNews(intl, t.name, to, folder.name))
    } catch {
      movingRef.current.delete(infoHash)
      moveAtRef.current.set(infoHash, Date.now() + SYNC_RETRY)
      // nothing was deleted: the copy runs first and the engine is only told once it lands
      tell(intl.formatMessage({ id: 'Moving {name} failed', defaultMessage: 'Moving {name} failed' }, { name: t.name }))
    }
  }

  /**
   * Carry out the moves that became possible: a torrent finished, the folder came back, or a place was chosen for one.
   *
   * Runs off the same state tick as the mirror below, so it re-checks twice a second, and every move
   * it starts is guarded by `movingRef` so a tick during a copy cannot start a second one. Only in the tab running the
   * engine: another tab's move would read files this one's had just dropped.
   */
  useEffect(() => {
    if (!folder || !permitted || !client.owns()) return
    // read on each tick, so a default chosen on another page or in another tab counts on the next
    let defaultLocation: SaveLocation = 'browser'
    try { defaultLocation = readGlobalDefault((k) => localStorage.getItem(k)) } catch {}
    for (const t of torrents) {
      if (t.state === 'missing') continue
      const intended = intendedLocation(t, defaultLocation)
      const current = currentLocation(t.stats?.savePath)
      if (t.infoHash && movingRef.current.get(t.infoHash) === current) movingRef.current.delete(t.infoHash)
      const readiness = moveReadiness({ current, intended, complete: t.progress >= 1 && holdsChosen(t), folderReady: true, leavesFilesOut: leavesFilesOut(t) })
      if (readiness.move) void runMove(t, readiness.to)
    }
  })

  // The backoff is what makes retrying safe: this effect re-runs twice a second from the state tick, so a bare retry would hammer the disk
  const syncAtRef = useRef(new Map<string, number>())
  // In-flight copies are tracked apart from the backoff: a copy can run longer than the retry window while this effect re-runs twice a second, and a swap-file
  // writable leaves the destination at its old size until close(), so the size-based idempotence check cannot catch a second pass over the same files
  const syncingRef = useRef(new Set<string>())
  const folderGenerationRef = useRef(0)
  useEffect(() => {
    folderGenerationRef.current++
    syncAtRef.current.clear()
    moveAtRef.current.clear()
    // a different folder, or a revoked grant, means nothing is known to be mirrored any more
    setSaved(() => new Set())
  }, [folder, permitted])
  // Both maps are keyed by the session handle, which names a different torrent after the engine moves to another tab
  useEffect(() => client.onEngineReset(() => {
    syncAtRef.current.clear()
    syncingRef.current.clear()
    // a move the old engine never reported done is decided again from the new one's rows
    movingRef.current.clear()
    // ids are session handles, so after a reset they name different torrents entirely
    setSaved(() => new Set())
  }), [client])
  useEffect(() => {
    if (!folder || !permitted) return
    // only the tab running the engine copies, beside its moves; another tab checks what it copied, for its options
    const copies = client.owns()
    const now = Date.now()
    for (const t of torrents) {
      if (!finished(t) || !holdsChosen(t)) continue
      /*
       * A created torrent is never mirrored.
       *
       * Its bytes ARE the user's own files, already sitting where they chose. Copying them into the
       * auto-save folder would duplicate an entire folder on their disk to produce a second copy of
       * something they already had, and the copy would then be the one Ripple offered to remove.
       * `moveReadiness` refuses the other half of this, the move into OPFS; this is the mirror.
       *
       * `created` as well as `saveTo`, since the copy path: a torrent made from a pick that could
       * not be re-opened lives in BROWSER storage, so it reaches here as an ordinary finished
       * download while its bytes are still a copy of files the person already has. Testing `saveTo`
       * alone stopped being enough the moment that existed, and the cost of missing it is the whole
       * pick written to their disk a third time.
       */
      if (!mirrorsToFolder(t, currentLocation(t.stats?.savePath))) continue
      // a move copies the files itself, and drops the ones a copy beside it would still be reading, so the copy also
      // waits out a failed move's wait: it would still be writing when the move tries again
      if (t.infoHash && (movingRef.current.has(t.infoHash) || now < (moveAtRef.current.get(t.infoHash) ?? 0))) continue
      if (!t.files?.length || syncingRef.current.has(t.id)) continue
      const key = copyKey(t)
      const attempt = syncAtRef.current.get(key)
      if (attempt !== undefined && (attempt === DONE || now < attempt)) continue
      syncingRef.current.add(t.id)
      const generation = folderGenerationRef.current
      copyUnderLock(t, () => syncTorrentToDirectory(client, t, folder, copies))
        .then((written) => {
          if (generation !== folderGenerationRef.current) return
          if (written === null) return
          syncAtRef.current.set(key, DONE)
          // `written` is false for a copy that was already there, which is still "it is in the
          // folder" and still the thing the removal options need to know
          setSaved((prev) => (prev.has(key) ? prev : new Set(prev).add(key)))
          if (written) tell(intl.formatMessage({ id: '{name} saved to {folder}', defaultMessage: '{name} saved to {folder}' }, { name: t.name, folder: folder.name }))
        })
        .catch(() => {
          if (generation !== folderGenerationRef.current) return
          syncAtRef.current.set(key, Date.now() + (copies ? SYNC_RETRY : CHECK_RETRY))
          if (copies) tell(intl.formatMessage({ id: 'Saving {name} to {folder} failed, retrying', defaultMessage: 'Saving {name} to {folder} failed, retrying' }, { name: t.name, folder: folder.name }))
        })
        .finally(() => syncingRef.current.delete(t.id))
    }
  }, [torrents, folder, permitted, client, intl])

  return null
}

/**
 * The folder's moves and copies, mounted around every page: the engine goes on finishing torrents whichever page its
 * tab shows. Only the tab running the engine moves and copies; another tab checks the copies read-only, for its
 * options. It waits for a page to make the client, and never makes one, so it is rendered after the page, which makes
 * the client as it renders.
 */
export const FolderWork = () => {
  // rendered again on each page, since the page shown may be the first to make the client
  useLocation()
  return runningTorrentClient() && <Work/>
}
