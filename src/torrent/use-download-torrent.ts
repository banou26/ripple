import { useCallback, useEffect, useRef, useState } from 'react'

import type { TorrentClient, TorrentSnapshot } from './client'
import { getTorrentClient } from './client'
import { magnetInfoHash } from './magnet'

export type DownloadTorrent = {
  client: TorrentClient
  snapshot: TorrentSnapshot | null
  handle: number | null
  /** The id every read of this export travels under, so the engine plans the swarm around it. */
  viewer: string
  /**
   * Ask the engine for bytes, naming the file the export is about to start at.
   *
   * Nothing is transferred until this is called. Reads carry the same viewer and re-anchor the
   * window themselves, so this only has to point the swarm at the right place; it exists so the
   * planning starts on the click rather than one sink handshake later.
   */
  claim: (fileIndex: number) => void
  engineError: string | null
  storageFull: boolean
}

/**
 * The engine side of a download page.
 *
 * Deliberately NOT `usePlayerTorrent`: that hook owns a read-window cache and a thumbnail reader
 * built for a demuxer seeking around one file, and a download reads every byte once, in order, and
 * never twice. Caching those windows would hold a copy of the whole export in memory for nothing.
 *
 * What it does share is the viewer, and that part is not optional. A torrent added by a PAGE is
 * ephemeral, and `applyViewing` pauses an ephemeral torrent the moment it has no viewers, so until
 * `claim` is called the page sits at 0 B/s with a perfectly healthy engine underneath it. That is
 * the intended resting state: opening a link reads the torrent's file list off the network and then
 * stops, and nothing is transferred until somebody presses Download.
 *
 * The claim also decides the ORDER bytes arrive in: it puts the selected file at normal priority
 * with a deadline band at the read cursor and everything else at skip, which is what turns a
 * rarest-first swarm into a stream that can be written straight to disk.
 */
export const useDownloadTorrent = (magnet: string | undefined): DownloadTorrent => {
  const client = getTorrentClient()
  const handleRef = useRef<number | null>(null)
  const viewerRef = useRef<string>(undefined as unknown as string)
  if (!viewerRef.current) viewerRef.current = client.newViewerId()
  const [snapshot, setSnapshot] = useState<TorrentSnapshot | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [storageFull, setStorageFull] = useState(false)

  useEffect(() => {
    if (!magnet) return
    const offUnavailable = client.onStorageUnavailable(
      () => setEngineError('Ripple needs a normal (non-private) window to download this'),
    )
    const offWorkerError = client.onWorkerError(({ fatal }) => {
      if (fatal) setEngineError('The download engine stopped. Reload the page to try again.')
    })
    const offFull = client.onStorageFull(setStorageFull)
    // Ephemeral for the same reason the player uses it: the page asked for this, not the person, so
    // its bytes stay a cache the engine may reclaim rather than something that fills the origin's
    // budget for good. Adding the same magnet by hand in the library promotes it out of the cache.
    // `hold` is what makes arriving here free: the engine reads the file list off the network and
    // then stops, so the page can offer a Download button instead of describing one already running.
    client.addMagnet(magnet, { ephemeral: true, hold: true })
    const infoHash = magnetInfoHash(magnet)
    const viewer = viewerRef.current
    let holding = false
    const offReset = client.onEngineReset(() => { holding = false; handleRef.current = null })
    const off = client.onState((snaps) => {
      // match on the infoHash, never on the magnet string, and never on "the first one"
      const snap = snaps.find((s) => s.magnet === magnet)
        ?? (infoHash ? snaps.find((s) => magnetInfoHash(s.magnet) === infoHash) : undefined)
        ?? null
      if (snap) handleRef.current = snap.handle
      /**
       * A HELD claim, registered as soon as there is a handle and kept for as long as the page is.
       *
       * It asks for no bytes and lifts no pause, so the hold above is untouched. What it does is
       * tell the storage budget that somebody has this torrent on screen: without it the page's own
       * torrent becomes an eviction candidate fifteen seconds after the add, and an eviction
       * untracks the handle, which this hook cannot recover from because its add runs once per
       * magnet. The page would sit at "Loading torrent…" for good.
       */
      if (snap && !holding) {
        holding = true
        client.watch(viewer, snap.handle, 0, 0, undefined, true)
      }
      setSnapshot(snap)
    })
    return () => {
      off()
      offReset()
      offUnavailable()
      offWorkerError()
      offFull()
      client.unwatch(viewer)
      handleRef.current = null
    }
  }, [client, magnet])

  const handle = snapshot?.handle ?? handleRef.current
  const files = snapshot?.files?.files.length ?? 0

  /**
   * Clamped against the real file list, because an unresolvable claim is worse than no claim at all:
   * `setStreamWindow` skips a file index the torrent does not have, finds nothing left to plan, and
   * returns false WITHOUT writing a priority map. Nothing is marked skip, so the torrent quietly
   * downloads the whole release at full speed while the page says none of the requested files are in
   * it, and the handle sits in `pendingViewing` being retried on every pump for the life of the
   * session.
   */
  const claim = useCallback((fileIndex: number) => {
    if (handle == null || files === 0) return
    client.watch(viewerRef.current, handle, fileIndex >= 0 && fileIndex < files ? fileIndex : 0)
  }, [client, handle, files])

  return {
    client,
    snapshot,
    handle,
    viewer: viewerRef.current,
    claim,
    engineError,
    storageFull,
  }
}
