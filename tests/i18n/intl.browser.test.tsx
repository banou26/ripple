import { afterEach, describe, expect, test } from 'vitest'
import { render } from 'vitest-browser-react'
import { useState } from 'react'
import { useIntl } from 'react-intl'

import { IntlRoot, intl, startLanguage, type Catalogue } from '../../src/i18n'

// plain descriptors, which the linter does not read
const message = (english: string) => ({ id: english, defaultMessage: english })

const start = (language: string, catalogue: Catalogue) =>
  startLanguage({ language, languages: [language], catalogues: { [`../locales/${language}.json`]: async () => catalogue } })

afterEach(() => startLanguage({ language: 'en', languages: ['en-US'] }))

describe('elements', () => {
  test('a value may be an element, and the text comes back as children a tree renders', async () => {
    const credit = intl.formatMessage(message('Streamed from {site}'), { site: <a href="https://torrent.fkn.app">Ripple</a> })
    const { container } = await render(<IntlRoot><p>{credit}</p></IntlRoot>)
    expect(container.innerHTML).toBe('<p>Streamed from <a href="https://torrent.fkn.app">Ripple</a></p>')
  })

  test('a tag takes a handler, which wraps its translated text', async () => {
    const fr = await start('fr', { 'Open it in <link>Ripple</link>': 'L’ouvrir dans <link>Ripple</link>' })
    const open = fr.formatMessage(message('Open it in <link>Ripple</link>'), { link: chunks => <a href="/">{chunks}</a> })
    const { container } = await render(<IntlRoot><p>{open}</p></IntlRoot>)
    expect(container.innerHTML).toBe('<p>L’ouvrir dans <a href="/">Ripple</a></p>')
  })
})

describe('switching in place', () => {
  // its count is state a remount would lose
  const Counter = () => {
    const { formatMessage } = useIntl()
    const [count, setCount] = useState(0)
    return <button onClick={() => setCount(count + 1)}>{formatMessage(message('{count, plural, one {# peer} other {# peers}}'), { count })}</button>
  }

  test('a language started later renders the tree again in it, keeping each component\'s state', async () => {
    const screen = await render(<IntlRoot><Counter/></IntlRoot>)
    const button = screen.getByRole('button')
    await button.click()
    await expect.element(button).toHaveTextContent('1 peer')
    await start('de', { '{count, plural, one {# peer} other {# peers}}': '{count, plural, one {# Peer} other {# Peers}}' })
    await expect.element(button).toHaveTextContent('1 Peer')
    await button.click()
    await expect.element(button).toHaveTextContent('2 Peers')
    await startLanguage({ language: 'en', languages: ['en-US'] })
    await expect.element(button).toHaveTextContent('2 peers')
  })
})
