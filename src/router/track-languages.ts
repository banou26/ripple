import type { LinkLanguages } from './embed-link'

/** The audio and subtitle languages the viewer last picked in the player, saved per origin like the normalizer switch. */
export const AUDIO_LANGUAGE_KEY = 'ripple:audio-language'
export const SUBTITLE_LANGUAGE_KEY = 'ripple:subtitle-language'
export const OFF = 'off'
export const ORIGINAL = 'original'

/**
 * As the player takes them: `subtitles` null for off, a language absent when none was picked, and `alwaysSubtitles`
 * as its `alwaysShowSubtitles`, absent as true.
 */
export type TrackLanguages = { audio?: string, subtitles?: string | null, alwaysSubtitles?: boolean }

/**
 * What the player starts in: each language the link names over the one saved, `original` as no audio language, which
 * starts the file on its original, and the link's Always show subtitles.
 */
export const startLanguages = ({ audio, subtitles, alwaysSubtitles }: LinkLanguages, saved: TrackLanguages): TrackLanguages => ({
  ...saved,
  ...audio ? { audio: audio === ORIGINAL ? undefined : audio } : {},
  ...subtitles ? { subtitles: subtitles === OFF ? null : subtitles } : {},
  ...alwaysSubtitles ? { alwaysSubtitles: alwaysSubtitles === '1' } : {},
})

export const savedLanguages = (read: (key: string) => string | null): TrackLanguages => {
  try {
    const audio = read(AUDIO_LANGUAGE_KEY)
    const subtitles = read(SUBTITLE_LANGUAGE_KEY)
    return {
      ...audio ? { audio } : {},
      ...subtitles ? { subtitles: subtitles === OFF ? null : subtitles } : {},
    }
  } catch {
    return {}
  }
}

export const saveLanguages = (write: (key: string, value: string) => void, { audio, subtitles }: TrackLanguages) => {
  try {
    if (audio) write(AUDIO_LANGUAGE_KEY, audio)
    if (subtitles !== undefined) write(SUBTITLE_LANGUAGE_KEY, subtitles ?? OFF)
  } catch {}
}
