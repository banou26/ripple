import type { Catalogue } from '../../src/i18n'

import { startLanguage } from '../../src/i18n'

/** Shows the page in `language` from `catalogue`, the browser set to `region`. */
export const showIn = (language: string, catalogue: Catalogue, region = language) =>
  startLanguage({ language, languages: [region], catalogues: { [`../locales/${language}.json`]: async () => catalogue } })

export const showEnglish = () => startLanguage({ language: 'en', languages: ['en-US'] })
