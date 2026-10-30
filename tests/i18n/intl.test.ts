import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { intl, startLanguage, type Catalogue } from '../../src/i18n'

// plain descriptors, which the linter does not read: each message as ripple writes it, its English its id
const message = (english: string, description?: string) =>
  ({ id: description ? `${english}#${description}` : english, defaultMessage: english, description })
const FILES = message('{count, plural, one {# file} other {# files}}')

const start = (language: string, catalogue: Catalogue, languages = [language]) =>
  startLanguage({ language, languages, catalogues: { [`../locales/${language}.json`]: async () => catalogue } })

// a stand-in for <html>, which the node project has none of
const element = () => {
  const attributes = new Map<string, string>([['lang', 'en']])
  return {
    get lang () { return attributes.get('lang') ?? '' },
    set lang (value: string) { attributes.set('lang', value) },
    get dir () { return attributes.get('dir') ?? '' },
    set dir (value: string) { attributes.set('dir', value) },
    removeAttribute: (name: string) => { attributes.delete(name) },
    attributes,
  }
}
const html = (shown: ReturnType<typeof element>) => shown as unknown as HTMLElement

afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))

test('before a language starts, the page writes English', () => {
  expect(intl.formatMessage(FILES, { count: 1180 })).toBe('1,180 files')
})

describe('English, the code\'s own text', () => {
  test('a plain value shows as given, never grouped', () => {
    expect(intl.formatMessage(message('Piece {piece} of {pieces}'), { piece: 1180, pieces: 2400 })).toBe('Piece 1180 of 2400')
  })

  test('# and a number are written in the language', () => {
    expect(intl.formatMessage(FILES, { count: 1180 })).toBe('1,180 files')
    expect(intl.formatMessage(FILES, { count: 1 })).toBe('1 file')
    expect(intl.formatMessage(message('{size, number} peers'), { size: 12345 })).toBe('12,345 peers')
  })

  test('a select picks its branch, else other', () => {
    const kind = message('{kind, select, seeder {A seeder} leecher {A leecher} other {A peer}}')
    expect(['seeder', 'leecher', 'web'].map(each => intl.formatMessage(kind, { kind: each }))).toEqual(['A seeder', 'A leecher', 'A peer'])
  })

  test('the English is written as the browser\'s own English writes numbers, and reports no missing translation', async () => {
    const reported = vi.spyOn(console, 'error')
    const english = await startLanguage({ language: 'en', languages: ['de-DE', 'en-IN'] })
    expect(english.formatMessage(FILES, { count: 123456 })).toBe('1,23,456 files')
    expect(reported).not.toHaveBeenCalled()
    reported.mockRestore()
  })
})

describe('plurals in each language\'s own forms', () => {
  test('French: one for 0 and 1, the group a narrow space', async () => {
    const fr = await start('fr', { [FILES.id]: '{count, plural, one {# fichier} other {# fichiers}}' })
    expect([0, 1, 2, 1180].map(count => fr.formatMessage(FILES, { count }))).toEqual(['0 fichier', '1 fichier', '2 fichiers', '1 180 fichiers'])
  })

  test('Russian: one, few, many, and other for a fraction', async () => {
    const ru = await start('ru', { [FILES.id]: '{count, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}' })
    expect([1, 3, 5, 21, 1.5].map(count => ru.formatMessage(FILES, { count }))).toEqual(['1 файл', '3 файла', '5 файлов', '21 файл', '1,5 файла'])
  })
})

describe('a description tells apart two messages spelled alike, and is part of the id', () => {
  const noun = message('Seed')
  const verb = message('Seed', 'verb')

  test('each reads its own text', async () => {
    const de = await start('de', { Seed: 'Seed', 'Seed#verb': 'Seeden' })
    expect([de.formatMessage(noun), de.formatMessage(verb)]).toEqual(['Seed', 'Seeden'])
  })

  test('English shows the text without its description', () => {
    expect([intl.formatMessage(noun), intl.formatMessage(verb)]).toEqual(['Seed', 'Seed'])
  })
})

describe('fallbacks', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks() })

  test('a key the catalogue lacks renders the English, with English plurals and numbers', async () => {
    const fr = await start('fr', {}, ['fr-FR'])
    expect([0, 1180].map(count => fr.formatMessage(FILES, { count }))).toEqual(['0 files', '1,180 files'])
  })

  test('a translation that does not parse renders the English', async () => {
    const fr = await start('fr', { [FILES.id]: '{count, plural, one {# fichier}' })
    expect(fr.formatMessage(FILES, { count: 2 })).toBe('2 files')
  })

  test('a value missing renders the translation\'s own text rather than throwing', async () => {
    const fr = await start('fr', { 'Added {name}': '{name} ajouté' })
    expect(fr.formatMessage(message('Added {name}'))).toBe('{name} ajouté')
  })

  test('a catalogue that fails to load leaves English, and English marks', async () => {
    const shown = element()
    const english = await startLanguage({ language: 'fr', languages: ['fr-FR'], html: html(shown), catalogues: { '../locales/fr.json': () => Promise.reject(new Error('offline')) } })
    expect(english.formatMessage(FILES, { count: 1180 })).toBe('1,180 files')
    expect(shown.lang).toBe('en')
  })

  test('a language with no catalogue at all leaves English', async () => {
    const shown = await startLanguage({ language: 'fr', languages: ['fr-FR'], catalogues: {} })
    expect(shown.formatMessage(message('Pause'))).toBe('Pause')
  })
})

describe('starting a language', () => {
  test('the page\'s intl is the one started', async () => {
    const fr = await start('fr', { Pause: 'Mettre en pause' })
    expect(intl).toBe(fr)
    expect(intl.formatMessage(message('Pause'))).toBe('Mettre en pause')
  })

  test('dates and numbers follow the browser\'s own tag for the language shown', async () => {
    const date = new Date(2026, 9, 26)
    expect((await startLanguage({ language: 'en', languages: ['en-GB'] })).formatDate(date)).toBe('26/10/2026')
    expect((await startLanguage({ language: 'en', languages: [] })).formatDate(date)).toBe('10/26/2026')
    expect((await start('es-419', {}, ['es-MX'])).formatNumber(1234.5)).toBe('1,234.5')
    expect((await start('es-419', {}, ['es-AR'])).formatNumber(1234.5)).toBe('1.234,5')
    expect((await start('fr', { [FILES.id]: '{count, plural, one {# fichier} other {# fichiers}}' }, ['fr-CA', 'en'])).formatMessage(FILES, { count: 1180 })).toBe('1 180 fichiers')
  })

  test('<html> takes the language and, right to left, its direction', async () => {
    const shown = element()
    await startLanguage({ language: 'ar', languages: ['ar-EG'], html: html(shown), catalogues: { '../locales/ar.json': async () => ({ Pause: 'إيقاف مؤقت' }) } })
    expect([shown.lang, shown.dir, intl.formatMessage(message('Pause'))]).toEqual(['ar', 'rtl', 'إيقاف مؤقت'])
    await startLanguage({ language: 'fr', languages: ['fr-FR'], html: html(shown), catalogues: { '../locales/fr.json': async () => ({}) } })
    expect([shown.lang, shown.attributes.has('dir')]).toEqual(['fr', false])
  })

  test('English leaves <html> as index.html writes it', async () => {
    const shown = element()
    await startLanguage({ language: 'en', languages: ['en-US'], html: html(shown) })
    expect([...shown.attributes]).toEqual([['lang', 'en']])
  })
})
