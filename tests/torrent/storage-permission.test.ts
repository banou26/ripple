import type { PersistState } from '../../src/torrent/storage-permission'

import { describe, expect, it } from 'vitest'

import { persistControl, persistOffer } from '../../src/torrent/storage-permission'

/**
 * Whether to offer the persistent-storage ask, and what it is allowed to say.
 *
 * The case this was written for: the ask used to be made for the person, from the storage poll, the
 * first time anything was written. On Firefox that is a doorhanger raised as a side effect of the
 * first byte, and its answer decides the QUOTA: granting it moved the reported limit from 12 GB to
 * 3.97 TB on an 8.03 TB device (measured 2026-09-01 on torrent.fkn.app). Spending that prompt with
 * nothing on screen explaining it is spending the only one there is.
 *
 * The failures worth pinning:
 *
 *  - offering the button where pressing it provably does nothing (already persistent, or the
 *    permission already denied).
 *  - offering it again after the browser has answered. On Chromium nobody is ever asked: persist()
 *    resolves false with no prompt.
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
   * person the button. Those used to be a fourth state here; `@banou/ponyfill` collapses them onto
   * 'prompt', which is the same edge of every rule below and the reason the fourth state could go.
   */
  it('offers it where the permission query could not be asked at all', () => {
    expect(persistOffer(state({ permission: 'prompt' })).kind).toBe('ask')
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

describe('the persistent-storage control in the footer', () => {
  /** a button only where pressing can raise a prompt, and a label that answers everywhere else */
  it('is pressable only where the offer is an ask', () => {
    const states = [
      state(),
      state({ persisted: true }),
      state({ permission: 'denied' }),
      state({ attempted: true, granted: false }),
    ]
    for (const s of states) {
      const { kind, action } = persistOffer(s)
      expect(action === null, `${kind} button`).toBe(kind !== 'ask')
      expect(persistControl(s).actionable, `${kind} actionable`).toBe(kind === 'ask')
    }
  })

  /** the two dead ends are both 'none', so the label is what tells them apart */
  it('tells the two dead ends apart by label, since the kind cannot', () => {
    expect(persistControl(state({ persisted: true })).label).toBe('Persistent')
    expect(persistControl(state({ permission: 'denied' })).label).toBe('Blocked')
  })
})
