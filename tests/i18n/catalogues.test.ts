import { afterEach, describe, expect, test } from 'vitest'

import { startLanguage } from '../../src/i18n'
import { catalogues, english } from '../languages'

const PLACEHOLDER = 'Add a magnet link, or search'

// stub's own words for labels the two apps share, so they read alike
const STUB_WORDS: Record<string, Record<string, string>> = {
  // the FKN account's, which stub words apart from unlinking a list service
  Disconnect: { ar: 'تسجيل الخروج', he: 'התנתקות' },
  'Disconnecting...': { ar: 'جارٍ تسجيل الخروج...', he: 'מתנתק...' },
  Disconnected: { ar: 'تم تسجيل الخروج', he: 'נותק' },
  'How it works': { de: 'So funktioniert es', ja: '仕組み' },
  Legal: { 'es-419': 'Aviso legal', 'pt-BR': 'Aviso legal', tr: 'Yasal bilgiler', 'zh-Hans': '法律声明', 'zh-Hant': '法律聲明' },
  'Powered by FKN': { de: 'Bereitgestellt von FKN', 'es-419': 'Con tecnología de FKN', it: 'Con tecnologia FKN', 'zh-Hant': '由 FKN 提供技術支援' },
  Privacy: { ko: '개인정보 보호', 'zh-Hant': '隱私權' },
  Reload: { pl: 'Odśwież' },
  Speed: { de: 'Geschwindigkeit' },
}

// the check asks this only of a language once it is offered, by when a gap would already be someone else's to find
describe('every catalogue', () => {
  const code = Object.keys(english())

  test.each(Object.entries(catalogues()))('%s carries every message of the code', (_, catalogue) => {
    expect(code.filter(id => !Object.hasOwn(catalogue, id))).toEqual([])
  })

  test.each(Object.entries(STUB_WORDS))('%s reads as in stub', (id, words) => {
    for (const [language, text] of Object.entries(words)) expect(catalogues()[language]![id], language).toBe(text)
  })

  // the warning's two actions stand side by side, and Close beside Cancel would read as two ways to keep the VPN on
  test.each(Object.entries(catalogues()))('%s names switching the VPN off by a word that is neither Close nor Cancel', (_, catalogue) => {
    expect([catalogue.Close, catalogue.Cancel]).not.toContain(catalogue['Turn off'])
  })

  // the switch's Off stands beside the line of a download that found nobody, which names the VPN with its article
  test.each(['es-419', 'pt-BR', 'it', 'fr'])('%s words the switch\'s state in the gender it gives the VPN', (language) => {
    const catalogue = catalogues()[language]!
    expect(catalogue['No peers found with the VPN off. Still searching.']!.toLowerCase()).toContain(catalogue.Off!.toLowerCase())
    // On and Off are one word in two states
    expect(catalogue.On!.at(-1)).toBe(catalogue.Off!.at(-1))
  })

  // a field cannot wrap, and a phone leaves the English's own length to it
  test.each(Object.entries(catalogues()))('%s words the magnet field no longer than English', (_, catalogue) => {
    expect(catalogue[PLACEHOLDER]!.length).toBeLessThanOrEqual(PLACEHOLDER.length)
  })
})

// Arabic and Hebrew write one and two in words, and their isolates, which only set a value apart, are left out here
describe('the right to left catalogues', () => {
  afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))
  const message = (english: string) => ({ id: english, defaultMessage: english })
  const FILES = message('{count, plural, one {{count} file} other {{count} files}}')
  const PEERS = message('{count, plural, one {{count} peer} other {{count} peers}}')
  const bare = (text: string) => text.replace(/[\u2068\u2069]/g, '')

  test('write Arabic\'s six forms and Hebrew\'s three', async () => {
    const ar = await startLanguage({ language: 'ar', languages: ['ar-MA'] })
    expect([0, 1, 2, 3, 11, 100].map(count => bare(ar.formatMessage(FILES, { count })))).toEqual(['0 ملف', 'ملف واحد', 'ملفان', '3 ملفات', '11 ملفًا', '100 ملف'])
    expect([1, 2, 5, 11].map(count => bare(ar.formatMessage(PEERS, { count })))).toEqual(['قرين واحد', 'قرينان', '5 قرناء', '11 قرينًا'])
    const he = await startLanguage({ language: 'he', languages: ['he-IL'] })
    expect([1, 2, 3, 20].map(count => bare(he.formatMessage(FILES, { count })))).toEqual(['קובץ אחד', 'שני קבצים', '3 קבצים', '20 קבצים'])
  })
})

// stub's rules for the second wave: Romanian puts de before a noun from 20, Hungarian keeps it singular after a number
describe('the second wave\'s counts', () => {
  afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))
  const FILES = { id: '{count, plural, one {{count} file} other {{count} files}}', defaultMessage: '{count, plural, one {{count} file} other {{count} files}}' }
  const counted = async (language: string, counts: number[]) => {
    const intl = await startLanguage({ language, languages: [language] })
    return counts.map(count => intl.formatMessage(FILES, { count }))
  }

  test('take each form their language needs', async () => {
    expect(await counted('ro', [1, 2, 19, 20, 101, 120])).toEqual(['1 fișier', '2 fișiere', '19 fișiere', '20 de fișiere', '101 fișiere', '120 de fișiere'])
    expect(await counted('hu', [1, 5])).toEqual(['1 fájl', '5 fájl'])
    expect(await counted('cs', [1, 3, 5])).toEqual(['1 soubor', '3 soubory', '5 souborů'])
    expect(await counted('uk', [1, 3, 5, 21])).toEqual(['1 файл', '3 файли', '5 файлів', '21 файл'])
    expect(await counted('hi', [0, 1, 2])).toEqual(['0 फ़ाइल', '1 फ़ाइल', '2 फ़ाइलें'])
    expect(await counted('th', [1, 2])).toEqual(['1 ไฟล์', '2 ไฟล์'])
  })
})
