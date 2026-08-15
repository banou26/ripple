import { expect, test } from 'vitest'

import { classifyAvailability } from './use-cloud-backup'

/**
 * What a storage-availability answer means, and specifically when it means "try again".
 *
 * The bug these were written for: `false` was read as "this user has no cloud", which is terminal
 * by design and correctly renders nothing. It is also what a signed-in account looks like when the
 * connect token could not be pulled through the broker in time, and in that reading it is not
 * terminal at all. Nothing distinguished them, so a transient failure at page load left the library
 * silently un-backed-up for the whole session, with no retry armed and no indication on screen.
 *
 * Observed live on 2026-08-16: signed in, Premium, `account.info()` answering normally, and no
 * Library stat rendered at all.
 */

test('storage that answers yes connects and syncs', () => {
  expect(classifyAvailability(true, true)).toEqual({
    connected: true, status: 'syncing', reason: null, retry: false,
  })
})

test('a signed-out user parks quietly rather than retrying', () => {
  // the resting state for most visitors, and nothing is wrong with it: account.onChange is what
  // picks them up if they do connect, so a retry loop here would only burn cycles
  expect(classifyAvailability(false, false)).toEqual({
    connected: false, status: 'off', reason: 'signed-out', retry: false,
  })
})

test('a signed-in user with no storage grant retries instead of parking', () => {
  // THE REGRESSION. Identical input to the case above except for the account, and it used to reach
  // the identical terminal 'off'.
  expect(classifyAvailability(false, true)).toEqual({
    connected: false, status: 'error', reason: 'no-storage-grant', retry: true,
  })
})

test('a broker that never answers retries, signed in or not', () => {
  for (const signedIn of [true, false]) {
    expect(classifyAvailability(null, signedIn)).toEqual({
      connected: false, status: 'error', reason: 'broker-timeout', retry: true,
    })
  }
})

/**
 * The two answers that mean "no" must never both be terminal, whatever else changes about them.
 * Stated as its own assertion because it is the invariant, and the cases above are its instances.
 */
test('nothing that could be transient is left without a retry', () => {
  const outcomes = [
    classifyAvailability(null, true),
    classifyAvailability(null, false),
    classifyAvailability(false, true),
  ]
  expect(outcomes.every((o) => o.retry)).toBe(true)
  // and the one genuinely terminal answer stays terminal, so the retry is not simply always on
  expect(classifyAvailability(false, false).retry).toBe(false)
})

test('every unconnected verdict names a reason a UI can show', () => {
  const inputs: [boolean | null, boolean][] = [[null, true], [null, false], [false, true], [false, false]]
  for (const [available, signedIn] of inputs) {
    const verdict = classifyAvailability(available, signedIn)
    expect(verdict.connected).toBe(false)
    expect(verdict.reason).toBeTruthy()
  }
})
