import { useEffect, useRef, useState } from 'react'

import { getTorrentClient } from './client'
import type { TorrentSnapshot } from './client'
import { magnetInfoHash } from './magnet'

export type PlayerTorrent = {
  snapshot: TorrentSnapshot | null
  engineError: string | null
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

  useEffect(() => {
    if (!magnet) return
    const offUnavailable = client.onStorageUnavailable(
      () => setEngineError('Ripple needs a normal (non-private) window to play this'),
    )
    const offWorkerError = client.onWorkerError(({ fatal }) => {
      if (fatal) setEngineError('The download engine stopped. Reload the page to try again.')
    })
    client.addMagnet(magnet)
    // match on the infoHash, never on the magnet string, and never on "the first one"
    const infoHash = magnetInfoHash(magnet)
    const viewer = viewerRef.current
    let watching = false
    const offReset = client.onEngineReset(() => { watching = false; handleRef.current = null })
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

  const read = (offset: number, size: number) => readAt(offset, size, true)
  const readQuiet = (offset: number, size: number) => readAt(offset, size, false)

  const prioritizeFrom = (offset: number) => {
    const handle = handleRef.current
    if (handle != null) client.watch(viewerRef.current, handle, fileIndex, Math.max(0, Math.floor(offset)))
  }

  return { snapshot, engineError, read, readQuiet, prioritizeFrom }
}
