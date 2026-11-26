import type { Persisted } from '../torrent/library'
import type { TorrentGroup } from '../torrent/groups'
import type { ExpandedGroups } from '../torrent/list-view'
import type { Torrent } from '../torrent/types'
import type { LinkedGroup } from './group-link'

import { useCallback, useEffect, useMemo, useState } from 'react'

import { createGroup, groupName, putInGroup, torrentsIn, useGroups } from '../torrent/groups'
import { savePathFor } from '../torrent/library'
import { LIST_EXPANDED_GROUPS_KEY, NO_EXPANDED, readExpandedGroups, toggleExpandedGroup, writeExpandedGroups } from '../torrent/list-view'
import { onSettingApplied, setSetting } from '../torrent/settings-sync'
import { useShareableMagnets } from '../torrent/use-shareable-magnet'
import { buildGroupLink } from './group-link'

const persistExpanded = (next: ExpandedGroups) => {
  try {
    if (next.size) localStorage.setItem(LIST_EXPANDED_GROUPS_KEY, writeExpandedGroups(next))
    else localStorage.removeItem(LIST_EXPANDED_GROUPS_KEY)
  } catch {}
}

/**
 * The synced groups and the ids of inline group rows currently expanded in this browser.
 *
 * Unknown group ids are pruned once the stored group list has been read, matching how stale selections
 * are dropped without wiping preferences before IndexedDB resolves.
 */
export const useExpandedGroups = (givenGroups?: readonly TorrentGroup[]) => {
  const syncedGroups = useGroups()
  const groups = givenGroups ?? syncedGroups
  const [stored, setStored] = useState<ExpandedGroups>(() => readExpandedGroups((key) => localStorage.getItem(key)))

  const validIds = useMemo(() => (groups ? new Set(groups.map((g) => g.id)) : undefined), [groups])
  const expanded = useMemo(() => {
    if (!validIds) return stored
    let allValid = true
    for (const id of stored) {
      if (!validIds.has(id)) { allValid = false; break }
    }
    if (allValid) return stored
    const next = new Set([...stored].filter((id) => validIds.has(id)))
    return next.size ? next : NO_EXPANDED
  }, [stored, validIds])

  useEffect(() => {
    if (!validIds || expanded === stored) return
    setStored(expanded)
    persistExpanded(expanded)
  }, [validIds, expanded, stored])

  const toggle = useCallback((groupId: string) => {
    const next = toggleExpandedGroup(stored, groupId)
    setStored(next)
    void setSetting('listExpandedGroups', [...next].sort())
  }, [stored])

  const expand = useCallback((groupId: string) => {
    if (stored.has(groupId)) return
    const next = new Set(stored)
    next.add(groupId)
    setStored(next)
    void setSetting('listExpandedGroups', [...next].sort())
  }, [stored])

  useEffect(() => onSettingApplied('listExpandedGroups', (ids) => {
    setStored(ids.length ? new Set(ids) : NO_EXPANDED)
  }), [])

  return { groups, expanded, toggle, expand }
}

/**
 * The link of a group of `rows`, with how many private torrents it leaves out; null while their magnets are read,
 * which is before the click that copies it, for the reason `useShareableMagnet` gives.
 */
export const useGroupLink = (name: string, rows: readonly Torrent[]) => {
  const read = useShareableMagnets(rows)
  return useMemo(() => read && { ...buildGroupLink(name, read.magnets.map((magnet) => ({ magnet }))), privateLeftOut: read.left }, [name, read])
}

/** A thousand torrents of 1 KiB each, far past the 7,276 characters a link of 250 measured. */
const MAX_RECEIVED_MAGNETS = 1024 * 1024

/**
 * A group read from a link as Add keeps it, its name as a group keeps one (`groupName`); null for none, and for one
 * whose magnets add up past 1 MiB. Each magnet is stored in the list and synced with it, and deflate lets a link of a
 * few thousand characters carry megabytes.
 */
export const receivable = (linked: LinkedGroup | null): LinkedGroup | null =>
  linked && linked.torrents.reduce((total, t) => total + t.magnet.length, 0) <= MAX_RECEIVED_MAGNETS
    ? { ...linked, name: groupName(linked.name) }
    : null

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
  const name = groupName(linked.name)
  const same = groups.find((g) => g.name === name && [...torrentsIn(g)].every((hash) => hashes.includes(hash)))
  if (!same) return createGroup(name, hashes)
  await putInGroup(same.id, hashes)
  return same.id
}
