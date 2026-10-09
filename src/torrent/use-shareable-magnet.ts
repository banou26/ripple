import type { Torrent } from './types'

import { useEffect, useState } from 'react'

import { shareableMagnet } from './torrent-export'

/**
 * `t`'s shareable magnet, or null while it is still being read.
 *
 * Read BEFORE the click that copies it, because the copy has to call `clipboard.writeText` inside
 * that click: WebKit 26 refuses a write that awaited IndexedDB first (NotAllowedError), where
 * Chromium 153 and Firefox 146 accept it (measured 2026-10-09). So a menu offering Copy magnet opens
 * once this answers, one read later, and the click writes a string it already holds.
 */
export const useShareableMagnet = (t: Torrent | undefined): { magnet: string | undefined } | null => {
  const [read, setRead] = useState<{ id: string, from: string | undefined, magnet: string | undefined } | null>(null)
  const id = t?.id
  const infoHash = t?.infoHash
  const from = t?.magnet
  useEffect(() => {
    if (id === undefined) return
    let live = true
    void shareableMagnet({ infoHash, magnet: from }).then((magnet) => { if (live) setRead({ id, from, magnet }) })
    return () => { live = false }
  }, [id, infoHash, from])
  return t && read?.id === t.id && read.from === t.magnet ? read : null
}
