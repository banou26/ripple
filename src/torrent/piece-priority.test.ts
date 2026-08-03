// The priority array is global to a torrent: rebuilding it for the last player to ask put a second tab's file back to normal on every seek

import { describe, expect, it } from 'vitest'

import { AHEAD, BEHIND, NORMAL, mergePriorities } from './piece-priority'

describe('merging viewer claims into piece priorities', () => {
  it('leaves a torrent nobody is watching at normal priority', () => {
    expect([...mergePriorities(5, [])]).toEqual([NORMAL, NORMAL, NORMAL, NORMAL, NORMAL])
  })

  it('puts one viewer ahead of the playhead first and behind it last', () => {
    expect([...mergePriorities(8, [{ p0: 2, p1: 5, pAt: 4 }])])
      .toEqual([NORMAL, NORMAL, BEHIND, BEHIND, AHEAD, AHEAD, NORMAL, NORMAL])
  })

  it('honours a second viewer on a different file instead of resetting the first', () => {
    const merged = mergePriorities(10, [
      { p0: 0, p1: 3, pAt: 2 },
      { p0: 6, p1: 9, pAt: 8 },
    ])
    expect([...merged]).toEqual([
      BEHIND, BEHIND, AHEAD, AHEAD,
      NORMAL, NORMAL,
      BEHIND, BEHIND, AHEAD, AHEAD,
    ])
  })

  // Both orders on purpose: one way round, "last one wins" agrees with "highest wins" and passes against the bug
  it.each([
    ['trailing player last', [{ p0: 0, p1: 5, pAt: 4 }, { p0: 0, p1: 5, pAt: 2 }]],
    ['trailing player first', [{ p0: 0, p1: 5, pAt: 2 }, { p0: 0, p1: 5, pAt: 4 }]],
  ])('gives a piece the highest claim on it, not the last one written (%s)', (_name, claims) => {
    expect([...mergePriorities(6, claims)]).toEqual([BEHIND, BEHIND, AHEAD, AHEAD, AHEAD, AHEAD])
  })

  it('covers the whole torrent, so a file prioritised earlier does not stay urgent', () => {
    const merged = mergePriorities(12, [{ p0: 0, p1: 1, pAt: 0 }])
    expect(merged).toHaveLength(12)
    expect([...merged.slice(2)]).toEqual(Array(10).fill(NORMAL))
  })

  it('clamps a claim that runs past the end rather than throwing', () => {
    expect([...mergePriorities(3, [{ p0: 1, p1: 99, pAt: 2 }])]).toEqual([NORMAL, BEHIND, AHEAD])
    expect([...mergePriorities(0, [{ p0: 0, p1: 5, pAt: 0 }])]).toEqual([])
  })
})
