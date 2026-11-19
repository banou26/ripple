// Ripple's text in the viewer's language, through react-intl, as stub writes its own. Each message is written in the
// code in English, its defaultMessage, with that English as its id (`formatjs/enforce-id` with `[content]`,
// vite.config.ts, writes it), so English loads no catalogue; src/locales/<tag>.json holds each other language's text
// by id, and `npm run i18n:check` keeps the two in step. A description is part of the id (`Play#verb`), which tells
// apart two messages spelled alike. Components format with useIntl().formatMessage.

import { parse, TYPE, type LiteralElement, type MessageFormatElement } from '@formatjs/icu-messageformat-parser'
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import { createIntl, createIntlCache, RawIntlProvider, type IntlShape } from 'react-intl'

import type { Said } from './said'

import { formatLocale, isRightToLeft, keepPickedLanguage, setUnitLocale, uiLanguage } from './languages'

export { LANGUAGE_KEY, OFFERED, automaticLanguage, bestLanguage, formatLocale, isRightToLeft, readPickedLanguage, uiLanguage } from './languages'
export type { Said } from './said'

/** A language's text by message id. */
export type Catalogue = Readonly<Record<string, string>>

const cache = createIntlCache()

// the page stays empty while it waits, so a catalogue this late is a catalogue that failed to load
const CATALOGUE_WAIT_MS = 3_000

// a colon written against a value, as in `:{port}`, is the value's: left outside, a right to left line draws it after
// the digits
const glued = (element: MessageFormatElement | undefined, next: MessageFormatElement | undefined): element is LiteralElement =>
  element?.type === TYPE.literal && element.value.endsWith(':') && next?.type === TYPE.argument

// U+2068 and U+2069 around each plain value, as <bdi> would: in a right to left sentence a Latin name otherwise takes the
// punctuation beside it into its own order, and a size or a count opening on a digit joins the Latin word before it.
// On the parsed message, the one place a value is told from a branch's text. Stub's own, as its catalogues are
const isolated = (elements: MessageFormatElement[]): MessageFormatElement[] => elements.flatMap((element, i): MessageFormatElement[] =>
  element.type === TYPE.argument
    ? [{ type: TYPE.literal, value: glued(elements[i - 1], element) ? '\u2068:' : '\u2068' }, element, { type: TYPE.literal, value: '\u2069' }]
  : glued(element, elements[i + 1]) ? [{ ...element, value: element.value.slice(0, -1) }]
  : element.type === TYPE.tag ? [{ ...element, children: isolated(element.children) }]
  : element.type === TYPE.select || element.type === TYPE.plural
    ? [{ ...element, options: Object.fromEntries(Object.entries(element.options).map(([key, option]) => [key, { ...option, value: isolated(option.value) }])) }]
  : [element])

// a message that does not parse stays text, which formatjs answers with its English, as in any other language
const isolatedText = (text: string) => {
  try { return isolated(parse(text)) } catch { return text }
}

// English shown, the defaultLocale is the browser's own English: against plain `en`, react-intl reports each message
// of an en-GB page missing and writes its numbers in `en`
const intlOf = (language: string, locale: string, messages: Record<string, string | MessageFormatElement[]>) =>
  createIntl({ locale, defaultLocale: language === 'en' ? locale : 'en', messages: messages as Record<string, string> }, cache)

/**
 * The page's react-intl object, which IntlRoot hands to every component's useIntl(), for text written outside a
 * component. startLanguage() replaces it, so read it where the text is shown, never at module scope.
 */
export let intl: IntlShape = intlOf('en', 'en', {})

let shown = 'en'
let starts = 0

/** The language `intl` writes in: English until startLanguage() loads another, or when its catalogue failed to load. */
export const shownLanguage = () => shown

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
 * catalogue that fails to load, or takes over 3 seconds, leaves the page in English until the next start, and a start
 * a later one overtook changes nothing. Returns the new `intl`.
 */
export const startLanguage = async ({ language = uiLanguage(), languages, catalogues = CATALOGUES, html = globalThis.document?.documentElement }: {
  language?: string
  /** The browser's languages, which formatLocale() reads. */
  languages?: readonly string[]
  /** Each catalogue's loader by its path, `../locales/<tag>.json`. */
  catalogues?: Readonly<Record<string, () => Promise<Catalogue>>>
  html?: HTMLElement
} = {}) => {
  const start = ++starts
  const catalogue = language === 'en' ? {} : await Promise.race([
    catalogues[`../locales/${language}.json`]?.().catch(() => undefined),
    new Promise<undefined>(resolve => setTimeout(resolve, CATALOGUE_WAIT_MS)),
  ])
  if (start !== starts) return intl
  shown = catalogue ? language : 'en'
  const messages = catalogue && isRightToLeft(shown)
    ? Object.fromEntries(Object.entries(catalogue).map(([id, text]) => [id, isolatedText(text)]))
    : catalogue ?? {}
  intl = intlOf(shown, formatLocale(shown, languages), messages)
  setUnitLocale(intl.locale)
  if (html) {
    html.lang = shown
    if (isRightToLeft(shown)) html.dir = 'rtl'
    else html.removeAttribute('dir')
  }
  for (const listener of listeners) listener()
  return intl
}

/**
 * Keeps `language` picked on this device, or Automatic with undefined, and shows the page in uiLanguage()'s answer at
 * once, in place: no reload, so the engine and its peers carry on. Other tabs take it on their next load.
 */
export const pickLanguage = (language: string | undefined) => {
  keepPickedLanguage(language)
  return startLanguage()
}
