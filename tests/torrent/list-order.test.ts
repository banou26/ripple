import { describe, expect, it } from 'vitest'

import { EMPTY_LIST_ORDER, mergeListOrder, reorderKeys } from '../../src/torrent/list-order'

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
})
