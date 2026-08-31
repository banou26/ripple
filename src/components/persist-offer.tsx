import type { PersistState } from '../torrent/storage-permission'

import { useRef, useState } from 'react'

import { persistOffer } from '../torrent/storage-permission'

/**
 * The offer to ask the browser for persistent storage, in whichever notice is reporting the problem.
 *
 * Two surfaces can raise it: the "running out of room" notice on the home page, and the add dialog
 * when a selection is bigger than the room left. One component rather than two copies of the same
 * six lines, because the properties that matter here are exactly the ones that must not drift apart
 * between two call sites:
 *
 *  - NOTHING FIRES ON RENDER. The only `persist()` this can cause is one somebody pressed a button
 *    for. On Firefox that call raises a "Store data in persistent storage" doorhanger, and a page
 *    that raises it by appearing spends the only prompt there is with nothing on screen saying what
 *    it is for. That is what the storage poll used to do; see the note in use-storage-usage.ts.
 *  - ONE PROMPT PER PRESS, and one press. The latch is a ref as well as state, so a second click
 *    landing before anything has re-rendered is dropped rather than raising a second doorhanger for
 *    a question already on screen.
 *  - NO NUMBER IS PROMISED, because every word comes from `persistOffer` rather than from here. The
 *    same press moved the reported quota from 12 GB to 3.97 TB on Firefox (measured 2026-09-01) and
 *    bought nothing at all on Chromium, which refused it without asking anyone (2026-08-30).
 *
 * Renders NOTHING where there is nothing to ask for, so a caller can drop it in unconditionally and
 * never has to choose between a dead button and a gap.
 *
 * No styles of its own, like storage-warning.tsx: a span and a button, painted by the notice around
 * them.
 */
export const PersistOffer = ({ persist, onAsk }: {
  persist: PersistState
  /** Makes the ask. Never rejects: `usePersistentStorage().request` catches everything itself. */
  onAsk: () => void
}) => {
  const asked = useRef(false)
  const [pressed, setPressed] = useState(false)
  const offer = persistOffer(persist)

  const ask = () => {
    if (asked.current) return
    asked.current = true
    setPressed(true)
    onAsk()
  }

  /**
   * 'none' is both dead ends at once: the origin is already persistent, or the browser setting
   * already answers no. Neither sentence is worth the room inside a notice that is on screen to
   * report something else, and a caller that showed one would be filling a warning with an aside.
   */
  if (offer.kind === 'none') return null

  return (
    <>
      <span>{offer.detail}</span>
      {/* Disabled rather than removed once pressed: the press is a fact worth keeping on screen
          until the measurement comes back and the copy above it changes to say what happened. */}
      {offer.action && <button type="button" disabled={pressed} onClick={ask}>{offer.action}</button>}
    </>
  )
}
