import type { TorrentGroup } from './groups'
import type { ListOrder, OrderKey } from './list-order'
import type {
  CardGroup, CollapsedGroups, ExpandedGroups, ListFilter, ListGroup, SortDir, SortKey,
} from './list-view'
import type { Torrent, TorrentState } from './types'

import { toStart } from '../router/bulk-selection'
import { torrentsIn } from './groups'
import {
  compareTorrents, groupOf, LIST_GROUPS, matchesSearch, torrentSize, visibleTorrents,
} from './list-view'

export type GroupSummary = {
  state: TorrentState
  listGroup: ListGroup
  addedAt: number
  size: number
  progress: number
  down: number
  up: number
  peers: number
  etaSeconds: number | undefined
  members: Torrent[]
  fetchable: Torrent[]
  previewHashes: string[]
  count: number
}

export type GroupEntry = {
  kind: 'group'
  key: `g:${string}`
  group: TorrentGroup
  summary: GroupSummary
}

export type TorrentEntry = {
  kind: 'torrent'
  key: `t:${string}`
  torrent: Torrent
}

export type LibraryEntry = GroupEntry | TorrentEntry

const ACTIVE_PRIORITY: readonly TorrentState[] = ['downloading', 'checking', 'queued', 'retrying', 'starting']

/** Best available creation timestamp for `group`, keeping initial member timestamps across renames. */
export const groupCreationTime = (group: TorrentGroup): number =>
  Math.min(group.namedAt, ...group.members.map((m) => m.at))

export const entryKeyOfTorrent = (t: Torrent): `t:${string}` => `t:${t.infoHash ?? t.id}`
export const entryKeyOfGroup = (group: TorrentGroup): `g:${string}` => `g:${group.id}`

const rankOfState = (state: TorrentState): number => (state === 'missing' ? 2 : state === 'starting' ? 1 : 0)

export const rankMap = <K extends string>(keys: readonly K[]): ReadonlyMap<K, number> =>
  new Map(keys.map((key, index) => [key, index]))

const groupMemberRankMap = (order: ListOrder, groupId: string): ReadonlyMap<string, number> | undefined => {
  const members = order.groups[groupId]?.members
  if (!members?.length) return undefined
  return new Map(members.map((hash, index) => [`t:${hash}`, index]))
}

const aggregateState = (members: readonly Torrent[]): { state: TorrentState, listGroup: ListGroup } => {
  if (members.length === 0) return { state: 'completed', listGroup: 'done' }
  for (const state of ACTIVE_PRIORITY) {
    if (members.some((m) => m.state === state)) return { state, listGroup: 'active' }
  }
  if (members.some((m) => m.state === 'paused')) return { state: 'paused', listGroup: 'paused' }
  if (members.some((m) => m.state === 'seeding')) return { state: 'seeding', listGroup: 'done' }
  if (members.some((m) => m.state === 'completed')) return { state: 'completed', listGroup: 'done' }
  return { state: 'missing', listGroup: 'missing' }
}

const clampedProgress = (t: Torrent): number => {
  if (t.state === 'missing' || t.state === 'starting') return 0
  return Math.max(0, Math.min(1, t.progress))
}

/** Computes aggregate state, progress, transfer rates, fetchable members, and preview hashes for `group`. */
export const summarizeGroup = (
  group: TorrentGroup,
  rawMembers: readonly Torrent[],
  sortKey: SortKey,
  sortDir: SortDir,
  customMemberRank?: ReadonlyMap<string, number>,
): GroupSummary => {
  const members = [...rawMembers].sort(compareTorrents(sortKey, sortDir, customMemberRank))
  const { state, listGroup } = aggregateState(members)

  let size = 0
  let weightedDone = 0
  let progressSum = 0
  let down = 0
  let up = 0
  let peers = 0
  let remaining = 0
  let downloadingCount = 0
  const downloadingEtas: number[] = []

  for (const m of members) {
    const s = torrentSize(m)
    const p = clampedProgress(m)
    size += s
    weightedDone += s * p
    progressSum += p
    if (m.state !== 'missing' && m.state !== 'starting') {
      down += m.down
      up += m.up
      peers += m.peers
    }
    if (m.state === 'downloading') {
      downloadingCount++
      if (s > 0) remaining += s * (1 - p)
      if (m.etaSeconds !== undefined) downloadingEtas.push(m.etaSeconds)
    }
  }

  const progress = members.length === 0 ? 1 : size > 0 ? weightedDone / size : progressSum / members.length
  const etaSeconds = state !== 'downloading'
    ? undefined
    : downloadingCount > 0 && downloadingEtas.length === downloadingCount
      ? Math.max(...downloadingEtas)
      : remaining > 0 && down > 0
        ? Math.round(remaining / down)
        : undefined

  const previewHashes: string[] = []
  const seenHashes = new Set<string>()
  for (const m of members) {
    if (m.infoHash && !seenHashes.has(m.infoHash)) {
      seenHashes.add(m.infoHash)
      previewHashes.push(m.infoHash)
      if (previewHashes.length >= 4) break
    }
  }

  return {
    state,
    listGroup,
    addedAt: groupCreationTime(group),
    size,
    progress,
    down,
    up,
    peers,
    etaSeconds,
    members,
    fetchable: toStart(members),
    previewHashes,
    count: members.length,
  }
}

const entryValue = (
  entry: LibraryEntry,
  key: SortKey,
  customTopRank?: ReadonlyMap<string, number>,
): number | string | null => {
  if (key === 'custom') return customTopRank?.get(entry.key) ?? null
  if (entry.kind === 'torrent') {
    const t = entry.torrent
    const pending = t.state === 'starting' || t.state === 'missing'
    switch (key) {
      case 'name': return t.name
      case 'added': return t.addedAt ?? null
      case 'size': {
        const size = torrentSize(t)
        return size > 0 ? size : null
      }
      case 'eta': return t.etaSeconds ?? null
      case 'progress': return pending ? null : t.progress
      case 'down': return pending ? null : t.down
      case 'up': return pending ? null : t.up
      case 'peers': return pending ? null : t.peers
    }
  }
  const s = entry.summary
  const pending = s.state === 'starting' || s.state === 'missing'
  switch (key) {
    case 'name': return entry.group.name
    case 'added': return s.addedAt
    case 'size': return s.size > 0 ? s.size : null
    case 'eta': return s.etaSeconds ?? null
    case 'progress': return pending ? null : s.progress
    case 'down': return pending ? null : s.down
    case 'up': return pending ? null : s.up
    case 'peers': return pending ? null : s.peers
  }
}

const entryAddedAt = (entry: LibraryEntry): number =>
  entry.kind === 'group' ? entry.summary.addedAt : (entry.torrent.addedAt ?? 0)

export const compareEntries = (
  key: SortKey,
  dir: SortDir,
  customTopRank?: ReadonlyMap<string, number>,
) => (a: LibraryEntry, b: LibraryEntry): number => {
  const ra = entryRank(a)
  const rb = entryRank(b)
  if (ra !== rb) return ra - rb
  const va = entryValue(a, key, customTopRank)
  const vb = entryValue(b, key, customTopRank)
  if (va === null && vb === null) return entryAddedAt(b) - entryAddedAt(a) || a.key.localeCompare(b.key)
  if (va === null) return 1
  if (vb === null) return -1
  const c = typeof va === 'string'
    ? va.localeCompare(vb as string, undefined, { numeric: true, sensitivity: 'base' })
    : va - (vb as number)
  return c !== 0 ? (dir === 'asc' ? c : -c) : entryAddedAt(b) - entryAddedAt(a) || a.key.localeCompare(b.key)
}

const entryRank = (entry: LibraryEntry): number =>
  entry.kind === 'group' ? rankOfState(entry.summary.state) : rankOfState(entry.torrent.state)

export const entryGroupOf = (entry: LibraryEntry): ListGroup =>
  entry.kind === 'group' ? entry.summary.listGroup : groupOf(entry.torrent)

/**
 * Builds sorted top-level library entries: groups replace their member torrents at the top level while
 * loose torrents stay outside, matching the symlink multi-group model.
 */
export const buildLibraryEntries = ({
  torrents,
  groups,
  filter,
  searchText,
  sortKey,
  sortDir,
  order,
}: {
  torrents: readonly Torrent[]
  groups: readonly TorrentGroup[]
  filter: ListFilter
  searchText: string
  sortKey: SortKey
  sortDir: SortDir
  order: ListOrder
}): LibraryEntry[] => {
  const byHash = new Map<string, Torrent>()
  for (const t of torrents) {
    if (t.infoHash && !byHash.has(t.infoHash)) byHash.set(t.infoHash, t)
  }

  const groupedHashes = new Set<string>()
  for (const g of groups) {
    for (const hash of torrentsIn(g)) groupedHashes.add(hash)
  }

  const typed = searchText.trim().toLowerCase()
  const broadFilter = filter === 'all' || filter === 'library'
  const entries: LibraryEntry[] = []

  for (const group of groups) {
    const memberSet = torrentsIn(group)
    const rawMembers: Torrent[] = []
    for (const hash of memberSet) {
      const row = byHash.get(hash)
      if (row) rawMembers.push(row)
    }
    const filteredMembers = visibleTorrents(rawMembers, filter)
    const groupNameMatches = typed ? group.name.toLowerCase().includes(typed) : false
    const matchedMembers = typed ? filteredMembers.filter((t) => matchesSearch(t, typed)) : filteredMembers

    let shownMembers: Torrent[]
    if (!typed) {
      if (filteredMembers.length === 0 && (!broadFilter || rawMembers.length > 0)) continue
      shownMembers = filteredMembers
    } else {
      if (matchedMembers.length > 0) shownMembers = matchedMembers
      else if (groupNameMatches && (filteredMembers.length > 0 || (broadFilter && rawMembers.length === 0))) shownMembers = filteredMembers
      else continue
    }

    const customMembers = sortKey === 'custom' ? groupMemberRankMap(order, group.id) : undefined
    const summary = summarizeGroup(group, shownMembers, sortKey, sortDir, customMembers)
    entries.push({ kind: 'group', key: entryKeyOfGroup(group), group, summary })
  }

  const loose = visibleTorrents(torrents, filter).filter((t) => !(t.infoHash && groupedHashes.has(t.infoHash)))
  const visibleLoose = typed ? loose.filter((t) => matchesSearch(t, typed)) : loose
  for (const torrent of visibleLoose) {
    entries.push({ kind: 'torrent', key: entryKeyOfTorrent(torrent), torrent })
  }

  const customTop = sortKey === 'custom' ? rankMap(order.top) : undefined
  return entries.sort(compareEntries(sortKey, sortDir, customTop))
}

/** Splits mixed library entries by category heading, omitting empty categories on multi-state filters. */
export const cardEntryGroups = (
  entries: readonly LibraryEntry[],
  filter: ListFilter,
  groupOfFn: (entry: LibraryEntry) => ListGroup = entryGroupOf,
): CardGroup<LibraryEntry>[] =>
  filter === 'all' || filter === 'library' || filter === 'temporary'
    ? LIST_GROUPS
      .map((name) => ({ group: name, rows: entries.filter((entry) => groupOfFn(entry) === name) }))
      .filter(({ rows }) => rows.length > 0)
    : [{ group: null, rows: [...entries] }]

/**
 * Returns every torrent currently visible on screen in display order (skipping folded categories and collapsed groups),
 * deduplicated by info hash / id so multi-group symlink torrents are counted once in bulk selection.
 */
export const visibleEntryTorrents = (
  groups: readonly CardGroup<LibraryEntry>[],
  collapsedCategories: CollapsedGroups,
  expandedGroups: ExpandedGroups,
): Torrent[] => {
  const seen = new Set<string>()
  const out: Torrent[] = []
  const push = (t: Torrent) => {
    const key = t.infoHash ?? t.id
    if (seen.has(key)) return
    seen.add(key)
    out.push(t)
  }
  for (const category of groups) {
    if (category.group && collapsedCategories.has(category.group)) continue
    for (const entry of category.rows) {
      if (entry.kind === 'torrent') push(entry.torrent)
      else if (expandedGroups.has(entry.group.id)) entry.summary.members.forEach(push)
    }
  }
  return out
}

export const visibleTopKeys = (entries: readonly LibraryEntry[]): OrderKey[] =>
  entries.map((entry) => entry.key)

export const groupMemberKeys = (summary: GroupSummary): string[] =>
  summary.members.flatMap((t) => (t.infoHash ? [t.infoHash] : []))
