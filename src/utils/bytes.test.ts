import { describe, expect, it } from 'vitest'

import { getHumanReadableByteString } from './bytes'

/*
 * This file exists because of one crash.
 *
 * The unit table has six entries and the index was computed straight from the logarithm, so anything
 * from 1e18 up read past the end, handed `undefined` to Intl.NumberFormat, and got back
 * `TypeError: Invalid unit argument`. Nothing caught it, so it took out whatever was rendering.
 *
 * It was unreachable for years because every caller passed a number the engine, the storage quota or
 * the library had produced. A file list carried in a share link is the first caller whose number
 * comes from a query string, which is what made a dead row reachable from outside. The formatter is
 * the right place to fix it: roughly twenty call sites read this, and only one of them was audited.
 */
describe('sizes past the end of the unit table', () => {
  it('formats rather than throwing, at and past the old boundary', () => {
    expect(() => getHumanReadableByteString(1e18)).not.toThrow()
    expect(() => getHumanReadableByteString(1e21)).not.toThrow()
    expect(() => getHumanReadableByteString(Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => getHumanReadableByteString(Number.MAX_VALUE)).not.toThrow()
    expect(() => getHumanReadableByteString(Infinity)).not.toThrow()
  })

  it('says petabytes rather than an empty unit', () => {
    expect(getHumanReadableByteString(1e18)).toMatch(/PB$/)
    expect(getHumanReadableByteString(1e21)).toMatch(/PB$/)
  })

  /** the boundary itself, so a future change to the table cannot quietly move it back */
  it('still formats the largest size that was always fine', () => {
    expect(getHumanReadableByteString(999e15)).toBe('999 PB')
  })
})

describe('the ordinary range, unchanged', () => {
  const CASES: [number, string][] = [
    [0, '0 bytes'],
    [1, '1 B'],
    [999, '999 B'],
    [1000, '1 kB'],
    [1_500_000, '1.5 MB'],
    [1_400_000_000, '1.4 GB'],
    [2_500_000_000_000, '2.5 TB'],
  ]
  for (const [bytes, want] of CASES) {
    it(`formats ${bytes} as ${want}`, () => {
      expect(getHumanReadableByteString(bytes)).toBe(want)
    })
  }

  it('still answers for NaN rather than throwing', () => {
    expect(getHumanReadableByteString(NaN)).toBe('NaN')
  })
})
