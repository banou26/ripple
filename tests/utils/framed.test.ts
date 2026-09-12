import { afterEach, describe, expect, it, vi } from 'vitest'

import { isFramed } from '../../src/utils/framed'

/**
 * The one frame test both callers share, driven from node.
 *
 * The case that matters is the THROWING one, and it is the case a browser actually produces: reading
 * `window.top` from a cross-origin frame throws, which is precisely the situation the callers refuse
 * in, so a check that let the error escape, or answered false on it, would refuse nothing exactly
 * where it has to refuse.
 */

const windowLike = (over: Record<string, unknown>): unknown => {
  const stub: Record<string, unknown> = { ...over }
  stub['self'] = stub
  if (!('top' in over)) stub['top'] = stub
  return stub
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('whether this document is inside somebody else\'s frame', () => {
  it('is false at the top level, where both callers do their work', () => {
    vi.stubGlobal('window', windowLike({}))
    expect(isFramed()).toBe(false)
  })

  it('is true in a frame, including a same-origin one', () => {
    vi.stubGlobal('window', windowLike({ top: { name: 'somebody else' } }))
    expect(isFramed()).toBe(true)
  })

  it('is true when the read itself throws, which is what a cross-origin frame does', () => {
    const stub: Record<string, unknown> = {}
    stub['self'] = stub
    Object.defineProperty(stub, 'top', {
      get () { throw new Error('Blocked a frame with origin "https://fkn.app" from accessing a cross-origin frame.') },
    })
    vi.stubGlobal('window', stub)
    expect(isFramed(), 'a throw is the cross-origin answer, so it cannot be read as "not framed"').toBe(true)
  })

  it('is false where there is no window at all, so a worker import is not a refusal', () => {
    expect(typeof window, 'the unit project runs in node, so this is the real absence').toBe('undefined')
    expect(isFramed()).toBe(false)
  })
})
