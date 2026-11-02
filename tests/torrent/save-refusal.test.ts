import type { TorrentClient } from '../../src/torrent/client'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { showSaveFilePicker } from '@banou/ponyfill'

import { isSaveCancelled, saveTorrentFileToDisk } from '../../src/torrent/save-file'
import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

/**
 * The one thing `save-file.ts` needs from `@banou/ponyfill`, asserted across the boundary.
 *
 * `openSink` tries the save picker and, when it refuses, falls through to an arm that can still
 * deliver the bytes. What decides between "fall through" and "stop" is `isSaveCancelled`, which
 * matches `AbortError` alone, because that is the platform's name for the PERSON closing the dialog.
 * So the ponyfill's refusals must never wear that name, and this is what would notice if they ever
 * did: a refusal read as a cancel ends a save that could have worked and reports it as a failure.
 *
 * Ripple used to carry its own copy of the cross origin check for this. The copy is gone; the
 * contract it depended on is not, so it is pinned here rather than assumed.
 */
describe('a refusal from the save picker is not a cancel', () => {
  it('refuses with a name ripple does not read as the person changing their mind', async () => {
    // node has no window and no picker, which is the "this environment cannot show one" refusal
    const error = await showSaveFilePicker({ suggestedName: 'x.mkv' }).catch((e: unknown) => e)
    expect((error as Error).name).toBe('NotAllowedError')
    expect(isSaveCancelled(error), 'a refusal read as a cancel stops a save that could have worked').toBe(false)
  })

  it('refuses a cross origin frame the same way, without calling the platform picker', async () => {
    let called = 0
    const top = { get location (): never { throw new DOMException('blocked', 'SecurityError') } }
    vi.stubGlobal('window', { self: {}, top })
    vi.stubGlobal('showSaveFilePicker', async () => { called++; return {} })
    const error = await showSaveFilePicker().catch((e: unknown) => e)
    vi.unstubAllGlobals()

    expect(called, 'calling it there spends part of the click the fallback arm still needs').toBe(0)
    expect(isSaveCancelled(error)).toBe(false)
  })

  /** and the control: a real cancel still has to read as one, or every dismissal becomes an error */
  it('still recognises the platform cancel it was written for', () => {
    expect(isSaveCancelled(new DOMException('The user aborted a request.', 'AbortError'))).toBe(true)
  })
})

// the reason the download page writes after "The download stopped:", the engine's own words already the page's
describe('a chunk the engine could not hand over', () => {
  afterEach(() => {
    vi.useRealTimers()
    return showEnglish()
  })

  const failed = async (reason: string) => {
    vi.useFakeTimers()
    const client = { read: () => Promise.reject(new Error(reason)) } as unknown as TorrentClient
    const save = saveTorrentFileToDisk(client, 1, 2, 'Pack/Small.mkv', 16).catch((error: Error) => error.message)
    // the retries' pauses
    await vi.runAllTimersAsync()
    return save
  }

  it('says which, and why, in the page\'s language', async () => {
    expect(await failed('torrent paused')).toBe('could not read 16 bytes at 0 of file 2: torrent paused')
    await showIn('de', de, 'de-DE')
    expect(await failed('Torrent pausiert')).toBe('16 Bytes an Position 0 von Datei 2 konnten nicht gelesen werden: Torrent pausiert')
  })
})

describe('a file too big to hold in memory, with no picker to stream it to', () => {
  afterEach(showEnglish)

  it('is refused in the page\'s language', async () => {
    const refusal = () => saveTorrentFileToDisk({} as TorrentClient, 1, 0, 'Pack/Big.mkv', 2 * 1024 ** 3)
    await expect(refusal()).rejects.toThrow('This file is too large to save here.')
    await showIn('de', de, 'de-DE')
    await expect(refusal()).rejects.toThrow('Diese Datei ist zu groß, um sie hier zu speichern.')
  })
})
