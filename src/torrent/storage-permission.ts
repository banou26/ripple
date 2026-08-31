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
 * The copy below therefore says BOTH things, names no number, and promises no prompt.
 *
 * WHY IT IS SEPARATE FROM storage-relief.ts. That module is the route that works on every engine:
 * move bytes off the origin. This one is a prompt the person may never be shown and that Chromium
 * answers no to, so it is an extra offer beside that route rather than a replacement for it.
 *
 * Pure, like storage-relief.ts and for the same reason: the rules and the words are both worth
 * testing without a browser, a prompt or an engine.
 */

/**
 * What `navigator.permissions.query({ name: 'persistent-storage' })` answered.
 *
 * `unknown` is not a Permissions API state. It is this codebase's word for "the query could not be
 * asked", which covers an engine with no Permissions API, one that rejects that particular name, and
 * a query that threw. It is deliberately treated like `prompt` by the rules below: an engine that
 * will not say must not cost the person the button.
 */
export type PersistPermission = 'granted' | 'prompt' | 'denied' | 'unknown'

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
    /** asked already and the browser said no, so say that instead of offering it again */
    | 'asked-and-refused'
    /** nothing to say and nothing to press */
    | 'none'
  detail: string
  action: string | null
}

export const persistOffer = ({ persisted, permission, attempted, granted }: PersistState): PersistOffer => {
  // Nothing to ask for. persist() on an origin that is already persistent is a call whose success
  // changes nothing, so a button here would be a control with no observable effect.
  if (persisted) {
    return {
      kind: 'none',
      detail: 'This site is already using persistent storage, so the browser will not clear it on its own.',
      action: null,
    }
  }

  // The one state where the prompt provably cannot appear: the answer is recorded in the browser and
  // pressing anything would call persist() into a refusal. Ordered BEFORE the refusal case on
  // purpose, because this is also where a person who answered the Firefox prompt with no ends up,
  // and they do not need their own answer read back to them.
  if (permission === 'denied') {
    return {
      kind: 'none',
      detail: 'Persistent storage is turned off for this site in the browser settings, so there is nothing here to ask for.',
      action: null,
    }
  }

  // THE CHROMIUM PATH in practice: persist() resolves false with no prompt ever shown, because the
  // engine decides from its own heuristics. The copy must not read as "you said no", since nobody
  // was asked, and the button must not come back this session, since the answer would be the same.
  if (attempted && !granted) {
    return {
      kind: 'asked-and-refused',
      detail: 'Ripple asked for persistent storage and the browser answered no by itself, without putting'
        + ' the question to anyone: some browsers decide that from how the site has been used. The limit'
        + ' stands for now, so more room has to come from keeping fewer bytes in the browser.',
      action: null,
    }
  }

  // `prompt` and `unknown` both land here. The detail carries both halves of what the call does,
  // because the half that matters depends on an engine this module cannot see, and it commits to no
  // number: the same press is about half a disk on Firefox and no extra bytes at all on Chromium.
  return {
    kind: 'ask',
    detail: 'Persistent storage does two things: it stops the browser clearing this site on its own, and on'
      + ' some browsers it is also what sets this limit, which can come back far larger. Your browser'
      + ' decides, and it may answer without asking you.',
    action: 'Ask for more room',
  }
}
