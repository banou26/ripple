import { describe, expect, it } from 'vitest'

import {
  currentLocation,
  intendedLocation,
  isSaveLocation,
  locationLabel,
  moveReadiness,
  pendingLabel,
  readGlobalDefault,
  savePathIn,
  SAVE_LOCATION_KEY,
} from './save-location'
import { isNativeSavePath } from './hybrid-storage'

/**
 * Two locations, and the rule that they are not interchangeable.
 *
 * A download can only be written into browser storage, because libtorrent writes pieces at arbitrary
 * offsets and OPFS is the only backend that takes an in-place random write. A granted folder is
 * readable, so a finished torrent can be shared out of it, but writing there publishes by renaming a
 * swap file over the target, which is why the file reads 0 bytes for the whole download and why a
 * crash loses the lot. Hence: land in browser storage, move on completion. Same split qBittorrent
 * makes with its incomplete-torrents path, from the same constraint.
 *
 * So "where the user wants it" and "where it is" are separate facts, and most of this file is about
 * not confusing them.
 */

describe('reading a stored preference', () => {
  it('defaults to browser storage when nothing has been chosen', () => {
    expect(readGlobalDefault(() => null)).toBe('browser')
  })

  it('reads a stored choice', () => {
    expect(readGlobalDefault((k) => (k === SAVE_LOCATION_KEY ? 'folder' : null))).toBe('folder')
  })

  it('ignores anything it does not recognise rather than trusting it', () => {
    for (const junk of ['Folder', 'opfs', '', 'true', '{}']) expect(readGlobalDefault(() => junk)).toBe('browser')
  })

  it('knows what is a location and what is not', () => {
    expect(isSaveLocation('browser')).toBe(true)
    expect(isSaveLocation('folder')).toBe(true)
    for (const junk of [undefined, null, 0, 'FOLDER', {}]) expect(isSaveLocation(junk)).toBe(false)
  })
})

describe('what the user wants for one torrent', () => {
  it('takes the global default when the torrent has no preference', () => {
    expect(intendedLocation({}, 'folder')).toBe('folder')
    expect(intendedLocation(undefined, 'folder')).toBe('folder')
    expect(intendedLocation(null, 'browser')).toBe('browser')
  })

  it('lets a torrent override the default in either direction', () => {
    expect(intendedLocation({ saveTo: 'browser' }, 'folder')).toBe('browser')
    expect(intendedLocation({ saveTo: 'folder' }, 'browser')).toBe('folder')
  })

  it('falls back to the default when the stored override is junk', () => {
    expect(intendedLocation({ saveTo: 'nowhere' as never }, 'folder')).toBe('folder')
  })
})

describe('where the bytes actually are', () => {
  it('reads the location off the save path libtorrent was given', () => {
    expect(currentLocation('/dl/abc')).toBe('browser')
    expect(currentLocation('/native/abc')).toBe('folder')
    expect(currentLocation(undefined)).toBe('browser')
  })

  it('builds a save path per location, and the folder one is recognised as native', () => {
    expect(savePathIn('browser', 'abc')).toBe('/dl/abc')
    expect(isNativeSavePath(savePathIn('folder', 'abc'))).toBe(true)
    expect(isNativeSavePath(savePathIn('browser', 'abc'))).toBe(false)
  })

  it('round trips: a path built for a location reads back as that location', () => {
    for (const location of ['browser', 'folder'] as const) {
      expect(currentLocation(savePathIn(location, 'abc'))).toBe(location)
    }
  })

  /** a .torrent add has no infohash yet, so it lands in the shared root and must not read as native */
  it('handles a torrent with no infohash yet', () => {
    expect(currentLocation(savePathIn('browser', null))).toBe('browser')
    expect(currentLocation(savePathIn('folder', null))).toBe('browser')
  })
})

describe('deciding whether files should move', () => {
  const base = { current: 'browser', intended: 'browser', complete: true, folderReady: true } as const

  it('does nothing when it is already where it belongs', () => {
    expect(moveReadiness(base)).toEqual({ move: false, reason: 'settled' })
    expect(moveReadiness({ ...base, current: 'folder', intended: 'folder' })).toEqual({ move: false, reason: 'settled' })
  })

  it('moves a finished torrent into the folder', () => {
    expect(moveReadiness({ ...base, intended: 'folder' })).toEqual({ move: true, to: 'folder' })
  })

  it('moves one back out of the folder', () => {
    expect(moveReadiness({ ...base, current: 'folder', intended: 'browser' })).toEqual({ move: true, to: 'browser' })
  })

  /**
   * The case the whole two-location split exists for. Asking for a folder while it downloads is a
   * reasonable thing to want, and the answer is "when it finishes", not "no".
   */
  it('waits for an unfinished torrent rather than refusing it', () => {
    expect(moveReadiness({ ...base, intended: 'folder', complete: false }))
      .toEqual({ move: false, reason: 'incomplete' })
  })

  /** coming OUT of a folder is fine unfinished, since the destination takes random writes */
  it('does not hold back a move out of the folder for being unfinished', () => {
    expect(moveReadiness({ ...base, current: 'folder', intended: 'browser', complete: false }))
      .toEqual({ move: true, to: 'browser' })
  })

  it('waits when there is no folder access, in both directions', () => {
    expect(moveReadiness({ ...base, intended: 'folder', folderReady: false }))
      .toEqual({ move: false, reason: 'no-folder' })
    // reading a torrent OUT of the folder needs the grant just as much as writing into it
    expect(moveReadiness({ ...base, current: 'folder', intended: 'browser', folderReady: false }))
      .toEqual({ move: false, reason: 'no-folder' })
  })

  it('says nothing about a settled torrent even with no folder', () => {
    expect(moveReadiness({ ...base, folderReady: false })).toEqual({ move: false, reason: 'settled' })
  })
})

describe('what the user is told', () => {
  it('explains a wait rather than leaving it silent', () => {
    expect(pendingLabel({ move: false, reason: 'incomplete' }, 'Downloads')).toBe('Moves to Downloads when it finishes')
    expect(pendingLabel({ move: false, reason: 'no-folder' }, 'Downloads')).toBe('Waiting for access to Downloads')
  })

  it('says nothing when there is nothing to wait for', () => {
    expect(pendingLabel({ move: false, reason: 'settled' }, 'Downloads')).toBe(null)
    expect(pendingLabel({ move: true, to: 'folder' }, 'Downloads')).toBe(null)
  })

  it('copes with a folder whose name is not known yet', () => {
    expect(pendingLabel({ move: false, reason: 'incomplete' }, undefined)).toBe('Moves to your folder when it finishes')
    expect(locationLabel('folder', undefined)).toBe('your folder')
  })

  it('names the folder rather than saying folder', () => {
    expect(locationLabel('folder', 'Downloads')).toBe('Downloads')
    expect(locationLabel('browser', 'Downloads')).toBe('Browser storage')
  })
})
