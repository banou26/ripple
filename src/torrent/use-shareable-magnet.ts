import type { Torrent } from './types'

import { useEffect, useState } from 'react'

import { magnetToCopy } from './torrent-export'

/**
 * `t`'s magnet to copy, `magnet: null` when it is known to be private, as `useShareableMagnets` leaves it out; null
 * while it is still being read.
 *
 * Read BEFORE the click that copies it, because the copy has to call `clipboard.writeText` inside
 * that click: WebKit 26 refuses a write that awaited IndexedDB first (NotAllowedError), where
 * Chromium 153 and Firefox 146 accept it (measured 2026-10-09). So a menu offering Copy magnet opens
 * once this answers, one read later, and the click writes a string it already holds.
 */
export const useShareableMagnet = (t: Torrent | undefined): { magnet: string | undefined | null } | null => {
  const [read, setRead] = useState<{ id: string, from: string | undefined, isPrivate: boolean, magnet: string | undefined | null } | null>(null)
  const id = t?.id
  const infoHash = t?.infoHash
  const from = t?.magnet
  const isPrivate = t?.private === true
  useEffect(() => {
    if (id === undefined) return
    let live = true
    void magnetToCopy({ infoHash, magnet: from, private: isPrivate }).then(({ magnet }) => { if (live) setRead({ id, from, isPrivate, magnet }) })
    return () => { live = false }
  }, [id, infoHash, from, isPrivate])
  return t && read?.id === t.id && read.from === t.magnet && read.isPrivate === isPrivate ? read : null
}

export type ShareableMagnets = { magnets: string[], left: number }

/**
 * Each torrent's magnet to copy, or null for one known to be private, by `[infoHash, magnet, addedAt]`. Kept for the
 * page once a file kept here answered it: that file does not change while the torrent is listed, and one removed and
 * added again has another `addedAt`. A torrent with no file here yet is read again each time.
 */
const copies = new Map<string, Promise<string | undefined | null>>()

const copyOf = (row: string): Promise<string | undefined | null> => {
  let copy = copies.get(row)
  if (!copy) {
    const [infoHash, magnet, , priv] = JSON.parse(row) as [string | null, string | null, number | null, boolean?]
    copy = magnetToCopy({ infoHash: infoHash ?? undefined, magnet: magnet ?? undefined, private: priv === true }).then((found) => {
      if (!found.kept) copies.delete(row)
      return found.magnet
    })
    copies.set(row, copy)
  }
  return copy
}

/**
 * The shareable magnets of `rows`, in their order, less those of torrents known to be private, which `left` counts as a
 * share link leaves them out; null while they are being read. Read before the click that copies them, for the reason
 * `useShareableMagnet` gives.
 */
export const useShareableMagnets = (rows: readonly Torrent[]): ShareableMagnets | null => {
  const key = rows.map((t) => JSON.stringify([t.infoHash ?? null, t.magnet ?? null, t.addedAt ?? null, t.private === true])).join('\n')
  const [read, setRead] = useState<ShareableMagnets & { key: string } | null>(null)
  useEffect(() => {
    let live = true
    void Promise.all(key ? key.split('\n').map(copyOf) : []).then((found) => {
      if (live) setRead({ key, magnets: found.filter((magnet): magnet is string => !!magnet), left: found.filter((magnet) => magnet === null).length })
    })
    return () => { live = false }
  }, [key])
  return read?.key === key ? read : null
}
