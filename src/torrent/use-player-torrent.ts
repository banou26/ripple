import { useEffect, useRef, useState } from 'react'

import { getTorrentClient } from './client'
import type { TorrentSnapshot } from './client'
import { magnetInfoHash } from './magnet'
import { makeReadWindowStore } from './read-window-store'

export type PlayerTorrent = {
  snapshot: TorrentSnapshot | null
  engineError: string | null
  /** The browser's storage budget is exhausted and the engine has nothing left it may reclaim. */
  storageFull: boolean
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  readQuiet: (offset: number, size: number) => Promise<ArrayBuffer>
  prioritizeFrom: (offset: number) => void
}

export const usePlayerTorrent = (magnet: string | undefined, fileIndex: number): PlayerTorrent => {
  const client = getTorrentClient()
  const handleRef = useRef<number | null>(null)
  // one id per open player: the engine merges every viewer's claim on the shared priority map
  const viewerRef = useRef<string>(undefined as unknown as string)
  if (!viewerRef.current) viewerRef.current = client.newViewerId()
  const [snapshot, setSnapshot] = useState<TorrentSnapshot | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [storageFull, setStorageFull] = useState(false)
  // playback only; the thumbnailer seeks all over the file and would evict the windows the player needs
  const readWindows = useRef(makeReadWindowStore())

  useEffect(() => {
    if (!magnet) return
    // held windows belong to one file of one torrent; nothing about them survives a change of either
    readWindows.current.clear()
    const offUnavailable = client.onStorageUnavailable(
      () => setEngineError('Ripple needs a normal (non-private) window to play this'),
    )
    const offWorkerError = client.onWorkerError(({ fatal }) => {
      if (fatal) setEngineError('The download engine stopped. Reload the page to try again.')
    })
    const offFull = client.onStorageFull(setStorageFull)
    // Ephemeral: the page asked for this, not the person using it. That makes its bytes a cache the
    // engine may reclaim when the origin runs short, which is what keeps one embedding page playing
    // episode after episode from filling the browser's whole budget and stalling on a failed write.
    // Adding the same magnet by hand in the library promotes it out of the cache for good.
    client.addMagnet(magnet, { ephemeral: true })
    // match on the infoHash, never on the magnet string, and never on "the first one"
    const infoHash = magnetInfoHash(magnet)
    const viewer = viewerRef.current
    let watching = false
    const offReset = client.onEngineReset(() => {
      watching = false
      handleRef.current = null
      readWindows.current.clear()
    })
    const off = client.onState((snaps) => {
      const snap = snaps.find((s) => s.magnet === magnet)
        ?? (infoHash ? snaps.find((s) => magnetInfoHash(s.magnet) === infoHash) : undefined)
        ?? null
      if (snap) handleRef.current = snap.handle
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
      offFull()
      client.unwatch(viewer)
      handleRef.current = null
    }
  }, [client, magnet, fileIndex])

  const readAt = async (offset: number, size: number, prioritize: boolean): Promise<ArrayBuffer> => {
    const handle = handleRef.current
    if (handle == null) throw new Error('torrent not ready')
    // clamp to the file boundary or a read near EOF awaits pieces that never land
    const fileSize = snapshot?.files?.files[fileIndex]?.size
    const clamped = fileSize != null ? Math.max(0, Math.min(size, fileSize - offset)) : size
    if (clamped === 0) return new ArrayBuffer(0)
    const u8 = await client.read(handle, fileIndex, offset, clamped, prioritize, viewerRef.current)
    const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    return buf as ArrayBuffer
  }

  /**
   * Playback reads, served out of the window store whenever they can be.
   *
   * A hit still has to tell the engine where the reader is. Nothing else advances the stream window during
   * playback: prioritizeFrom fires only on an explicit seek, so before this the window was being carried
   * by the reads themselves, and caching them silently would have stopped the engine following the
   * playhead. The read length goes with it, so the move takes the same re-anchor test the read would have:
   * without it, a hit on a demuxer index probe at the file's tail would drag the deadlined band to the end
   * of the file and strand the header the player is about to need.
   */
  const read = async (offset: number, size: number) => {
    const hit = readWindows.current.get(offset, size)
    if (hit) {
      const handle = handleRef.current
      if (handle != null) {
        client.watch(viewerRef.current, handle, fileIndex, Math.max(0, Math.floor(offset)), size)
      }
      return hit
    }
    // Ask for exactly what was asked of us, never more. A read waits for its PIECES, and the deadlined
    // band is sized from one READ_SIZE, so inflating this would block the player on pieces nothing marked
    // urgent. The whole read is then kept, which is what the reads walking through it afterwards hit.
    const buffer = await readAt(offset, size, true)
    readWindows.current.put(offset, buffer)
    // never hand back the buffer the store is holding, even when it is exactly the size asked for: the
    // consumer is free to neuter what it receives, and an osra transfer() on this path would detach the
    // window in place and leave it reporting zero bytes for the rest of the session
    return buffer.slice(0, Math.min(size, buffer.byteLength))
  }

  const readQuiet = (offset: number, size: number) => readAt(offset, size, false)

  const prioritizeFrom = (offset: number) => {
    const handle = handleRef.current
    if (handle != null) client.watch(viewerRef.current, handle, fileIndex, Math.max(0, Math.floor(offset)))
  }

  return { snapshot, engineError, storageFull, read, readQuiet, prioritizeFrom }
}
