import { useEffect, useRef, useState } from 'react'

import type { TorrentClient, TorrentSnapshot } from './client'
import { getTorrentClient } from './client'
import { magnetInfoHash } from './magnet'

export type DownloadTorrent = {
  client: TorrentClient
  snapshot: TorrentSnapshot | null
  handle: number | null
  /** The id every read of this export travels under, so the engine plans the swarm around it. */
  viewer: string
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
 * ephemeral, and `applyViewing` pauses an ephemeral torrent the moment it has no viewers, so without
 * a claim here the download page would sit at 0 B/s forever with a perfectly healthy engine
 * underneath it. The claim also decides the ORDER bytes arrive in: it puts the selected file at
 * normal priority with a deadline band at the read cursor and everything else at skip, which is what
 * turns a rarest-first swarm into a stream that can be written straight to disk.
 */
export const useDownloadTorrent = (magnet: string | undefined, firstFileIndex: number): DownloadTorrent => {
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
    client.addMagnet(magnet, { ephemeral: true })
    const infoHash = magnetInfoHash(magnet)
    const viewer = viewerRef.current
    let watching = false
    const offReset = client.onEngineReset(() => {
      watching = false
      handleRef.current = null
    })
    const off = client.onState((snaps) => {
      // match on the infoHash, never on the magnet string, and never on "the first one"
      const snap = snaps.find((s) => s.magnet === magnet)
        ?? (infoHash ? snaps.find((s) => magnetInfoHash(s.magnet) === infoHash) : undefined)
        ?? null
      if (snap) handleRef.current = snap.handle
      if (snap?.files && !watching) {
        watching = true
        /**
         * Claimed before anything is clicked, so the head of the selection is already on disk by the
         * time somebody presses Download. The claim moves itself from there: every read carries the
         * viewer, and the engine re-anchors the window to wherever the export has reached.
         *
         * Clamped HERE, because this is the first moment the file count is known, and an
         * unresolvable claim is worse than no claim at all: `setStreamWindow` skips a file index the
         * torrent does not have, finds nothing left to plan, and returns false WITHOUT writing a
         * priority map. Nothing is marked skip, so the torrent quietly downloads the whole release
         * at full speed while the page says none of the requested files are in it, and the handle
         * sits in `pendingViewing` being retried on every pump for the life of the session.
         */
        const count = snap.files.files.length
        client.watch(viewer, snap.handle, firstFileIndex < count ? firstFileIndex : 0)
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
  }, [client, magnet, firstFileIndex])

  return {
    client,
    snapshot,
    handle: snapshot?.handle ?? handleRef.current,
    viewer: viewerRef.current,
    engineError,
    storageFull,
  }
}
