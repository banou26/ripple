import { userEvent } from '@vitest/browser/context'
import { useState } from 'react'
import { useIntl } from 'react-intl'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { LanguageSelect } from '../../src/components/language-select'
import { IntlRoot, LANGUAGE_KEY, startLanguage } from '../../src/i18n'
import { showEnglish } from '../i18n/show-in'

// RIPPLE-49 (ripple in the viewer's language): the footer's Language select, Automatic until one is picked, a pick
// shown at once with no reload

// its count is state a remount, or a reload, would lose
const Footer = () => {
  const { formatMessage } = useIntl()
  const [count, setCount] = useState(0)
  return (
    <>
      <button onClick={() => setCount(count + 1)}>{formatMessage({ id: '{count, plural, one {Saved {count} file} other {Saved {count} files}}', defaultMessage: '{count, plural, one {Saved {count} file} other {Saved {count} files}}' }, { count })}</button>
      <label><span>{formatMessage({ id: 'Language', defaultMessage: 'Language' })}</span><LanguageSelect/></label>
    </>
  )
}

// browser test files share one origin's storage and run side by side, so this file keeps its own
const stored = new Map<string, string>()
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value) },
  removeItem: (key: string) => { stored.delete(key) },
}
beforeEach(() => {
  stored.clear()
  vi.stubGlobal('localStorage', storage)
})

const mount = async () => {
  const screen = await render(<IntlRoot><Footer/></IntlRoot>)
  const select = screen.container.querySelector('select')!
  const options = () => [...select.options].map(option => ({ value: option.value, text: option.textContent, lang: option.getAttribute('lang') }))
  return { screen, select, options }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await showEnglish()
})

describe('the Language select', () => {
  it('names the browser\'s language in Automatic, then every language offered, each in its own name and lang, as stub orders them', async () => {
    const { screen, select, options } = await mount()
    await expect.element(screen.getByRole('combobox', { name: 'Language' })).toBeInTheDocument()
    expect(select.value).toBe('')
    expect(options()).toEqual([
      { value: '', text: 'Automatic (English)', lang: null },
      { value: 'de', text: 'Deutsch', lang: 'de' },
      { value: 'en', text: 'English', lang: 'en' },
      { value: 'es-419', text: 'Español latinoamericano', lang: 'es-419' },
      { value: 'fr', text: 'Français', lang: 'fr' },
      { value: 'it', text: 'Italiano', lang: 'it' },
      { value: 'pl', text: 'Polski', lang: 'pl' },
      { value: 'pt-BR', text: 'Português (Brasil)', lang: 'pt-BR' },
      { value: 'tr', text: 'Türkçe', lang: 'tr' },
      { value: 'ru', text: 'Русский', lang: 'ru' },
      { value: 'ko', text: '한국어', lang: 'ko' },
      { value: 'ja', text: '日本語', lang: 'ja' },
      { value: 'zh-Hans', text: '简体中文', lang: 'zh-Hans' },
      { value: 'zh-Hant', text: '繁體中文', lang: 'zh-Hant' },
    ])
  })

  it('names the language Automatic shows for a browser that asks for another', async () => {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['sv-SE', 'pt-PT', 'en'])
    expect((await mount()).options()[0]!.text).toBe('Automatic (Português (Brasil))')
  })

  it('shows a pick at once, in place, keeps it on this device, and Automatic keeps nothing', async () => {
    const { screen, select, options } = await mount()
    const counter = screen.getByRole('button')
    await counter.click()
    await userEvent.selectOptions(select, 'fr')
    await expect.element(screen.getByText('Langue')).toBeInTheDocument()
    expect(stored.get(LANGUAGE_KEY)).toBe('fr')
    expect(document.documentElement.lang).toBe('fr')
    expect(select.value).toBe('fr')
    expect(options()[0]!.text).toBe('Automatique (English)')
    await expect.element(counter).toHaveTextContent('1 fichier enregistré')

    await userEvent.selectOptions(select, '')
    await expect.element(screen.getByText('Language')).toBeInTheDocument()
    expect(stored.has(LANGUAGE_KEY)).toBe(false)
    expect(document.documentElement.lang).toBe('en')
    await expect.element(counter).toHaveTextContent('Saved 1 file')
  })

  it('shows a pick the browser\'s storage refuses, in the select and the page alike', async () => {
    const refuse = () => { throw new DOMException('blocked', 'SecurityError') }
    vi.stubGlobal('localStorage', { getItem: refuse, setItem: refuse, removeItem: refuse })
    const { screen, select, options } = await mount()
    await userEvent.selectOptions(select, 'fr')
    await expect.element(screen.getByText('Langue')).toBeInTheDocument()
    expect([select.value, document.documentElement.lang, options()[0]!.text]).toEqual(['fr', 'fr', 'Automatique (English)'])

    vi.stubGlobal('localStorage', storage)
    await userEvent.selectOptions(select, '')
    await expect.element(screen.getByText('Language')).toBeInTheDocument()
    expect([select.value, document.documentElement.lang]).toEqual(['', 'en'])
  })

  it('reads the pick kept on this device, and an unknown one as Automatic', async () => {
    stored.set(LANGUAGE_KEY, 'ja')
    const kept = await mount()
    expect(kept.select.value).toBe('ja')
    await kept.screen.unmount()
    stored.set(LANGUAGE_KEY, 'xx')
    expect((await mount()).select.value).toBe('')
  })

  it('reads in the language shown, the languages still in their own names', async () => {
    await startLanguage({ language: 'de', languages: ['de-DE'] })
    const texts = (await mount()).options().map(option => option.text)
    expect(texts.slice(0, 4)).toEqual(['Automatisch (English)', 'Deutsch', 'English', 'Español latinoamericano'])
  })
})
