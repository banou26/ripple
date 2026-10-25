/** The audio and subtitle languages the viewer last picked in the player, saved per origin like the normalizer switch. */
export const AUDIO_LANGUAGE_KEY = 'ripple:audio-language'
export const SUBTITLE_LANGUAGE_KEY = 'ripple:subtitle-language'
const OFF = 'off'

/** As the player takes them: `subtitles` null for off, and a language absent when none was picked. */
export type TrackLanguages = { audio?: string, subtitles?: string | null }

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
