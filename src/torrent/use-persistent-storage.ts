import type { PersistPermission, PersistState } from './storage-permission'

import { useCallback, useEffect, useState } from 'react'

import { permissions, storage } from '@banou/ponyfill'

/**
 * Asking the browser to make this origin persistent, and MEASURING what that did.
 *
 * The rules and the words are in storage-permission.ts, which also carries the numbers. The short
 * version of why this hook reports measurements rather than answers: `persist()` means two different
 * things depending on the engine. Chrome 151 refused it on every attempt with no prompt shown
 * (2026-08-30) and the quota never moved off a flat 10 GiB; Firefox raises a doorhanger, and granting
 * it moved the quota from 12 GB to 3.97 TB on an 8.03 TB device (2026-09-01, torrent.fkn.app).
 *
 * So `request()` reads the quota BEFORE, calls persist(), then reads `persisted()` and the quota
 * AFTER, and reports all three. What was asked for is the same call in both browsers; what happened
 * is the only thing that distinguishes them, and it is the difference this whole change is built on.
 *
 * NOTHING HERE THROWS OR REJECTS. Every branch has a fallback and every call is caught, including on
 * a browser with no `navigator.storage` at all, because the caller is a click handler in a warning
 * about storage: a rejection there would be an unhandled promise raised by the control that was meant
 * to help.
 *
 * MAKING THE FIGURES ON SCREEN MOVE. `useStorageUsage(refreshKey)` re-reads the moment its key
 * changes, so the caller folds this hook's `refreshKey` into that key:
 *
 *   const persistence = usePersistentStorage()
 *   const storage = useStorageUsage(`${torrents.length}:${persistence.refreshKey}`)
 *
 * That is the whole wiring. Without it the number is not wrong, only late: the poll picks the new
 * quota up on its next pass, at most 30 seconds later. The fold is what makes it change while the
 * person is still looking at the button they pressed.
 */

/**
 * The platform, as `@banou/ponyfill` makes it behave, and as a test can hand its own in.
 *
 * WHY THIS IS A PARAMETER RATHER THAN A GLOBAL. The ponyfill reads `globalThis.navigator` itself, so
 * a test that wanted to steer this would have to stub a global and then reason about which of the
 * two layers it was exercising. Injecting the ponyfill's own shape keeps that separable: the cases
 * below drive THIS module's rules, and the ponyfill's own suite covers what it absorbs.
 *
 * THREE ABSORBED CASES ARE GONE FROM HERE and none of them lost coverage. `permissions.query` no
 * longer has to be wrapped for an engine with no Permissions API, one that rejects this name, or one
 * that throws synchronously for it; all three answer 'prompt', which is what this module already did
 * with its own fourth state. `storage.persist()` no longer has to be reconciled against a following
 * `persisted()` read, because it already resolves the state it leaves behind rather than its own
 * claim. What is left here is what this app decides, which is when to ask and what to do with the
 * answer.
 */
type PersistenceApi = {
  storage: {
    persist: () => Promise<boolean>
    persisted: () => Promise<boolean>
    estimate: () => Promise<{ quota?: number }>
  }
  permissions: { query: (descriptor: PermissionDescriptor) => Promise<{ state: PermissionState }> }
}

const PLATFORM: PersistenceApi = { storage, permissions }

/**
 * THE ONE TYPE ASSERTION, and why the query name is spelled exactly here and nowhere else.
 *
 * `persistent-storage` is in the `PermissionName` union of the lib.dom shipped with this repo's
 * TypeScript (checked 2026-09-01), so the assertion is redundant against that one. It is kept
 * because older DOM typings do not list it and this file is not worth breaking over a lib version.
 * The RUNTIME half of what this used to guard against, an engine that accepts the type and still
 * rejects or throws for the name, is the ponyfill's now.
 */
const PERSISTENT_STORAGE = { name: 'persistent-storage' } as PermissionDescriptor

const readQuota = async (api: PersistenceApi): Promise<number | null> =>
  api.storage.estimate().then(({ quota }) => quota ?? null).catch(() => null)

export const readPersistPermission = async (
  api: PersistenceApi = PLATFORM,
): Promise<PersistPermission> => {
  try {
    return (await api.permissions.query(PERSISTENT_STORAGE)).state
  } catch {
    // the ponyfill does not reject, so this is a fake in a test or a build that drifted, and neither
    // is a reason for a click handler in a storage warning to raise an unhandled rejection
    return 'prompt'
  }
}

/**
 * The opening read, plus the ONE call worth making without anybody pressing anything.
 *
 * This used to live in `useStorageUsage`'s poll, which called persist() as soon as measured usage
 * passed zero. Two different cases were tangled together there:
 *
 *  - permission is 'prompt', where the call can raise a doorhanger. That one is now a
 *    button, because a person gets one prompt and it should be spent with the reason on screen.
 *  - permission is already 'granted', where the question has been answered and there is nothing left
 *    to ask: the call registers the protection against the existing grant. Nobody is interrupted, so
 *    there is no reason to make them press anything, and it stays automatic.
 *
 * It sits in the hook's mount effect rather than in the poll because it is a one-time settle. The
 * poll re-decided it every 30 seconds and needed a module-level `requested` flag to stop repeating.
 */
export const settlePersistence = async (
  api: PersistenceApi = PLATFORM,
): Promise<{ persisted: boolean, permission: PersistPermission, silentlyPersisted: boolean }> => {
  try {
    const permission = await readPersistPermission(api)
    const persisted = await api.storage.persisted()
    if (persisted || permission !== 'granted') return { persisted, permission, silentlyPersisted: false }
    // `persist()` resolves the state it LEAVES BEHIND rather than its own claim, so there is nothing
    // left to reconcile here: the answer is already what `persisted()` would say afterwards
    const after = await api.storage.persist()
    return { persisted: after, permission, silentlyPersisted: after }
  } catch {
    return { persisted: false, permission: 'prompt', silentlyPersisted: false }
  }
}

export type PersistMeasurement = {
  attempted: boolean
  granted: boolean | null
  quotaBefore: number | null
  quotaAfter: number | null
}

/**
 * Ask, and report what was measured rather than what was asked for.
 *
 * `granted` is `persisted()` read AFTER the call, not persist()'s own return value. The two are
 * different claims: one is what the call says it did and the other is the state the app then lives
 * in, and only the second decides whether the origin can still be cleared. persist()'s answer is the
 * fallback for a browser that offers no `persisted()` to check with.
 *
 * `attempted` is true even where there was nothing to call. A browser with no persist() has already
 * given its answer, and re-offering the button would put a control on screen that cannot do
 * anything.
 */
export const requestPersistence = async (
  api: PersistenceApi = PLATFORM,
): Promise<PersistMeasurement> => {
  try {
    const quotaBefore = await readQuota(api)
    const granted = await api.storage.persist()
    /*
     * READ AFTERWARDS, THROUGH THE SAME LENS THE SCREEN USES.
     *
     * Both readings go through the ponyfill, which is what `useStorageUsage` displays, so `moved`
     * below is a claim about the number somebody is actually looking at. Reading one of them raw
     * would compare two different quantities: the ponyfill reports a ceiling that holds while the
     * platform's own figure floats upward on Chromium, and a difference between those two is not a
     * grant, it is the two definitions disagreeing.
     */
    const quotaAfter = await readQuota(api)
    return { attempted: true, granted, quotaBefore, quotaAfter }
  } catch {
    return { attempted: true, granted: false, quotaBefore: null, quotaAfter: null }
  }
}

export type PersistentStorage = PersistState & {
  /** what `estimate().quota` read either side of the last ask, so the two can be compared on screen */
  quotaBefore: number | null
  quotaAfter: number | null
  /** changes whenever a measurement showed the storage figures are stale. See the note at the top. */
  refreshKey: number
  /** never rejects, so a click handler can call it without a catch */
  request: () => Promise<void>
}

const INITIAL: Omit<PersistentStorage, 'request'> = {
  persisted: false,
  // 'prompt' rather than a fourth state for "not asked yet": the offer rules read it the same way,
  // and the ponyfill has no fourth state to report
  permission: 'prompt',
  attempted: false,
  granted: null,
  quotaBefore: null,
  quotaAfter: null,
  refreshKey: 0,
}

export const usePersistentStorage = (): PersistentStorage => {
  const [state, setState] = useState(INITIAL)

  useEffect(() => {
    let cancelled = false
    void settlePersistence().then(({ persisted, permission, silentlyPersisted }) => {
      if (cancelled) return
      setState((prev) => ({
        ...prev,
        persisted,
        permission,
        // a grant can move the quota, so anything already on screen is stale from here
        refreshKey: silentlyPersisted ? prev.refreshKey + 1 : prev.refreshKey,
      }))
    })
    return () => { cancelled = true }
  }, [])

  const request = useCallback(async () => {
    const measurement = await requestPersistence()
    setState((prev) => {
      // MEASURED, not assumed: a quota that moved is reason enough to re-read even where the grant
      // itself could not be confirmed, and a refusal that moved nothing is reason to leave the poll
      // alone rather than walk the whole file system again for a number that cannot have changed
      const moved = measurement.quotaAfter !== null && measurement.quotaAfter !== measurement.quotaBefore
      const landed = measurement.granted === true
      return {
        ...prev,
        ...measurement,
        persisted: prev.persisted || landed,
        refreshKey: landed || moved ? prev.refreshKey + 1 : prev.refreshKey,
      }
    })
  }, [])

  return { ...state, request }
}
