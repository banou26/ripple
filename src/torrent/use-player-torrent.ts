import { useEffect, useRef, useState } from 'react'

import { createTorrentClient } from './client'
import type { TorrentClient, TorrentSnapshot } from './client'
import { getBackend } from './backend'

export type PlayerTorrent = {
  snapshot: TorrentSnapshot | null
  // Reads a byte range of the selected file straight from the Session (which
  // prioritizes + awaits the covering pieces on demand - ideal for seeking).
  read: (offset: number, size: number) => Promise<ArrayBuffer>
  // Re-points download priority at a byte offset of the watched file (seeks).
  prioritizeFrom: (offset: number) => void
}

// Drives one torrent for the /embed player: adds the magnet, tracks its live
// snapshot, and exposes a read() bound to the handle once metadata lands.
export const usePlayerTorrent = (magnet: string | undefined, fileIndex: number): PlayerTorrent => {
  const clientRef = useRef<TorrentClient | null>(null)
  const handleRef = useRef<number | null>(null)
  const [snapshot, setSnapshot] = useState<TorrentSnapshot | null>(null)

  useEffect(() => {
    if (!magnet) return
    const client = createTorrentClient(getBackend())
    clientRef.current = client
    client.ready.then(() => client.addMagnet(magnet))
    let sequentialSet = false
    const off = client.onState((snaps) => {
      const snap = snaps.find((s) => s.magnet === magnet) ?? snaps[0] ?? null
      if (snap) handleRef.current = snap.handle
      // Watching = stream in order: sequential mode + the watched file first.
      if (snap?.files && !sequentialSet) {
        sequentialSet = true
        client.setSequential(snap.handle, true)
        client.prioritizeFile(snap.handle, fileIndex)
      }
      setSnapshot(snap)
    })
    return () => { off(); client.destroy(); clientRef.current = null; handleRef.current = null }
  }, [magnet, fileIndex])

  const read = async (offset: number, size: number): Promise<ArrayBuffer> => {
    const client = clientRef.current
    const handle = handleRef.current
    if (!client || handle == null) throw new Error('torrent not ready')
    // Clamp to the file boundary - the remuxer reads a full buffer near EOF,
    // but the torrent would otherwise await pieces past the file that never land.
    const fileSize = snapshot?.files?.files[fileIndex]?.size
    const clamped = fileSize != null ? Math.max(0, Math.min(size, fileSize - offset)) : size
    if (clamped === 0) return new ArrayBuffer(0)
    const u8 = await client.read(handle, fileIndex, offset, clamped)
    const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength
      ? u8.buffer
      : u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
    return buf as ArrayBuffer
  }

  const prioritizeFrom = (offset: number) => {
    const client = clientRef.current
    const handle = handleRef.current
    if (client && handle != null) client.prioritizeFile(handle, fileIndex, Math.max(0, Math.floor(offset)))
  }

  return { snapshot, read, prioritizeFrom }
}
