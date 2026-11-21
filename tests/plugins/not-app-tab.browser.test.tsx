// Ripple in a frame fkn.app does not vouch for: another site's frame, or fkn.app's tab on a version that predates
// `shell.isAppTab`, or one that does not answer by the lib's 8 s deadline. The lib answers false for each (through a
// stand-in here), and its plugins stay off before that answer and after it.
import type { Button, ClickContext } from '../../src/plugins/contract'

import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
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

const { addByAddress, browsePlugins, clickButton, connectAnswered, connectInstalled, connectPlugin, pluginsHere, removePlugin } =
  await import('../../src/plugins/host')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { HeaderButtons, rowMenuGroups, usePlaced } = await import('../../src/plugins/plugin-buttons')
const { answer, keepButtons } = await import('../../src/plugins/switches')
const Settings = (await import('../../src/router/settings')).default

const A = 'a'.repeat(40)
const SORT: Button = { id: 'go', place: 'header', label: 'Sort' }
const GROUP: Button = { id: 'one', place: 'row-menu', label: 'Group' }
const URI = 'npm:@someone/ripple-plugin-1'
const NAME = 'Tracker sorter'
// answered for and none of its buttons kept, so a page would connect it to ask for them
const UNKEPT = 'npm:@someone/ripple-plugin-2'

const RowMenu = () => <div role="menu"><MenuItems groups={rowMenuGroups(usePlaced('row-menu'), A)} onChose={() => {}}/></div>
const inline = () => [...document.querySelectorAll<HTMLButtonElement>('header .tool.plugin')]
const items = () => [...document.querySelectorAll('[role="menuitem"]')]
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent === text)
const wait = () => new Promise((resolve) => setTimeout(resolve, 200))

afterEach(async () => {
  await removePlugin(URI)
  await removePlugin(UNKEPT)
})

it('lists, draws, connects and adds nothing while fkn.app has not answered, nor once it answers no', async () => {
  const clicks: [string, ClickContext][] = []
  fkn.plugins.set(URI, { name: NAME, version: '1.0.0', payload: { asks: ['read'], buttons: () => [SORT, GROUP], click: (id: string, context: ClickContext) => { clicks.push([id, context]) } } })
  fkn.plugins.set(UNKEPT, { name: 'Feed', version: '1.0.0', payload: { asks: ['read'], buttons: () => [SORT] } })
  fkn.installed.push({ uri: URI, name: NAME, version: '1.0.0', installedAt: 1 }, { uri: UNKEPT, name: 'Feed', version: '1.0.0', installedAt: 2 })
  fkn.picks = [URI]
  engine.double.start([entry(A)], [{ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }])
  await answer(URI, { read: true })
  await answer(UNKEPT, { read: true })
  await keepButtons(URI, { name: NAME, installedAt: 1, locales: { en: [SORT, GROUP] } })
  await render(<IntlRoot><MemoryRouter><header><HeaderButtons/></header><RowMenu/><Settings/><PluginHost/></MemoryRouter></IntlRoot>)
  const nothing = async () => {
    await wait()
    expect(button('Open torrents with Ripple'), 'Settings is drawn (control)').toBeTruthy()
    expect(button('Browse')).toBeUndefined()
    expect(inline()).toHaveLength(0)
    expect(items()).toHaveLength(0)
    expect(fkn.calls).toEqual([])
  }
  await nothing()
  appTab.answer(false)
  expect(await pluginsHere()).toBe(false)
  await nothing()
  expect(await addByAddress(URI)).toBe(false)
  await browsePlugins()
  await clickButton(URI, NAME, SORT.id, {})
  await connectPlugin(URI)
  await connectInstalled()
  await connectAnswered()
  await wait()
  expect(fkn.calls).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.body).not.toHaveTextContent('is not responding')
  expect(clicks).toEqual([])
  expect(appTab.asked).toBe(1)
})
