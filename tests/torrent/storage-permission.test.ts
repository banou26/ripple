import type { PersistState } from '../../src/torrent/storage-permission'

import { describe, expect, it } from 'vitest'

import { persistOffer } from '../../src/torrent/storage-permission'
import { reliefOffer } from '../../src/torrent/storage-relief'

/**
 * Whether to offer the persistent-storage ask, and what it is allowed to say.
 *
 * The case this was written for: the ask used to be made for the person, from the storage poll, the
 * first time anything was written. On Firefox that is a doorhanger raised as a side effect of the
 * first byte, and its answer decides the QUOTA: granting it moved the reported limit from 12 GB to
 * 3.97 TB on an 8.03 TB device (measured 2026-09-01 on torrent.fkn.app). Spending that prompt with
 * nothing on screen explaining it is spending the only one there is.
 *
 * The failures worth pinning are therefore about the words as much as the rules:
 *
 *  - offering the button where pressing it provably does nothing (already persistent, or the
 *    permission already denied).
 *  - offering it again after the browser has answered, and wording that answer as though the person
 *    refused something. On Chromium nobody is ever asked: persist() resolves false with no prompt.
 *  - promising room. The same press is about half a disk on Firefox and no extra bytes at all on
 *    Chromium, so a number here would be wrong for half the people reading it.
 */

const state = (over: Partial<PersistState> = {}): PersistState => ({
  persisted: false,
  permission: 'prompt',
  attempted: false,
  granted: null,
  ...over,
})

describe('whether to offer the persistent-storage ask', () => {
  it('offers it where the browser has not answered yet', () => {
    const offer = persistOffer(state())
    expect(offer.kind).toBe('ask')
    expect(offer.action).toBe('Ask for more room')
  })

  /**
   * An engine with no Permissions API, or one that rejects this particular name, must not cost the
   * person the button: 'unknown' means the query could not be asked, not that the answer was no.
   */
  it('offers it where the permission query could not be asked at all', () => {
    expect(persistOffer(state({ permission: 'unknown' })).kind).toBe('ask')
  })

  it('offers nothing once the origin is already persistent', () => {
    const offer = persistOffer(state({ persisted: true, permission: 'granted' }))
    expect(offer.kind).toBe('none')
    expect(offer.action).toBeNull()
  })

  /** the prompt cannot appear from a denied permission, so a button would be a control that does nothing */
  it('offers nothing once the permission is denied', () => {
    const offer = persistOffer(state({ permission: 'denied' }))
    expect(offer.kind).toBe('none')
    expect(offer.action).toBeNull()
  })

  /**
   * THE ONE THAT MATTERS, and it is the Chromium path in practice. persist() resolved false, no
   * prompt was ever shown, and offering the same button again would ask the same engine the same
   * question for the same answer.
   */
  it('says the browser answered, and does not offer again, after a measured refusal', () => {
    const offer = persistOffer(state({ attempted: true, granted: false }))
    expect(offer.kind).toBe('asked-and-refused')
    expect(offer.action).toBeNull()
  })

  /** an ask whose result could not be measured is still an ask that happened */
  it('treats an unmeasurable result as a refusal rather than re-offering', () => {
    expect(persistOffer(state({ attempted: true, granted: null })).kind).toBe('asked-and-refused')
  })

  /**
   * Ordering. A person who answered the Firefox prompt with no lands with permission 'denied' AND
   * attempted true, and reading their own answer back to them as "the browser decided" would be
   * false. Denied is checked first for exactly that reason.
   */
  it('says nothing at all where the person answered the prompt themselves', () => {
    expect(persistOffer(state({ permission: 'denied', attempted: true, granted: false })).kind).toBe('none')
  })

  /** and a grant that landed reads as settled, not as an ask that can be repeated */
  it('stops offering once an ask has actually landed', () => {
    expect(persistOffer(state({ persisted: true, attempted: true, granted: true })).kind).toBe('none')
  })
})

describe('what the persistent-storage offer is allowed to say', () => {
  /**
   * Both halves, because which half matters depends on an engine this module cannot see. Chromium
   * grants no extra room and only stops the clearing; Firefox is where the room is.
   */
  it('says what the ask does in terms of room AND of clearing', () => {
    const { detail } = persistOffer(state())
    expect(detail).toMatch(/clearing this site/)
    expect(detail).toMatch(/sets this limit/)
    expect(detail).toMatch(/far larger/)
  })

  /**
   * No number, in any form. 3.97 TB is one measurement on one engine on one device, and on Chromium
   * the honest figure is zero extra bytes, so a digit here would be wrong for half the people
   * reading it.
   */
  it('promises no number', () => {
    expect(persistOffer(state()).detail).not.toMatch(/\d/)
  })

  /** it may not promise a prompt either: Chromium shows none and decides on its own */
  it('does not promise that anybody will be asked', () => {
    expect(persistOffer(state()).detail).toMatch(/may answer without asking you/)
  })

  /**
   * The refusal copy must not read as "you said no". Nobody was asked on the engine that produces
   * this state, and telling somebody they refused something they never saw is the failure this
   * wording exists to avoid.
   */
  it('puts the refusal on the browser, never on the person', () => {
    const { detail } = persistOffer(state({ attempted: true, granted: false }))
    expect(detail).toMatch(/the browser answered no by itself/)
    expect(detail).not.toMatch(/\byou (refused|declined|said no|denied)\b/i)
  })

  /**
   * And it points at the route that works on every engine, in its own words. storage-relief.ts owns
   * that sentence and is usually on screen at the same time; repeating it verbatim would read as a
   * stutter rather than as a second offer.
   */
  it('points at keeping fewer bytes here without repeating the folder copy verbatim', () => {
    const { detail } = persistOffer(state({ attempted: true, granted: false }))
    expect(detail).toMatch(/keeping fewer bytes in the browser/)
    expect(detail).not.toContain(reliefOffer({ kind: 'choose' }).detail)
    expect(detail).not.toContain('only your own disk space applies')
  })

  /** every state says something, and only the ask carries a button */
  it('gives every state copy, and a button only where there is something to press', () => {
    const states = [
      state(),
      state({ permission: 'unknown' }),
      state({ persisted: true }),
      state({ permission: 'denied' }),
      state({ attempted: true, granted: false }),
    ]
    for (const s of states) {
      const { kind, detail, action } = persistOffer(s)
      expect(detail.length, `${kind} has no detail`).toBeGreaterThan(20)
      expect(action === null, `${kind} button`).toBe(kind !== 'ask')
    }
  })

  /** the two dead ends are both 'none' and must not therefore say the same thing */
  it('tells the two dead ends apart in the copy, since the kind cannot', () => {
    const alreadyOn = persistOffer(state({ persisted: true })).detail
    const turnedOff = persistOffer(state({ permission: 'denied' })).detail
    expect(alreadyOn).not.toBe(turnedOff)
    expect(alreadyOn).toMatch(/already using persistent storage/)
    expect(turnedOff).toMatch(/turned off for this site/)
  })
})
