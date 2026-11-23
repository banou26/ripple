import type { Torrent } from './types'

import { defineMessage, defineMessages } from 'react-intl'

import { ownsItsDirectory } from './library'
import { hexInfoHash } from './magnet'
import { chosenFiles, contentFiles } from './types'

/**
 * How the library list is filtered, sorted and arranged, as arithmetic with no React in it.
 *
 * Pure for the same reason save-location.ts is: these are rules that can be wrong in ways no
 * screenshot would catch. A comparator that reads a field which is null for a second after every
 * reload crashes the whole route; one that treats "unknown" as zero silently claims a torrent nobody
 * has measured is the smallest one. Both are arithmetic, so both are tested here.
 */

// ---------------------------------------------------------------------------------------- the word

/**
 * TEMPORARY, never "ephemeral" and never "cache".
 *
 * "Cache" names a store the machine manages and the person is not meant to think about, which is the
 * opposite of the intent: this is exactly the fact they DO need to know. And every torrent is bytes
 * on disk, so "cache" does not separate anything. "Temporary" names the consequence, which is the
 * part that costs them something.
 */
export const TEMPORARY_HINT = defineMessage({ id: 'May be deleted to free space. Open options to keep it.', defaultMessage: 'May be deleted to free space. Open options to keep it.' })

/**
 * Whether Ripple may delete this torrent's files to free space once it is temporary: the budget pass's own rule
 * ({@link ownsItsDirectory}), so never a torrent in the person's folder, one made from their own files, or a .torrent
 * added at the shared root. Only such a torrent is asked about, told about or marked as one that may be deleted.
 */
export const reclaimable = (t: Pick<Torrent, 'infoHash' | 'stats'>): boolean =>
  ownsItsDirectory(t.stats?.savePath, t.infoHash)

// -------------------------------------------------------------------------------------- the filter

/** What the Show menu offers, in its order. Every value past Temporary is a `TorrentState`, matched as it is. */
export const FILTERS = ['all', 'library', 'temporary', 'downloading', 'seeding', 'completed', 'paused', 'missing', 'retrying'] as const

export type ListFilter = typeof FILTERS[number]

export const FILTER_LABEL = defineMessages<ListFilter>({
  all: { id: 'All', defaultMessage: 'All' },
  library: { id: 'Kept', defaultMessage: 'Kept' },
  temporary: { id: 'Temporary#filter', defaultMessage: 'Temporary', description: 'filter' },
  downloading: { id: 'Downloading#filter', defaultMessage: 'Downloading', description: 'filter' },
  seeding: { id: 'Seeding#filter', defaultMessage: 'Seeding', description: 'filter' },
  completed: { id: 'Completed#filter', defaultMessage: 'Completed', description: 'filter' },
  paused: { id: 'Paused#filter', defaultMessage: 'Paused', description: 'filter' },
  missing: { id: 'Not on this device#filter', defaultMessage: 'Not on this device', description: 'filter' },
  retrying: { id: 'Retrying#filter', defaultMessage: 'Retrying', description: 'filter' },
})

/**
 * `=== true` is the only positive test, so a row whose flag is unknown counts as LIBRARY.
 *
 * A live snapshot whose magnet carries no `btih` has no infohash, so it joins no library entry and
 * arrives with `ephemeral` undefined. Treating unknown as temporary would let a row vanish from the
 * default view because a lookup missed, which is the one failure this whole feature exists to avoid.
 */
export const isTemporary = (t: Torrent): boolean => t.ephemeral === true

// ------------------------------------------------------------------------------------- the groups

export type ListGroup = 'active' | 'paused' | 'done' | 'missing'

/** The order the card view stacks its groups in: what is moving first, what is not on this device last. */
export const LIST_GROUPS: readonly ListGroup[] = ['active', 'paused', 'done', 'missing']

export const GROUP_LABEL = defineMessages<ListGroup>({
  active: { id: 'Downloading#heading', defaultMessage: 'Downloading', description: 'heading' },
  paused: { id: 'Paused#heading', defaultMessage: 'Paused', description: 'heading' },
  done: { id: 'Done#heading', defaultMessage: 'Done', description: 'heading' },
  // the filter's words name a group, where the bare id is the sentence a row's line says
  missing: FILTER_LABEL.missing,
})

/**
 * Which heading a row sits under. Queued, checking and retrying rows are downloads still to finish, so they sit under
 * Downloading, and so does a `starting` row, which the engine has not reported yet and which carries no progress.
 */
export const groupOf = (t: Pick<Torrent, 'state'>): ListGroup =>
  t.state === 'missing' ? 'missing'
  : t.state === 'paused' ? 'paused'
  : t.state === 'seeding' || t.state === 'completed' ? 'done'
  : 'active'

/**
 * The rows split by group in LIST_GROUPS order, each keeping the order it arrived in. Empty groups are left out. `group`
 * is where each row goes, the page's being one held still while the pointer is in the list.
 */
export const groupTorrents = <T extends Pick<Torrent, 'state'>>(
  rows: readonly T[],
  group: (t: T) => ListGroup = groupOf,
): { group: ListGroup, rows: T[] }[] =>
  LIST_GROUPS
    .map((name) => ({ group: name, rows: rows.filter((t) => group(t) === name) }))
    .filter(({ rows }) => rows.length > 0)

/** A run of cards and the heading it stands under, or null for no heading. */
export type CardGroup<T> = { group: ListGroup | null, rows: T[] }

/**
 * The cards in the order they are drawn: under their group headings where the filter mixes states, and as one run with
 * no heading where it shows one state, whose heading would only repeat the filter.
 */
export const cardGroups = <T extends Pick<Torrent, 'state'>>(
  rows: readonly T[],
  filter: ListFilter,
  group: (t: T) => ListGroup = groupOf,
): CardGroup<T>[] =>
  filter === 'all' || filter === 'library' || filter === 'temporary' ? groupTorrents(rows, group) : [{ group: null, rows: [...rows] }]

/** Categories folded by the person in cards view, keyed by {@link ListGroup}. */
export type CollapsedGroups = ReadonlySet<ListGroup>

export const NO_COLLAPSED: CollapsedGroups = new Set()

/** Toggles `group` in `collapsed`, returning a fresh set. */
export const toggleCollapsed = (collapsed: CollapsedGroups, group: ListGroup): CollapsedGroups => {
  const next = new Set(collapsed)
  if (!next.delete(group)) next.add(group)
  return next
}

/** Rows currently drawn in cards view, skipping categories folded by `collapsed`. */
export const visibleGroupRows = <T>(groups: readonly CardGroup<T>[], collapsed: CollapsedGroups): T[] =>
  groups.flatMap((g) => (g.group && collapsed.has(g.group) ? [] : g.rows))

const shows = (filter: ListFilter, t: Torrent): boolean =>
  filter === 'all' || (filter === 'library' ? !isTemporary(t) : filter === 'temporary' ? isTemporary(t) : t.state === filter)

export const visibleTorrents = (all: readonly Torrent[], filter: ListFilter): Torrent[] => all.filter((t) => shows(filter, t))

export const filterCounts = (all: readonly Torrent[]): Record<ListFilter, number> =>
  Object.fromEntries(FILTERS.map((f) => [f, all.filter((t) => shows(f, t)).length])) as Record<ListFilter, number>

/**
 * What the Show menu offers: All, each filter that shows a row, and `chosen` even once it shows none, so the menu still
 * names what emptied the list. Kept goes only with Temporary, since with nothing temporary it shows what All does.
 */
export const offeredFilters = (counts: Record<ListFilter, number>, chosen: ListFilter): ListFilter[] =>
  FILTERS.filter((f) => f === 'all' || f === chosen || (counts[f] > 0 && (f !== 'library' || counts.temporary > 0)))

// ---------------------------------------------------------------------------------------- the sort

export type SortKey = 'added' | 'custom' | 'name' | 'size' | 'progress' | 'down' | 'up' | 'peers' | 'eta'
export type SortDir = 'asc' | 'desc'

export const SORT_LABEL = defineMessages<SortKey>({
  added: { id: 'Date added', defaultMessage: 'Date added' },
  custom: { id: 'Custom', defaultMessage: 'Custom' },
  name: { id: 'Name', defaultMessage: 'Name' },
  size: { id: 'Size', defaultMessage: 'Size' },
  progress: { id: 'Progress', defaultMessage: 'Progress' },
  down: { id: 'Download speed', defaultMessage: 'Download speed' },
  up: { id: 'Upload speed', defaultMessage: 'Upload speed' },
  peers: { id: 'Peers', defaultMessage: 'Peers' },
  eta: { id: 'Time left', defaultMessage: 'Time left' },
})

/**
 * The direction each key gets when it is first chosen, which is the one that answers the question
 * somebody had when they picked it: newest first, biggest first, fastest first, soonest first.
 */
export const NATURAL_DIR: Record<SortKey, SortDir> = {
  added: 'desc',
  custom: 'asc',
  name: 'asc',
  size: 'desc',
  progress: 'desc',
  down: 'desc',
  up: 'desc',
  peers: 'desc',
  eta: 'asc',
}

/**
 * Rows that are not running here sort after ones that are, whichever direction is chosen.
 *
 * A ghost has no peers, no speed and no progress, and a starting row has none of them YET. Ordering
 * those by value would interleave torrents that are not on this device through the middle of ones
 * that are, for a reason invisible on screen. Presence is the primary key and the chosen key only
 * refines within each group, which also preserves the grouping the list has always had.
 */
const rank = (t: Torrent): number => (t.state === 'missing' ? 2 : t.state === 'starting' ? 1 : 0)

/**
 * The sort value, or null for "not known", which is never the same as zero.
 *
 * NOTHING here touches `t.stats`. It is null for every ghost and for every row in the second or more
 * after a reload while the engine is still starting, so a key that reached into it would crash the
 * route exactly when the list is at its longest. Keeping the key list to flat fields removes that
 * whole class rather than guarding against it.
 */
/** Effective download size of `t`: chosen content files if deselected partially, else total `t.size`. */
export const torrentSize = (t: Torrent): number => {
  const chosen = chosenFiles(t)
  return chosen.length < contentFiles(t.files).length ? chosen.reduce((sum, f) => sum + f.size, 0) : t.size
}

const valueOf = (t: Torrent, key: SortKey, customRank?: ReadonlyMap<string, number>): number | string | null => {
  if (key === 'custom') return (t.infoHash ? customRank?.get(`t:${t.infoHash}`) : undefined) ?? customRank?.get(`t:${t.id}`) ?? null
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

/**
 * Total and stable, because this list re-renders twice a second: two rows tying on a live rate must
 * not trade places on every tick. Newest first, then by id, which is unique and never absent.
 */
const tiebreak = (a: Torrent, b: Torrent): number =>
  (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.id.localeCompare(b.id)

export const compareTorrents = (key: SortKey, dir: SortDir, customRank?: ReadonlyMap<string, number>) => (a: Torrent, b: Torrent): number => {
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  const va = valueOf(a, key, customRank)
  const vb = valueOf(b, key, customRank)
  // BEFORE the direction flip, so unknown sits last both ways round. Reversing the list must not
  // promote every torrent nobody has measured to the top.
  if (va === null && vb === null) return tiebreak(a, b)
  if (va === null) return 1
  if (vb === null) return -1
  const c = typeof va === 'string'
    ? va.localeCompare(vb as string, undefined, { numeric: true, sensitivity: 'base' })
    : va - (vb as number)
  return c !== 0 ? (dir === 'asc' ? c : -c) : tiebreak(a, b)
}

export const sortTorrents = (all: readonly Torrent[], key: SortKey, dir: SortDir, customRank?: ReadonlyMap<string, number>): Torrent[] =>
  [...all].sort(compareTorrents(key, dir, customRank))

// ------------------------------------------------------------------------------------ the throttle

/** Keys whose value changes on its own, twice a second, with nobody touching anything. */
export const VOLATILE_KEYS: readonly SortKey[] = ['down', 'up', 'peers', 'progress', 'eta']

export const isVolatile = (key: SortKey): boolean => VOLATILE_KEYS.includes(key)

/**
 * Whether the arrangement may be recomputed now.
 *
 * Sorting by download speed against a feed that ticks twice a second means rows swapping places
 * under the cursor, and the button somebody was about to press moving out from under them. So the
 * ORDER is held still for a moment while the contents keep updating.
 *
 * A pure decision on purpose: the alternative is a test with fake timers and synthesized pointer
 * events, measuring the harness more than the rule.
 *
 * `interacting` cannot defer this forever, or a list labelled "Fastest first" would sit disagreeing
 * with its own numbers for as long as a pointer rests on it, which is its own kind of lie. Hence the
 * hard ceiling that ignores it.
 */
export const REORDER_QUIET_MS = 2_000
export const REORDER_CEILING_MS = 10_000

export const shouldReorder = (
  { viewChanged, idsChanged, volatile, interacting, sinceMs }: {
    /** The key, the direction or the filter changed, which is somebody asking for a new order. */
    viewChanged: boolean
    /** A torrent was added or removed, so the held order no longer describes the list. */
    idsChanged: boolean
    volatile: boolean
    interacting: boolean
    sinceMs: number
  },
): boolean =>
  viewChanged
  || idsChanged
  || !volatile
  || sinceMs > REORDER_CEILING_MS
  || (sinceMs > REORDER_QUIET_MS && !interacting)

// ------------------------------------------------------------------------------------ preferences

export const LIST_FILTER_KEY = 'ripple:list-filter'
export const LIST_SORT_KEY = 'ripple:list-sort'
export const LIST_VIEW_KEY = 'ripple:list-view'
/** Ids of expanded inline groups in the list. */
export const LIST_EXPANDED_GROUPS_KEY = 'ripple:list-expanded-groups'
/** Categories folded in cards view, comma-separated in {@link LIST_GROUPS} order. */
export const LIST_COLLAPSED_KEY = 'ripple:list-collapsed'

export type ViewMode = 'cards' | 'table'

/**
 * Three keys rather than one blob, matching every other preference in this app, and with no parse
 * failure mode: a value that is not recognised falls back to the default rather than taking the
 * others down with it.
 *
 * These are PAGE preferences, so localStorage is right. The temporary flag is not one of these and
 * never comes here: it is engine state, owned by whichever tab won the election.
 */
const isFilter = (v: unknown): v is ListFilter => (FILTERS as readonly unknown[]).includes(v)
const isView = (v: unknown): v is ViewMode => v === 'cards' || v === 'table'
const isKey = (v: unknown): v is SortKey => typeof v === 'string' && v in SORT_LABEL
const isDir = (v: unknown): v is SortDir => v === 'asc' || v === 'desc'
const isListGroup = (v: unknown): v is ListGroup => (LIST_GROUPS as readonly unknown[]).includes(v)

/** Reads folded card categories from storage, dropping unknown tokens and failing closed to none on error. */
export const readCollapsed = (read: (key: string) => string | null): CollapsedGroups => {
  try {
    const picked = (read(LIST_COLLAPSED_KEY) ?? '').split(',').filter(isListGroup)
    return picked.length ? new Set(picked) : NO_COLLAPSED
  } catch { return NO_COLLAPSED }
}

/** Serializes folded card categories in canonical {@link LIST_GROUPS} order. */
export const writeCollapsed = (collapsed: CollapsedGroups): string =>
  LIST_GROUPS.filter((g) => collapsed.has(g)).join(',')

export const readFilter = (read: (key: string) => string | null): ListFilter => {
  try { const v = read(LIST_FILTER_KEY); return isFilter(v) ? v : 'all' } catch { return 'all' }
}

export type ExpandedGroups = ReadonlySet<string>

export const NO_EXPANDED: ExpandedGroups = new Set()

export const toggleExpandedGroup = (expanded: ExpandedGroups, groupId: string): ExpandedGroups => {
  const next = new Set(expanded)
  if (!next.delete(groupId)) next.add(groupId)
  return next
}

export const readExpandedGroups = (read: (key: string) => string | null): ExpandedGroups => {
  try {
    const raw = read(LIST_EXPANDED_GROUPS_KEY)
    if (!raw) return NO_EXPANDED
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return NO_EXPANDED
    const ids = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    return ids.length ? new Set(ids) : NO_EXPANDED
  } catch { return NO_EXPANDED }
}

export const writeExpandedGroups = (expanded: ExpandedGroups): string =>
  JSON.stringify([...expanded].sort())

export const readView = (read: (key: string) => string | null): ViewMode => {
  try { const v = read(LIST_VIEW_KEY); return isView(v) ? v : 'cards' } catch { return 'cards' }
}

export const DEFAULT_SORT: { key: SortKey, dir: SortDir } = { key: 'added', dir: 'desc' }

export const readSort = (read: (key: string) => string | null): { key: SortKey, dir: SortDir } => {
  try {
    const [key, dir] = (read(LIST_SORT_KEY) ?? '').split(':')
    return isKey(key) && isDir(dir) ? { key, dir } : DEFAULT_SORT
  } catch { return DEFAULT_SORT }
}

export const writeSort = (key: SortKey, dir: SortDir): string => `${key}:${dir}`

// -------------------------------------------------------------------------------------- the search

/** Whether a row answers what is typed in the add field: part of its name in any case, or the start of its info hash. */
export const matchesSearch = (t: Torrent, text: string): boolean => {
  const typed = text.trim().toLowerCase()
  return t.name.toLowerCase().includes(typed)
    || (!!t.infoHash && [t.infoHash.toLowerCase(), hexInfoHash(t.infoHash)].some((hash) => hash.startsWith(typed)))
}
