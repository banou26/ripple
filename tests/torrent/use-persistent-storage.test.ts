import { describe, expect, it } from 'vitest'

import { readPersistPermission, requestPersistence, settlePersistence } from '../../src/torrent/use-persistent-storage'

/**
 * The three navigator calls behind the persistent-storage ask, driven from node.
 *
 * WHAT IS AND IS NOT COVERED HERE. A grant cannot be tested: it needs a real Firefox and a real
 * person pressing a doorhanger, and that measurement is the one written down in
 * storage-permission.ts (12 GB to 3.97 TB on an 8.03 TB device, 2026-09-01). What IS testable is
 * every path that does not need a prompt, which is most of them and all the ones that fail silently:
 * a browser with no `navigator.storage`, a Permissions API that will not answer for this name, a
 * permission already denied, and an ask the browser refuses without showing anything. That last one
 * is the Chromium path in practice, measured refused on every attempt on Chrome 151 (2026-08-30).
 *
 * The React shell around these is deliberately thin (three `useState` writes) and is NOT covered
 * here: the unit project runs in node with no DOM. Everything that decides anything is a function
 * these tests call directly.
 *
 * Mocked at the navigator boundary, so what runs is the real code all the way down to the API.
 */

/** successive answers from one stubbed call, the last one repeating: [before, after] reads as itself */
const queue = <T>(values: T[]) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]!
}

const stubNavigator = (
  { permission = 'prompt', persisted = [false], persist = false, quotas = [1_000] }: {
    permission?: PermissionState | 'throws' | 'rejects'
    persisted?: boolean[]
    persist?: boolean | 'absent' | 'rejects'
    quotas?: number[]
  } = {},
) => {
  const nextPersisted = queue(persisted)
  const nextQuota = queue(quotas)
  const calls = { persist: 0, query: 0 }
  return {
    calls,
    nav: {
      storage: {
        persisted: () => Promise.resolve(nextPersisted()),
        estimate: () => Promise.resolve({ quota: nextQuota() }),
        ...(persist === 'absent'
          ? {}
          : {
              persist: () => {
                calls.persist += 1
                return persist === 'rejects' ? Promise.reject(new Error('refused')) : Promise.resolve(persist)
              },
            }),
      },
      permissions: {
        query: () => {
          calls.query += 1
          // a sync throw, not a rejection: an engine that does not know the name can do either, and
          // only one of the two is caught by a `.catch`
          if (permission === 'throws') throw new Error('unsupported permission name')
          if (permission === 'rejects') return Promise.reject(new Error('unsupported permission name'))
          return Promise.resolve({ state: permission })
        },
      },
    },
  }
}

describe('reading whether the persistent-storage prompt can be raised', () => {
  it('reports the permission the browser gives', async () => {
    for (const state of ['granted', 'prompt', 'denied'] as const) {
      expect(await readPersistPermission(stubNavigator({ permission: state }).nav)).toBe(state)
    }
  })

  /**
   * An engine that does not know this permission name is not an engine that said no. Both shapes of
   * refusal to answer land on 'unknown', which the offer rules treat like 'prompt': the button stays.
   */
  it('answers unknown when the query throws, and when it rejects', async () => {
    expect(await readPersistPermission(stubNavigator({ permission: 'throws' }).nav)).toBe('unknown')
    expect(await readPersistPermission(stubNavigator({ permission: 'rejects' }).nav)).toBe('unknown')
  })

  it('answers unknown where there is no Permissions API at all', async () => {
    expect(await readPersistPermission({})).toBe('unknown')
    expect(await readPersistPermission(undefined)).toBe('unknown')
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
    const { calls, nav } = stubNavigator({ permission: 'granted', persisted: [false, true], persist: true })
    expect(await settlePersistence(nav)).toEqual({ persisted: true, permission: 'granted', silentlyPersisted: true })
    expect(calls.persist).toBe(1)
  })

  /** and it reports what persisted() then said, not what persist() claimed */
  it('reports a granted-permission call that did not take as not persisted', async () => {
    const { nav } = stubNavigator({ permission: 'granted', persisted: [false, false], persist: true })
    expect(await settlePersistence(nav)).toEqual({ persisted: false, permission: 'granted', silentlyPersisted: false })
  })

  /**
   * THE REGRESSION SHAPE. Any state other than 'granted' is a state where persist() can raise a
   * prompt, and a prompt raised here is one raised with nothing on screen to explain it.
   */
  it('asks for nothing where a prompt could still appear', async () => {
    for (const permission of ['prompt', 'denied', 'throws'] as const) {
      const { calls, nav } = stubNavigator({ permission })
      const settled = await settlePersistence(nav)
      expect(calls.persist, `${permission} raised a prompt`).toBe(0)
      expect(settled.silentlyPersisted).toBe(false)
    }
  })

  it('does nothing further where the origin is already persistent', async () => {
    const { calls, nav } = stubNavigator({ permission: 'granted', persisted: [true] })
    expect(await settlePersistence(nav)).toEqual({ persisted: true, permission: 'granted', silentlyPersisted: false })
    expect(calls.persist).toBe(0)
  })

  it('survives a browser with no navigator.storage at all', async () => {
    expect(await settlePersistence({})).toEqual({ persisted: false, permission: 'unknown', silentlyPersisted: false })
    expect(await settlePersistence(undefined)).toEqual({ persisted: false, permission: 'unknown', silentlyPersisted: false })
  })

  /** storage missing while permissions answers granted: the grant must not turn into a thrown TypeError */
  it('survives a granted permission with nothing to call it on', async () => {
    const nav = { permissions: { query: () => Promise.resolve({ state: 'granted' as PermissionState }) } }
    expect(await settlePersistence(nav)).toEqual({ persisted: false, permission: 'granted', silentlyPersisted: false })
  })
})

describe('asking, and measuring what the ask did', () => {
  /**
   * THE CHROMIUM PATH. persist() resolves false, no prompt is shown to anybody, and the quota does
   * not move. What makes this worth recording rather than discarding is that the offer rules read
   * `attempted` and `granted` to stop putting the button back on screen.
   */
  it('records a refusal the browser made on its own', async () => {
    const { calls, nav } = stubNavigator({ persist: false, persisted: [false], quotas: [10_737_418_240] })
    expect(await requestPersistence(nav)).toEqual({
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
    const { nav } = stubNavigator({ persist: true, persisted: [true], quotas: [12_000_000_000, 3_970_000_000_000] })
    expect(await requestPersistence(nav)).toEqual({
      attempted: true,
      granted: true,
      quotaBefore: 12_000_000_000,
      quotaAfter: 3_970_000_000_000,
    })
  })

  /**
   * MEASURED, NOT ASKED. persist() saying yes and persisted() saying no are two different claims,
   * and only the second is the state the app then lives in.
   */
  it('believes persisted() over what persist() returned', async () => {
    const { nav } = stubNavigator({ persist: true, persisted: [false] })
    expect((await requestPersistence(nav)).granted).toBe(false)
  })

  it('falls back to the call answer where the browser offers no persisted() to check with', async () => {
    const nav = { storage: { persist: () => Promise.resolve(true) } }
    expect(await requestPersistence(nav)).toEqual({
      attempted: true, granted: true, quotaBefore: null, quotaAfter: null,
    })
  })

  /** a rejection is an answer of no, and must not reach the click handler that called this */
  it('treats a persist() that rejects as a refusal rather than throwing', async () => {
    const { nav } = stubNavigator({ persist: 'rejects', persisted: [false] })
    expect((await requestPersistence(nav)).granted).toBe(false)
  })

  /**
   * `attempted` stays true even where there was nothing to call, which is what keeps the button from
   * coming back on a browser that has already given its whole answer by not implementing this.
   */
  it('counts an ask with nothing to call as an ask that happened', async () => {
    const { nav } = stubNavigator({ persist: 'absent', quotas: [2_147_483_648] })
    expect(await requestPersistence(nav)).toEqual({
      attempted: true, granted: false, quotaBefore: 2_147_483_648, quotaAfter: 2_147_483_648,
    })
  })

  it('survives a browser with no navigator.storage at all', async () => {
    expect(await requestPersistence({})).toEqual({
      attempted: true, granted: false, quotaBefore: null, quotaAfter: null,
    })
  })

  /** and whatever this environment happens to have: node has a navigator, and it has no storage */
  it('never rejects against the real navigator of wherever it is running', async () => {
    const measurement = await requestPersistence()
    expect(measurement.attempted).toBe(true)
    expect(typeof measurement.granted === 'boolean' || measurement.granted === null).toBe(true)
  })
})
