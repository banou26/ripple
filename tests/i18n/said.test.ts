import { afterEach, expect, test } from 'vitest'

import { startLanguage, wordsOf } from '../../src/i18n'
import { forPage } from '../../src/i18n/said'

// what the engine worker writes travels as a message and its values, and the page writes it in the language it shows

afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))

// plain descriptors, which the linter does not read
const said = (english: string, values?: Parameters<typeof forPage.formatMessage>[1]) => {
  const descriptor = { id: english, defaultMessage: english }
  return forPage.formatMessage(descriptor, values)
}

test('a message is its id and its values, written in where it is shown', () => {
  const failed = said('Could not read {name}', { name: 'Sintel.torrent' })
  expect(failed).toEqual({ message: 'Could not read {name}', values: { name: 'Sintel.torrent' } })
  expect(wordsOf(failed)).toBe('Could not read Sintel.torrent')
  expect(said('That is not a valid magnet link')).toEqual({ message: 'That is not a valid magnet link' })
})

test('words that came as a string show as they came, braces included', () => {
  expect(wordsOf('Invalid info-hash {x}')).toBe('Invalid info-hash {x}')
  expect(wordsOf(said('The engine said: {said}', { said: 'bad {bencode}' }))).toBe('The engine said: bad {bencode}')
})

test('the page writes the worker\'s message in its language, and one its catalogue lacks in English', async () => {
  await startLanguage({ language: 'de', languages: ['de-DE'], catalogues: { '../locales/de.json': async () => ({ 'Could not read {name}': '{name} konnte nicht gelesen werden' }) } })
  expect(wordsOf(said('Could not read {name}', { name: 'Sintel.torrent' }))).toBe('Sintel.torrent konnte nicht gelesen werden')
  expect(wordsOf(said('That is not a valid magnet link'))).toBe('That is not a valid magnet link')
})
