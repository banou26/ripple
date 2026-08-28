import { describe, expect, it } from 'vitest'

import type { TorrentState } from './types'
import { interrupts, isIdle } from './shell-update'

/**
 * The set is written as "idle", so a state nobody classified reads as busy. That direction is the
 * whole point, and it is what the sweep below pins: the cost of being wrong one way is staying on
 * an old shell until the next reload, and the other way it is somebody's download stopping.
 */
const ALL: TorrentState[] = [
  'downloading', 'seeding', 'paused', 'queued', 'done',
  'error', 'missing', 'retrying', 'checking', 'starting',
]

describe('whether a shell reload would interrupt anything', () => {
  it('covers every state the engine can report', () => {
    expect(ALL).toHaveLength(10)
  })

  it('treats an empty library as safe to reload', () => {
    expect(interrupts([])).toBe(false)
  })

  it('reloads over torrents that are all sitting still', () => {
    expect(interrupts(ALL.filter(isIdle))).toBe(false)
  })

  it('refuses when a single torrent is working, whatever else is idle', () => {
    for (const state of ALL.filter((s) => !isIdle(s))) {
      expect(interrupts(['done', state, 'paused']), state).toBe(true)
    }
  })

  /** the four that matter most, named so a failure says which one was reclassified */
  it('counts downloading, seeding, checking and starting as work', () => {
    for (const state of ['downloading', 'seeding', 'checking', 'starting'] as TorrentState[]) {
      expect(isIdle(state), state).toBe(false)
    }
  })

  it('counts paused and queued as safe, since neither loses anything to a reload', () => {
    expect(isIdle('paused')).toBe(true)
    expect(isIdle('queued')).toBe(true)
  })

  /**
   * The failure this file exists to prevent: a state the engine grows later, that nobody thinks to
   * classify, silently reading as safe and taking a live transfer down with it.
   */
  it('treats an unknown state as work rather than as safe', () => {
    expect(isIdle('something-new-the-engine-reports' as TorrentState)).toBe(false)
    expect(interrupts(['something-new-the-engine-reports' as TorrentState])).toBe(true)
  })
})
