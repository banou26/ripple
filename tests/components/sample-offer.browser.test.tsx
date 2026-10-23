import { render } from 'vitest-browser-react'
import { expect, test, vi } from 'vitest'

import { SampleOffer } from '../../src/components/sample-offer'

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
