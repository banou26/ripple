import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SORT, NATURAL_DIR, SORT_LABEL, TEMPORARY_HINT,
  compareTorrents, isTemporary, isVolatile, readFilter, readSort, readView,
  shouldReorder, sortTorrents, visibleTorrents, writeSort,
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
  })
})

describe('the copy', () => {
  it('never says ephemeral, cache or evict where a person can read it', () => {
    for (const text of [TEMPORARY_HINT, ...Object.values(SORT_LABEL)]) {
      expect(text, text).not.toMatch(/ephemeral|cache|evict|reclaim/i)
    }
  })

  it('says what a temporary download is and what to do about it', () => {
    expect(TEMPORARY_HINT).toMatch(/delete/)
    expect(TEMPORARY_HINT).toMatch(/keep it/)
  })
})
