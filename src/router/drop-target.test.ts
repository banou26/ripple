import { describe, expect, it } from 'vitest'

import type { DropState, DropTarget } from './drop-target'
import { dropTarget } from './drop-target'

/**
 * The property this file exists for: AT MOST ONE surface is ever lit.
 *
 * It is written as an exhaustive sweep rather than a handful of cases, because the defect it guards
 * against was never a wrong answer to a question anybody asked. It was two surfaces answering
 * independently, which no single-case test would have caught: each one was individually correct.
 */
const ALL: DropState[] = [false, true].flatMap((dragging) =>
  [false, true].flatMap((overField) =>
    [false, true].map((pickOpen) => ({ dragging, overField, pickOpen }))))

describe('the drop target', () => {
  it('covers every combination of the three inputs', () => {
    expect(ALL).toHaveLength(8)
  })

  it('names at most one surface, whatever the state', () => {
    for (const state of ALL) {
      const lit = dropTarget(state)
      const surfaces: DropTarget[] = ['field', 'pick', 'page']
      expect(surfaces.filter((s) => s === lit), JSON.stringify(state)).toHaveLength(lit === null ? 0 : 1)
    }
  })

  it('lights nothing at all while no drag is happening', () => {
    for (const state of ALL.filter((s) => !s.dragging)) {
      expect(dropTarget(state), JSON.stringify(state)).toBeNull()
    }
  })

  it('always lights something once a drag is happening', () => {
    for (const state of ALL.filter((s) => s.dragging)) {
      expect(dropTarget(state), JSON.stringify(state)).not.toBeNull()
    }
  })

  /**
   * The two regressions, pinned as the cases they actually were.
   *
   * Both shipped, and both looked like this: a drag over the page with a second surface visible, and
   * both lit. Named individually so a failure says which one came back.
   */
  it('stands the page down when the drag reaches the magnet field', () => {
    expect(dropTarget({ dragging: true, overField: true, pickOpen: false })).toBe('field')
  })

  it('stands the page down when the share panel is asking for a torrent', () => {
    expect(dropTarget({ dragging: true, overField: false, pickOpen: true })).toBe('pick')
  })

  it('prefers the field to the share panel, since the field takes the drop itself', () => {
    expect(dropTarget({ dragging: true, overField: true, pickOpen: true })).toBe('field')
  })

  it('falls back to the page-wide overlay when nothing narrower is on screen', () => {
    expect(dropTarget({ dragging: true, overField: false, pickOpen: false })).toBe('page')
  })
})
