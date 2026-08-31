import { describe, expect, it } from 'vitest'

import { reliefOffer, storageRelief } from '../../src/torrent/storage-relief'

/**
 * What the "Running out of room" warning offers, which is the whole point of the warning.
 *
 * The case this was written for: a person with a 2.15 GB budget, one finished 1.78 GB torrent, and
 * downloads that had stopped. They had no folder set, and the warning told them to remove a torrent.
 * Even had they found the folder control, it only starts the auto-save MIRROR, so their usage would
 * have stayed exactly where it was and gone up on the next download.
 *
 * So the failure worth pinning is not "the warning does not appear". It is the warning appearing and
 * pointing somewhere that does not help.
 */

const relief = (over: Partial<Parameters<typeof storageRelief>[0]> = {}) =>
  storageRelief({ supported: true, folderName: undefined, permitted: false, defaultLocation: 'browser', ...over })

describe('what to offer when the origin is filling up', () => {
  it('offers to choose a folder when none has ever been chosen', () => {
    expect(relief()).toEqual({ kind: 'choose' })
  })

  /**
   * THE ONE THAT MATTERS. A folder is set, the mirror is running, and the person is still stuck,
   * because copying is not moving. Nothing on screen said so before this.
   */
  it('offers to MOVE when a folder is live but downloads are only being copied to it', () => {
    expect(relief({ folderName: 'downloads', permitted: true, defaultLocation: 'browser' }))
      .toEqual({ kind: 'move', folderName: 'downloads' })
  })

  it('says the words copy and move, so the difference is on screen and not implied', () => {
    const { detail } = reliefOffer(relief({ folderName: 'downloads', permitted: true }))
    expect(detail).toMatch(/copying/)
    expect(detail).toMatch(/[Mm]ove/)
  })

  /**
   * A lapsed grant beats the location setting. Offering "move them there" while the browser has
   * forgotten the folder would be a button that provably does nothing: moveReadiness returns
   * no-folder in exactly this state.
   */
  it('asks for the folder back before offering to move into it', () => {
    expect(relief({ folderName: 'downloads', permitted: false, defaultLocation: 'folder' }))
      .toEqual({ kind: 'allow', folderName: 'downloads' })
  })

  it('offers nothing more once finished downloads already move out', () => {
    const settled = relief({ folderName: 'downloads', permitted: true, defaultLocation: 'folder' })
    expect(settled).toEqual({ kind: 'settled', folderName: 'downloads' })
    expect(reliefOffer(settled).action).toBeNull()
  })

  /**
   * Firefox and Safari have no showDirectoryPicker, so there is genuinely nowhere for the bytes to
   * go. Inventing a button there would be worse than the old copy, not better.
   */
  it('keeps the old advice where no folder can be granted at all', () => {
    expect(relief({ supported: false, folderName: 'downloads', permitted: true })).toEqual({ kind: 'none' })
    expect(reliefOffer({ kind: 'none' })).toEqual({ detail: 'Removing a torrent frees its files.', action: null })
  })

  /** every state says something, and only the two dead ends withhold a button */
  it('gives every state copy, and a button wherever there is an action', () => {
    const states = [
      { kind: 'none' },
      { kind: 'choose' },
      { kind: 'move', folderName: 'd' },
      { kind: 'allow', folderName: 'd' },
      { kind: 'settled', folderName: 'd' },
    ] as const
    for (const s of states) {
      const { detail, action } = reliefOffer(s)
      expect(detail.length, `${s.kind} has no detail`).toBeGreaterThan(20)
      expect(action === null, `${s.kind} button`).toBe(s.kind === 'none' || s.kind === 'settled')
    }
  })

  /**
   * The FOLDER route must never sell itself as a way to raise the limit, because choosing a folder
   * does not move the browser's number on any engine. It moves bytes out from under it.
   *
   * This comment used to say the limit is not raisable at all. That was Chromium only: measured
   * 2026-08-30, a flat 10 GiB on 2.8 TiB free, with persist() refused on every attempt and no prompt
   * ever shown, so what a success does was never observable there. Firefox does raise it, and by a
   * lot: granting its persistent-storage prompt moved the quota from 12 GB to 3.97 TB on an 8.03 TB
   * device, measured 2026-09-01 on torrent.fkn.app.
   *
   * That ask is a separate offer with its own copy and its own table test, in storage-permission.ts.
   * These two strings are about the folder, so anyone rewording them towards "request more storage"
   * is describing the other module.
   */
  it('never sells the folder route as a way to raise the limit', () => {
    for (const s of [{ kind: 'choose' }, { kind: 'move', folderName: 'd' }] as const) {
      expect(reliefOffer(s).detail).not.toMatch(/more (storage|space|room)|increase|raise the limit/i)
    }
    // "on its own" is load bearing and was added 2026-09-01: Ripple CAN now ask, and this sentence
    // can end up on screen directly beside that ask, so a flat "cannot raise it" would read as a
    // contradiction on Firefox
    expect(reliefOffer({ kind: 'choose' }).detail).toMatch(/cannot raise it on its own/)
  })
})
