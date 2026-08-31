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

/*
 * A handle is a counter inside ONE libtorrent session, so the same number means different torrents in
 * two of them. SESSION_SCOPED names the commands that carry one, and both places that hold a command
 * across an engine swap consult it. The list is a hand-written copy of a fact that lives in the
 * worker, which is the shape that rots: add a command taking a handle, forget this, and a handover
 * silently re-aims it. So it is DERIVED here rather than restated.
 */
describe('the commands that only mean something inside one session', () => {
  const declared = (): string[] => {
    const match = protocolSource.match(/SESSION_SCOPED = new Set\(\[([\s\S]*?)\]\)/)
    expect(match, 'SESSION_SCOPED moved or changed shape').toBeTruthy()
    return [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!)
  }

  /*
   * Every branch of the worker's dispatch that reads `m.handle`, taken from the source.
   *
   * `\b` is load bearing: `m.handles` is a list of FileSystemHandles on create-source and
   * start-source, which are keyed by info hash and must keep crossing a handover. Without the
   * boundary both are swept in and `/embed` loses the source it was opened for.
   */
  const carriesHandle = (): string[] => {
    const parts = workerSource.split(/m\.type === '([a-z-]+)'/)
    const out: string[] = []
    for (let i = 1; i < parts.length; i += 2) {
      if (/m\.handle\b/.test(parts[i + 1]!.slice(0, 1_200))) out.push(parts[i]!)
    }
    return [...new Set(out)]
  }

  it('names every command whose branch reads a handle', () => {
    const missing = carriesHandle().filter((type) => !declared().includes(type))
    expect(missing, 'a handover would re-aim these at whatever the new session gave that number').toEqual([])
  })

  it('names nothing else, so a safe command is not dropped for no reason', () => {
    const carrying = carriesHandle()
    expect(declared().filter((type) => !carrying.includes(type))).toEqual([])
  })

  it('found both lists, so neither check can pass by matching nothing', () => {
    expect(declared().length).toBeGreaterThan(10)
    expect(carriesHandle().length).toBeGreaterThan(10)
  })

  it('leaves the commands that name a torrent by info hash alone', () => {
    // these are exactly the ones gate.ts is about: dropping them is the bug it was written to fix
    for (const safe of ['add-magnet', 'add-torrent-file', 'import-list', 'start', 'set-location']) {
      expect(declared(), `${safe} must survive an engine swap`).not.toContain(safe)
    }
  })
})
