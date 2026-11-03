import type { MediaPlayerLocalOptions } from '@banou/media-player'
import type { EmbedderAsk } from '../../src/router/embedder'
import type { TrackLanguages } from '../../src/router/track-languages'
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

// the framing window is the only one heard or told, and a test has none: this is its hand and its ear
const embedder = vi.hoisted(() => ({ ask: (_: EmbedderAsk) => {}, told: [] as TrackLanguages[] }))
vi.mock('../../src/router/embedder', () => ({
  useEmbedder: (on: (ask: EmbedderAsk) => void) => { embedder.ask = on },
  tellPicked: (picked: TrackLanguages) => { embedder.told.push(picked) },
}))

const FILE = { path: 'Show.S01E04.mkv', size: 1_400_000_000, offset: 0 }
const playing: (number | undefined)[] = []
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: (_: string | undefined, named?: number): PlayerTorrent => (playing.push(named), {
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

const mount = async (search = '') => {
  seen.length = 0
  const { default: Embed } = await import('../../src/router/embed')
  const { IntlRoot } = await import('../../src/i18n')
  return render(<IntlRoot><MemoryRouter initialEntries={[`/watch?magnet=bWFnbmV0Og==${search}`]}><Embed /></MemoryRouter></IntlRoot>)
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
    expect(latest().alwaysShowSubtitles).toBeUndefined()

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

  it('starts the player in the languages the link names, over the ones last picked', async () => {
    localStorage.setItem(AUDIO_LANGUAGE_KEY, 'eng')
    localStorage.setItem(SUBTITLE_LANGUAGE_KEY, 'eng')
    const first = await mount('&audio=ja&subtitles=off&alwaysSubtitles=0')
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect([latest().preferredAudioLanguage, latest().preferredSubtitleLanguage, latest().alwaysShowSubtitles]).toEqual(['ja', null, false])
    await first.unmount()

    await mount('&audio=original&subtitles=fr&alwaysSubtitles=1')
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    expect([latest().preferredAudioLanguage, latest().preferredSubtitleLanguage, latest().alwaysShowSubtitles]).toEqual([undefined, 'fr', true])
  })

  it('tells the page framing it each pick, and starts the next file in place in it', async () => {
    embedder.told.length = 0
    await mount('&audio=ja&subtitles=fr&alwaysSubtitles=0')
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    latest().onPreferredAudioLanguageChange!('eng')
    latest().onPreferredSubtitleLanguageChange!(null)
    latest().onAlwaysShowSubtitlesChange!(true)
    expect(embedder.told).toEqual([{ audio: 'eng' }, { subtitles: null }, { alwaysSubtitles: true }])
    embedder.ask({ ripple: 'open', magnet: 'magnet:?xt=urn:btih:def', fileIndex: 2 })
    await expect.poll(() => playing[playing.length - 1]).toBe(2)
    expect([latest().preferredAudioLanguage, latest().preferredSubtitleLanguage, latest().alwaysShowSubtitles]).toEqual(['eng', null, true])
  })
})

describe('the language of the player on /watch', () => {
  const browser = (...languages: string[]) => vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  const shown = async (search?: string) => {
    await mount(search)
    await expect.poll(() => seen.length).toBeGreaterThan(0)
    return latest().language
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('is the link\'s over the browser\'s', async () => {
    browser('de-DE', 'en')
    expect(await shown('&language=fr')).toBe('fr')
  })

  it('is the browser\'s first with none on the link', async () => {
    browser('fr-FR', 'en')
    expect(await shown()).toBe('fr-FR')
  })

  it('is the first of the browser\'s the player has text in', async () => {
    browser('fi', 'da', 'ru', 'en')
    expect(await shown()).toBe('ru')
  })

  it('is none when the browser lists nothing the player has text in', async () => {
    browser('fa-IR', 'fi-FI')
    expect(await shown()).toBeUndefined()
  })

  it.each(['fr_FR', '%3Cscript%3E', 'xx', 'fi'])('is the browser\'s when the link says %s', async (tag) => {
    browser('de-DE', 'en')
    expect(await shown(`&language=${tag}`)).toBe('de-DE')
  })

  it('walks the browser\'s list when the link names its first language and the player has no text in it', async () => {
    browser('fi', 'fr')
    expect(await shown('&language=fi')).toBe('fr')
  })

  it('stays the link\'s when the embedder opens the next file in place', async () => {
    browser('de-DE')
    await shown('&language=fr')
    embedder.ask({ ripple: 'open', magnet: 'magnet:?xt=urn:btih:def', fileIndex: 2 })
    await expect.poll(() => playing[playing.length - 1]).toBe(2)
    await expect.poll(() => latest().language).toBe('fr')
  })

  it('is what Intl writes, never the link\'s own spelling', async () => {
    browser('de-DE')
    expect(await shown('&language=FR-ca-u-nu-arab')).toBe('fr-CA')
  })
})
