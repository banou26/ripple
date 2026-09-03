import { describe, expect, it } from 'vitest'

import { installNodeShims } from '../../src/torrent/node-shims'

/**
 * The shim has to FILL IN a partial `process`, not skip when one already exists.
 *
 * Written from a real failure whose cost was out of all proportion to the bug. The shim used to be
 * `if (!root.process) root.process = { ...everything }`, which does nothing at all when somebody
 * else got there first. Under `vp dev` somebody always does: the dependency optimizer installs its
 * own `process` without `nextTick`, so libtorrent's glue died on `process.nextTick is not a
 * function` while the wasm module was still starting.
 *
 * What that cost is the part worth remembering. A half-started wasm module does not stop. It reports
 * the TypeError once, quietly, then every later call into it traps with
 * `RuntimeError: memory access out of bounds`, twice a second, from the status pump. Hundreds of
 * copies of a symptom, frames pointing at whichever engine call happened to be next, and the one
 * line that said what actually broke scrolled off the top of the console long before anyone looked.
 *
 * So the property here is not "the shim works on a bare global". It is "the shim works on a global
 * somebody else has already half-populated", which is the normal case rather than the edge.
 *
 * Every case runs against a plain object. Mutating the real global cannot work: this installs
 * `process`, which under the node runner is the runner's own, and deleting it to stage the
 * interesting case takes vitest down with it.
 */

const KEYS = ['env', 'version', 'browser', 'platform', 'nextTick', 'emit', 'on', 'once', 'off', 'removeListener', 'cwd'] as const

type Root = { global?: unknown, process?: Record<string, unknown> }

describe('the node shims the torrent worker installs', () => {
  it('supplies every member on a bare global', () => {
    const root: Root = {}
    installNodeShims(root)
    for (const key of KEYS) expect(root.process?.[key], key).toBeDefined()
  })

  it('points global at the root when it is missing', () => {
    const root: Root = {}
    installNodeShims(root)
    expect(root.global).toBe(root)
  })

  /** the regression: a `process` already there, missing the one member libtorrent needs */
  it('fills in nextTick when something else installed a process without it', () => {
    const root: Root = { process: { env: {}, platform: 'browser' } }
    installNodeShims(root)
    expect(typeof root.process?.nextTick).toBe('function')
  })

  it('keeps what the existing process already provided', () => {
    const theirs = () => 'theirs'
    const root: Root = { process: { env: { NODE_DEBUG: 'theirs' }, cwd: theirs } }
    installNodeShims(root)
    expect(root.process?.cwd).toBe(theirs)
    expect((root.process?.env as Record<string, string> | undefined)?.NODE_DEBUG).toBe('theirs')
    expect(typeof root.process?.nextTick).toBe('function')
  })

  /**
   * The sweep, because the bug was never about one member. Whichever single one a foreign shim
   * happens to define, every other one still has to arrive.
   */
  it('leaves no member missing, whichever single one was already present', () => {
    for (const present of KEYS) {
      const root: Root = { process: { [present]: present === 'env' ? { NODE_DEBUG: '' } : (() => {}) } }
      installNodeShims(root)
      for (const key of KEYS) {
        expect(root.process?.[key], `${key} missing when only ${present} was there`).toBeDefined()
      }
    }
  })

  /**
   * readable-stream calls `nextTick(fn, arg)` and expects the argument through. A shim that dropped
   * the trailing arguments would look correct and lose data, which this file's oldest comment
   * already warned about before any of the rest existed.
   */
  it('forwards nextTick trailing arguments', async () => {
    const root: Root = {}
    installNodeShims(root)
    const nextTick = root.process!.nextTick as (fn: (...a: unknown[]) => void, ...args: unknown[]) => void
    const seen = await new Promise<unknown[]>((resolve) => { nextTick((...args) => resolve(args), 'a', 2) })
    expect(seen).toEqual(['a', 2])
  })

  it('replaces an env that is present but not an object, which some shims leave undefined', () => {
    const root: Root = { process: { env: undefined } }
    installNodeShims(root)
    expect(typeof root.process?.env).toBe('object')
    expect(root.process?.env).not.toBeNull()
  })

  it('runs twice without clobbering what the first pass installed', () => {
    const root: Root = {}
    installNodeShims(root)
    const first = root.process?.nextTick
    installNodeShims(root)
    expect(root.process?.nextTick).toBe(first)
  })
})
