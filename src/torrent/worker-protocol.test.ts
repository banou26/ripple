// The worker answers only the message types in its OWN allowlist, because it shares a
// message channel with @fkn/lib's socket relay. Anything the page sends that is not on that
// list is dropped without a word: no error, no reply, no log. That is how the Recheck button
// shipped doing nothing at all.
//
// Reading both files as text is deliberate. Importing the worker would pull in libtorrent
// and OPFS, and the point is to compare the three lists that have to agree, not to run any
// of it.

import { describe, expect, it } from 'vitest'

import clientSource from './client.ts?raw'
import workerSource from './worker.ts?raw'

const own = (): string[] => {
  const match = workerSource.match(/const OWN = new Set\(\[([\s\S]*?)\]\)/)
  expect(match, 'the OWN allowlist moved or changed shape').toBeTruthy()
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

// Every `m.type === '...'` inside the worker, which is what handleMessage actually answers.
const handled = (): string[] =>
  [...new Set([...workerSource.matchAll(/m\.type === '([^']+)'/g)].map((m) => m[1]!))]

// Every `send({ type: '...' })` in the client, which is what the page actually sends.
const sent = (): string[] =>
  [...new Set([...clientSource.matchAll(/send\(\{ type: '([^']+)'/g)].map((m) => m[1]!))]

describe('the worker message allowlist', () => {
  it('admits every type the client sends', () => {
    const allowed = own()
    expect(sent().filter((type) => !allowed.includes(type))).toEqual([])
  })

  it('admits every type the worker has a handler for', () => {
    const allowed = own()
    expect(handled().filter((type) => !allowed.includes(type))).toEqual([])
  })

  // The other direction is not a silent failure, but an entry here with no handler is dead
  // weight that reads as supported.
  it('has no entry without a handler', () => {
    const answers = handled()
    // read-error is compared against m.type inside a catch, not a command of its own.
    expect(own().filter((type) => !answers.includes(type))).toEqual([])
  })

  it('found the lists at all, so a rename cannot make this vacuous', () => {
    expect(own().length).toBeGreaterThan(10)
    expect(sent().length).toBeGreaterThan(10)
    expect(handled().length).toBeGreaterThan(10)
  })
})
