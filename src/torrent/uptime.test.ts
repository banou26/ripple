import { describe, expect, it } from 'vitest'

import { NO_UPTIME, WRITE_EVERY_SECONDS, formatDuration, totalUptime, worthWriting } from './uptime'

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
