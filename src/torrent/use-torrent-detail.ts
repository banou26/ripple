import type { PeerInfo, TrackerInfo } from './worker'

import { useEffect, useState } from 'react'

import { getTorrentClient } from './client'

export interface TorrentDetailView {
  peers: PeerInfo[]
  trackers: TrackerInfo[]
  /** False until the first broadcast for this handle lands, so a panel can say "loading" honestly. */
  loaded: boolean
}

const EMPTY: TorrentDetailView = { peers: [], trackers: [], loaded: false }

/**
 * Peers and trackers for one torrent, live, for as long as this stays mounted with a handle.
 *
 * Pass null to stop. The engine computes this for exactly one torrent at a time and does nothing at
 * all when nobody is asking, which is the whole reason it is a separate channel from the ordinary
 * state broadcast: a library of thirty torrents would otherwise ship every peer of every one of
 * them, twice a second, to draw a panel that is usually closed.
 *
 * Answers are matched against the handle asked for before they are shown. The engine takes a moment
 * to switch subject, so the first broadcast after a change still carries the previous torrent's
 * peers, and rendering them under the new torrent's name is worse than rendering nothing.
 */
export const useTorrentDetail = (handle: number | null): TorrentDetailView => {
  const client = getTorrentClient()
  const [view, setView] = useState<TorrentDetailView>(EMPTY)

  useEffect(() => {
    if (handle == null) {
      setView(EMPTY)
      client.inspect(null)
      return
    }
    // the previous torrent's rows must not survive into this one's panel
    setView(EMPTY)
    client.inspect(handle)
    const off = client.onDetail((detail) => {
      if (!detail || detail.handle !== handle) return
      setView({ peers: detail.peers, trackers: detail.trackers, loaded: true })
    })
    return () => {
      off()
      client.inspect(null)
    }
  }, [client, handle])

  return view
}
