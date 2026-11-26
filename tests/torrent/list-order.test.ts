import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  update: async (key: string, fn: (prev: unknown) => unknown) => {
    const next = fn(store.get(key))
    store.set(key, next)
    return next
  },
}))

import { EMPTY_LIST_ORDER, LIST_ORDER_KEY, mergeListOrder, pruneListOrder, removeFromListOrder, reorderKeys, saveTopOrder } from '../../src/torrent/list-order'

describe('custom list order', () => {
  it('merges top-level order and each group member order independently by latest updatedAt', () => {
    const local = {
      updatedAt: 20,
      top: ['g:g1', 't:a'] as const,
      groups: { g1: { updatedAt: 5, members: ['h1', 'h2'] } },
    }
    const cloud = {
      updatedAt: 10,
      top: ['t:a', 'g:g1'] as const,
      groups: {
        g1: { updatedAt: 15, members: ['h2', 'h1'] },
        g2: { updatedAt: 8, members: ['h3'] },
      },
    }
    expect(mergeListOrder(EMPTY_LIST_ORDER, local, cloud)).toEqual({
      updatedAt: 20,
      top: ['g:g1', 't:a'],
      groups: {
        g1: { updatedAt: 15, members: ['h2', 'h1'] },
        g2: { updatedAt: 8, members: ['h3'] },
      },
    })
  })

  it('keeps unplaced visible items in their current trailing position instead of promoting them to index 0', () => {
    // Regression test: unplaced item `t:unplaced` is at the end of `visible`, while `existing` only placed `t:a` and `t:b`.
    const next = reorderKeys(['t:a', 't:b', 't:unplaced'], ['t:a', 't:b'], 't:b', 't:a', 'before')
    expect(next).toEqual(['t:b', 't:a', 't:unplaced'])
  })

  it('preserves hidden keys anchored after their nearest visible predecessor while reflecting visible reorder', () => {
    const existing = ['t:h1', 't:h2', 't:a', 't:h3', 't:h4', 't:b']
    const next = reorderKeys(['t:a', 't:b'], existing, 't:b', 't:a', 'before')
    expect(next).toEqual(['t:h1', 't:h2', 't:b', 't:a', 't:h3', 't:h4'])
  })

  it('drops invalid keys and duplicate entries while merging', () => {
    const merged = mergeListOrder({
      updatedAt: 5,
      top: ['t:a', 'bad-key', 't:a', 'g:g1', 42],
      groups: { g1: { updatedAt: 3, members: ['m1', '', 'm1', 'm2'] }, '': { updatedAt: 9, members: ['x'] } },
    })
    expect(merged).toEqual({
      updatedAt: 5,
      top: ['t:a', 'g:g1'],
      groups: { g1: { updatedAt: 3, members: ['m1', 'm2'] } },
    })
  })

  it('prunes deleted torrents and deleted groups while preserving timestamps when nothing is stale', () => {
    const clean = {
      updatedAt: 100,
      top: ['t:h1', 'g:g1'] as const,
      groups: { g1: { updatedAt: 50, members: ['h1', 'h2'] } },
    }
    const unchanged = pruneListOrder(
      { ...clean, top: [...clean.top] },
      new Set(['h1', 'h2']),
      new Set(['g1']),
      999,
    )
    expect(unchanged.changed).toBe(false)
    expect(unchanged.order).toEqual(clean)

    const dirty = {
      updatedAt: 100,
      top: ['t:h1', 't:dead', 'g:g1', 'g:dead-g'] as const,
      groups: {
        g1: { updatedAt: 50, members: ['h1', 'dead', 'h2'] },
        'dead-g': { updatedAt: 60, members: ['h1'] },
      },
    }
    const pruned = pruneListOrder(
      { ...dirty, top: [...dirty.top] },
      new Set(['h1', 'h2']),
      new Set(['g1']),
      500,
    )
    expect(pruned.changed).toBe(true)
    expect(pruned.order).toEqual({
      updatedAt: 500,
      top: ['t:h1', 'g:g1'],
      groups: { g1: { updatedAt: 500, members: ['h1', 'h2'] } },
    })
  })

  it('removes specified torrents and groups from stored IDB order', async () => {
    store.clear()
    await saveTopOrder(['t:h1', 't:h2', 'g:g1', 'g:g2'])
    store.set(LIST_ORDER_KEY, {
      account: null,
      order: {
        updatedAt: 10,
        top: ['t:h1', 't:h2', 'g:g1', 'g:g2'],
        groups: {
          g1: { updatedAt: 10, members: ['h1', 'h2'] },
          g2: { updatedAt: 10, members: ['h3'] },
        },
      },
    })
    await removeFromListOrder({ hashes: ['h1'], groupIds: ['g2'] })
    const stored = store.get(LIST_ORDER_KEY) as { order: { top: string[], groups: Record<string, { members: string[] }> } }
    expect(stored.order.top).toEqual(['t:h2', 'g:g1'])
    expect(Object.keys(stored.order.groups)).toEqual(['g1'])
    expect(stored.order.groups.g1?.members).toEqual(['h2'])
  })
})
