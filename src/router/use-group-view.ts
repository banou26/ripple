import type { Persisted } from '../torrent/library'
import type { TorrentGroup } from '../torrent/groups'
import type { Torrent } from '../torrent/types'
import type { LinkedGroup } from './group-link'

import { useEffect, useMemo, useRef, useState } from 'react'

import { createGroup, putInGroup, torrentsIn, useGroups } from '../torrent/groups'
import { savePathFor } from '../torrent/library'
import { LIST_GROUP_KEY, isTemporary, readGroup } from '../torrent/list-view'
import { useShareableMagnets } from '../torrent/use-shareable-magnet'
import { buildGroupLink } from './group-link'

/**
 * The groups, and the one the list shows, remembered in this browser. `group` is undefined for every torrent, and while
 * the stored id names no group: one deleted here or on another device, or before this browser's copy has been read.
 *
 * A torrent added while a group is shown joins it: kept, on this device, added after this tab showed the group, and
 * never in it or taken out of it before. So rows from sync, a player's temporary torrent and a torrent taken out on
 * purpose stay out, as does every torrent the list held already.
 */
export const useGroupView = (torrents: readonly Torrent[]) => {
  const groups = useGroups()
  const [chosen, setChosen] = useState(() => readGroup((key) => localStorage.getItem(key)))
  const shownAt = useRef(0)
  const group = chosen ? groups?.find((g) => g.id === chosen) : undefined
  useEffect(() => { shownAt.current = Date.now() }, [])

  const choose = (id: string | null) => {
    setChosen(id)
    shownAt.current = Date.now()
    try {
      if (id) localStorage.setItem(LIST_GROUP_KEY, id)
      else localStorage.removeItem(LIST_GROUP_KEY)
    } catch {}
  }

  useEffect(() => {
    if (!group) return
    const known = new Set(group.members.map((m) => m.infoHash))
    const joining = torrents.flatMap((t) => t.infoHash && !known.has(t.infoHash) && t.state !== 'missing' && !isTemporary(t)
      && (t.addedAt ?? 0) >= shownAt.current ? [t.infoHash] : [])
    if (joining.length) putInGroup(group.id, joining).catch(() => {})
  }, [group, torrents])

  return { groups, group, members: group ? torrentsIn(group) : undefined, choose }
}

/**
 * The link of a group of `rows`, with how many private torrents it leaves out; null while their magnets are read,
 * which is before the click that copies it, for the reason `useShareableMagnet` gives.
 */
export const useGroupLink = (name: string, rows: readonly Torrent[]) => {
  const read = useShareableMagnets(rows)
  return useMemo(() => read && { ...buildGroupLink(name, read.magnets.map((magnet) => ({ magnet }))), privateLeftOut: read.left }, [name, read])
}

/**
 * Copies a group read from a link into the list, as rows not on this device, and into a group, resolving to its id.
 * A group of the same name holding only torrents the link names takes the rest, so a link opened twice, or a newer one
 * of the same group, adds only what is new. Each row gets its own save path, since one in the shared root would have
 * its removal delete another's files, and the time of now, so a torrent removed before comes back.
 */
export const addLinkedGroup = async (
  linked: LinkedGroup, groups: readonly TorrentGroup[], importList: (list: Persisted[]) => void,
): Promise<string | null> => {
  const addedAt = Date.now()
  importList(linked.torrents.map(({ infoHash, magnet }) => ({ infoHash, magnet, savePath: savePathFor(infoHash), addedAt })))
  const hashes = linked.torrents.map((t) => t.infoHash)
  const name = linked.name.trim()
  const same = groups.find((g) => g.name === name && [...torrentsIn(g)].every((hash) => hashes.includes(hash)))
  if (!same) return createGroup(name, hashes)
  await putInGroup(same.id, hashes)
  return same.id
}
