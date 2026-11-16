import type { Torrent } from './types'

import { useEffect, useState } from 'react'

import { knownPrivate, shareableMagnet } from './torrent-export'

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

export type ShareableMagnets = { magnets: string[], left: number }

/**
 * The shareable magnets of `rows`, in their order, less those of torrents known to be private, which `left` counts as a
 * share link leaves them out; null while they are being read. Read before the click that copies them, for the reason
 * `useShareableMagnet` gives.
 */
export const useShareableMagnets = (rows: readonly Torrent[]): ShareableMagnets | null => {
  const key = JSON.stringify(rows.map((t) => [t.infoHash ?? null, t.magnet ?? null]))
  const [read, setRead] = useState<ShareableMagnets & { key: string } | null>(null)
  useEffect(() => {
    let live = true
    const subjects = (JSON.parse(key) as [string | null, string | null][]).map(([infoHash, magnet]) => ({ infoHash: infoHash ?? undefined, magnet: magnet ?? undefined }))
    void Promise.all(subjects.map(async (t) => (await knownPrivate(t.infoHash) ? null : await shareableMagnet(t))))
      .then((found) => {
        if (live) setRead({ key, magnets: found.filter((magnet): magnet is string => !!magnet), left: found.filter((magnet) => magnet === null).length })
      })
    return () => { live = false }
  }, [key])
  return read?.key === key ? read : null
}
