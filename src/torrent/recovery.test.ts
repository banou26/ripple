import { describe, expect, it } from 'vitest'

import { createRecoveryTracker } from './recovery'

const stopped = { paused: true, state: 3, totalDone: 0, downloadRate: 0, numPeers: 0, queued: false, error: '' }
// Stopped by a disk failure, which the engine reports on the torrent it happened to.
const errored = { ...stopped, error: 'No space left on device' }
// Stopped by libtorrent's own queue rather than by anything going wrong.
const queued = { ...stopped, queued: true }
const running = (totalDone: number, downloadRate = 1_000) =>
  ({ paused: false, state: 3, totalDone, downloadRate, numPeers: 4, queued: false, error: '' })
// Downloading in name only: no peers and nothing arriving.
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

    // Still stopped: the grace window keeps it from being re-judged, then the next
    // retry lands 15s after the first, not 5s.
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
      // Jump straight to whatever it is waiting for.
      t = r.state(1)!.retryAt
      gaps.push(t - before)
      expect(r.due(t)).toEqual([{ handle: 1, reason: 'stopped' }])
      r.observe(1, stopped, false, t + 10_001)
      t += 10_001
    }
    expect(gaps[0]).toBe(5_000)
    // Never gives up, and never retries faster than the 5 minute ceiling once there.
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

    // Recovered. The entry survives until it has proved itself.
    t += 10_001
    r.observe(1, running(1), false, t)
    expect(r.state(1)).toBeNull()
    t += 59_000
    r.observe(1, running(2), false, t)
    t += 2_000
    r.observe(1, running(3), false, t)

    // Next failure starts from the shortest delay again.
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
    // Fails again after 5s of health, well short of the 60s it needs.
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
    // A magnet fetching metadata, or a torrent every peer is choking: kicking it would
    // disconnect the peers it is waiting on.
    const connectedButQuiet = { paused: false, state: 2, totalDone: 0, downloadRate: 0, numPeers: 6, queued: false, error: '' }
    for (let t = 0; t <= 600_000; t += 30_000) r.observe(1, connectedButQuiet, false, t)
    expect(r.state(1)).toBeNull()
  })

  it('leaves a torrent libtorrent queued behind others alone for as long as it is queued', () => {
    const r = createRecoveryTracker()
    // The engine reports the queue rather than Ripple inferring it, so there is no window
    // after which the explanation has to be doubted: a ten minute wait behind a big
    // library is a torrent working exactly as intended.
    for (let t = 0; t <= 600_000; t += 30_000) r.observe(1, queued, false, t)
    expect(r.state(1)).toBeNull()
    expect(r.due(600_000)).toEqual([])
  })

  it('does not treat a queued torrent as healthy, which would drop a real failure', () => {
    const r = createRecoveryTracker()
    r.observe(1, errored, false, 0)
    expect(r.state(1)).toMatchObject({ reason: 'stopped' })
    // Another torrent gets promoted into the freed slot, so this one now reads as queued.
    for (let at = 0; at <= 120_000; at += 5_000) r.observe(1, queued, false, at)
    // The failure is still on the books, so the retry schedule and the reason survive.
    expect(r.state(1)).toMatchObject({ reason: 'stopped' })
  })

  it('takes the explanation from the torrent the engine reported it against', () => {
    const r = createRecoveryTracker()
    r.observe(1, errored, false, 0)
    // A second torrent stopped in the same tick for an unrelated reason must not inherit
    // the first one's message, which is exactly what timing-based attribution did.
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
    // And the schedule restarts short rather than continuing to widen.
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
