/**
 * The publish gate, and the case that cost a run: an UNPUBLISHED version number.
 *
 * npm keeps a number reserved after an unpublish. The version document 404s and `versions` no longer
 * carries it, so the obvious check reads it as free, while the upload is still refused with
 * "Cannot publish over previously published version". @banou/ripple 0.0.6 was published on
 * 2025-03-17 and unpublished a minute later, and on 2026-09-11 the first automated run built the
 * whole package and signed a provenance statement into the public transparency log before the PUT
 * came back 400.
 *
 * `time` keeps every number that was ever used, which is why the gate reads that and not `versions`.
 */
import { decide } from '../scripts/npm-version-gate.mjs'

import { describe, expect, it } from 'vitest'

/** the real shape, trimmed: 0.0.6 sits in `time` and in no other field */
const RIPPLE = {
  versions: { '0.0.1': {}, '0.0.3': {}, '0.0.4': {} },
  time: {
    created: '2023-12-14T01:46:34.519Z',
    '0.0.1': '2023-12-14T01:46:34.916Z',
    '0.0.2': '2023-12-24T17:47:37.552Z',
    '0.0.3': '2023-12-24T22:43:48.549Z',
    '0.0.4': '2023-12-26T00:42:10.564Z',
    '0.0.6': '2025-03-17T00:40:35.916Z',
  },
}

describe('a version number that was used and unpublished', () => {
  it('is refused, because the registry reserves it forever', () => {
    const { action, reason } = decide(RIPPLE, '0.0.6')
    expect(action, 'the version document 404s, so anything reading that would build and sign first').toBe('refuse')
    expect(reason).toContain('2025-03-17')
  })

  it('is refused for every such number, not just the newest', () => {
    expect(decide(RIPPLE, '0.0.2').action).toBe('refuse')
  })
})

describe('the ordinary cases', () => {
  it('skips a version the registry already serves', () => {
    expect(decide(RIPPLE, '0.0.4').action).toBe('skip')
  })

  it('publishes a number that has never been used', () => {
    expect(decide(RIPPLE, '0.0.7').action).toBe('publish')
  })

  it('publishes when the registry carries no such package at all', () => {
    expect(decide(null, '0.0.1').action).toBe('publish')
  })
})
