import { useMemo, useState } from 'react'
import { useIntl } from 'react-intl'

import { automaticLanguage, OFFERED, pickLanguage, readPickedLanguage } from '../i18n'

/**
 * `tag`'s name in `locale`, its own by default, as a menu row writes it: CLDR names a language as written mid-sentence
 * (`français`), and a menu starts it with a capital, as CLDR's uiListOrMenu context does for these languages.
 */
export const languageName = (tag: string, locale = tag) => {
  const name = new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
}

/**
 * The language ripple's text is shown in, as stub's Settings offers it: Automatic, naming the language the browser's
 * give, then each offered one in its own name. A pick shows at once, in place.
 */
export const LanguageSelect = () => {
  const intl = useIntl()
  const [picked, setPicked] = useState(() => readPickedLanguage() ?? '')
  const byName = useMemo(() => {
    const collator = new Intl.Collator(intl.locale)
    return OFFERED.map(tag => ({ tag, name: languageName(tag) })).sort((a, b) => collator.compare(a.name, b.name))
  }, [intl])
  return (
    <select
      value={picked}
      onChange={(event) => {
        setPicked(event.currentTarget.value)
        void pickLanguage(event.currentTarget.value || undefined)
      }}
    >
      <option value="">{intl.formatMessage({ id: 'Automatic ({language})', defaultMessage: 'Automatic ({language})' }, { language: languageName(automaticLanguage()) })}</option>
      {byName.map(({ tag, name }) => <option key={tag} value={tag} lang={tag}>{name}</option>)}
    </select>
  )
}
