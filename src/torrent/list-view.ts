import type { Torrent } from './types'

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
 * part that costs them something. Where it came from is carried by the sentence below, not the word.
 */
export const TEMPORARY_HINT =
  'Ripple downloaded this to play a link, and can delete it to free space. Open options to keep it.'

/** The same fact once the bytes are already gone, where it explains rather than warns. */
export const TEMPORARY_GONE_HINT =
  'Ripple downloaded this to play a link and has since freed the space. You can download it again at any time.'

// -------------------------------------------------------------------------------------- the filter

export type ListFilter = 'all' | 'library' | 'temporary'

/**
 * `=== true` is the only positive test, so a row whose flag is unknown counts as LIBRARY.
 *
 * A live snapshot whose magnet carries no `btih` has no infohash, so it joins no library entry and
 * arrives with `ephemeral` undefined. Treating unknown as temporary would let a row vanish from the
 * default view because a lookup missed, which is the one failure this whole feature exists to avoid.
 */
export const isTemporary = (t: Torrent): boolean => t.ephemeral === true

export const visibleTorrents = (all: readonly Torrent[], filter: ListFilter): Torrent[] =>
  filter === 'all'
    ? [...all]
    : filter === 'temporary'
      ? all.filter(isTemporary)
      : all.filter((t) => !isTemporary(t))

// ---------------------------------------------------------------------------------------- the sort

export type SortKey = 'added' | 'name' | 'size' | 'progress' | 'down' | 'up' | 'peers' | 'eta'
export type SortDir = 'asc' | 'desc'

export const SORT_LABEL: Record<SortKey, string> = {
  added: 'Date added',
  name: 'Name',
  size: 'Size',
  progress: 'Progress',
  down: 'Download speed',
  up: 'Upload speed',
  peers: 'Peers',
  eta: 'Time left',
}

/**
 * The direction each key gets when it is first chosen, which is the one that answers the question
 * somebody had when they picked it: newest first, biggest first, fastest first, soonest first.
 */
export const NATURAL_DIR: Record<SortKey, SortDir> = {
  added: 'desc',
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
const valueOf = (t: Torrent, key: SortKey): number | string | null => {
  const pending = t.state === 'starting' || t.state === 'missing'
  switch (key) {
    case 'name': return t.name
    case 'added': return t.addedAt ?? null
    case 'size': return t.size > 0 ? t.size : null
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

export const compareTorrents = (key: SortKey, dir: SortDir) => (a: Torrent, b: Torrent): number => {
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  const va = valueOf(a, key)
  const vb = valueOf(b, key)
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

export const sortTorrents = (all: readonly Torrent[], key: SortKey, dir: SortDir): Torrent[] =>
  [...all].sort(compareTorrents(key, dir))

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

export type ViewMode = 'cards' | 'table'

/**
 * Three keys rather than one blob, matching every other preference in this app, and with no parse
 * failure mode: a value that is not recognised falls back to the default rather than taking the
 * others down with it.
 *
 * These are PAGE preferences, so localStorage is right. The temporary flag is not one of these and
 * never comes here: it is engine state, owned by whichever tab won the election.
 */
const isFilter = (v: unknown): v is ListFilter => v === 'all' || v === 'library' || v === 'temporary'
const isView = (v: unknown): v is ViewMode => v === 'cards' || v === 'table'
const isKey = (v: unknown): v is SortKey => typeof v === 'string' && v in SORT_LABEL
const isDir = (v: unknown): v is SortDir => v === 'asc' || v === 'desc'

export const readFilter = (read: (key: string) => string | null): ListFilter => {
  try { const v = read(LIST_FILTER_KEY); return isFilter(v) ? v : 'all' } catch { return 'all' }
}

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
