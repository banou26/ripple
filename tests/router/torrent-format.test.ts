import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import { relativeDay, retryLine } from '../../src/router/torrent-format'

/**
 * The strings a row says about itself.
 *
 * `retryLine` is here because it told somebody there was an error when there was not one, and they
 * went and checked the console before reporting it. It was neither exported nor tested at the time,
 * which is how a sentence that contradicts its own data survived.
 */
const t = (over: Partial<Torrent> = {}): Torrent => ({
  id: '1',
  name: 'A release',
  size: 1,
  downloaded: 0,
  progress: 0,
  state: 'downloading',
  down: 0,
  up: 0,
  peers: 0,
  seeds: 0,
  eta: '-',
  flags: 0,
  queuePosition: -1,
  stats: null,
  ...over,
})

const retry = (over: Partial<NonNullable<Torrent['retry']>> = {}) => ({
  reason: 'stopped' as const, attempt: 1, retryInSeconds: 5, ...over,
})

describe('what a retrying row says', () => {
  /**
   * The bug. `recovery.ts` sets reason `stopped` from `status.paused` alone, and the real error text
   * arrives separately as `message`. So this branch is reached exactly when there is NO error, and
   * naming one sent somebody to the console to look for something that was never there.
   */
  it('does not claim an error when nothing reported one', () => {
    const line = retryLine(t(), retry({ reason: 'stopped' }))
    expect(line).not.toMatch(/error/i)
    expect(line).toContain('Stopped unexpectedly')
  })

  /** the control: when there IS a fault, its own text wins and the generic line never appears */
  it('shows the engine\'s own words whenever there are any', () => {
    const line = retryLine(t(), retry({ reason: 'stopped', message: 'file too short' }))
    expect(line).toContain('file too short')
    expect(line).not.toContain('Stopped unexpectedly')
  })

  it('tells a stall apart by whether anybody is connected', () => {
    expect(retryLine(t({ peers: 3 }), retry({ reason: 'stalled' }))).toContain('Peers stopped sending data')
    expect(retryLine(t({ peers: 0 }), retry({ reason: 'stalled' }))).toContain('Not connected to any peers')
  })

  it('counts down in seconds, then in minutes, and says now at zero', () => {
    expect(retryLine(t(), retry({ retryInSeconds: 2 }))).toContain('retrying in 2s')
    expect(retryLine(t(), retry({ retryInSeconds: 90 }))).toContain('retrying in 2m')
    expect(retryLine(t(), retry({ retryInSeconds: 0 }))).toContain('retrying now')
  })
})

describe('how long ago something was added', () => {
  const now = Date.parse('2026-08-30T12:00:00Z')

  it('uses hours today and days this week', () => {
    expect(relativeDay(now - 3 * 3_600_000, now)).toBe('3h')
    expect(relativeDay(now - 3 * 86_400_000, now)).toBe('3d')
  })

  it('never rounds a fresh add down to zero hours', () => {
    expect(relativeDay(now - 60_000, now)).toBe('1h')
  })

  /** absent is an absence, not a zero, and renders the way eta already does */
  it('writes a hyphen for something with no date', () => {
    expect(relativeDay(undefined, now)).toBe('-')
    expect(relativeDay(0, now)).toBe('-')
  })

  it('falls back to a date once it is older than a week', () => {
    expect(relativeDay(now - 40 * 86_400_000, now)).toMatch(/\w/)
    expect(relativeDay(now - 40 * 86_400_000, now)).not.toMatch(/^\d+[hd]$/)
  })
})
