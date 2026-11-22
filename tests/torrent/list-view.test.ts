import type { Torrent, TorrentState } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SORT, FILTERS, GROUP_LABEL, LIST_COLLAPSED_KEY, LIST_GROUPS, NATURAL_DIR, NO_COLLAPSED, SORT_LABEL,
  TEMPORARY_HINT, cardGroups, compareTorrents, filterCounts, groupOf, groupTorrents, isTemporary, isVolatile,
  offeredFilters, readCollapsed, readFilter, readGroup, readSort, readView, reclaimable, shouldReorder, sortTorrents,
  toggleCollapsed, visibleGroupRows, visibleTorrents, writeCollapsed, writeSort,
} from '../../src/torrent/list-view'

/**
 * The rules behind the library list's filter, sort and order throttle.
 *
 * Written against the failures that are invisible on screen: a comparator reaching into `stats`,
 * which is null for every ghost and for every row in the second after a reload; unknown values
 * sorting as zero, which claims a torrent nobody measured is the smallest; and an order that
 * reshuffles under the cursor while somebody is aiming at a button.
 */

let n = 0
const t = (over: Partial<Torrent> = {}): Torrent => ({
  id: 'id-' + (n++),
  name: 'A torrent',
  size: 1_000,
  downloaded: 0,
  progress: 0,
  state: 'downloading',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: null,
  addedAt: 1_000,
  ...over,
})

const names = (list: Torrent[]) => list.map((x) => x.name)

describe('the temporary filter', () => {
  const mine = t({ name: 'mine', ephemeral: false })
  const temp = t({ name: 'temp', ephemeral: true })
  const unknown = t({ name: 'unknown' })

  it('shows everything by default', () => {
    expect(names(visibleTorrents([mine, temp, unknown], 'all'))).toEqual(['mine', 'temp', 'unknown'])
  })

  it('keeps temporary downloads out of the library view', () => {
    expect(names(visibleTorrents([mine, temp, unknown], 'library'))).toEqual(['mine', 'unknown'])
  })

  it('shows only temporary downloads when asked for them', () => {
    expect(names(visibleTorrents([mine, temp, unknown], 'temporary'))).toEqual(['temp'])
  })

  /**
   * The failure this guards: a live row whose magnet carries no infohash joins no library entry and
   * arrives with the flag undefined. If unknown counted as temporary it would disappear from the
   * default view because a lookup missed, which is the exact thing this feature exists to prevent.
   */
  it('treats a row whose flag never arrived as part of the library, not as temporary', () => {
    expect(isTemporary(unknown)).toBe(false)
    expect(names(visibleTorrents([unknown], 'library'))).toEqual(['unknown'])
    expect(visibleTorrents([unknown], 'temporary')).toEqual([])
  })

  it('does not mutate the array it is given', () => {
    const input = [mine, temp]
    visibleTorrents(input, 'library')
    expect(input).toHaveLength(2)
  })
})

// the budget pass's rule, read off where the engine says the files are: only a torrent in its own directory there
describe('which torrents Ripple may delete to free space once temporary', () => {
  const hash = 'ab'.repeat(20)
  const at = (savePath: string) => t({ infoHash: hash, stats: { savePath } as Torrent['stats'] })

  it('is one in its own directory in browser storage', () => {
    expect(reclaimable(at(`/dl/${hash}`))).toBe(true)
    expect(reclaimable(at(`/cache/${hash}`))).toBe(true)
  })

  it('is never one in the folder, at the shared root, made from the person\'s files, or not reported yet', () => {
    expect([`/native/${hash}`, '/dl', `/source/${hash}`, `/dl/${'cd'.repeat(20)}`].map((path) => reclaimable(at(path)))).toEqual([false, false, false, false])
    expect(reclaimable(t({ infoHash: hash }))).toBe(false)
    expect(reclaimable(t({ stats: { savePath: `/dl/${hash}` } as Torrent['stats'] }))).toBe(false)
  })
})

describe('the state filters', () => {
  const STATES: TorrentState[] = ['downloading', 'seeding', 'paused', 'queued', 'completed', 'error', 'missing', 'retrying', 'checking', 'starting']
  const rows = STATES.map((state) => t({ name: state, state }))

  it('shows only the rows in each state', () => {
    for (const state of ['downloading', 'seeding', 'completed', 'paused', 'missing', 'retrying'] as const) {
      expect(names(visibleTorrents(rows, state)), state).toEqual([state])
    }
  })

  it('counts the rows each filter shows, from the same rule', () => {
    const library = [...rows, t({ state: 'seeding', ephemeral: true }), t({ state: 'seeding' })]
    const counts = filterCounts(library)
    expect(counts).toEqual({ all: 12, library: 11, temporary: 1, downloading: 1, seeding: 3, completed: 1, paused: 1, missing: 1, retrying: 1 })
    for (const f of FILTERS) expect(counts[f], f).toBe(visibleTorrents(library, f).length)
  })

  const none = Object.fromEntries(FILTERS.map((f) => [f, 0])) as ReturnType<typeof filterCounts>

  it('offers All and each filter that shows a row, never one that shows none', () => {
    expect(offeredFilters({ ...none, all: 5, library: 3, temporary: 2, seeding: 4, missing: 1 }, 'all'))
      .toEqual(['all', 'library', 'temporary', 'seeding', 'missing'])
  })

  /** with nothing temporary, Kept shows exactly what All does */
  it('offers Kept only beside Temporary', () => {
    expect(offeredFilters({ ...none, all: 3, library: 3, downloading: 3 }, 'all')).toEqual(['all', 'downloading'])
  })

  /** a remembered filter can match nothing after a reload, and the menu still has to say which it is */
  it('keeps offering the chosen filter once it shows nothing', () => {
    expect(offeredFilters({ ...none, all: 3, downloading: 3 }, 'seeding')).toEqual(['all', 'downloading', 'seeding'])
  })
})

describe('the groups the cards stack under', () => {
  const heading = (state: TorrentState) => GROUP_LABEL[groupOf(t({ state }))].defaultMessage

  it('puts every state under its heading', () => {
    const under: Record<TorrentState, string> = {
      downloading: 'Downloading',
      queued: 'Downloading',
      checking: 'Downloading',
      retrying: 'Downloading',
      error: 'Downloading',
      paused: 'Paused',
      seeding: 'Done',
      completed: 'Done',
      missing: 'Not on this device',
      starting: 'Downloading',
    }
    for (const [state, label] of Object.entries(under) as [TorrentState, string][]) expect(heading(state), state).toBe(label)
  })

  it('stacks the groups in order, keeps the order inside each, and leaves out empty ones', () => {
    const rows = [
      t({ name: 'gone', state: 'missing' }),
      t({ name: 'seed 1', state: 'seeding', progress: 1 }),
      t({ name: 'down 1', state: 'downloading' }),
      t({ name: 'seed 2', state: 'completed', progress: 1 }),
      t({ name: 'down 2', state: 'queued' }),
    ]
    const groups = groupTorrents(rows)
    expect(groups.map((g) => g.group)).toEqual(['active', 'done', 'missing'])
    expect(groups.map((g) => names(g.rows))).toEqual([['down 1', 'down 2'], ['seed 1', 'seed 2'], ['gone']])
    expect(LIST_GROUPS).toEqual(['active', 'paused', 'done', 'missing'])
  })

  it('loses no row and repeats none', () => {
    const states: TorrentState[] = ['downloading', 'seeding', 'paused', 'queued', 'completed', 'error', 'missing', 'retrying', 'checking', 'starting']
    const rows = states.map((state) => t({ name: state, state }))
    expect(groupTorrents(rows).flatMap((g) => names(g.rows)).sort()).toEqual([...states].sort())
  })

  /** The page hands its own, held while the pointer is in the list, so a row paused there keeps its heading. */
  it('puts each row where the group it is handed says', () => {
    const paused = t({ name: 'paused', state: 'paused' })
    const rows = [t({ name: 'down', state: 'downloading' }), paused]
    const held = (x: Torrent) => x === paused ? 'active' as const : groupOf(x)
    expect(groupTorrents(rows, held).map((g) => [g.group, names(g.rows)])).toEqual([['active', ['down', 'paused']]])
  })

  /** A heading under a one-state filter only repeats the filter, and Downloading would count rows the filter leaves out. */
  it('draws headings only under a filter that mixes states', () => {
    const rows = [t({ name: 'seed', state: 'seeding' }), t({ name: 'down', state: 'downloading' })]
    for (const filter of ['all', 'library', 'temporary'] as const) {
      expect(cardGroups(rows, filter).map((g) => [g.group, names(g.rows)]), filter).toEqual([['active', ['down']], ['done', ['seed']]])
    }
    for (const filter of FILTERS.filter((f) => f !== 'all' && f !== 'library' && f !== 'temporary')) {
      expect(cardGroups(rows, filter).map((g) => [g.group, names(g.rows)]), filter).toEqual([[null, ['seed', 'down']]])
    }
  })

  it('toggles collapsed categories cleanly and omits only folded groups from visible rows', () => {
    const afterDone = toggleCollapsed(NO_COLLAPSED, 'done')
    expect([...afterDone]).toEqual(['done'])
    expect(NO_COLLAPSED.size).toBe(0)
    const afterMissing = toggleCollapsed(afterDone, 'missing')
    expect([...afterMissing]).toEqual(['done', 'missing'])
    expect([...toggleCollapsed(afterMissing, 'done')]).toEqual(['missing'])

    const rows = [
      t({ name: 'down', state: 'downloading' }),
      t({ name: 'held', state: 'paused' }),
      t({ name: 'seed', state: 'seeding' }),
      t({ name: 'gone', state: 'missing' }),
    ]
    const grouped = cardGroups(rows, 'all')
    expect(names(visibleGroupRows(grouped, afterMissing))).toEqual(['down', 'held'])
    expect(names(visibleGroupRows(cardGroups(rows, 'seeding'), afterDone))).toEqual(['down', 'held', 'seed', 'gone'])
  })
})

describe('the sort', () => {
  it('orders by every key it offers, in the natural direction first', () => {
    for (const key of Object.keys(SORT_LABEL) as (keyof typeof SORT_LABEL)[]) {
      expect(NATURAL_DIR[key], `${key} has no natural direction`).toMatch(/^(asc|desc)$/)
    }
  })

  it('puts the biggest first on size and the newest first on date', () => {
    const small = t({ name: 'small', size: 10 })
    const big = t({ name: 'big', size: 1_000_000 })
    expect(names(sortTorrents([small, big], 'size', 'desc'))).toEqual(['big', 'small'])
    const pack = t({
      name: 'pack',
      size: 1_010_000,
      files: [{ name: 'one', size: 10_000, index: 0 }, { name: 'rest', size: 1_000_000, index: 1 }],
      wantedFiles: [0],
    })
    const whole = t({ name: 'whole', size: 500_000 })
    expect(names(sortTorrents([pack, whole], 'size', 'desc'))).toEqual(['whole', 'pack'])
    const old = t({ name: 'old', addedAt: 1 })
    const recent = t({ name: 'recent', addedAt: 9_000 })
    expect(names(sortTorrents([old, recent], 'added', 'desc'))).toEqual(['recent', 'old'])
  })

  it('sorts names the way a person reads them, so episode 9 comes before episode 10', () => {
    const nine = t({ name: 'Show - 9' })
    const ten = t({ name: 'Show - 10' })
    expect(names(sortTorrents([ten, nine], 'name', 'asc'))).toEqual(['Show - 9', 'Show - 10'])
  })

  /**
   * The crash class the key list was chosen to remove. Every one of these rows has `stats: null`,
   * which is what the whole library looks like for over a second after a reload.
   */
  it('never reads stats, so a whole list of engine-less rows sorts rather than throwing', () => {
    const rows = [t({ state: 'starting', stats: null }), t({ state: 'missing', stats: null }), t({ stats: null })]
    for (const key of Object.keys(SORT_LABEL) as (keyof typeof SORT_LABEL)[]) {
      for (const dir of ['asc', 'desc'] as const) {
        expect(() => sortTorrents(rows, key, dir), `${key} ${dir} threw`).not.toThrow()
      }
    }
  })

  /**
   * Presence outranks the key in BOTH directions, so torrents that are not on this device never land
   * in the middle of ones that are.
   *
   * Sorted by NAME, and that choice is the whole test. On a volatile key every absent row already
   * resolves to null through the pending guard, so this passed with the presence rank deleted
   * outright: it was measuring the null rule twice and the rank not at all. A ghost has a name, a
   * size and a date from its stored metadata, so those are the keys where only the rank can put it
   * last. The names below are chosen so alphabetical order alone would interleave all three.
   */
  it('keeps rows that are not on this device at the end, even sorting by something they have', () => {
    const live = t({ name: 'M live', peers: 1 })
    const starting = t({ name: 'A starting', state: 'starting' })
    const ghost = t({ name: 'B ghost', state: 'missing' })
    expect(names(sortTorrents([ghost, starting, live], 'name', 'asc')))
      .toEqual(['M live', 'A starting', 'B ghost'])
    // reversed, the group order holds and only the contents of each group flip
    expect(names(sortTorrents([ghost, starting, live], 'name', 'desc')))
      .toEqual(['M live', 'A starting', 'B ghost'])
  })

  it('ranks by presence on date and size too, which a ghost also carries', () => {
    const live = t({ name: 'live', addedAt: 1, size: 5 })
    const ghost = t({ name: 'ghost', state: 'missing', addedAt: 9_999, size: 9_999 })
    expect(names(sortTorrents([ghost, live], 'added', 'desc'))).toEqual(['live', 'ghost'])
    expect(names(sortTorrents([ghost, live], 'size', 'desc'))).toEqual(['live', 'ghost'])
  })

  /** unknown is not a small number: reversing must not promote everything nobody has measured */
  it('sorts unknown values last in both directions', () => {
    const known = t({ name: 'known', etaSeconds: 500 })
    const alsoKnown = t({ name: 'also', etaSeconds: 10 })
    const noEta = t({ name: 'none' })
    expect(names(sortTorrents([noEta, known, alsoKnown], 'eta', 'asc'))).toEqual(['also', 'known', 'none'])
    expect(names(sortTorrents([noEta, known, alsoKnown], 'eta', 'desc'))).toEqual(['known', 'also', 'none'])
  })

  it('treats a size of zero as not yet known rather than as the smallest torrent', () => {
    const sized = t({ name: 'sized', size: 5 })
    const unsized = t({ name: 'unsized', size: 0 })
    expect(names(sortTorrents([unsized, sized], 'size', 'asc'))).toEqual(['sized', 'unsized'])
  })

  /**
   * The list re-renders twice a second. Two rows tying on a live rate must land the same way every
   * time or they trade places forever, which looks like the page shaking.
   */
  it('is stable for rows that tie, so a live list does not shuffle on every tick', () => {
    const a = t({ name: 'a', down: 5, addedAt: 100 })
    const b = t({ name: 'b', down: 5, addedAt: 200 })
    const once = names(sortTorrents([a, b], 'down', 'desc'))
    for (let i = 0; i < 20; i++) expect(names(sortTorrents([b, a], 'down', 'desc'))).toEqual(once)
  })

  it('is a total order, so sorting a shuffled list always gives the same answer', () => {
    const rows = Array.from({ length: 12 }, (_, i) => t({ name: 'n' + i, down: i % 3, addedAt: i }))
    const expected = names(sortTorrents(rows, 'down', 'desc'))
    for (let seed = 1; seed < 12; seed++) {
      const shuffled = [...rows].sort((x, y) => ((x.name.length * seed) % 7) - ((y.name.length * seed) % 5))
      expect(names(sortTorrents(shuffled, 'down', 'desc'))).toEqual(expected)
    }
  })

  it('leaves the caller\'s array alone', () => {
    const input = [t({ name: 'b' }), t({ name: 'a' })]
    sortTorrents(input, 'name', 'asc')
    expect(names(input)).toEqual(['b', 'a'])
  })
})

describe('the order throttle', () => {
  const base = { viewChanged: false, idsChanged: false, volatile: true, interacting: false, sinceMs: 0 }

  it('reorders at once when somebody asks for a different order', () => {
    expect(shouldReorder({ ...base, viewChanged: true, interacting: true })).toBe(true)
  })

  it('reorders at once when a torrent appears or disappears', () => {
    expect(shouldReorder({ ...base, idsChanged: true, interacting: true })).toBe(true)
  })

  /** sorting by name or date has nothing to churn, so there is nothing to hold still */
  it('never holds back a key whose value does not move on its own', () => {
    expect(shouldReorder({ ...base, volatile: false, interacting: true })).toBe(true)
    expect(isVolatile('name')).toBe(false)
    expect(isVolatile('added')).toBe(false)
    expect(isVolatile('down')).toBe(true)
  })

  it('holds the order still while somebody is reaching for a row', () => {
    expect(shouldReorder({ ...base, interacting: true, sinceMs: 3_000 })).toBe(false)
  })

  it('lets it settle once the pointer has gone', () => {
    expect(shouldReorder({ ...base, interacting: false, sinceMs: 3_000 })).toBe(true)
  })

  it('does not reorder immediately on a volatile key, even with nobody near it', () => {
    expect(shouldReorder({ ...base, sinceMs: 500 })).toBe(false)
  })

  /**
   * The ceiling, without which a pointer resting on the list would let "Fastest first" disagree with
   * its own numbers indefinitely. That is a different lie, not a smaller one.
   */
  it('gives up holding after the ceiling however much is being touched', () => {
    expect(shouldReorder({ ...base, interacting: true, sinceMs: 11_000 })).toBe(true)
  })
})

describe('the stored preferences', () => {
  const from = (map: Record<string, string>) => (k: string) => map[k] ?? null
  const throws = () => { throw new Error('localStorage is unavailable in a private window') }

  it('defaults to showing everything, newest first, as cards', () => {
    expect(readFilter(from({}))).toBe('all')
    expect(readView(from({}))).toBe('cards')
    expect(readSort(from({}))).toEqual(DEFAULT_SORT)
  })

  it('reads back what it wrote', () => {
    expect(readSort(from({ 'ripple:list-sort': writeSort('size', 'asc') }))).toEqual({ key: 'size', dir: 'asc' })
    expect(readFilter(from({ 'ripple:list-filter': 'temporary' }))).toBe('temporary')
    for (const filter of FILTERS) expect(readFilter(from({ 'ripple:list-filter': filter }))).toBe(filter)
    expect(readView(from({ 'ripple:list-view': 'table' }))).toBe('table')
  })

  /** a stored value from a future version, or a hand-edited one, must not take the page down */
  it('falls back rather than trusting anything it did not recognise', () => {
    expect(readFilter(from({ 'ripple:list-filter': 'nonsense' }))).toBe('all')
    expect(readView(from({ 'ripple:list-view': '{}' }))).toBe('cards')
    expect(readSort(from({ 'ripple:list-sort': 'ratio:sideways' }))).toEqual(DEFAULT_SORT)
    expect(readSort(from({ 'ripple:list-sort': 'size' }))).toEqual(DEFAULT_SORT)
  })

  /** a private window throws on the read itself, which is a real state in this app */
  it('survives a localStorage that throws', () => {
    expect(readFilter(throws)).toBe('all')
    expect(readView(throws)).toBe('cards')
    expect(readSort(throws)).toEqual(DEFAULT_SORT)
    expect(readGroup(throws)).toBeNull()
  })

  /** any id: whether it names a group is the page's to say, once the groups are read */
  it('reads the group shown by its id, and none when nothing is stored', () => {
    expect(readGroup(from({ 'ripple:list-group': 'q9X-_0aZ12345678' }))).toBe('q9X-_0aZ12345678')
    expect(readGroup(from({}))).toBeNull()
    expect(readGroup(from({ 'ripple:list-group': '' }))).toBeNull()
  })

  it('reads, validates, and serializes collapsed categories in canonical order', () => {
    expect([...readCollapsed(from({}))]).toEqual([])
    expect([...readCollapsed(throws)]).toEqual([])
    expect([...readCollapsed(from({ [LIST_COLLAPSED_KEY]: 'done,bogus,missing,,done' }))]).toEqual(['done', 'missing'])
    expect(writeCollapsed(new Set(['missing', 'active']))).toBe('active,missing')
    expect(writeCollapsed(NO_COLLAPSED)).toBe('')
  })
})

describe('the copy', () => {
  it('never says ephemeral, cache or evict where a person can read it', () => {
    for (const { defaultMessage } of [TEMPORARY_HINT, ...Object.values(SORT_LABEL)]) {
      expect(defaultMessage).not.toMatch(/ephemeral|cache|evict|reclaim/i)
    }
  })

  it('says what a temporary download is and what to do about it', () => {
    expect(TEMPORARY_HINT.defaultMessage).toMatch(/delete/)
    expect(TEMPORARY_HINT.defaultMessage).toMatch(/keep it/)
  })
})
