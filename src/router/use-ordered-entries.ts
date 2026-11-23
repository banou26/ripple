import type { LibraryEntry } from '../torrent/group-rows'
import type { TorrentGroup } from '../torrent/groups'
import type { ListOrder, OrderKey } from '../torrent/list-order'
import type { ListFilter, ListGroup, SortDir, SortKey } from '../torrent/list-view'
import type { Torrent } from '../torrent/types'

import { useCallback, useRef, useState } from 'react'

import { buildLibraryEntries, entryGroupOf } from '../torrent/group-rows'
import { isVolatile, shouldReorder } from '../torrent/list-view'

type GroupHold = { groups: ReadonlyMap<OrderKey, ListGroup>, movedAt: number | null }

const isStartingEntry = (entry: LibraryEntry): boolean =>
  entry.kind === 'torrent' ? entry.torrent.state === 'starting' : entry.summary.state === 'starting'

const nextGroupHold = (
  hold: GroupHold,
  entries: readonly LibraryEntry[],
  viewChanged: boolean,
  interacting: boolean,
  now: number,
): GroupHold => {
  const live = new Map(entries.map((e) => [e.key, entryGroupOf(e)]))
  const groups = new Map([...hold.groups].filter(([k]) => live.has(k)))
  for (const e of entries) {
    if (!isStartingEntry(e) && !groups.has(e.key)) groups.set(e.key, entryGroupOf(e))
  }
  let movedAt = [...groups].some(([k, group]) => live.get(k) !== group) ? hold.movedAt ?? now : null
  if (movedAt !== null && shouldReorder({ viewChanged, idsChanged: false, volatile: true, interacting, sinceMs: now - movedAt })) {
    for (const [k, group] of live) if (groups.has(k)) groups.set(k, group)
    movedAt = null
  }
  const same = movedAt === hold.movedAt
    && groups.size === hold.groups.size
    && [...groups].every(([k, group]) => hold.groups.get(k) === group)
  return same ? hold : { groups, movedAt }
}

const orderSignature = (order: ListOrder): string =>
  `${order.updatedAt}:${Object.entries(order.groups).map(([id, g]) => `${id}@${g.updatedAt}`).join(',')}`

/**
 * Arranges top-level library entries (groups + loose torrents) and group members, holding order and category
 * headings still for a short window during volatile rate/progress sorts while updating numbers every tick.
 */
export const useOrderedEntries = (
  torrents: readonly Torrent[],
  groups: readonly TorrentGroup[],
  filter: ListFilter,
  searchText: string,
  sortKey: SortKey,
  sortDir: SortDir,
  order: ListOrder,
  now: () => number = Date.now,
) => {
  const fresh = buildLibraryEntries({ torrents, groups, filter, searchText, sortKey, sortDir, order })
  const freshMap = new Map(fresh.map((e) => [e.key, e]))

  const heldOrder = useRef<OrderKey[]>([])
  const heldMembers = useRef<Map<string, string[]>>(new Map())
  const heldAt = useRef(0)
  const interacting = useRef(false)
  const viewKey = `${filter}\0${searchText}\0${sortKey}\0${sortDir}\0${orderSignature(order)}`
  const [view, setView] = useState(viewKey)
  const [groupHold, setGroupHold] = useState<GroupHold>({ groups: new Map(), movedAt: null })

  const currentNow = now()
  const viewChanged = view !== viewKey
  if (viewChanged) setView(viewKey)

  const idsChanged = heldOrder.current.length !== fresh.length
    || heldOrder.current.some((key) => !freshMap.has(key))
    || fresh.some((e) => {
      if (e.kind !== 'group') return false
      const prevM = heldMembers.current.get(e.group.id)
      const nowM = e.summary.members.map((m) => m.infoHash ?? m.id)
      return !prevM || prevM.length !== nowM.length || nowM.some((id) => !prevM.includes(id))
    })

  const touching = interacting.current

  if (shouldReorder({
    viewChanged,
    idsChanged,
    volatile: isVolatile(sortKey),
    interacting: touching,
    sinceMs: currentNow - heldAt.current,
  })) {
    heldOrder.current = fresh.map((e) => e.key)
    const nextMembers = new Map<string, string[]>()
    for (const e of fresh) {
      if (e.kind === 'group') nextMembers.set(e.group.id, e.summary.members.map((m) => m.infoHash ?? m.id))
    }
    heldMembers.current = nextMembers
    heldAt.current = currentNow
  }

  const entries: LibraryEntry[] = []
  const placed = new Set<OrderKey>()
  for (const key of heldOrder.current) {
    const entry = freshMap.get(key)
    if (!entry) continue
    placed.add(key)
    if (entry.kind !== 'group') {
      entries.push(entry)
      continue
    }
    const orderIds = heldMembers.current.get(entry.group.id)
    if (!orderIds) { entries.push(entry); continue }
    const byId = new Map(entry.summary.members.map((m) => [m.infoHash ?? m.id, m]))
    const orderedMembers = orderIds.flatMap((id) => {
      const m = byId.get(id)
      return m ? [m] : []
    })
    for (const m of entry.summary.members) {
      if (!orderedMembers.includes(m)) orderedMembers.push(m)
    }
    entries.push({ ...entry, summary: { ...entry.summary, members: orderedMembers } })
  }
  for (const entry of fresh) {
    if (!placed.has(entry.key)) entries.push(entry)
  }

  const held = nextGroupHold(groupHold, entries, viewChanged || idsChanged, touching, currentNow)
  if (held !== groupHold) setGroupHold(held)

  const latestGroups = useRef(held.groups)
  latestGroups.current = held.groups

  const groupOfEntry = useCallback(
    (entry: LibraryEntry): ListGroup => latestGroups.current.get(entry.key) ?? entryGroupOf(entry),
    [],
  )

  const interaction = useRef({
    onPointerEnter: () => { interacting.current = true },
    onPointerLeave: () => { interacting.current = false },
    onFocusCapture: () => { interacting.current = true },
    onBlurCapture: () => { interacting.current = false },
  }).current

  return { entries, groupOf: groupOfEntry, interaction }
}
