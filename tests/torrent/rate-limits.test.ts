import { describe, expect, it } from 'vitest'

import {
  BYTES_PER_KB,
  NO_LIMITS,
  UNLIMITED,
  effectiveLimit,
  formatLimit,
  isLimit,
  limitInputValue,
  limitLabel,
  limitNote,
  limitsOf,
  normalizeLimits,
  parseLimit,
} from '../../src/torrent/rate-limits'

/**
 * The rules behind two speed ceilings, with no engine and no dialog in sight.
 *
 * Two of these carry the weight. 0 means UNLIMITED rather than "stopped", so it has to lose every
 * comparison instead of winning as the smallest number, and an unlimited session must never be read
 * as a session capped at nothing. And `undefined` has to stay distinguishable from 0: one is a
 * torrent that has never been given a limit, the other is one deliberately exempted, and once the
 * two are collapsed in storage the difference cannot be recovered.
 */

describe('what counts as a limit at all', () => {
  it('takes whole non-negative numbers and nothing else', () => {
    for (const good of [0, 1, 1000, 5_000_000]) expect(isLimit(good)).toBe(true)
    // the wasm layer floors and clamps whatever it is handed, so a value it would silently alter is
    // refused here instead: otherwise the number on screen is not the number in force
    for (const bad of [-1, 1.5, NaN, Infinity, '1000', null, undefined, {}]) expect(isLimit(bad)).toBe(false)
  })
})

describe('reading a stored pair', () => {
  it('is unlimited when nothing was ever stored', () => {
    expect(normalizeLimits(undefined)).toEqual(NO_LIMITS)
    expect(normalizeLimits(null)).toEqual({ down: 0, up: 0 })
  })

  it('keeps a real pair', () => {
    expect(normalizeLimits({ down: 2_000_000, up: 500_000 })).toEqual({ down: 2_000_000, up: 500_000 })
  })

  it('drops junk per direction rather than the whole pair', () => {
    expect(normalizeLimits({ down: 2_000_000, up: -5 })).toEqual({ down: 2_000_000, up: 0 })
    expect(normalizeLimits({ down: 'fast', up: 1000 })).toEqual({ down: 0, up: 1000 })
  })
})

describe('one torrent\'s own limits', () => {
  /**
   * The distinction the whole file exists to protect. A torrent that has never been given a limit
   * follows the session and nothing else; a torrent explicitly set to 0 has been exempted on purpose.
   */
  it('keeps never-set apart from deliberately unlimited', () => {
    expect(limitsOf({}).down).toBeUndefined()
    expect(limitsOf({ downloadLimit: 0 }).down).toBe(0)
  })

  it('reads both directions, and copes with no entry at all', () => {
    expect(limitsOf({ downloadLimit: 1000, uploadLimit: 2000 })).toEqual({ down: 1000, up: 2000 })
    expect(limitsOf(null)).toEqual({ down: undefined, up: undefined })
  })

  it('treats a stored value it cannot use as never set', () => {
    expect(limitsOf({ downloadLimit: -1 }).down).toBeUndefined()
  })
})

describe('which ceiling actually binds', () => {
  it('takes the tighter of the two', () => {
    expect(effectiveLimit(5_000_000, 1_000_000)).toBe(1_000_000)
    expect(effectiveLimit(1_000_000, 5_000_000)).toBe(1_000_000)
  })

  /**
   * 0 has to LOSE this comparison. Read as the smallest number it wins every time, and an unlimited
   * session then caps every torrent at zero: a download that connects, finds peers and never moves.
   */
  it('lets an unlimited session defer to the torrent, not cap it at nothing', () => {
    expect(effectiveLimit(UNLIMITED, 1_000_000)).toBe(1_000_000)
    expect(effectiveLimit(1_000_000, UNLIMITED)).toBe(1_000_000)
    expect(effectiveLimit(UNLIMITED, UNLIMITED)).toBe(UNLIMITED)
  })

  it('falls back to the session limit for a torrent that has never been given one', () => {
    expect(effectiveLimit(2_000_000, undefined)).toBe(2_000_000)
    expect(effectiveLimit(UNLIMITED, undefined)).toBe(UNLIMITED)
  })
})

describe('reading the kB/s field', () => {
  it('converts to bytes per second', () => {
    expect(parseLimit('1000')).toBe(1_000_000)
    expect(parseLimit('1.5')).toBe(1500)
    expect(parseLimit(' 250 ')).toBe(250_000)
  })

  it('takes 0 as a real answer, because it is how unlimited is expressed', () => {
    expect(parseLimit('0')).toBe(0)
  })

  /**
   * Empty is null and NOT zero. Zero removes the limit, and a half-typed or cleared field must never
   * be read as a decision to remove one.
   */
  it('refuses an empty field rather than reading it as unlimited', () => {
    expect(parseLimit('')).toBe(null)
    expect(parseLimit('   ')).toBe(null)
  })

  it('refuses anything that is not a number, including the half-numbers parseFloat accepts', () => {
    for (const junk of ['fast', '12abc', '-5', 'NaN', 'Infinity', '1e400']) expect(parseLimit(junk)).toBe(null)
  })

  it('round trips through the field it fills', () => {
    expect(limitInputValue(parseLimit('250')!)).toBe('250')
    // unlimited leaves the field EMPTY rather than holding a 0 to be deleted first
    expect(limitInputValue(0)).toBe('')
    expect(limitInputValue(undefined)).toBe('')
  })

  it('agrees with the rest of Ripple that a kilobyte is 1000 bytes', () => {
    expect(BYTES_PER_KB).toBe(1000)
  })
})

describe('how a limit reads', () => {
  it('says unlimited rather than 0 B/s', () => {
    expect(formatLimit(0)).toBe('Unlimited')
    expect(formatLimit(undefined)).toBe('Unlimited')
  })

  it('scales to MB/s once there is enough of it', () => {
    expect(formatLimit(500_000)).toBe('500 kB/s')
    expect(formatLimit(1_500_000)).toBe('1.5 MB/s')
    expect(formatLimit(12_000_000)).toBe('12 MB/s')
  })

})

/**
 * libtorrent accepts a per-torrent limit above the session one and then ignores it, because a
 * torrent can never exceed the global ceiling (torrent_handle.hpp:1234). That is invisible from the
 * outside, so the label and the note are the only things standing between the user and a control
 * that looks broken.
 */
describe('saying so when the session limit is what really binds', () => {
  it('names the session limit in the label when it overrides the torrent\'s own', () => {
    expect(limitLabel(5_000_000, 1_000_000)).toBe('5 MB/s, held to 1 MB/s in total')
  })

  it('says nothing extra when the torrent\'s own limit is the one in force', () => {
    expect(limitLabel(1_000_000, 5_000_000)).toBe('1 MB/s')
    expect(limitLabel(1_000_000, UNLIMITED)).toBe('1 MB/s')
  })

  it('still mentions the session limit for a torrent with none of its own', () => {
    expect(limitLabel(undefined, 2_000_000)).toBe('Unlimited, 2 MB/s in total')
    expect(limitLabel(undefined, UNLIMITED)).toBe('Unlimited')
  })

  it('warns only when there is something surprising to warn about', () => {
    expect(limitNote(5_000_000, 1_000_000)).toMatch(/1 MB\/s/)
    expect(limitNote(1_000_000, 5_000_000)).toBe(null)
    expect(limitNote(1_000_000, UNLIMITED)).toBe(null)
    expect(limitNote(undefined, 1_000_000)).toBe(null)
    // equal is not exceeded, so there is nothing to explain
    expect(limitNote(1_000_000, 1_000_000)).toBe(null)
  })
})
