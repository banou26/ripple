import { afterEach, describe, expect, it } from 'vitest'

import { startLanguage } from '../../src/i18n'
import { getHumanReadableByteString, getHumanReadableSpeed, getRoundedSpeed, writePercent } from '../../src/utils/bytes'

// a language shown, with no text of its own: units follow the language, not its catalogue
const show = (language: string, languages = [language]) =>
  startLanguage({ language, languages, catalogues: { [`../locales/${language}.json`]: async () => ({}) } })
// ICU writes a no-break space between a number and its unit in some languages, and which one moves between versions
const plain = (text: string) => text.replace(/\s/gu, ' ')

/*
 * This file exists because of one crash.
 *
 * The unit table has six entries and the index was computed straight from the logarithm, so anything
 * from 1e18 up read past the end, handed `undefined` to Intl.NumberFormat, and got back
 * `TypeError: Invalid unit argument`. Nothing caught it, so it took out whatever was rendering.
 *
 * It was unreachable for years because every caller passed a number the engine, the storage quota or
 * the library had produced. A file list carried in a share link is the first caller whose number
 * comes from a query string, which is what made a dead row reachable from outside. The formatter is
 * the right place to fix it: roughly twenty call sites read this, and only one of them was audited.
 */
describe('sizes past the end of the unit table', () => {
  it('formats rather than throwing, at and past the old boundary', () => {
    expect(() => getHumanReadableByteString(1e18)).not.toThrow()
    expect(() => getHumanReadableByteString(1e21)).not.toThrow()
    expect(() => getHumanReadableByteString(Number.MAX_SAFE_INTEGER)).not.toThrow()
    expect(() => getHumanReadableByteString(Number.MAX_VALUE)).not.toThrow()
    expect(() => getHumanReadableByteString(Infinity)).not.toThrow()
  })

  it('says petabytes rather than an empty unit', () => {
    expect(getHumanReadableByteString(1e18)).toMatch(/PB$/)
    expect(getHumanReadableByteString(1e21)).toMatch(/PB$/)
  })

  /** the boundary itself, so a future change to the table cannot quietly move it back */
  it('still formats the largest size that was always fine', () => {
    expect(getHumanReadableByteString(999e15)).toBe('999 PB')
  })
})

describe('the ordinary range, unchanged', () => {
  const CASES: [number, string][] = [
    [0, '0 bytes'],
    [1, '1 B'],
    [999, '999 B'],
    [1000, '1 kB'],
    [1_500_000, '1.5 MB'],
    [1_400_000_000, '1.4 GB'],
    [2_500_000_000_000, '2.5 TB'],
  ]
  for (const [bytes, want] of CASES) {
    it(`formats ${bytes} as ${want}`, () => {
      expect(getHumanReadableByteString(bytes)).toBe(want)
    })
  }

  it('still answers for NaN rather than throwing', () => {
    expect(getHumanReadableByteString(NaN)).toBe('NaN')
  })

  it('compact shortens the zero and nothing else', () => {
    expect(getHumanReadableByteString(0, true)).toBe('0 B')
    expect(getHumanReadableByteString(0.5, true)).toBe('0 B')
    expect(getHumanReadableByteString(1_500_000, true)).toBe('1.5 MB')
  })
})

describe('speeds', () => {
  const CASES: [number, boolean, string][] = [
    [0, true, '0 B/s'],
    [0, false, '0 bytes/s'],
    [999, true, '999 B/s'],
    [1000, true, '1 kB/s'],
    [10_400_000, true, '10.4 MB/s'],
    [1_500_000_000, true, '1.5 GB/s'],
    [2_500_000_000_000, true, '2.5 TB/s'],
    [1e18, true, '1,000 PB/s'],
  ]
  for (const [bytes, compact, want] of CASES) {
    it(`writes ${bytes} as ${want}`, () => {
      expect(getHumanReadableSpeed(bytes, compact)).toBe(want)
    })
  }

  it('in whole units, the capital K and never a group', () => {
    expect(getRoundedSpeed(512_400)).toBe('512 KB/s')
    expect(getRoundedSpeed(12_400_000)).toBe('12 MB/s')
    expect(getRoundedSpeed(5_000_000_000)).toBe('5 GB/s')
    expect(getRoundedSpeed(1_234_000_000_000)).toBe('1234 GB/s')
  })
})

describe('in the language of the page', () => {
  afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))

  it('French writes its own units and its own decimal comma', async () => {
    await show('fr')
    expect(plain(getHumanReadableByteString(1_500_000_000))).toBe('1,5 Go')
    expect(plain(getHumanReadableSpeed(512_000, true))).toBe('512 ko/s')
    expect(plain(getRoundedSpeed(512_000))).toBe('512 ko/s')
  })

  it('Russian and Japanese write the speed in their own words', async () => {
    await show('ru')
    expect(plain(getHumanReadableByteString(1_500_000_000))).toBe('1,5 ГБ')
    await show('ja')
    expect(plain(getHumanReadableSpeed(1_500_000, true))).toBe('1.5 MB/秒')
  })

  it('a byte reads as its symbol wherever the language spells it out, singular or plural', async () => {
    await show('pt-BR')
    expect(plain(getHumanReadableByteString(999))).toBe('999 B')
    await show('it')
    expect(plain(getHumanReadableSpeed(999, true))).toBe('999 B/s')
    await show('ko')
    expect(plain(getHumanReadableByteString(999))).toBe('999B')
  })

  it('a zero takes the same unit in another language, compact or not', async () => {
    await show('fr')
    expect([getHumanReadableByteString(0), getHumanReadableByteString(0, true), getHumanReadableSpeed(0)].map(plain)).toEqual(['0 o', '0 o', '0 o/s'])
    await show('it')
    expect([getHumanReadableByteString(0), getHumanReadableSpeed(0)].map(plain)).toEqual(['0 B', '0 B/s'])
  })

  it('any English reads as ripple has always written it', async () => {
    for (const browser of ['en-GB', 'en-DE', 'en-IN']) {
      await show('en', [browser])
      expect(getHumanReadableByteString(1_500_000)).toBe('1.5 MB')
      expect(getHumanReadableByteString(0)).toBe('0 bytes')
      expect(getHumanReadableSpeed(10_400_000)).toBe('10.4 MB/s')
    }
  })

  it('a language whose catalogue fails to load stays with English units, as its text does', async () => {
    await startLanguage({ language: 'fr', languages: ['fr-FR'], catalogues: { '../locales/fr.json': () => Promise.reject(new Error('offline')) } })
    expect(getHumanReadableByteString(1_500_000_000)).toBe('1.5 GB')
  })
})

describe('a percentage', () => {
  afterEach(() => show('en', ['en-US']))

  it('writes English as a row always has, its digits exact', () => {
    expect(writePercent(0.5, 1)).toBe('50.0%')
    expect(writePercent(0.1234, 1)).toBe('12.3%')
    expect(writePercent(1)).toBe('100%')
  })

  it('follows the page\'s language, the sign where that language puts it', async () => {
    await show('fr')
    expect(plain(writePercent(0.5, 1))).toBe('50,0 %')
    await show('de')
    expect(plain(writePercent(1))).toBe('100 %')
    await show('tr')
    expect(writePercent(0.5, 1)).toBe('%50,0')
  })
})
