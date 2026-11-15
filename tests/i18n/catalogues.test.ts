import { describe, expect, test } from 'vitest'

import { catalogues, english } from '../languages'

const PLACEHOLDER = 'Add a magnet link, or search'

// stub's own words for labels the two apps share, so they read alike
const STUB_WORDS: Record<string, Record<string, string>> = {
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
