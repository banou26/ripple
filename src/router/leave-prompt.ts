import type { TorrentSnapshot } from '../torrent/client'
import type { TorrentState } from '../torrent/types'

import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { runningTorrentClient } from '../torrent/client'
import { magnetInfoHash } from '../torrent/magnet'
import { snapshotState } from '../torrent/use-torrents'
import { isFramed } from '../utils/framed'
import { reloadingPage } from '../utils/reload'

const DOWNLOADING = new Set<TorrentState>(['downloading', 'retrying'])

/**
 * Has the browser ask before the tab closes while its engine downloads a torrent the person added; a temporary torrent
 * does not count, and neither does a tab whose closing leaves the engine running in another. Mounted around every page,
 * since the engine goes on downloading whichever one shows. The listener is there only while that holds, since a page
 * holding one at all is kept out of some browsers' back-forward cache. Never inside a frame, whose closing is the
 * page's around it, and never for the page's own reload, after which the engine picks its downloads up again.
 */
export const useLeavePrompt = () => {
  const { key } = useLocation()
  const [ask, setAsk] = useState(false)
  useEffect(() => {
    // a page makes the client as it renders, so it is looked for once each page has
    const client = runningTorrentClient()
    if (!client || isFramed()) return
    let rows: TorrentSnapshot[] = []
    let temporary = new Set<string>()
    let owned = false
    const look = () => setAsk(owned && rows.some((s) => DOWNLOADING.has(snapshotState(s)) && !temporary.has(magnetInfoHash(s.magnet) ?? '')))
    const offs = [
      client.onState((snapshots) => { rows = snapshots; look() }),
      client.onList((list) => { temporary = new Set(list.filter((e) => e.ephemeral).map((e) => e.infoHash)); look() }),
      client.onOwnership((runs) => { owned = runs; look() }),
      // after the latched state, which a stopped engine leaves behind: it downloads nothing until another starts
      client.onWorkerError(({ fatal }) => { if (fatal) { rows = []; look() } }),
    ]
    return () => { for (const off of offs) off() }
  }, [key])

  useEffect(() => {
    if (!ask) return
    const hold = (event: BeforeUnloadEvent) => { if (!reloadingPage()) event.preventDefault() }
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [ask])
}
