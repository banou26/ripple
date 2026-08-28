import { describe, expect, it } from 'vitest'

import { place } from './menu'

/**
 * Where a menu goes, as arithmetic.
 *
 * Driven with synthetic rectangles rather than a real menu because the case that matters most is
 * the one a test is least likely to arrange by accident: a trigger close enough to the bottom of
 * the viewport that the menu cannot open downwards. Reproducing that with a real header means
 * sizing a viewport around a component, and the answer would still be one number.
 *
 * The two placements flip DIFFERENTLY and that is the whole point of them being separate. A pointer
 * menu subtracts its height from a point, because a point has no size. A control's menu has to
 * clear the control, so subtracting from the same edge would land the menu on top of the thing that
 * opened it, with a destructive row under the cursor that just pressed it.
 */

// in the browser project on purpose: place() reads window.innerWidth and window.innerHeight
const vw = () => window.innerWidth
const vh = () => window.innerHeight

const anchor = (rect: Partial<DOMRect>) => ({
  current: { getBoundingClientRect: () => rect as DOMRect } as unknown as HTMLElement,
})

const BOX = { width: 240, height: 90 }

describe('a menu hanging under a control', () => {
  it('end-aligns with the control and sits below it', () => {
    const a = { right: 600, bottom: 60, top: 22, left: 460 }
    const at = place({ kind: 'under', of: anchor(a) }, BOX)!
    expect(at.x).toBe(600 - BOX.width)
    expect(at.y).toBe(60 + 6)
  })

  /**
   * The case this function exists for. Flipping the way the pointer branch does would put the menu
   * at `bottom - height`, which overlaps the trigger rather than clearing it.
   */
  it('flips ACROSS the control near the bottom, never over it', () => {
    const bottom = vh() - 10
    const top = bottom - 38
    const at = place({ kind: 'under', of: anchor({ right: 600, bottom, top, left: 460 }) }, BOX)!
    expect(at.y).toBe(top - 6 - BOX.height)
    // the property, stated as the thing that must not happen: no overlap with the trigger
    expect(at.y + BOX.height).toBeLessThanOrEqual(top)
  })

  it('stays below when there is no room above either, rather than leaving the viewport', () => {
    // a short viewport where neither side fits: below is the honest answer, and the menu scrolls
    const at = place({ kind: 'under', of: anchor({ right: 600, bottom: vh() - 10, top: 4, left: 460 }) }, BOX)!
    expect(at.y).toBe(vh() - 10 + 6)
  })

  it('slides back inside rather than hanging off the right edge', () => {
    const at = place({ kind: 'under', of: anchor({ right: vw() + 40, bottom: 60, top: 22, left: vw() }) }, BOX)!
    expect(at.x).toBeLessThanOrEqual(vw() - BOX.width - 8)
    expect(at.x).toBeGreaterThanOrEqual(8)
  })

  it('never goes off the left edge for a control near it', () => {
    const at = place({ kind: 'under', of: anchor({ right: 60, bottom: 60, top: 22, left: 10 }) }, BOX)!
    expect(at.x).toBe(8)
  })

  /** The trigger can be gone by the time a reposition runs, and null is what says so. */
  it('answers null when the control has left the page', () => {
    expect(place({ kind: 'under', of: { current: null } }, BOX)).toBeNull()
  })
})

describe('a menu at the pointer', () => {
  it('opens down and right from the cursor when it fits', () => {
    expect(place({ kind: 'pointer', at: { x: 40, y: 40 } }, BOX)).toEqual({ x: 40, y: 40 })
  })

  /** Flipped, not clamped: clamping slides the menu under the cursor about to be released. */
  it('flips about the point at an edge', () => {
    const at = place({ kind: 'pointer', at: { x: vw() - 5, y: vh() - 5 } }, BOX)!
    expect(at.x).toBe(vw() - 5 - BOX.width)
    expect(at.y).toBe(vh() - 5 - BOX.height)
  })
})
