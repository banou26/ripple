// The worker drops anything not in its OWN allowlist without a word: no error, no reply, no
// log. That is how the Recheck button shipped doing nothing at all.

import { describe, expect, it } from 'vitest'

import clientSource from './client.ts?raw'
import protocolSource from './engine-protocol.ts?raw'
import workerSource from './worker.ts?raw'

const own = (): string[] => {
  const match = workerSource.match(/const OWN = new Set\(\[([\s\S]*?)\]\)/)
  expect(match, 'the OWN allowlist moved or changed shape').toBeTruthy()
  return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
}

const handled = (): string[] =>
  [...new Set([...workerSource.matchAll(/m\.type === '([^']+)'/g)].map((m) => m[1]!))]

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

  it('has no entry without a handler', () => {
    const answers = handled()
    expect(own().filter((type) => !answers.includes(type))).toEqual([])
  })

  it('found the lists at all, so a rename cannot make this vacuous', () => {
    expect(own().length).toBeGreaterThan(10)
    expect(sent().length).toBeGreaterThan(10)
    expect(handled().length).toBeGreaterThan(10)
  })
})

// Same silent failure one layer up: a type missing here works only in the tab that owns the engine.
describe('the follower broadcast allowlist', () => {
  const broadcast = (): string[] => {
    const match = protocolSource.match(/BROADCAST_TYPES = new Set\(\[([\s\S]*?)\]\)/)
    expect(match, 'BROADCAST_TYPES moved or changed shape').toBeTruthy()
    return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  }

  const clientHandles = (): string[] =>
    [...new Set([...clientSource.matchAll(/m\.type === '([^']+)'/g)].map((m) => m[1]!))]

  // a read reply belongs to the one tab that asked, so it never goes to everyone
  const PRIVATE = ['read-result', 'read-error']

  it('carries every message type the client reacts to', () => {
    const allowed = broadcast()
    const missing = clientHandles().filter((type) => !allowed.includes(type) && !PRIVATE.includes(type))
    expect(missing, 'these would silently never arrive in a borrowing tab').toEqual([])
  })

  it('found the list, so a rename cannot make this vacuous', () => {
    expect(broadcast().length).toBeGreaterThan(5)
    expect(clientHandles().length).toBeGreaterThan(5)
  })
})
