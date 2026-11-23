import type { TorrentGroup } from '../../src/torrent/groups'
import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import {
  buildLibraryEntries, cardEntryGroups, groupCreationTime, summarizeGroup, visibleEntryTorrents,
} from '../../src/torrent/group-rows'
import { EMPTY_LIST_ORDER } from '../../src/torrent/list-order'
import { NO_COLLAPSED } from '../../src/torrent/list-view'

const hash = (c: string) => c.repeat(40)

const mkTorrent = (c: string, over: Partial<Torrent> = {}): Torrent => ({
  id: c,
  infoHash: hash(c),
  magnet: `magnet:?xt=urn:btih:${hash(c)}`,
  name: `Torrent ${c}`,
  size: 1_000,
  downloaded: 1_000,
  progress: 1,
  state: 'completed',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: null,
  addedAt: 100,
  ...over,
})

const mkGroup = (id: string, name: string, memberHashes: string[], namedAt = 200): TorrentGroup => ({
  id,
  name,
  namedAt,
  members: memberHashes.map((infoHash) => ({ infoHash, at: 150 })),
})

describe('inline group rows and symlink model', () => {
  it('hides grouped torrents from loose top-level while allowing a torrent in multiple groups', () => {
    const shared = mkTorrent('a', { addedAt: 300 })
    const loose = mkTorrent('b', { addedAt: 250 })
    const g1 = mkGroup('g1', 'First', [hash('a')])
    const g2 = mkGroup('g2', 'Second', [hash('a')])

    const entries = buildLibraryEntries({
      torrents: [shared, loose],
      groups: [g1, g2],
      filter: 'all',
      searchText: '',
      sortKey: 'added',
      sortDir: 'desc',
      order: EMPTY_LIST_ORDER,
    })

    expect(entries.map((e) => e.key)).toEqual(['t:' + hash('b'), 'g:g1', 'g:g2'])
    expect(entries.filter((e) => e.kind === 'torrent').map((e) => e.torrent.id)).toEqual(['b'])
    const gEntries = entries.filter((e) => e.kind === 'group')
    expect(gEntries.map((g) => g.summary.members.map((m) => m.id))).toEqual([['a'], ['a']])

    // Expanding both groups deduplicates bulk-visible torrents by infoHash so multi-group symlinks count once.
    const grouped = cardEntryGroups(entries, 'all')
    const visible = visibleEntryTorrents(grouped, NO_COLLAPSED, new Set(['g1', 'g2']))
    expect(visible.map((t) => t.id)).toEqual(['b', 'a'])
  })

  it('aggregates state priority, byte-weighted progress, transfer rates, ETA, and fetchable members', () => {
    const dl = mkTorrent('a', { state: 'downloading', size: 3_000, progress: 0.5, down: 300, up: 50, peers: 4, etaSeconds: 5 })
    const missing = mkTorrent('b', { state: 'missing', size: 1_000, progress: 0 })
    const group = mkGroup('g1', 'Mixed', [hash('a'), hash('b')])

    const summary = summarizeGroup(group, [dl, missing], 'added', 'desc')
    expect(summary.state).toBe('downloading')
    expect(summary.listGroup).toBe('active')
    expect(summary.size).toBe(4_000)
    expect(summary.progress).toBeCloseTo(1_500 / 4_000, 6)
    expect(summary.down).toBe(300)
    expect(summary.up).toBe(50)
    expect(summary.peers).toBe(4)
    expect(summary.etaSeconds).toBe(5)
    expect(summary.fetchable.map((t) => t.id)).toEqual(['b'])
    expect(summary.previewHashes).toEqual([hash('a'), hash('b')])
  })

  it('preserves group creation time across renames', () => {
    const g: TorrentGroup = { id: 'g1', name: 'Renamed', namedAt: 9_000, members: [{ infoHash: hash('a'), at: 1_200 }] }
    expect(groupCreationTime(g)).toBe(1_200)
  })

  it('sorts mixed entries and group members under custom order cleanly', () => {
    const t1 = mkTorrent('a', { addedAt: 10 })
    const t2 = mkTorrent('b', { addedAt: 20 })
    const t3 = mkTorrent('c', { addedAt: 30 })
    const g = mkGroup('g1', 'Folder', [hash('a'), hash('b')], 5)

    const entries = buildLibraryEntries({
      torrents: [t1, t2, t3],
      groups: [g],
      filter: 'all',
      searchText: '',
      sortKey: 'custom',
      sortDir: 'asc',
      order: {
        updatedAt: 50,
        top: [`g:g1`, `t:${hash('c')}`],
        groups: { g1: { updatedAt: 50, members: [hash('b'), hash('a')] } },
      },
    })

    expect(entries.map((e) => e.key)).toEqual(['g:g1', `t:${hash('c')}`])
    expect(entries[0]!.kind === 'group' ? entries[0]!.summary.members.map((m) => m.id) : []).toEqual(['b', 'a'])
  })

  it('matches group names or member names on search and hides empty categories under filter', () => {
    const t1 = mkTorrent('a', { name: 'Alpha', state: 'completed' })
    const g1 = mkGroup('g1', 'Cinema', [hash('a')])
    const empty = mkGroup('g2', 'Archives', [])

    const byGroupName = buildLibraryEntries({
      torrents: [t1],
      groups: [g1, empty],
      filter: 'all',
      searchText: 'cin',
      sortKey: 'added',
      sortDir: 'desc',
      order: EMPTY_LIST_ORDER,
    })
    expect(byGroupName.map((e) => (e.kind === 'group' ? e.group.id : e.torrent.id))).toEqual(['g1'])

    const filteredEmpty = buildLibraryEntries({
      torrents: [t1],
      groups: [g1, empty],
      filter: 'paused',
      searchText: '',
      sortKey: 'added',
      sortDir: 'desc',
      order: EMPTY_LIST_ORDER,
    })
    expect(filteredEmpty).toEqual([])
  })
})
