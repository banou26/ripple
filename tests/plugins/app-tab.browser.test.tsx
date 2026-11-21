// Ripple in the frame fkn.app's /app page mounted for it as its tab's own page: its plugins wait for fkn.app to say so
// (`shell.isAppTab`, through a stand-in), then connect and show as on ripple's own site.
import type { Button, ClickContext } from '../../src/plugins/contract'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { MenuItems } from '../../src/components/menu'
import { IntlRoot } from '../../src/i18n'
import { entry } from './engine-double'
import { fkn } from './packages-double'
import { appTab } from './shell-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const engine = vi.hoisted(() => ({ double: undefined as unknown as import('./engine-double').EngineDouble }))

vi.mock('@fkn/lib/packages', () => import('./packages-double'))
vi.mock('@fkn/lib', async (importOriginal) => {
  const [real, double] = await Promise.all([importOriginal<typeof import('@fkn/lib')>(), import('./shell-double')])
  return { ...real, shell: { ...real.shell, isAppTab: double.isAppTab } }
})
vi.mock('../../src/utils/framed', () => ({ isFramed: () => true }))
vi.mock('idb-keyval', async () => {
  const made = (await import('./engine-double')).memoryStore()
  memory.store = made.store
  return made.module
})
vi.mock('../../src/torrent/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/torrent/client')>()
  engine.double = (await import('./engine-double')).engineDouble(real)
  return { ...real, getTorrentClient: () => engine.double.client, runningTorrentClient: () => (engine.double.running ? engine.double.client : null) }
})

const { removePlugin } = await import('../../src/plugins/host')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { HeaderButtons, rowMenuGroups, usePlaced } = await import('../../src/plugins/plugin-buttons')
const { answer, answersOf, keepButtons } = await import('../../src/plugins/switches')
const Settings = (await import('../../src/router/settings')).default

const A = 'a'.repeat(40)
const SORT: Button = { id: 'go', place: 'header', label: 'Sort' }
const GROUP: Button = { id: 'one', place: 'row-menu', label: 'Group' }

let n = 0
/** A plugin of its own for each case, with a header button and a menu item, its clicks kept. */
const plugin = (asks: string[]) => {
  const made = { uri: `npm:@someone/ripple-plugin-${++n}`, name: `Tracker sorter ${n}`, clicks: [] as [string, ClickContext][] }
  fkn.plugins.set(made.uri, {
    name: made.name,
    version: '1.0.0',
    payload: { asks, buttons: () => [SORT, GROUP], click: (id: string, context: ClickContext) => { made.clicks.push([id, context]) } },
  })
  return made
}

const RowMenu = () => <div role="menu"><MenuItems groups={rowMenuGroups(usePlaced('row-menu'), A)} onChose={() => {}}/></div>
const page = () => render(<IntlRoot><MemoryRouter><header><HeaderButtons/></header><RowMenu/><Settings/><PluginHost/></MemoryRouter></IntlRoot>)
const inline = () => [...document.querySelectorAll<HTMLButtonElement>('header .tool.plugin')]
const items = () => [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)

beforeEach(() => {
  fkn.reset()
  memory.store.clear()
  engine.double.running = true
  engine.double.start([entry(A)], [{ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }])
})
afterEach(async () => {
  for (const uri of [...fkn.plugins.keys()]) await removePlugin(uri)
})

const installed = async (made: ReturnType<typeof plugin>) => {
  fkn.installed.push({ uri: made.uri, name: made.name, version: '1.0.0', installedAt: 1 })
  await answer(made.uri, { read: true })
}

// first, while fkn.app has not answered: in a copy that knows no plugin yet, nothing but the start asks it
it('asks fkn.app once as it starts, shows no Plugins until it answers, then adds by address and from its picker', async () => {
  const added = plugin(['read'])
  const picked = plugin(['change'])
  fkn.picks = [picked.uri]
  await page()
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(button(document, 'Open torrents with Ripple'), 'Settings is drawn (control)').toBeTruthy()
  expect(button(document, 'Browse')).toBeUndefined()
  expect(appTab.asked).toBe(1)
  appTab.answer(true)
  await vi.waitFor(() => expect(button(document, 'Browse')).toBeTruthy())
  await userEvent.type(document.querySelector('input[aria-label="Plugin address"]')!, `${added.uri}{Enter}`)
  await vi.waitFor(() => expect(sheet()).toHaveAccessibleName(added.name))
  await vi.waitFor(() => expect(sheet()!.querySelectorAll('input[type=checkbox]')).toHaveLength(1))
  await userEvent.click(button(sheet()!, 'Done')!)
  await vi.waitFor(() => expect(sheet()).toBeNull())
  expect(await answersOf(added.uri)).toEqual({ read: false })
  await userEvent.click(button(document, 'Browse')!)
  await vi.waitFor(() => expect(sheet()).toHaveAccessibleName(picked.name))
  expect(fkn.calls).toContain('pick plugin ripple true')
  await vi.waitFor(() => expect(button(sheet()!, 'Done')).toBeEnabled())
  await userEvent.click(button(sheet()!, 'Done')!)
  await vi.waitFor(() => expect(sheet()).toBeNull())
  expect(appTab.asked).toBe(1)
})

it('draws each plugin\'s buttons, connects one that kept none, and hands a click on', async () => {
  appTab.answer(true)
  engine.double.start([entry(A)], [], false)
  const made = plugin(['read'])
  await installed(made)
  await keepButtons(made.uri, { name: made.name, installedAt: 1, locales: { en: [SORT, GROUP] } })
  const unkept = plugin(['read'])
  await installed(unkept)
  await page()
  await vi.waitFor(() => expect(inline().map((b) => b.getAttribute('aria-label'))).toEqual(['Sort', 'Sort']))
  expect(items()).toEqual(['Group', 'Group'])
  expect(fkn.calls).toContain(`connect ${unkept.uri}`)
  await userEvent.click(inline()[0]!)
  await vi.waitFor(() => expect(made.clicks).toStrictEqual([['go', {}]]))
  expect(appTab.asked).toBe(1)
})

it('connects each plugin answered for in the tab running the engine', async () => {
  appTab.answer(true)
  const made = plugin(['read'])
  await installed(made)
  await page()
  await vi.waitFor(() => expect(fkn.calls).toContain(`connect ${made.uri}`))
  expect(appTab.asked).toBe(1)
})
