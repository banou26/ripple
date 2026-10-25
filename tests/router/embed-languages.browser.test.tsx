import type { MediaPlayerLocalOptions } from '@banou/media-player'
import type { PlayerTorrent } from '../../src/torrent/use-player-torrent'

import { AUDIO_LANGUAGE_KEY, SUBTITLE_LANGUAGE_KEY } from '../../src/router/track-languages'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter } from 'react-router-dom'

/**
 * What /watch hands the player for its languages, read off the props: the player applies them and reports the
 * viewer's picks (`@banou/media-player` tests that against a real file), and ripple's half is keeping the picks.
 */
const seen: Partial<MediaPlayerLocalOptions>[] = []
vi.mock('@banou/media-player', () => ({
  MediaPlayer: (props: Partial<MediaPlayerLocalOptions>) => { seen.push(props); return null },
}))

const FILE = { path: 'Show.S01E04.mkv', size: 1_400_000_000, offset: 0 }
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: (): PlayerTorrent => ({
    snapshot: {
      handle: 1,
      magnet: 'magnet:?xt=urn:btih:abc',
      files: { storageIndex: 0, pieceLength: 1 << 20, numPieces: 1400, totalSize: FILE.size, files: [FILE] },
      status: { numPeers: 3, uploadRate: 0 },
      bitfield: null,
      recovery: null,
      userPaused: false,
      displayDownloadRate: 0,
    },
    engineError: null,
    fileIndex: 0,
    read: async () => new ArrayBuffer(0),
    readQuiet: async () => new ArrayBuffer(0),
    prioritizeFrom: () => {},
  } as unknown as PlayerTorrent),
}))

const mount = async () => {
  seen.length = 0
  const { default: Embed } = await import('../../src/router/embed')
  return render(<MemoryRouter initialEntries={['/watch?magnet=bWFnbmV0Og==']}><Embed /></MemoryRouter>)
}
const latest = () => seen[seen.length - 1]!

describe('the languages on /watch', () => {
  afterEach(() => {
    localStorage.removeItem(AUDIO_LANGUAGE_KEY)
    localStorage.removeItem(SUBTITLE_LANGUAGE_KEY)
  })

  it('starts the player in the languages last picked, and keeps each new pick for the next visit', async () => {
    const first = await mount()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect(latest().preferredAudioLanguage).toBeUndefined()
    expect(latest().preferredSubtitleLanguage).toBeUndefined()

    latest().onPreferredAudioLanguageChange!('jpn')
    latest().onPreferredSubtitleLanguageChange!(null)
    await expect.poll(() => [latest().preferredAudioLanguage, latest().preferredSubtitleLanguage]).toEqual(['jpn', null])
    expect(localStorage.getItem(AUDIO_LANGUAGE_KEY)).toBe('jpn')
    expect(localStorage.getItem(SUBTITLE_LANGUAGE_KEY)).toBe('off')
    await first.unmount()

    await mount()
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect([latest().preferredAudioLanguage, latest().preferredSubtitleLanguage]).toEqual(['jpn', null])
    latest().onPreferredSubtitleLanguageChange!('eng')
    await expect.poll(() => latest().preferredSubtitleLanguage).toBe('eng')
    expect(localStorage.getItem(SUBTITLE_LANGUAGE_KEY)).toBe('eng')
  })
})
