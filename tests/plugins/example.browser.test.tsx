// The example plugin (examples/group-by-tracker) end to end: added by its address, answered for, and pressed in the
// library's header, a torrent's menu and Settings, connected through a stand-in for fkn.app's packages API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { createPlugin } from '../../examples/group-by-tracker/src/plugin'
import { IntlRoot } from '../../src/i18n'
import { entry, snapshot } from './engine-double'
import { fkn } from './packages-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const engine = vi.hoisted(() => ({ double: undefined as unknown as import('./engine-double').EngineDouble }))

vi.mock('@fkn/lib/packages', () => import('./packages-double'))
// the test page is itself framed by vitest
vi.mock('../../src/utils/framed', () => ({ isFramed: () => false }))
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
vi.mock('../../src/torrent/use-thumbnails', () => ({ useThumbnail: () => null, useThumbnailGeneration: () => {} }))

const { default: Home } = await import('../../src/router/home')
const { addByAddress, removePlugin } = await import('../../src/plugins/host')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { PluginsSection } = await import('../../src/plugins/plugins-section')
const { currentGroups, deleteGroup, subscribeGroups, torrentsIn } = await import('../../src/torrent/groups')

const EXAMPLE = 'npm:ripple-plugin-group-by-tracker'
const NAME = 'Group by tracker (example)'
// a private tracker's key, in its announce url's path, and a tracker with a port
const PASSKEY = 'abc123'
const SINTEL = 'b'.repeat(40)
const SPRING = 'c'.repeat(40)
const STEEL = 'd'.repeat(40)
const COSMOS = 'e'.repeat(40)
const magnet = (hash: string, name: string, tracker?: string) =>
  `magnet:?xt=urn:btih:${hash}&dn=${name}${tracker ? `&tr=${encodeURIComponent(tracker)}` : ''}`
const torrent = (hash: string, name: string, tracker?: string) => entry(hash, { name, magnet: magnet(hash, name, tracker) })
const LIBRARY = [
  torrent(SINTEL, 'Sintel', `https://t.example/${PASSKEY}/announce`),
  torrent(SPRING, 'Spring', 'udp://tracker.example:6969/announce'),
  torrent(STEEL, 'Tears.of.Steel'),
]

const groups = () => (currentGroups() ?? []).map((g) => [g.name, [...torrentsIn(g)].sort()])
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('.torrent')].find((card) => card.textContent?.includes(name))!
const options = (name: string) => document.querySelector<HTMLElement>(`button[aria-label="Options for ${name}"]`)!

beforeEach(() => {
  fkn.reset()
  memory.store.clear()
  engine.double.running = true
  engine.double.start(LIBRARY, LIBRARY.map((t, i) => ({ handle: i + 1, magnet: t.magnet })))
  fkn.plugins.set(EXAMPLE, { name: NAME, version: '0.0.0', payload: (ripple) => createPlugin(ripple) })
  subscribeGroups(() => {})()
})
afterEach(async () => {
  await removePlugin(EXAMPLE)
  for (const group of currentGroups() ?? []) await deleteGroup(group.id)
  await vi.waitFor(() => expect(currentGroups()).toEqual([]))
})

const added = async () => {
  await render(<IntlRoot><MemoryRouter><Home/><PluginsSection/><PluginHost/></MemoryRouter></IntlRoot>)
  await vi.waitFor(() => expect(row('Sintel')).toBeTruthy())
  expect(await addByAddress(EXAMPLE)).toBe(true)
  await vi.waitFor(() => expect(sheet()?.querySelectorAll('input[type=checkbox]')).toHaveLength(2))
  for (const box of sheet()!.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) await userEvent.click(box)
  await userEvent.click(button(sheet()!, 'Done')!)
  await vi.waitFor(() => expect(sheet()).toBeNull())
}

describe('the example plugin', () => {
  it('groups every torrent by its tracker from the header, before Create, and never sees a tracker\'s key', async () => {
    await added()
    const pressed = () => document.querySelector<HTMLButtonElement>('header .tool.plugin')
    await vi.waitFor(() => expect(pressed()).toHaveAccessibleName('Group by tracker'))
    expect(pressed()!.nextElementSibling).toHaveClass('create')
    expect(getComputedStyle(pressed()!.querySelector('.plugin-icon')!).maskImage).toContain('data:image/svg+xml')
    await userEvent.click(pressed()!)
    await vi.waitFor(() => expect(groups()).toEqual([['t.example', [SINTEL]], ['tracker.example', [SPRING]]]))
    expect(JSON.stringify(currentGroups()), 'the key in Sintel\'s tracker reached no group').not.toContain(PASSKEY)
  })

  it('puts one torrent in its tracker\'s group from its menu, and lists the same item behind its Options', async () => {
    await added()
    await vi.waitFor(() => expect(memory.store.get('ripple:plugin-buttons')).toBeTruthy())
    row('Spring').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }))
    const item = () => [...document.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent === 'Put in its tracker\'s group') as HTMLElement
    await vi.waitFor(() => expect(item()).toBeTruthy())
    expect(item().closest('[role="group"]')).toHaveAccessibleName(NAME)
    item().click()
    await vi.waitFor(() => expect(groups()).toEqual([['tracker.example', [SPRING]]]))
    options('Tears.of.Steel').click()
    const dialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1)!
    await vi.waitFor(() => expect(button(dialog(), 'Put in its tracker\'s group')).toBeTruthy())
    button(dialog(), 'Put in its tracker\'s group')!.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(groups(), 'a torrent with no tracker has no group to go in').toEqual([['tracker.example', [SPRING]]])
  })

  it('groups each torrent added once its Settings button says so, and says it on that button', async () => {
    await added()
    const settings = () => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(NAME))?.querySelector<HTMLButtonElement>('button.plugin')
    await vi.waitFor(() => expect(settings()).toHaveAccessibleName('Group new torrents'))
    await userEvent.click(settings()!)
    await vi.waitFor(() => expect(settings()).toHaveAccessibleName('Stop grouping new torrents'), { timeout: 3_000 })
    const grown = [...LIBRARY, torrent(COSMOS, 'Cosmos.Laundromat', `https://t.example/${PASSKEY}/announce`)]
    engine.double.say({ type: 'list', list: grown })
    engine.double.say({ type: 'state', torrents: grown.map((t, i) => snapshot({ handle: i + 1, magnet: t.magnet })) })
    await vi.waitFor(() => expect(groups()).toEqual([['t.example', [COSMOS]]]), { timeout: 5_000 })
  })
})
