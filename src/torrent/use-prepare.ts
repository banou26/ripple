import { useEffect, useState } from 'react'

import { getTorrentClient } from './client'
import { magnetInfoHash } from './magnet'
import { pickVideoFile } from './watch'

export type Prepared = { magnet: string, fileIndex?: number }

/**
 * The file an embedder expects to play next, prepared: its torrent added with its file list fetched and nothing
 * else (`hold`, ephemeral as a player's), then its head and tail claimed, on the file named or else its video file.
 * The claim lasts until the next one, or until the page goes, so an `open` of the same file finds it still held and
 * its peers still connected.
 */
export const usePrepare = () => {
  const [next, setNext] = useState<Prepared>()

  useEffect(() => {
    if (!next) return
    const { magnet, fileIndex } = next
    const client = getTorrentClient()
    const viewer = client.newViewerId()
    client.addMagnet(magnet, { ephemeral: true, hold: true })
    const infoHash = magnetInfoHash(magnet)
    let claimed = false
    const offReset = client.onEngineReset(() => { claimed = false })
    const off = client.onState((snaps) => {
      if (claimed) return
      const snap = snaps.find((s) => s.magnet === magnet)
        ?? (infoHash ? snaps.find((s) => magnetInfoHash(s.magnet) === infoHash) : undefined)
      if (!snap?.files) return
      claimed = true
      client.prepare(viewer, snap.handle, fileIndex ?? pickVideoFile(snap.files.files.map((f) => ({ name: f.path, size: f.size, pad: f.pad }))))
    })
    return () => {
      off()
      offReset()
      client.unwatch(viewer)
    }
  }, [next])

  return setNext
}
