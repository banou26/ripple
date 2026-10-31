import type { ReactNode } from 'react'

import { render as mount } from 'vitest-browser-react'
import { afterEach, expect, test, vi } from 'vitest'

import { SampleOffer } from '../../src/components/sample-offer'
import { IntlRoot } from '../../src/i18n'
import fr from '../../src/locales/fr.json'
import { showEnglish, showIn } from '../i18n/show-in'

const render = (ui: ReactNode) => mount(<IntlRoot>{ui}</IntlRoot>)

afterEach(showEnglish)

const buttons = (c: HTMLElement) => [...c.querySelectorAll('button')]
const named = (c: HTMLElement, name: string) => buttons(c).find((b) => b.textContent === name)!

test('offers the sample in one line and two actions, and is not a torrent row', async () => {
  const { container } = await render(<SampleOffer onAnswer={() => {}}/>)
  expect(container.textContent).toContain('Try Ripple with Sintel, a free open movie (129 MB)')
  expect(buttons(container).map((b) => b.textContent)).toEqual(['Add Sintel', 'No thanks'])
  // the end-to-end specs count and click rows by this class
  expect(container.querySelector('.torrent')).toBeNull()
})

test('Add Sintel answers yes and No thanks answers no', async () => {
  const yes = vi.fn()
  const first = await render(<SampleOffer onAnswer={yes}/>)
  named(first.container, 'Add Sintel').click()
  expect(yes).toHaveBeenCalledWith(true)

  const no = vi.fn()
  const second = await render(<SampleOffer onAnswer={no}/>)
  named(second.container, 'No thanks').click()
  expect(no).toHaveBeenCalledWith(false)
})

test('reads in the language of the page, the film\'s size written there too', async () => {
  await showIn('fr', fr)
  const { container } = await render(<SampleOffer onAnswer={() => {}}/>)
  expect(container.querySelector('strong')?.textContent).toMatch(/^Essayez Ripple avec Sintel, un film libre et gratuit \(129\sMo\)$/u)
  expect(buttons(container).map((b) => b.textContent)).toEqual(['Ajouter Sintel', 'Non merci'])
})

test('answers once however fast it is pressed', async () => {
  const onAnswer = vi.fn()
  const { container } = await render(<SampleOffer onAnswer={onAnswer}/>)
  // every click lands in one tick, before React can re-render, so only the ref can stop the second
  named(container, 'Add Sintel').click()
  named(container, 'Add Sintel').click()
  named(container, 'No thanks').click()
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith(true)
})
