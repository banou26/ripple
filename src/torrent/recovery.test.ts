import { describe, expect, it } from 'vitest'

import { createRecoveryTracker, pauseLanded } from './recovery'

const stopped = { paused: true, state: 3, totalDone: 0, downloadRate: 0, numPeers: 0, queued: false, error: '' }
const errored = { ...stopped, error: 'No space left on device' }
const queued = { ...stopped, queued: true }
const running = (totalDone: number, downloadRate = 1_000) =>
  ({ paused: false, state: 3, totalDone, downloadRate, numPeers: 4, queued: false, error: '' })
const quiet = (totalDone: number) =>
  ({ paused: false, state: 3, totalDone, downloadRate: 0, numPeers: 0, queued: false, error: '' })

describe('recovery tracker', () => {
  it('schedules the first retry 5s after a torrent is stopped, and widens from there', () => {
    const r = createRecoveryTracker()
    let t = 1_000_000
    r.observe(1, stopped, false, t)
    expect(r.state(1)).toMatchObject({ reason: 'stopped', attempt: 0 })
    expect(r.due(t)).toEqual([])

    t += 4_999
    expect(r.due(t)).toEqual([])
    t += 1
    expect(r.due(t)).toEqual([{ handle: 1, reason: 'stopped' }])
    expect(r.state(1)!.attempt).toBe(1)

    r.observe(1, stopped, false, t)
    expect(r.due(t + 14_999)).toEqual([])
    expect(r.due(t + 15_000)).toEqual([{ handle: 1, reason: 'stopped' }])
  })

  it('caps the backoff and keeps retrying forever', () => {
    const r = createRecoveryTracker()
    let t = 0
    r.observe(1, stopped, false, t)
    const gaps: number[] = []
    for (let i = 0; i < 12; i++) {
      const before = t
      t = r.state(1)!.retryAt
      gaps.push(t - before)
      expect(r.due(t)).toEqual([{ handle: 1, reason: 'stopped' }])
      r.observe(1, stopped, false, t + 10_001)
      t += 10_001
    }
    expect(gaps[0]).toBe(5_000)
    expect(gaps.slice(-3).every((g) => g > 0 && g <= 300_000)).toBe(true)
    expect(r.state(1)).not.toBeNull()
  })

  it('forgets a torrent that has run healthily for a minute, resetting the backoff', () => {
    const r = createRecoveryTracker()
    let t = 0
    r.observe(1, stopped, false, t)
    t = r.state(1)!.retryAt
    r.due(t)
    expect(r.state(1)!.attempt).toBe(1)

    t += 10_001
    r.observe(1, running(1), false, t)
    expect(r.state(1)).toBeNull()
    t += 59_000
    r.observe(1, running(2), false, t)
    t += 2_000
    r.observe(1, running(3), false, t)

    r.observe(1, stopped, false, t)
    expect(r.state(1)).toMatchObject({ attempt: 0 })
    expect(r.state(1)!.retryAt - t).toBe(5_000)
  })

  it('keeps the attempt count when a torrent fails again before it earned a reset', () => {
    const r = createRecoveryTracker()
    let t = 0
    r.observe(1, stopped, false, t)
    t = r.state(1)!.retryAt
    r.due(t)
    t += 10_001
    r.observe(1, running(1), false, t)
    expect(r.state(1)).toBeNull()
    t += 5_000
    r.observe(1, stopped, false, t)
    expect(r.state(1)!.attempt).toBe(1)
    expect(r.state(1)!.retryAt - t).toBe(15_000)
  })

  it('never touches a torrent the user paused', () => {
    const r = createRecoveryTracker()
    r.observe(1, stopped, true, 0)
    expect(r.state(1)).toBeNull()
    expect(r.due(1_000_000)).toEqual([])
  })

  it('leaves a torrent alone while it is checking files', () => {
    const r = createRecoveryTracker()
    r.observe(1, { ...stopped, state: 1 }, false, 0)
    r.observe(1, { ...stopped, state: 7 }, false, 500)
    expect(r.state(1)).toBeNull()
  })

  it('calls a torrent stalled only after two minutes of no peers and no bytes', () => {
    const r = createRecoveryTracker()
    r.observe(1, quiet(100), false, 0)
    r.observe(1, quiet(100), false, 119_999)
    expect(r.state(1)).toBeNull()
    r.observe(1, quiet(100), false, 120_000)
    expect(r.state(1)).toMatchObject({ reason: 'stalled' })
  })

  it('does not call a slow but progressing torrent stalled', () => {
    const r = createRecoveryTracker()
    for (let t = 0; t <= 600_000; t += 30_000) r.observe(1, quiet(t / 1_000), false, t)
    expect(r.state(1)).toBeNull()
  })

  it('leaves a connected torrent alone even when nothing is arriving', () => {
    const r = createRecoveryTracker()
    const connectedButQuiet = { paused: false, state: 2, totalDone: 0, downloadRate: 0, numPeers: 6, queued: false, error: '' }
    for (let t = 0; t <= 600_000; t += 30_000) r.observe(1, connectedButQuiet, false, t)
    expect(r.state(1)).toBeNull()
  })

  it('leaves a torrent libtorrent queued behind others alone for as long as it is queued', () => {
    const r = createRecoveryTracker()
    for (let t = 0; t <= 600_000; t += 30_000) r.observe(1, queued, false, t)
    expect(r.state(1)).toBeNull()
    expect(r.due(600_000)).toEqual([])
  })

  it('does not treat a queued torrent as healthy, which would drop a real failure', () => {
    const r = createRecoveryTracker()
    r.observe(1, errored, false, 0)
    expect(r.state(1)).toMatchObject({ reason: 'stopped' })
    for (let at = 0; at <= 120_000; at += 5_000) r.observe(1, queued, false, at)
    expect(r.state(1)).toMatchObject({ reason: 'stopped' })
  })

  it('takes the explanation from the torrent the engine reported it against', () => {
    const r = createRecoveryTracker()
    r.observe(1, errored, false, 0)
    r.observe(2, stopped, false, 0)
    expect(r.state(1)).toMatchObject({ reason: 'stopped', message: 'No space left on device' })
    expect(r.state(2)!.message).toBeUndefined()
  })

  it('brings a manual retry forward without losing the reason', () => {
    const r = createRecoveryTracker()
    const t = 0
    r.observe(1, errored, false, t)
    expect(r.state(1)).toMatchObject({ retryAt: t + 5_000, message: 'No space left on device' })
    r.due(t + 5_000)
    expect(r.state(1)!.retryAt).toBe(t + 20_000)
    r.retry(1, t + 6_000)
    expect(r.state(1)).toMatchObject({ attempt: 0, retryAt: t + 6_000, message: 'No space left on device' })
    expect(r.due(t + 6_000)).toEqual([{ handle: 1, reason: 'stopped' }])
  })

  it('collapses every pending backoff when connectivity returns', () => {
    const r = createRecoveryTracker()
    r.observe(1, stopped, false, 0)
    r.observe(2, stopped, false, 0)
    r.due(9_000)
    expect(r.due(10_000)).toEqual([])
    r.retryNow(10_000)
    expect(r.due(10_000).map((a) => a.handle).sort()).toEqual([1, 2])
    expect(r.state(1)!.retryAt - 10_000).toBe(15_000)
  })

  it('ignores a torrent that is being held after a command', () => {
    const r = createRecoveryTracker()
    r.hold(1, 0)
    r.observe(1, stopped, false, 1_000)
    expect(r.state(1)).toBeNull()
    r.observe(1, stopped, false, 10_001)
    expect(r.state(1)).toMatchObject({ reason: 'stopped' })
  })

  it('drops all per-handle state for torrents that went away', () => {
    const r = createRecoveryTracker()
    r.observe(1, stopped, false, 0)
    r.observe(2, stopped, false, 0)
    r.retain(new Set([2]))
    expect(r.state(1)).toBeNull()
    expect(r.state(2)).not.toBeNull()
    expect(r.due(1_000_000).map((a) => a.handle)).toEqual([2])
  })
})

/**
 * WHICH KIND OF PAUSED, which is three different things wearing one flag.
 *
 * The bug this rule exists to stop: a loop enforcing a pause read a libtorrent QUEUE park as "the
 * pause has landed", withdrew the want, and then nothing re-paused the torrent when the queue
 * started it again half a second later. The row went back to Downloading on its own, with nothing
 * anywhere saying why. Measured through a tab handover: 1 pass in 4 before the rule, 6 in 6 after.
 */
describe('telling a real pause from libtorrent reporting one', () => {
  const status = (over: Partial<{ paused: boolean, autoManaged: boolean }> = {}) =>
    ({ paused: true, autoManaged: false, ...over })

  it('counts a pause that cleared auto-management, which is the only one a person asked for', () => {
    expect(pauseLanded(status())).toBe(true)
  })

  /** The queue parks whatever sits past the active limits, and unparks it again on its own. */
  it('does NOT count a queue park, which keeps auto-management on', () => {
    expect(pauseLanded(status({ autoManaged: true }))).toBe(false)
  })

  it('does not count a running torrent, however it is managed', () => {
    expect(pauseLanded(status({ paused: false }))).toBe(false)
    expect(pauseLanded(status({ paused: false, autoManaged: true }))).toBe(false)
  })

  /**
   * A handle the engine has not registered yet reports nothing at all, which is exactly the window a
   * pause can be lost in: the command returns -1 doing nothing and the caller has to try again.
   */
  it('does not count an absent status as a pause that landed', () => {
    expect(pauseLanded(null)).toBe(false)
    expect(pauseLanded(undefined)).toBe(false)
  })
})

