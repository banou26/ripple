import { useEffect, useRef, useState } from 'react'

import { getTorrentClient } from './client'
import type { TorrentSnapshot } from './client'
import { magnetInfoHash } from './magnet'

export type PlayerTorrent = {
  snapshot: TorrentSnapshot | null
  // Why the engine cannot serve this file, if it cannot: OPFS refused (a private or
  // incognito window) or the worker died. Either way nothing will ever arrive, so the
  // player has to say so rather than sit on a spinner forever.
  engineError: string | null
  // Reads a byte range of the selected file straight from the Session (which
  // prioritizes + awaits the covering pieces on demand - ideal for seeking).
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  // Same read but without touching piece priorities - for background consumers
  // (thumbnail generation) that must not fight the playback download order.
  readQuiet: (offset: number, size: number) => Promise<ArrayBuffer>
  // Re-points download priority at a byte offset of the watched file (seeks).
  prioritizeFrom: (offset: number) => void
}

// Drives one torrent for the /embed player: adds the magnet, tracks its live
// snapshot, and exposes a read() bound to the handle once metadata lands.
export const usePlayerTorrent = (magnet: string | undefined, fileIndex: number): PlayerTorrent => {
  const client = getTorrentClient()
  const handleRef = useRef<number | null>(null)
  // One id for this open player, distinct from any other player in this tab or any other.
  // The engine merges every viewer's claim on the shared priority map, so two tabs watching
  // one torrent no longer overwrite each other on every seek, and one of them closing no
  // longer drops the other back to rarest-first.
  const viewerRef = useRef<string>(undefined as unknown as string)
  if (!viewerRef.current) viewerRef.current = client.newViewerId()
  const [snapshot, setSnapshot] = useState<TorrentSnapshot | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)

  useEffect(() => {
    if (!magnet) return
    const offUnavailable = client.onStorageUnavailable(
      () => setEngineError('Ripple needs a normal (non-private) window to play this'),
    )
    const offWorkerError = client.onWorkerError(({ fatal }) => {
      if (fatal) setEngineError('The download engine stopped. Reload the page to try again.')
    })
    // The engine is shared with the library, so this either finds the torrent already
    // running or adds it; the worker dedups by infoHash either way.
    client.addMagnet(magnet)
    // Match on the infoHash, never on the magnet string: the library's copy of the same
    // torrent can carry different trackers or a display name, and with one shared session
    // the list holds every other torrent too, so falling back to "the first one" would
    // happily play the wrong file.
    const infoHash = magnetInfoHash(magnet)
    const viewer = viewerRef.current
    let watching = false
    // A handover builds a fresh session that knows nothing about this tab's streaming order,
    // and the latch below would otherwise never re-arm, leaving playback pulling pieces
    // rarest-first for the rest of the route. The handle is re-read from state either way.
    const offReset = client.onEngineReset(() => { watching = false; handleRef.current = null })
    const off = client.onState((snaps) => {
      const snap = snaps.find((s) => s.magnet === magnet)
        ?? (infoHash ? snaps.find((s) => magnetInfoHash(s.magnet) === infoHash) : undefined)
        ?? null
      if (snap) handleRef.current = snap.handle
      // Watching = stream in order: sequential mode + the watched file first. Both now follow
      // from the engine knowing this player exists.
      if (snap?.files && !watching) {
        watching = true
        client.watch(viewer, snap.handle, fileIndex)
      }
      setSnapshot(snap)
    })
    return () => {
      off()
      offReset()
      offUnavailable()
      offWorkerError()
      // Leaving the player drops this viewer's claim. The session goes back to downloading
      // rarest-first only once nobody is left watching, so closing one of two players no
      // longer stops the other one streaming in order.
      client.unwatch(viewer)
      handleRef.current = null
    }
  }, [client, magnet, fileIndex])

  const readAt = async (offset: number, size: number, prioritize: boolean): Promise<ArrayBuffer> => {
    const handle = handleRef.current
    if (handle == null) throw new Error('torrent not ready')
    // Clamp to the file boundary - the remuxer reads a full buffer near EOF,
    // but the torrent would otherwise await pieces past the file that never land.
    const fileSize = snapshot?.files?.files[fileIndex]?.size
    const clamped = fileSize != null ? Math.max(0, Math.min(size, fileSize - offset)) : size
    if (clamped === 0) return new ArrayBuffer(0)
    const u8 = await client.read(handle, fileIndex, offset, clamped, prioritize, viewerRef.current)
    const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    return buf as ArrayBuffer
  }

  const read = (offset: number, size: number) => readAt(offset, size, true)
  const readQuiet = (offset: number, size: number) => readAt(offset, size, false)

  const prioritizeFrom = (offset: number) => {
    const handle = handleRef.current
    if (handle != null) client.watch(viewerRef.current, handle, fileIndex, Math.max(0, Math.floor(offset)))
  }

  return { snapshot, engineError, read, readQuiet, prioritizeFrom }
}
