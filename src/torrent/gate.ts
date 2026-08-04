/**
 * A latch commands park behind until the engine is ready, which can be RE-ARMED without stranding the
 * commands already waiting on it.
 *
 * The subtlety is the whole reason this is its own module. A caller parks work with `wait`, and that
 * work re-parks itself when it is still too early, so it only ever runs once the engine can take it.
 * That pattern is only sound while every latch a caller parks on eventually settles. Swapping in a
 * fresh promise and walking away from the previous one breaks it: nothing holds the old promise's
 * resolver any more, so everything chained to it is orphaned in silence, forever, with no error.
 *
 * It shipped exactly that way and it was not a rare window. `arm` is called whenever the engine is
 * replaced, which happens the instant a document wins the engine election, roughly 13ms after boot.
 * `/embed` issues its `add-magnet` inside that window, so the torrent was never added at all and the
 * player waited on metadata for a torrent the session had never heard of: no peers, no bytes, no error.
 *
 * `arm` therefore installs the new latch FIRST and only then releases the old one, so a woken waiter
 * re-parks on the latch that is now current rather than on the one being retired.
 */
export type Gate = {
  /** run `fn` once the gate is open; `fn` may call `wait` again to re-park on the current gate */
  wait: (fn: () => void) => void
  open: () => void
  /** replace the gate, waking everything parked on the old one so it can re-park */
  arm: () => void
}

export const createGate = (): Gate => {
  let open!: () => void
  let latch!: Promise<void>

  const arm = () => {
    const release = open as (() => void) | undefined
    latch = new Promise<void>((resolve) => { open = resolve })
    release?.()
  }
  arm()

  return {
    // reads `latch` at call time, so a re-park always lands on the current gate
    wait: (fn) => { void latch.then(fn) },
    open: () => open(),
    arm,
  }
}
