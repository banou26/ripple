/**
 * Whether this document is running inside a frame put there by another page.
 *
 * TRUE ON A THROWN ACCESS, which is the whole reason this is a function. Reading `window.top` across
 * origins throws, and the answer a throw carries is "framed by a page that is not us", so a caller
 * that let the error escape would be refusing nothing in exactly the case the check is for.
 *
 * A SAME-ORIGIN FRAME COUNTS AS FRAMED, and neither caller needs to tell the two apart: the magnet
 * handoff refuses because a page that sizes and positions the frame decides what the visitor thinks
 * they are clicking, and the folder control refuses because a directory picker is refused in a
 * cross-origin frame whatever its sandbox tokens, so offering it there is a button that can only
 * turn out to be impossible once pressed.
 */
export const isFramed = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return window.top !== window.self
  } catch {
    return true
  }
}
