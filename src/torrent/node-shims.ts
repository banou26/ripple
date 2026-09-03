/**
 * The node globals libtorrent's glue and `@fkn/lib/{net,dgram}`'s readable-stream expect.
 *
 * Imported first by the worker so these exist before anything dereferences them.
 *
 * FILLED IN MEMBER BY MEMBER, never all or nothing. This used to be
 * `if (!root.process) root.process = { ... }`, which silently did nothing whenever somebody else
 * had already put a `process` on the global, and then whatever they left out stayed out. In a
 * `vp dev` worker that is exactly what happens: the dependency optimizer's own shim defines
 * `process` without `nextTick`, the guard skipped the whole block, and libtorrent's glue died on
 * `process.nextTick is not a function` while it was still starting up.
 *
 * What made that expensive to find is what a HALF-STARTED wasm module does next. The TypeError is
 * reported once, quietly, as a worker error; the module carries on with an unfinished runtime, and
 * every later call into it traps with `RuntimeError: memory access out of bounds`, twice a second,
 * from the status pump. So the console fills with hundreds of copies of a symptom whose cause
 * scrolled off the top, and the frames point at whichever engine call happened to be next rather
 * than at anything to do with the real fault.
 *
 * The rule this file now follows: a shim asks "is this member missing", never "is the namespace
 * missing". A partial polyfill is the normal case, not the exception.
 */

type Shimmable = { global?: unknown, process?: Record<string, unknown> }

/**
 * Exported and taking its target so it can be tested against a plain object.
 *
 * The obvious test, mutating the real global and putting it back, cannot work here: this installs
 * `process`, and under the node test runner that IS the runner's own `process`. Deleting it to set
 * up the interesting case took vitest's rpc down with it.
 */
export const installNodeShims = (root: Shimmable): void => {
  if (!root.global) root.global = root

  const proc = (root.process ??= {})

  // `??=` per member, so an existing process keeps everything it already provides and gains the rest
  proc.env ??= { NODE_DEBUG: '' }
  // present but not an object happens too: some shims leave `env` undefined behind a getter
  if (typeof proc.env !== 'object' || proc.env === null) proc.env = { NODE_DEBUG: '' }
  proc.version ??= ''
  proc.browser ??= true
  proc.platform ??= 'browser'
  // the trailing args are load bearing: readable-stream calls nextTick(fn, arg) and expects them through
  proc.nextTick ??= (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args))
  proc.emit ??= () => false
  proc.on ??= () => proc
  proc.once ??= () => proc
  proc.off ??= () => proc
  proc.removeListener ??= () => proc
  proc.cwd ??= () => '/'
}

const root = typeof globalThis !== 'undefined' ? globalThis
  : (typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : {}))

installNodeShims(root)
