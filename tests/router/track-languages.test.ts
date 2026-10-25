import { describe, expect, it } from 'vitest'

import { AUDIO_LANGUAGE_KEY, SUBTITLE_LANGUAGE_KEY, saveLanguages, savedLanguages } from '../../src/router/track-languages'

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
