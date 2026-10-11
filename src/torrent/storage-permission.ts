/**
 * Whether asking the browser to make this origin persistent is worth offering, and the words for it.
 *
 * THE TWO ENGINES DISAGREE ABOUT WHAT THIS CALL IS, which is the whole reason this module exists.
 * `navigator.storage.persist()` reads as a request for protection from eviction, and until
 * 2026-09-01 three comments in this codebase said that is all it is. That was measured on Chromium
 * only, through a call that never once succeeded, so what a SUCCESS does was never observable there.
 *
 *  - Chromium, measured 2026-08-30 on Chrome 151: refused on every attempt (plain, after granting
 *    notifications, and after a CDP durableStorage grant), no prompt shown at any point, and the
 *    quota stayed a flat 10 GiB on a machine with 2.8 TiB free. Nothing here can move that number.
 *  - Firefox, measured 2026-09-01 on torrent.fkn.app: the call raises a "Store data in persistent
 *    storage" doorhanger, and granting it moved the reported quota from 12 GB to 3.97 TB on a device
 *    holding 7.3 TiB (8.03 TB). About half the whole disk, and roughly 330 times the previous
 *    figure.
 *
 * So on one engine this is a request for room worth several hundred times what the site has, and on
 * the other it is a request for eviction protection that is answered no without anyone being asked.
 * The label therefore names no number and promises no prompt.
 *
 * WHY IT IS SEPARATE FROM storage-relief.ts. That module is the route that works on every engine:
 * move bytes off the origin. This one is a prompt the person may never be shown and that Chromium
 * answers no to, so it is an extra offer beside that route rather than a replacement for it.
 *
 * Pure, like storage-relief.ts and for the same reason: the rules and the words are both worth
 * testing without a browser, a prompt or an engine.
 */

/**
 * What `permissions.query({ name: 'persistent-storage' })` answered.
 *
 * THE PLATFORM'S OWN THREE, and there used to be a fourth. `unknown` was this codebase's word for
 * "the query could not be asked", covering an engine with no Permissions API, one that rejects that
 * particular name, and one that throws synchronously for it. It is gone because `@banou/ponyfill`
 * answers 'prompt' for all three, which is what the rules below already did with it: an engine that
 * will not say has not refused anything, and must not cost the person the button.
 *
 * Nothing rendered ever distinguished the two. Both fell past the `denied` check in `persistOffer`
 * and `persistControl` alike and produced the same copy and the same button.
 */
export type PersistPermission = PermissionState

export type PersistState = {
  /** what `navigator.storage.persisted()` last answered */
  persisted: boolean
  permission: PersistPermission
  /** an ask THIS session already made, whether or not a prompt was ever shown for it */
  attempted: boolean
  /** what was MEASURED after that ask, or null when none has been made */
  granted: boolean | null
}

export type PersistOffer = {
  kind:
    /** worth offering: a button that asks */
    | 'ask'
    /** asked already and the browser said no, so the button does not come back this session */
    | 'asked-and-refused'
    /** nothing to press */
    | 'none'
  action: string | null
}

export const persistOffer = ({ persisted, permission, attempted, granted }: PersistState): PersistOffer => {
  // persist() on an origin that is already persistent is a call whose success changes nothing
  if (persisted) return { kind: 'none', action: null }
  // The prompt provably cannot appear. Ordered BEFORE the refusal case on purpose, because this is
  // also where a person who answered the Firefox prompt with no ends up.
  if (permission === 'denied') return { kind: 'none', action: null }
  // THE CHROMIUM PATH in practice: persist() resolves false with no prompt ever shown, and asking
  // again this session would get the same answer
  if (attempted && !granted) return { kind: 'asked-and-refused', action: null }
  // 'prompt' lands here, which after the ponyfill's collapse also means "this engine cannot be asked"
  return { kind: 'ask', action: 'Ask for more room' }
}

/**
 * The same question as a standing control in the footer, rather than a notice that appears when
 * something is already wrong.
 *
 * It sits beside Speed, On add and Auto-save, which all report their state whether or not anything
 * is wrong, so the dead ends become the label instead of silence. `actionable` is false for every
 * state where pressing could not raise a prompt, and the caller disables rather than hides.
 */
export type PersistControl = { label: string, hint: string | null, on: boolean, actionable: boolean }

export const persistControl = (state: PersistState): PersistControl => {
  const offer = persistOffer(state)
  // 'on' means the good state is in effect, matching the footer's other controls
  if (state.persisted) return { label: 'Persistent', hint: null, on: true, actionable: false }
  if (state.permission === 'denied') {
    return { label: 'Blocked', hint: 'Turned off in the browser settings', on: false, actionable: false }
  }
  if (offer.kind === 'asked-and-refused') return { label: 'Not granted', hint: null, on: false, actionable: false }
  return { label: offer.action ?? 'Ask for more room', hint: null, on: false, actionable: true }
}
