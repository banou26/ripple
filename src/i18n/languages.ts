// The viewer's language, the one picked (kept on this device) else the browser's, read two ways: the language ripple's
// text is shown in, and how dates and numbers are written. Import free but the offered list, so a worker can read it.

import OFFERED_LANGUAGES from './offered.json'

/** The localStorage key holding the language picked, an offered tag. No value is Automatic. */
export const LANGUAGE_KEY = 'ripple:language'

/** The languages ripple's text is offered in, each but English with a complete catalogue in src/locales. */
export const OFFERED: readonly string[] = OFFERED_LANGUAGES

// a fixed list rather than Intl.Locale's text info, which Firefox lacks
const RIGHT_TO_LEFT = new Set(['ar', 'ckb', 'dv', 'fa', 'he', 'ps', 'sd', 'ug', 'ur', 'yi'])

const browserLanguages = (): readonly string[] => globalThis.navigator?.languages ?? []

const localeOf = (tag: string) => {
  try { return new Intl.Locale(tag) } catch { return undefined }
}

/** Whether `tag`'s language is written right to left. */
export const isRightToLeft = (tag: string) => RIGHT_TO_LEFT.has(localeOf(tag)?.language ?? '')

/**
 * The offered tag serving the first of `wanted` that any serves: matched exactly, else by language and script once
 * maximized (`zh-TW` finds `zh-Hant`, `pt-PT` finds `pt-BR`, `es-MX` finds `es-419`), else by language alone.
 * Undefined when none is served.
 */
export const bestLanguage = (wanted: readonly string[], offered: readonly string[]): string | undefined => {
  const candidates = offered.flatMap(tag => {
    const locale = localeOf(tag)
    if (!locale) return []
    const { language, script } = locale.maximize()
    return [{ tag, exact: locale.baseName, language, script }]
  })
  for (const tag of wanted) {
    const locale = localeOf(tag)
    if (!locale) continue
    const { language, script } = locale.maximize()
    const hit = candidates.find(candidate => candidate.exact === locale.baseName)
      ?? candidates.find(candidate => candidate.language === language && candidate.script === script)
      ?? candidates.find(candidate => candidate.language === language)
    if (hit) return hit.tag
  }
  return undefined
}

/** The language picked, or undefined for Automatic, a language not offered, or no storage. */
export const readPickedLanguage = (): string | undefined => {
  let kept: string | null | undefined
  try { kept = globalThis.localStorage?.getItem(LANGUAGE_KEY) } catch { return undefined }
  return kept && OFFERED.includes(kept) ? kept : undefined
}

let unitTag = 'en-US'

/**
 * The locale sizes, speeds and durations are written in: the page's, any English as US English, as ripple has always
 * written them. Here rather than beside `intl` because the worker imports rate-limits.ts and uptime.ts, which read it,
 * and must not load react-intl.
 */
export const unitLocale = () => unitTag

/** Makes `locale`, the page's `intl.locale`, unitLocale()'s answer. */
export const setUnitLocale = (locale: string) => {
  unitTag = localeOf(locale)?.language === 'en' ? 'en-US' : locale
}

/** The language ripple's text is shown in: the one picked, else the offered one best serving the browser's, else English. */
export const uiLanguage = (languages = browserLanguages(), offered = OFFERED) =>
  readPickedLanguage() ?? bestLanguage(languages, offered) ?? 'en'

/**
 * The locale dates, numbers and lists are written in: the browser's first language in `shown`'s language and
 * script, as it writes it, so an en-GB browser keeps 26/10/2026 and es-MX keeps 1,234.5; else `shown` itself.
 */
export const formatLocale = (shown = uiLanguage(), languages = browserLanguages()) => {
  const { language, script } = localeOf(shown)?.maximize() ?? {}
  return languages.find(tag => {
    const locale = localeOf(tag)?.maximize()
    return !!locale && locale.language === language && locale.script === script
  }) ?? shown
}
