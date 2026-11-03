import { describe, expect, it } from 'vitest'

import { AUDIO_LANGUAGE_KEY, SUBTITLE_LANGUAGE_KEY, saveLanguages, savedLanguages, startLanguages } from '../../src/router/track-languages'

const storage = (entries: Record<string, string> = {}) => {
  const values = new Map(Object.entries(entries))
  return {
    values,
    read: (key: string) => values.get(key) ?? null,
    write: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('the saved track languages', () => {
  it('reads the languages last picked, with subtitles off as null and nothing picked as absent', () => {
    expect(savedLanguages(storage().read)).toEqual({})
    expect(savedLanguages(storage({ [AUDIO_LANGUAGE_KEY]: 'jpn', [SUBTITLE_LANGUAGE_KEY]: 'eng' }).read))
      .toEqual({ audio: 'jpn', subtitles: 'eng' })
    expect(savedLanguages(storage({ [SUBTITLE_LANGUAGE_KEY]: 'off' }).read)).toEqual({ subtitles: null })
  })

  it('saves a pick, subtitles off included, and leaves the other language as it was', () => {
    const kept = storage({ [AUDIO_LANGUAGE_KEY]: 'jpn' })
    saveLanguages(kept.write, { subtitles: null })
    expect(savedLanguages(kept.read)).toEqual({ audio: 'jpn', subtitles: null })
    saveLanguages(kept.write, { subtitles: 'Japanese' })
    saveLanguages(kept.write, { audio: 'eng' })
    expect(savedLanguages(kept.read)).toEqual({ audio: 'eng', subtitles: 'Japanese' })
  })

  it('reads nothing and saves nothing where storage is blocked', () => {
    const blocked = () => { throw new DOMException('blocked', 'SecurityError') }
    expect(savedLanguages(blocked)).toEqual({})
    expect(() => saveLanguages(blocked, { audio: 'jpn' })).not.toThrow()
  })
})

describe('the languages the player starts in', () => {
  const saved = { audio: 'eng', subtitles: 'eng' }

  it('are the link\'s over the ones last picked, original as no audio language and off as null', () => {
    expect(startLanguages({ audio: 'ja', subtitles: 'fr', alwaysSubtitles: '0' }, saved)).toEqual({ audio: 'ja', subtitles: 'fr', alwaysSubtitles: false })
    expect(startLanguages({ audio: 'original', subtitles: 'off', alwaysSubtitles: '1' }, saved)).toEqual({ audio: undefined, subtitles: null, alwaysSubtitles: true })
  })

  it('are the ones last picked where the link names none', () => {
    expect(startLanguages({}, saved)).toEqual(saved)
    expect(startLanguages({ language: 'fr' }, { subtitles: null })).toEqual({ subtitles: null })
  })
})
