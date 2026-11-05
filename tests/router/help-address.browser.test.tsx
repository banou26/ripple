import type { ComponentType } from 'react'

import { expect, it } from 'vitest'
import { render } from 'vitest-browser-react'
import { MemoryRouter } from 'react-router-dom'

import Legal from '../../src/router/legal'
import Privacy from '../../src/router/privacy'

const ADDRESS = 'admin@fkn.app'

it.each([['legal', Legal], ['privacy', Privacy]] as [string, ComponentType][])(`the %s page gives ${ADDRESS} as its only address`, async (_, Page) => {
  const { container } = await render(<MemoryRouter><Page/></MemoryRouter>)
  const mailtos = [...container.querySelectorAll('a[href^="mailto:"]')]
  expect(mailtos.map(link => [link.getAttribute('href'), link.textContent])).toEqual([[`mailto:${ADDRESS}`, ADDRESS]])
  expect(container.innerHTML.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g)).toEqual([ADDRESS, ADDRESS])
})
