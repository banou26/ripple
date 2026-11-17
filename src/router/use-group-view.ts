import type { Torrent } from '../torrent/types'

import { useEffect, useRef, useState } from 'react'

import { putInGroup, torrentsIn, useGroups } from '../torrent/groups'
import { LIST_GROUP_KEY, isTemporary, readGroup } from '../torrent/list-view'

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
