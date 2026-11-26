import { expect, it, vi } from 'vitest'

import { RATE_LIMITS_KEY } from '../../src/torrent/rate-limits'
import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * The worker must not report a new session rate limit through periodic `state` ticks before the
 * IndexedDB write has committed, and once that write commits it must push `state` immediately so
 * UI labels update without waiting up to 500 ms for the next timer tick.
 */

const store = vi.hoisted(() => new Map<string, unknown>())
const engine = vi.hoisted(() => ({
  rateCalls: [] as { download: number, upload: number }[],
}))
const gate = vi.hoisted(() => ({
  blockKey: null as string | null,
  rejectKey: null as string | null,
  entered: [] as unknown[],
  resolve: null as (() => void) | null,
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      setRateLimits: (limits: { download: number, upload: number }) => {
        engine.rateCalls.push(limits)
      },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => {
    if (gate.rejectKey === key) throw new Error('idb quota exceeded')
    if (gate.blockKey === key) {
      gate.entered.push(value)
      await new Promise<void>((resolve) => { gate.resolve = resolve })
    }
    store.set(key, value)
  },
  del: async (key: string) => { store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
}))

const settle = async (check: () => void, stepMs = 50, steps = 40) => {
  let lastErr: unknown
  for (let i = 0; i < steps; i++) {
    try { check(); return } catch (err) { lastErr = err }
    await vi.advanceTimersByTimeAsync(stepMs)
  }
  throw lastErr
}

it('keeps broadcasting the old limit while IDB persists, pushes right after, and survives IDB write failure', async () => {
  vi.useFakeTimers()
  try {
    await import('../../src/torrent/worker')
    await settle(() => expect(rig.of('ready')).toHaveLength(1), 10)

    gate.blockKey = RATE_LIMITS_KEY
    const stateStart = rig.of('state').length

    rig.send({ type: 'set-session-limits', down: 1_500_000 })
    await settle(() => expect(gate.entered).toHaveLength(1), 0, 20)
    expect(engine.rateCalls.at(-1)).toEqual({ download: 0, upload: 0 })

    // Advance virtual clock through two+ periodic 500 ms ticks while IDB is still writing.
    await vi.advanceTimersByTimeAsync(1_100)
    const stalledStates = rig.of('state').slice(stateStart)
    expect(stalledStates.length).toBeGreaterThanOrEqual(2)
    for (const state of stalledStates) expect(state.rateLimits).toEqual({ down: 0, up: 0 })
    expect(store.get(RATE_LIMITS_KEY)).toBeUndefined()

    // Flush the pending IDB write and verify an immediate state broadcast without waiting 500 ms.
    const countBeforeResolve = rig.of('state').length
    gate.resolve!()
    gate.blockKey = null
    await settle(() => {
      const fresh = rig.of('state').slice(countBeforeResolve)
      expect(fresh.some((s) => {
        const limits = s.rateLimits as { down: number, up: number } | undefined
        return limits?.down === 1_500_000 && limits?.up === 0
      })).toBe(true)
    }, 0, 20)

    expect(engine.rateCalls.at(-1)).toEqual({ download: 1_500_000, upload: 0 })
    expect(store.get(RATE_LIMITS_KEY)).toEqual({ down: 1_500_000, up: 0 })
    expect(rig.of('state').at(-1)?.rateLimits).toEqual({ down: 1_500_000, up: 0 })

    // If IDB set() rejects, session.setRateLimits and state broadcast still proceed without worker error.
    gate.rejectKey = RATE_LIMITS_KEY
    rig.send({ type: 'set-session-limits', down: 2_500_000, up: 500_000 })
    await settle(() => {
      expect(engine.rateCalls.at(-1)).toEqual({ download: 2_500_000, upload: 500_000 })
      expect(rig.of('state').at(-1)?.rateLimits).toEqual({ down: 2_500_000, up: 500_000 })
    }, 0, 20)
    gate.rejectKey = null
    expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})
