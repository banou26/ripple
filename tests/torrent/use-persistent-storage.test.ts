import { describe, expect, it, vi } from 'vitest'

import { readPersistPermission, requestPersistence, settlePersistence } from '../../src/torrent/use-persistent-storage'

/**
 * The persistent-storage ask, driven from node.
 *
 * WHAT MOVED OUT, AND WHERE IT WENT. This used to mock at the `navigator` boundary and carry four
 * cases about engines that will not answer: no Permissions API at all, one that rejects this name,
 * one that throws synchronously for it, and a `persist()` with no `persisted()` to check against.
 * None of those is this app's problem any more. `@banou/ponyfill` absorbs all four and its own suite
 * pins each one, so what is mocked here is the ponyfill's contract and what is tested is the part
 * ripple decides: WHEN to ask, and what to do with the answer.
 *
 * WHAT IS AND IS NOT COVERED. A grant cannot be tested: it needs a real Firefox and a real person
 * pressing a doorhanger, and that measurement is the one written down in storage-permission.ts
 * (12 GB to 3.97 TB on an 8.03 TB device, 2026-09-01). What IS testable is every path that does not
 * need a prompt, which is most of them and all the ones that fail silently.
 *
 * The React shell around these is deliberately thin (three `useState` writes) and is NOT covered
 * here: the unit project runs in node with no DOM. Everything that decides anything is a function
 * these tests call directly.
 */

/** successive answers from one stubbed call, the last one repeating: [before, after] reads as itself */
const queue = <T>(values: T[]) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

/**
 * The ponyfill's contract, as a fake.
 *
 * `persist` resolves the state it LEAVES BEHIND rather than its own claim, because that is what the
 * ponyfill promises and what this module is written against. A fake that resolved the call's own
 * answer would be testing the code against an API that does not exist.
 */
const stubApi = (
  { permission = 'prompt', persisted = [false], persist = false, quotas = [1_000] }: {
    permission?: PermissionState | 'throws'
    persisted?: boolean[]
    persist?: boolean | 'rejects'
    quotas?: number[]
  } = {},
) => {
  const nextPersisted = queue(persisted)
  const nextQuota = queue(quotas)
  const calls = { persist: 0, query: 0 }
  return {
    calls,
    api: {
      storage: {
        persist: () => {
          calls.persist += 1
          return persist === 'rejects' ? Promise.reject(new Error('refused')) : Promise.resolve(persist)
        },
        persisted: () => Promise.resolve(nextPersisted()),
        estimate: () => Promise.resolve({ quota: nextQuota() }),
      },
      permissions: {
        query: () => {
          calls.query += 1
          if (permission === 'throws') throw new Error('a fake that misbehaves')
          return Promise.resolve({ state: permission })
        },
      },
    },
  }
}

describe('reading whether the persistent-storage prompt can be raised', () => {
  it('reports the permission the browser gives', async () => {
    for (const state of ['granted', 'prompt', 'denied'] as const) {
      expect(await readPersistPermission(stubApi({ permission: state }).api)).toBe(state)
    }
  })

  /**
   * There is no fourth state any more, and nothing rendered ever distinguished one.
   *
   * The three shapes that used to produce 'unknown' answer 'prompt' inside the ponyfill and are
   * pinned there. What is left here is the guard for a query that throws anyway, which after the
   * ponyfill can only be a fake or a build that drifted. It stays because the caller is a click
   * handler in a warning about storage, and an unhandled rejection raised by the control that was
   * meant to help is the worst possible failure for it.
   */
  it('answers prompt rather than throwing, whatever a broken query does', async () => {
    expect(await readPersistPermission(stubApi({ permission: 'throws' }).api)).toBe('prompt')
  })
})

describe('the one call still made without anybody pressing anything', () => {
  /**
   * THE CASE THAT WAS KEPT. A permission that already answers 'granted' has nothing left to ask, so
   * this registers the protection and interrupts nobody. It is the only automatic persist() left:
   * the poll used to make this call in every state, which on Firefox is a doorhanger raised by the
   * first byte written.
   */
  it('registers the protection where the permission is already granted', async () => {
    const { calls, api } = stubApi({ permission: 'granted', persisted: [false], persist: true })
    expect(await settlePersistence(api)).toEqual({ persisted: true, permission: 'granted', silentlyPersisted: true })
    expect(calls.persist).toBe(1)
  })

  /** and it reports the state the call left behind, which the ponyfill is what resolves */
  it('reports a granted-permission call that did not take as not persisted', async () => {
    const { api } = stubApi({ permission: 'granted', persisted: [false], persist: false })
    expect(await settlePersistence(api)).toEqual({ persisted: false, permission: 'granted', silentlyPersisted: false })
  })

  /**
   * THE REGRESSION SHAPE. Any state other than 'granted' is a state where persist() can raise a
   * prompt, and a prompt raised here is one raised with nothing on screen to explain it.
   */
  it('asks for nothing where a prompt could still appear', async () => {
    for (const permission of ['prompt', 'denied'] as const) {
      const { calls, api } = stubApi({ permission })
      const settled = await settlePersistence(api)
      expect(calls.persist, `${permission} raised a prompt`).toBe(0)
      expect(settled.silentlyPersisted).toBe(false)
    }
  })

  it('does nothing further where the origin is already persistent', async () => {
    const { calls, api } = stubApi({ permission: 'granted', persisted: [true] })
    expect(await settlePersistence(api)).toEqual({ persisted: true, permission: 'granted', silentlyPersisted: false })
    expect(calls.persist).toBe(0)
  })

  /** nothing here may reject: the caller is a mount effect and a click handler, neither of which catches */
  it('survives an api whose every call rejects', async () => {
    const rejecting = {
      storage: {
        persist: () => Promise.reject(new Error('no')),
        persisted: () => Promise.reject(new Error('no')),
        estimate: () => Promise.reject(new Error('no')),
      },
      permissions: { query: () => Promise.reject(new Error('no')) },
    }
    expect(await settlePersistence(rejecting)).toEqual({ persisted: false, permission: 'prompt', silentlyPersisted: false })
  })
})

describe('asking, and measuring what the ask did', () => {
  /**
   * THE CHROMIUM PATH. persist() resolves false, no prompt is shown to anybody, and the quota does
   * not move. What makes this worth recording rather than discarding is that the offer rules read
   * `attempted` and `granted` to stop putting the button back on screen.
   */
  it('records a refusal the browser made on its own', async () => {
    const { calls, api } = stubApi({ persist: false, quotas: [10_737_418_240] })
    expect(await requestPersistence(api)).toEqual({
      attempted: true,
      granted: false,
      quotaBefore: 10_737_418_240,
      quotaAfter: 10_737_418_240,
    })
    expect(calls.persist).toBe(1)
  })

  /**
   * The Firefox shape, in the numbers that were actually measured on 2026-09-01: 12 GB before the
   * doorhanger, 3.97 TB after it. Nothing here can produce that prompt, so what is pinned is that
   * both readings are taken and reported rather than only the answer to the call.
   */
  it('reports the quota either side of a grant, not just the grant', async () => {
    const { api } = stubApi({ persist: true, quotas: [12_000_000_000, 3_970_000_000_000] })
    expect(await requestPersistence(api)).toEqual({
      attempted: true,
      granted: true,
      quotaBefore: 12_000_000_000,
      quotaAfter: 3_970_000_000_000,
    })
  })

  /** a rejection is an answer of no, and must not reach the click handler that called this */
  it('treats a persist() that rejects as a refusal rather than throwing', async () => {
    const { api } = stubApi({ persist: 'rejects' })
    expect((await requestPersistence(api)).granted).toBe(false)
  })

  /**
   * `attempted` stays true even where the engine answered without asking anybody, which is what
   * keeps the button from coming back on a browser that has already given its whole answer.
   */
  it('counts an ask the engine refused on its own as an ask that happened', async () => {
    const { api } = stubApi({ persist: false, quotas: [2_147_483_648] })
    expect(await requestPersistence(api)).toEqual({
      attempted: true, granted: false, quotaBefore: 2_147_483_648, quotaAfter: 2_147_483_648,
    })
  })

  it('survives an api whose every call rejects', async () => {
    const rejecting = {
      storage: {
        persist: () => Promise.reject(new Error('no')),
        persisted: () => Promise.reject(new Error('no')),
        estimate: () => Promise.reject(new Error('no')),
      },
      permissions: { query: () => Promise.reject(new Error('no')) },
    }
    expect(await requestPersistence(rejecting)).toEqual({
      attempted: true, granted: false, quotaBefore: null, quotaAfter: null,
    })
  })

  /** and whatever this environment happens to have: node has a navigator, and it has no storage */
  it('never rejects against the real ponyfill and the real navigator of wherever it runs', async () => {
    const measurement = await requestPersistence()
    expect(measurement.attempted).toBe(true)
    expect(typeof measurement.granted).toBe('boolean')
  })
})

/**
 * THE POINT OF THE WHOLE CHANGE, through the REAL ponyfill rather than a fake of it.
 *
 * Everything above mocks the ponyfill's contract, which is right for testing ripple's rules and
 * blind to whether the two halves actually fit together. This drives the published module against a
 * stubbed `navigator`, so it fails if the ponyfill's behaviour ever stops being the behaviour this
 * module is written against.
 *
 * A FRESH MODULE, because the ponyfill's quota ceiling is module state that remembers the narrowest
 * quota it has seen. Without the reset a grant looks like it changed nothing, which is the exact
 * failure this asserts against.
 */
describe('against the real ponyfill', () => {
  const withNavigator = async (navigator: unknown) => {
    vi.resetModules()
    vi.stubGlobal('navigator', navigator)
    return import('../../src/torrent/use-persistent-storage')
  }

  it('reports a grant as a quota that moved, so the figures on screen are re-read', async () => {
    let persisted = false
    const module = await withNavigator({
      storage: {
        persist: async () => { persisted = true; return true },
        persisted: async () => persisted,
        estimate: async () => ({ usage: 0, quota: persisted ? 3_970_000_000_000 : 12_000_000_000 }),
      },
      permissions: { query: async () => ({ state: 'prompt' }) },
    })

    const measurement = await module.requestPersistence()
    expect(measurement.granted, 'the origin is persistent afterwards, so the ask landed').toBe(true)
    expect(measurement.quotaBefore).toBe(12_000_000_000)
    expect(
      measurement.quotaAfter,
      'the ceiling the ponyfill latched before the grant must not survive it, or the screen keeps the old limit',
    ).toBe(3_970_000_000_000)
    vi.unstubAllGlobals()
  })

  it('reports a refusal as a quota that did not move', async () => {
    const module = await withNavigator({
      storage: {
        persist: async () => false,
        persisted: async () => false,
        estimate: async () => ({ usage: 0, quota: 10_737_418_240 }),
      },
      permissions: { query: async () => ({ state: 'prompt' }) },
    })
    const measurement = await module.requestPersistence()
    expect(measurement.granted).toBe(false)
    expect(measurement.quotaAfter).toBe(measurement.quotaBefore)
    vi.unstubAllGlobals()
  })
})
