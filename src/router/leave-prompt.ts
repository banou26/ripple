import type { Torrent } from '../torrent/types'

import { useEffect } from 'react'

import { isFramed } from '../utils/framed'

/**
 * Has the browser ask before the tab closes while a torrent the person added downloads and this tab runs the engine,
 * the one whose closing stops it; a temporary torrent does not count. The listener is there only while that holds,
 * since a page holding one at all is kept out of some browsers' back-forward cache. Never inside a frame, whose
 * closing is the page's around it.
 */
export const useLeavePrompt = (torrents: readonly Torrent[], runsEngine: boolean) => {
  const ask = runsEngine && torrents.some((t) => t.ephemeral !== true && (t.state === 'downloading' || t.state === 'retrying'))
  useEffect(() => {
    if (!ask || isFramed()) return
    const hold = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', hold)
    return () => window.removeEventListener('beforeunload', hold)
  }, [ask])
}
