import { describe, expect, it, test } from 'vitest'

import { classifyAvailability, isAbsent } from './use-cloud-backup'

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

/**
 * Whether the store is saying "there is no backup" or "I could not tell you".
 *
 * The distinction decides whether the local library is written up as a fresh backup or held back
 * untouched, so being wrong in one direction loses a user's library and in the other never starts
 * syncing at all. It is a message test because that is all that survives the broker boundary:
 * custom error properties are stripped, and only `message` and `code` come through.
 */
describe('recognising an absent backup', () => {
  it('accepts the api refusing to presign a path with no row', () => {
    expect(isAbsent('Not found')).toBe(true)
  })

  /**
   * THE REGRESSION. The presign succeeds, the object fetch 404s, and the message says nothing
   * about "not found". Observed live on 2026-08-16: the sync retried on its backoff indefinitely
   * and the library was never backed up.
   */
  it('accepts a committed row whose object is not in the bucket', () => {
    expect(isAbsent('storage: read failed (404)')).toBe(true)
  })

  /** Everything else is inconclusive, and must never seed over a backup that may still be good. */
  it.each([
    ['a server fault', 'storage: read failed (500)'],
    ['a gateway fault', 'storage: read failed (502)'],
    ['a refusal', 'storage: read failed (403)'],
    ['a broker timeout', 'broker timed out'],
    ['a network failure', 'Failed to fetch'],
    ['nothing at all', ''],
  ])('holds the backup back on %s', (_name, message) => {
    expect(isAbsent(message)).toBe(false)
  })

  /** 404 has to be the STATUS, not a coincidence in a path or a byte count. */
  it('does not fire on a 404 that is part of some other number', () => {
    expect(isAbsent('storage: read failed (4040)')).toBe(false)
    expect(isAbsent('read 404040 bytes')).toBe(false)
  })
})
