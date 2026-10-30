// Ripple's text in the viewer's language, through react-intl, as stub writes its own. Each message is written in the
// code in English, its defaultMessage, with that English as its id (`formatjs/enforce-id` with `[content]`,
// vite.config.ts, writes it), so English loads no catalogue; src/locales/<tag>.json holds each other language's text
// by id, and `npm run i18n:check` keeps the two in step. A description is part of the id (`Play#verb`), which tells
// apart two messages spelled alike. Components format with useIntl().formatMessage.

import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import { createIntl, createIntlCache, RawIntlProvider, type IntlShape } from 'react-intl'

import type { Said } from './said'

import { formatLocale, isRightToLeft, uiLanguage } from './languages'

export { LANGUAGE_KEY, OFFERED, bestLanguage, formatLocale, isRightToLeft, readPickedLanguage, uiLanguage } from './languages'
export type { Said } from './said'

/** A language's text by message id. */
export type Catalogue = Readonly<Record<string, string>>

const cache = createIntlCache()

// the page stays empty while it waits, so a catalogue this late is a catalogue that failed to load
const CATALOGUE_WAIT_MS = 3_000

// English shown, the defaultLocale is the browser's own English: against plain `en`, react-intl reports each message
// of an en-GB page missing and writes its numbers in `en`
const intlOf = (language: string, locale: string, messages: Catalogue) =>
  createIntl({ locale, defaultLocale: language === 'en' ? locale : 'en', messages }, cache)

/**
 * The page's react-intl object, which IntlRoot hands to every component's useIntl(), for text written outside a
 * component. startLanguage() replaces it, so read it where the text is shown, never at module scope.
 */
export let intl: IntlShape = intlOf('en', 'en', {})

const listeners = new Set<() => void>()
const listen = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Gives every component under it the page's intl, and renders them again, in place, when startLanguage() changes it. */
export const IntlRoot = ({ children }: { children?: ReactNode }) =>
  createElement(RawIntlProvider, { value: useSyncExternalStore(listen, () => intl) }, children)

/** `said` in the language shown: one of ripple's messages with its values written in, or words shown as they came. */
export const wordsOf = (said: Said): string => {
  if (typeof said === 'string') return said
  // a descriptor the linter and `formatjs extract` leave alone, held in a variable: each message is read where
  // forPage.formatMessage writes it, and its id is its English
  const descriptor = { id: said.message, defaultMessage: said.message }
  return intl.formatMessage(descriptor, said.values)
}

// one chunk per language, by its path as the pattern writes it. tests/languages.ts finds this call by its text, and
// no type argument, which Vitest 5's on-disk cache reads as no glob and so keeps the files matched before a new one
const CATALOGUES = import.meta.glob('../locales/*.json', { import: 'default' }) as Record<string, () => Promise<Catalogue>>

/**
 * Shows `language` on this page from now on: loads its catalogue, makes `intl` write in it, with dates and numbers in
 * formatLocale(), marks `<html>` with its `lang` and, right to left, its `dir`, and renders IntlRoot's tree again. A
 * catalogue that fails to load, or takes over 3 seconds, leaves the page in English until the next start. Returns the
 * new `intl`.
 */
export const startLanguage = async ({ language = uiLanguage(), languages, catalogues = CATALOGUES, html = globalThis.document?.documentElement }: {
  language?: string
  /** The browser's languages, which formatLocale() reads. */
  languages?: readonly string[]
  /** Each catalogue's loader by its path, `../locales/<tag>.json`. */
  catalogues?: Readonly<Record<string, () => Promise<Catalogue>>>
  html?: HTMLElement
} = {}) => {
  const catalogue = language === 'en' ? {} : await Promise.race([
    catalogues[`../locales/${language}.json`]?.().catch(() => undefined),
    new Promise<undefined>(resolve => setTimeout(resolve, CATALOGUE_WAIT_MS)),
  ])
  const shown = catalogue ? language : 'en'
  intl = intlOf(shown, formatLocale(shown, languages), catalogue ?? {})
  if (html) {
    html.lang = shown
    if (isRightToLeft(shown)) html.dir = 'rtl'
    else html.removeAttribute('dir')
  }
  for (const listener of listeners) listener()
  return intl
}
