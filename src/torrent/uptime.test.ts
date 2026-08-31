import { describe, expect, it } from 'vitest'

import type { Totals } from './uptime'

import { NO_UPTIME, WRITE_EVERY_SECONDS, accumulate, formatDuration, mergeTotals, sessionTotals, totalUptime, worthWriting } from './uptime'

const at = (activeSeconds: number, seedingSeconds = 0) => ({ activeSeconds, seedingSeconds })

describe('accumulating across sessions', () => {
  it('adds this session onto what was stored', () => {
    expect(totalUptime(at(900, 300), at(0, 0), at(60, 20))).toEqual(at(960, 320))
  })

  /**
   * THE CASE THE DELTA EXISTS FOR. A resume blob restores libtorrent's own counters, so the engine
   * begins this session already reading 900 seconds, and the stored total already contains those
   * same 900. Adding the engine's reading rather than the delta would count them twice, and the
   * figure would roughly double on every reload: a torrent seeded for a day would claim a week
   * inside a week.
   */
  it('does not count time twice when the engine restored its own counters', () => {
    expect(totalUptime(at(900, 300), at(900, 300), at(960, 320))).toEqual(at(960, 320))
  })

  it('starts from nothing for a torrent that has never been recorded', () => {
    expect(totalUptime(undefined, at(0, 0), at(45, 5))).toEqual(at(45, 5))
    expect(totalUptime(NO_UPTIME, at(0, 0), at(45, 5))).toEqual(at(45, 5))
  })

  /**
   * A recheck resets libtorrent's timers, and so does re-adding a torrent whose blob was deleted.
   * Time already counted is not something to give back, so the delta floors at zero rather than
   * subtracting: without this the total would fall, and a number that goes backwards reads as a bug
   * whichever way it is explained.
   */
  it('never subtracts when the engine restarts its own clock', () => {
    expect(totalUptime(at(900, 300), at(900, 300), at(0, 0))).toEqual(at(900, 300))
    expect(totalUptime(at(900, 300), at(900, 300), at(10, 2))).toEqual(at(900, 300))
  })

  it('ignores a stored value that is not a usable number', () => {
    expect(totalUptime({ activeSeconds: NaN, seedingSeconds: -5 }, at(0, 0), at(30, 10))).toEqual(at(30, 10))
  })

  it('tracks the two clocks independently', () => {
    // running the whole time, seeding for only part of it
    expect(totalUptime(at(100, 0), at(0, 0), at(50, 10))).toEqual(at(150, 10))
  })
})

describe('when it is worth writing to disk', () => {
  it('waits until enough has accumulated to be worth a transaction', () => {
    expect(worthWriting(at(100, 0), at(100 + WRITE_EVERY_SECONDS - 1, 0))).toBe(false)
    expect(worthWriting(at(100, 0), at(100 + WRITE_EVERY_SECONDS, 0))).toBe(true)
  })

  it('writes on either clock moving, not only the first', () => {
    expect(worthWriting(at(100, 100), at(100, 100 + WRITE_EVERY_SECONDS))).toBe(true)
  })

  it('writes for a torrent with nothing stored yet', () => {
    expect(worthWriting(undefined, at(WRITE_EVERY_SECONDS, 0))).toBe(true)
    expect(worthWriting(undefined, at(1, 0))).toBe(false)
  })
})

describe('saying how long', () => {
  it('uses seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(59)).toBe('59s')
  })

  it('uses minutes, then hours and minutes', () => {
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(3_599)).toBe('59m')
    expect(formatDuration(3_600)).toBe('1h')
    expect(formatDuration(3_600 + 300)).toBe('1h 5m')
  })

  it('uses days and hours for anything longer', () => {
    expect(formatDuration(86_400)).toBe('1d')
    expect(formatDuration(86_400 * 3 + 3_600 * 4)).toBe('3d 4h')
  })

  /** Two units at most: a torrent seeding for months should not read `2160h 0m`. */
  it('never shows more than two units, or a trailing zero unit', () => {
    expect(formatDuration(86_400 * 90)).toBe('90d')
    expect(formatDuration(86_400 * 90 + 3_600 * 2 + 61)).toBe('90d 2h')
    expect(formatDuration(7_200)).toBe('2h')
  })

  it('treats nonsense as nothing rather than rendering NaN', () => {
    expect(formatDuration(NaN)).toBe('0s')
    expect(formatDuration(-10)).toBe('0s')
  })
})

/*
 * The same delta rule over more counters, plus the merge that reconciles two devices.
 *
 * The bytes are here for the reason the seconds are: libtorrent counts them and writes them into
 * resume data, and a finished torrent's blob is written once and never again, so a library left
 * seeding reports whatever it had uploaded seconds after it finished. That is the most visible way
 * this goes wrong, because it looks like the upload total resetting on every reload.
 */
describe('accumulating every counter, not just the seconds', () => {
  const engine = (over: Partial<Totals> = {}): Totals =>
    ({ activeSeconds: 0, seedingSeconds: 0, downloaded: 0, uploaded: 0, wasted: 0, ...over })

  it('adds this session to what was stored, key by key', () => {
    const stored = engine({ activeSeconds: 100, downloaded: 1_000, uploaded: 500 })
    const atAdd = engine({ activeSeconds: 40, downloaded: 200 })
    const now = engine({ activeSeconds: 90, downloaded: 900, uploaded: 300 })
    expect(accumulate(stored, atAdd, now)).toEqual({
      activeSeconds: 150, seedingSeconds: 0, downloaded: 1_700, uploaded: 800, wasted: 0,
    })
  })

  /*
   * A recheck resets libtorrent's counters, and so does re-adding a torrent whose resume blob was
   * deleted. Time and bytes already counted are not something to give back, so the delta floors at
   * zero rather than subtracting.
   */
  it('never gives back what a reset took, in any counter', () => {
    const stored = engine({ activeSeconds: 500, uploaded: 9_000 })
    const atAdd = engine({ activeSeconds: 400, uploaded: 8_000 })
    const now = engine({ activeSeconds: 0, uploaded: 0 })
    expect(accumulate(stored, atAdd, now)).toEqual({
      activeSeconds: 500, seedingSeconds: 0, downloaded: 0, uploaded: 9_000, wasted: 0,
    })
  })

  it('reports the session delta on its own, which is what sits beside the total', () => {
    expect(sessionTotals(engine({ activeSeconds: 40, uploaded: 100 }), engine({ activeSeconds: 90, uploaded: 700 })))
      .toEqual({ activeSeconds: 50, seedingSeconds: 0, downloaded: 0, uploaded: 600, wasted: 0 })
  })
})

describe('reconciling two devices', () => {
  const totals = (over: Partial<Totals> = {}): Totals =>
    ({ activeSeconds: 0, seedingSeconds: 0, downloaded: 0, uploaded: 0, wasted: 0, ...over })

  it('takes the highest of each, so a laptop on 3 GB and a desktop on 2 GB both end on 3 GB', () => {
    const laptop = totals({ downloaded: 3_000_000_000, activeSeconds: 100 })
    const desktop = totals({ downloaded: 2_000_000_000, activeSeconds: 400 })
    expect(mergeTotals(laptop, desktop)).toEqual(totals({ downloaded: 3_000_000_000, activeSeconds: 400 }))
  })

  /*
   * The three properties that make this safe to run in any order, any number of times, on either
   * device. Without them a merge could move a number backwards, and a write lost to a race would
   * stay lost rather than being republished by the next one.
   */
  it('is commutative, associative and idempotent, which is what makes it converge', () => {
    const a = totals({ downloaded: 10, uploaded: 5, activeSeconds: 7 })
    const b = totals({ downloaded: 4, uploaded: 9, activeSeconds: 2 })
    const c = totals({ downloaded: 6, uploaded: 1, activeSeconds: 11 })
    expect(mergeTotals(a, b)).toEqual(mergeTotals(b, a))
    expect(mergeTotals(mergeTotals(a, b), c)).toEqual(mergeTotals(a, mergeTotals(b, c)))
    expect(mergeTotals(mergeTotals(a, b), b)).toEqual(mergeTotals(a, b))
  })

  it('never moves a counter backwards, whatever it is merged with', () => {
    const mine = totals({ downloaded: 500, activeSeconds: 60 })
    for (const other of [undefined, totals(), totals({ downloaded: 1 }), totals({ activeSeconds: 59 })]) {
      const merged = mergeTotals(mine, other)
      expect(merged.downloaded).toBeGreaterThanOrEqual(mine.downloaded)
      expect(merged.activeSeconds).toBeGreaterThanOrEqual(mine.activeSeconds)
    }
  })

  it('treats a missing side as zero rather than throwing', () => {
    expect(mergeTotals(undefined, undefined)).toEqual(totals())
    expect(mergeTotals(totals({ uploaded: 8 }), undefined)).toEqual(totals({ uploaded: 8 }))
  })
})
