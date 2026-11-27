import { describe, expect, it } from 'vitest'

import type { LibraryEntry } from '../../src/torrent/group-rows'
import type { TorrentGroup } from '../../src/torrent/groups'
import type { ListOrder } from '../../src/torrent/list-order'
import type { Torrent } from '../../src/torrent/types'

import { summarizeGroup } from '../../src/torrent/group-rows'
import { buildNewGroupTopOrder, moveEntryByStep, parseChildKey, resolveDrop, rowDragAttrs, type RowDragActions } from '../../src/router/list-drag'

const makeTorrent = (infoHash: string, name = infoHash): Torrent => ({
  id: infoHash,
  infoHash,
  magnet: `magnet:?xt=urn:btih:${infoHash}`,
  name,
  size: 1000,
  downloaded: 1000,
  progress: 1,
  state: 'seeding',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: {
    allTimeDownload: 1000,
    allTimeUpload: 0,
    sessionDownload: 0,
    sessionUpload: 0,
    wasted: 0,
    swarmSeeds: 0,
    swarmPeers: 0,
    numConnections: 0,
    connectionsLimit: 0,
    availability: 1,
    activeSeconds: 0,
    seedingSeconds: 0,
    sessionActiveSeconds: 0,
    sessionSeedingSeconds: 0,
    completedAt: 0,
    lastSeenComplete: 0,
    hadIncoming: false,
    savePath: '/dl',
    pieceLength: 16384,
    numPieces: 1,
    numPiecesHave: 1,
    remaining: 0,
  },
  files: [],
})

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const H3 = '3'.repeat(40)
const H4 = '4'.repeat(40)
const H_MISSING = 'f'.repeat(40)

const t1 = makeTorrent(H1, 'One')
const t2 = makeTorrent(H2, 'Two')
const t3 = makeTorrent(H3, 'Three')
const t4 = makeTorrent(H4, 'Four')

const g1: TorrentGroup = {
  id: 'g1',
  name: 'Group 1',
  namedAt: 1,
  members: [{ infoHash: H1, at: 1 }, { infoHash: H2, at: 2 }],
}
const g2: TorrentGroup = {
  id: 'g2',
  name: 'Group 2',
  namedAt: 2,
  members: [{ infoHash: H3, at: 3 }],
}

const entries: LibraryEntry[] = [
  { kind: 'group', key: 'g:g1', group: g1, summary: summarizeGroup(g1, [t1, t2], 'custom', 'asc') },
  { kind: 'group', key: 'g:g2', group: g2, summary: summarizeGroup(g2, [t3], 'custom', 'asc') },
  { kind: 'torrent', key: `t:${H4}`, torrent: t4 },
]

const groups = [g1, g2]
const emptyOrder: ListOrder = { updatedAt: 0, top: [], groups: {} }

describe('list-drag pure helpers', () => {
  it('parses child keys safely', () => {
    expect(parseChildKey(`child:g1:${H1}`)).toEqual({ groupId: 'g1', infoHash: H1 })
    expect(parseChildKey('child::abc')).toBeNull()
    expect(parseChildKey('child:g1:')).toBeNull()
    expect(parseChildKey('t:123')).toBeNull()
  })

  it('rejects forged or unknown source and target hashes or groups', () => {
    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H_MISSING}` },
      targetKey: `t:${H4}`,
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: `t:${H_MISSING}`,
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'missing-g', infoHash: H1 },
      targetKey: `t:${H4}`,
      place: 'after',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H_MISSING },
      targetKey: 'g:g2',
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: 'g:missing-g',
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: `child:g1:${H_MISSING}`,
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toBeNull()
  })

  it('resolves top, group, and member drops accurately', () => {
    const loose2: Torrent = makeTorrent('5'.repeat(40), 'Five')
    const twoLooseEntries: LibraryEntry[] = [
      ...entries,
      { kind: 'torrent', key: `t:${loose2.infoHash}`, torrent: loose2 },
    ]

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${loose2.infoHash}` },
      targetKey: `t:${H4}`,
      place: 'into',
      entries: twoLooseEntries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({ kind: 'new-group', targetHash: H4, draggedHash: loose2.infoHash! })

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: 'g:g1',
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({ kind: 'add-to-group', groupId: 'g1', infoHash: H4 })

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: `child:g1:${H1}`,
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'move-between-groups',
      fromGroupId: undefined,
      toGroupId: 'g1',
      infoHash: H4,
      membersOrder: [H4, H1, H2],
    })

    expect(resolveDrop({
      payload: { kind: 'top', key: `t:${H4}` },
      targetKey: 'g:g1',
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'reorder-top',
      top: [`t:${H4}`, 'g:g1', 'g:g2'],
    })

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H2 },
      targetKey: `child:g1:${H1}`,
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'reorder-members',
      groupId: 'g1',
      members: [H2, H1],
    })

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H1 },
      targetKey: `child:g2:${H3}`,
      place: 'after',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'move-between-groups',
      fromGroupId: 'g1',
      toGroupId: 'g2',
      infoHash: H1,
      membersOrder: [H3, H1],
    })

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H1 },
      targetKey: 'g:g2',
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'move-between-groups',
      fromGroupId: 'g1',
      toGroupId: 'g2',
      infoHash: H1,
    })

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H1 },
      targetKey: 'g:g2',
      place: 'before',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'reorder-top',
      top: ['g:g1', `t:${H1}`, 'g:g2', `t:${H4}`],
      removeFromGroup: { groupId: 'g1', infoHash: H1 },
    })

    expect(resolveDrop({
      payload: { kind: 'member', groupId: 'g1', infoHash: H1 },
      targetKey: `t:${H4}`,
      place: 'into',
      entries,
      groups,
      listOrder: emptyOrder,
    })).toEqual({
      kind: 'new-group',
      targetHash: H4,
      draggedHash: H1,
      removeFromGroupId: 'g1',
    })
  })

  it('builds replacement top order on new-group creation and computes step moves', () => {
    expect(buildNewGroupTopOrder(entries, ['g:g1', 'g:g2', `t:${H4}`, `t:${H_MISSING}`], H4, H_MISSING, 'new-g')).toEqual([
      'g:g1', 'g:g2', 'g:new-g',
    ])
    expect(buildNewGroupTopOrder(entries, [], H4, H1, 'new-g')).toBeNull()

    expect(moveEntryByStep({
      target: { kind: 'top', key: 'g:g2' },
      direction: 'up',
      entries,
      listOrder: emptyOrder,
    })).toEqual({ kind: 'top', top: ['g:g2', 'g:g1', `t:${H4}`] })

    expect(moveEntryByStep({
      target: { kind: 'top', key: 'g:g1' },
      direction: 'up',
      entries,
      listOrder: emptyOrder,
    })).toBeNull()

    expect(moveEntryByStep({
      target: { kind: 'member', groupId: 'g1', infoHash: H1 },
      direction: 'down',
      entries,
      listOrder: emptyOrder,
    })).toEqual({ kind: 'members', groupId: 'g1', members: [H2, H1] })

    expect(moveEntryByStep({
      target: { kind: 'member', groupId: 'g1', infoHash: H2 },
      direction: 'down',
      entries,
      listOrder: emptyOrder,
    })).toBeNull()
  })

  it('wires onDragEnter to dragActions.onOver so WebKit allows drops without an extra move', () => {
    const called: string[] = []
    const dragActions: RowDragActions = {
      onStart: () => {},
      onEnd: () => {},
      onOver: (targetKey, allowInto) => called.push(`over:${targetKey}:${String(allowInto)}`),
      onLeave: () => {},
      onDrop: () => {},
    }
    const attrs = rowDragAttrs({
      dragActions,
      dragKey: 'g:g1',
      payload: { kind: 'top', key: 'g:g1' },
      allowInto: true,
    })
    expect('onDragEnter' in attrs && typeof attrs.onDragEnter).toBe('function')
    if ('onDragEnter' in attrs && attrs.onDragEnter) {
      attrs.onDragEnter({} as Parameters<NonNullable<typeof attrs.onDragEnter>>[0])
    }
    expect(called).toEqual(['over:g:g1:true'])
  })
})
