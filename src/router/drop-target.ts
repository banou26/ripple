/**
 * Which ONE surface announces where a drop will land.
 *
 * The library page has three that can say it: the magnet field in the header, the share dialog's
 * drop zone, and the page-wide overlay. They were three independent booleans, and that shape
 * produced the same defect twice: the page and the field lit together, and after that was fixed the
 * page and the share panel lit together, because both were still reading one flag. Two surfaces lit
 * at once tell a person there are two places the file could go when there is only ever one.
 *
 * So the choice is made HERE, once, and returns a single name. A caller cannot light two surfaces
 * without ignoring the answer, and the priority is written down rather than emerging from whichever
 * condition happened to be checked first.
 *
 * Priority is by what is ON TOP, then by what is narrowest.
 *
 * The share dialog comes first because it is a MODAL: it covers the page and the header both, and
 * the shell marks everything behind it inert, so neither of the other two can be reached while it is
 * open. This is the one thing that changed when the share panel stopped being an inline element and
 * became a dialog. As a panel it sat in the page and the field genuinely could win, so the field was
 * checked first; keeping that order afterwards would have let an inert control claim a drop that can
 * only land on the dialog.
 *
 * Then the field, which is a real target with its own drop handler, so reaching it stands the
 * page-wide overlay down. Then the overlay, which accepts anything the other two did not.
 *
 * No engine and no DOM, so the rule can be tested directly.
 */
export type DropTarget = 'field' | 'share' | 'page' | null

export type DropState = {
  /** A drag carrying something addable is over the window. */
  dragging: boolean
  /** That drag is over the magnet field, which takes the drop itself. */
  overField: boolean
  /** The share dialog is open and waiting to be given a torrent, so its drop zone is on screen. */
  shareOpen: boolean
}

export const dropTarget = ({ dragging, overField, shareOpen }: DropState): DropTarget => {
  if (!dragging) return null
  if (shareOpen) return 'share'
  if (overField) return 'field'
  return 'page'
}
