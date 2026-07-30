// The merge is the whole point of the viewer model. Before it, priorities were rebuilt for
// whichever player asked last, so a second tab watching the same torrent had its file put
// back to normal on every seek the first one made.

import { describe, expect, it } from 'vitest'

import { AHEAD, BEHIND, NORMAL, mergePriorities } from './piece-priority'

describe('merging viewer claims into piece priorities', () => {
  it('leaves a torrent nobody is watching at normal priority', () => {
    expect([...mergePriorities(5, [])]).toEqual([NORMAL, NORMAL, NORMAL, NORMAL, NORMAL])
  })

  it('puts one viewer ahead of the playhead first and behind it last', () => {
    // File spans pieces 2..5, playhead at 4.
    expect([...mergePriorities(8, [{ p0: 2, p1: 5, pAt: 4 }])])
      .toEqual([NORMAL, NORMAL, BEHIND, BEHIND, AHEAD, AHEAD, NORMAL, NORMAL])
  })

  // The regression this model exists for. Two tabs, two files, one torrent.
  it('honours a second viewer on a different file instead of resetting the first', () => {
    const merged = mergePriorities(10, [
      { p0: 0, p1: 3, pAt: 2 },
      { p0: 6, p1: 9, pAt: 8 },
    ])
    expect([...merged]).toEqual([
      BEHIND, BEHIND, AHEAD, AHEAD, // first viewer's file
      NORMAL, NORMAL, // between them, nobody watching
      BEHIND, BEHIND, AHEAD, AHEAD, // second viewer's file
    ])
  })

  // Same file, two players at different points. Pieces 2 and 3 are behind the player at 4 but
  // ahead of the one at 2, so they are urgent. Asserted in both orders on purpose: with the
  // claims one way round, "last one wins" happens to agree with "highest wins", and a test
  // that only checked that order would pass against the bug.
  it.each([
    ['trailing player last', [{ p0: 0, p1: 5, pAt: 4 }, { p0: 0, p1: 5, pAt: 2 }]],
    ['trailing player first', [{ p0: 0, p1: 5, pAt: 2 }, { p0: 0, p1: 5, pAt: 4 }]],
  ])('gives a piece the highest claim on it, not the last one written (%s)', (_name, claims) => {
    expect([...mergePriorities(6, claims)]).toEqual([BEHIND, BEHIND, AHEAD, AHEAD, AHEAD, AHEAD])
  })

  it('covers the whole torrent, so a file prioritised earlier does not stay urgent', () => {
    // A claim on an early file must still write NORMAL over the later pieces, which is what
    // the old array (sized to the watched file) never reached.
    const merged = mergePriorities(12, [{ p0: 0, p1: 1, pAt: 0 }])
    expect(merged).toHaveLength(12)
    expect([...merged.slice(2)]).toEqual(Array(10).fill(NORMAL))
  })

  it('clamps a claim that runs past the end rather than throwing', () => {
    expect([...mergePriorities(3, [{ p0: 1, p1: 99, pAt: 2 }])]).toEqual([NORMAL, BEHIND, AHEAD])
    expect([...mergePriorities(0, [{ p0: 0, p1: 5, pAt: 0 }])]).toEqual([])
  })
})
