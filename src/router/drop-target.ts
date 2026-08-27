/**
 * Which ONE surface announces where a drop will land.
 *
 * The library page has three that can say it: the magnet field in the header, the share panel's
 * "pick a torrent" box, and the page-wide overlay. They were three independent booleans, and that
 * shape has now produced the same defect twice: the page and the field lit together, and after that
 * was fixed the page and the share panel lit together, because both were still reading one flag.
 * Two surfaces lit at once tell a person there are two places the file could go when there is only
 * ever one.
 *
 * So the choice is made HERE, once, and returns a single name. A caller cannot light two surfaces
 * without ignoring the answer, and the priority is written down rather than emerging from whichever
 * condition happened to be checked first.
 *
 * Priority is narrowest first. The field is a real target with its own drop handler, so reaching it
 * stands everything else down. The share panel's box is next: it is page-wide like the overlay, but
 * it says what the drop will DO right now (build a link for what you drop) rather than merely that
 * it will be accepted, so where both could speak it is the more useful of the two.
 *
 * No engine and no DOM, so the rule can be tested directly.
 */
export type DropTarget = 'field' | 'pick' | 'page' | null

export type DropState = {
  /** A drag carrying something addable is over the window. */
  dragging: boolean
  /** That drag is over the magnet field, which takes the drop itself. */
  overField: boolean
  /** The share panel is open and waiting to be given a torrent, so its box is on screen. */
  pickOpen: boolean
}

export const dropTarget = ({ dragging, overField, pickOpen }: DropState): DropTarget => {
  if (!dragging) return null
  if (overField) return 'field'
  if (pickOpen) return 'pick'
  return 'page'
}
