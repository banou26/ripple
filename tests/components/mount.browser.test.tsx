import { afterEach, expect, test, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import de from '../../src/locales/de.json'
import { showEnglish, showIn } from '../i18n/show-in'

vi.mock('../../src/router', () => ({ default: () => null }))
vi.mock('../../src/torrent/engine-protocol', () => ({ hasWebLocks: () => false }))
vi.mock('../../src/torrent/client', () => ({ destroyTorrentClient: () => {} }))
vi.mock('../../src/utils/active-window-effect', () => ({ useActiveWindow: () => ({ claim: 'inactive', activate: () => {} }) }))
vi.mock('../../src/utils/use-ripple-update', () => ({ useRippleUpdate: () => true }))

const { default: Mount } = await import('../../src/components/mount')
const { IntlRoot } = await import('../../src/i18n')

afterEach(showEnglish)

test('a tab another took over, and an update on its way, read in the language of the page', async () => {
  await showIn('de', de)
  const { container } = await render(<IntlRoot><Mount/></IntlRoot>)
  expect(container.textContent).toContain('Ripple ist in einem anderen Tab geöffnet.')
  expect(container.querySelector('button')?.textContent).toBe('Stattdessen hier verwenden')
  expect(document.querySelector('[role=status]')?.textContent).toBe('Ripple wird aktualisiert')
})
