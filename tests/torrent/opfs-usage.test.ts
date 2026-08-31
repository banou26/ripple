import { describe, expect, it } from 'vitest'

import { correctedUsage, isUsageUnderReported } from '../../src/torrent/opfs-usage'

/**
 * Reconciling the browser's usage figure with a measured one.
 *
 * The numbers in the first test are the real ones, copied off Chrome 151 on 2026-08-30 against a
 * library holding a verified 1,783,407,077 byte file. They are here rather than as round numbers so
 * that anyone changing this arithmetic is looking at the case it exists for.
 */

const REAL = {
  usage: 1_813_502,
  quota: 10_739_231_742,
  usageDetails: { fileSystem: 752, indexedDB: 1_809_581, serviceWorkerRegistrations: 3_169 },
}
const ON_DISK = 1_783_407_077

describe('correcting a wrong usage figure', () => {
  it('replaces a file system component that is six orders of magnitude short', () => {
    // the measurement, plus the 1,812,750 bytes of IndexedDB and worker registrations Chrome DID
    // count correctly. Not simply the measurement, which would quietly drop those.
    expect(correctedUsage(REAL, ON_DISK)).toBe(ON_DISK + (REAL.usage - REAL.usageDetails.fileSystem))
  })

  it('leaves a browser that is telling the truth alone', () => {
    const honest = { usage: 5_000_000_000, quota: 10_000_000_000, usageDetails: { fileSystem: 4_900_000_000 } }
    // measured slightly lower because a file the engine has open could not be read; the browser's
    // own answer is the larger and therefore the one kept
    expect(correctedUsage(honest, 4_800_000_000)).toBe(5_000_000_000)
  })

  /**
   * The walk is a FLOOR: files locked by a live sync access handle are skipped. So a measurement
   * below the reported figure is ordinary and must never drag the answer down, or a download in
   * progress would make the origin look emptier the busier it got.
   */
  it('never reports less than the browser does', () => {
    for (const measured of [0, 1, 1_000, 900_000_000]) {
      expect(correctedUsage(REAL, measured)).toBeGreaterThanOrEqual(REAL.usage)
    }
  })

  /** Firefox reports no usageDetails, so the surgical correction is unavailable and the max is not */
  it('falls back to the larger of the two where the browser gives no breakdown', () => {
    const noDetails = { usage: 1_813_502, quota: 10_000_000_000 }
    expect(correctedUsage(noDetails, ON_DISK)).toBe(ON_DISK)
    expect(correctedUsage(noDetails, 5)).toBe(1_813_502)
  })

  it('says nothing rather than zero when neither source knows', () => {
    expect(correctedUsage({}, null)).toBeNull()
    expect(correctedUsage({ quota: 10 }, null)).toBeNull()
  })

  it('uses whichever single source it has', () => {
    expect(correctedUsage({ usage: 42 }, null)).toBe(42)
    expect(correctedUsage({}, 99)).toBe(99)
  })

  /** a negative would be a bug in the walk, and must not be allowed to shrink the answer */
  it('ignores a nonsense measurement', () => {
    expect(correctedUsage(REAL, -1)).toBe(REAL.usage)
  })

  it('never returns less than the parts the browser counted correctly', () => {
    // the IndexedDB and worker bytes are real whatever the file system holds
    const other = REAL.usage - REAL.usageDetails.fileSystem
    expect(correctedUsage(REAL, 0)).toBeGreaterThanOrEqual(other)
  })
})

describe('spotting an under-report', () => {
  it('recognises the case this module was written for', () => {
    expect(isUsageUnderReported(REAL, ON_DISK)).toBe(true)
  })

  it('does not cry wolf at a browser that is merely a little behind', () => {
    expect(isUsageUnderReported({ usage: 900 }, 1_000)).toBe(false)
  })

  it('says nothing when there is no measurement or nothing on disk', () => {
    expect(isUsageUnderReported(REAL, null)).toBe(false)
    expect(isUsageUnderReported(REAL, 0)).toBe(false)
  })
})
