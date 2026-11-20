// The buttons plugins put in ripple's header, a torrent's menu and Settings, as ripple draws them from what it keeps
// for each plugin and language, and the clicks it hands each plugin, through a stand-in for fkn.app's packages API.
import type { Button, ClickContext } from '../../src/plugins/contract'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { MenuItems } from '../../src/components/menu'
import { IntlRoot } from '../../src/i18n'
import he from '../../src/locales/he.json'
import { showEnglish, showIn } from '../i18n/show-in'
import { entry } from './engine-double'
import { fkn } from './packages-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const engine = vi.hoisted(() => ({ double: undefined as unknown as import('./engine-double').EngineDouble }))
const frame = vi.hoisted(() => ({ framed: false }))

vi.mock('@fkn/lib/packages', () => import('./packages-double'))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => frame.framed }))
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

const { BUTTONS_CHANGED_MS, CLICK_MS } = await import('../../src/plugins/buttons')
const { removePlugin } = await import('../../src/plugins/host')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { HeaderButtons, rowMenuGroups, usePlaced } = await import('../../src/plugins/plugin-buttons')
const { PluginsSection } = await import('../../src/plugins/plugins-section')
const { answer, answersOf, BUTTONS_KEY, keepButtons } = await import('../../src/plugins/switches')

const A = 'a'.repeat(40)
// the real one, for a round trip over a MessageChannel while the page's timers are fake
const realTimeout = setTimeout
const realWait = (ms: number) => new Promise((resolve) => realTimeout(resolve, ms))
const ICON = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M4 12h12%27/%3E%3C/svg%3E'

type Fake = {
  uri: string
  name: string
  /** Each language `buttons` was asked in, in order. */
  asked: string[]
  /** Each click handed on, by id and context. */
  clicks: [string, ClickContext][]
}

let n = 0
/** A plugin of its own for each case, installed in this order and answered for unless `answers` is null. */
const plugin = async ({ asks = [] as string[], buttons, click, answers = {}, hangs = false }: {
  asks?: string[]
  /** None: the plugin's payload has no `buttons` at all. */
  buttons: ((locale: string) => Button[]) | null
  click?: () => Promise<void>
  answers?: Record<string, boolean> | null
  hangs?: boolean
}): Promise<Fake> => {
  const made: Fake = { uri: `npm:@someone/ripple-plugin-${++n}`, name: `Tracker sorter ${n}`, asked: [], clicks: [] }
  fkn.plugins.set(made.uri, {
    name: made.name,
    version: '1.0.0',
    hangs,
    payload: {
      asks,
      ...(buttons && { buttons: (locale: string) => { made.asked.push(locale); return buttons(locale) } }),
      click: (id: string, context: ClickContext) => { made.clicks.push([id, context]); return click?.() },
    },
  })
  fkn.installed.push({ uri: made.uri, name: made.name, version: '1.0.0', installedAt: n })
  if (answers) await answer(made.uri, answers)
  return made
}
const header = (id: string, label: string, over: Partial<Button> = {}): Button => ({ id, place: 'header', label, ...over })

const withHost = (children: React.ReactNode) => render(<IntlRoot><MemoryRouter>{children}<PluginHost/></MemoryRouter></IntlRoot>)
const inline = () => [...document.querySelectorAll<HTMLButtonElement>('header .tool.plugin')]
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)
const kept = () => memory.store.get(BUTTONS_KEY) as Record<string, { locales: Record<string, Button[]> }> | undefined

const RowMenu = ({ infoHash }: { infoHash: string }) => <MenuItems groups={rowMenuGroups(usePlaced('row-menu'), infoHash)} onChose={() => {}}/>

beforeEach(() => {
  fkn.reset()
  memory.store.clear()
  frame.framed = false
  engine.double.running = true
  engine.double.start([entry(A)], [{ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }])
})
afterEach(async () => {
  vi.useRealTimers()
  for (const uri of [...fkn.plugins.keys()]) await removePlugin(uri)
  await showEnglish()
})

describe('the header', () => {
  it('draws the first two plugins\' button in install order, one each, and the rest in More, each click with nothing', async () => {
    const made = [] as Fake[]
    for (const at of [1, 2, 3]) made.push(await plugin({ buttons: () => [header('go', `Sort ${at}`), header('second', `Again ${at}`)] }))
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline().map((b) => b.getAttribute('aria-label'))).toEqual(['Sort 1', 'Sort 2']))
    const more = document.querySelector<HTMLButtonElement>('header .tool.plugin-more')!
    expect(more).toHaveAccessibleName('More')
    await userEvent.click(inline()[0]!)
    await vi.waitFor(() => expect(made[0]!.clicks).toStrictEqual([['go', {}]]))
    await userEvent.click(more)
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect([...menu.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual([made[2]!.name])
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent)).toEqual(['Sort 3'])
    await userEvent.click(menu.querySelector('[role="menuitem"]')!)
    await vi.waitFor(() => expect(made[2]!.clicks).toStrictEqual([['go', {}]]))
    expect(made[1]!.clicks).toStrictEqual([])
  })

  it('shows no More with two plugins, and no button for a plugin that has none, which keeps none', async () => {
    await plugin({ buttons: () => [header('go', 'Sort')] })
    const none = await plugin({ buttons: null })
    await plugin({ buttons: () => [header('go', 'Group')] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline().map((b) => b.getAttribute('aria-label'))).toEqual(['Sort', 'Group']))
    expect(document.querySelector('header .plugin-more')).toBeNull()
    // so no other tab connects it to ask
    await vi.waitFor(() => expect(kept()?.[none.uri]?.locales).toEqual({ en: [] }))
  })

  it('draws the icon as a mask in the text colour, mirrored right to left when asked, and the first letter without one', async () => {
    await plugin({ buttons: () => [header('go', 'Next', { icon: ICON, mirror: true })] })
    await plugin({ buttons: () => [header('go', 'group', { icon: 'https://tracker.example/icon.svg' })] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline()).toHaveLength(2))
    const icon = inline()[0]!.querySelector<HTMLElement>('.plugin-icon')!
    expect(getComputedStyle(icon).maskImage).toContain('data:image/svg+xml')
    expect(getComputedStyle(icon).backgroundColor).toBe(getComputedStyle(inline()[0]!).color)
    expect(getComputedStyle(icon).scale).toBe('none')
    expect(inline()[1]!.querySelector('.plugin-icon')).toBeNull()
    expect(inline()[1]!.querySelector('.plugin-letter')).toHaveTextContent('G')
    document.documentElement.dir = 'rtl'
    try {
      expect(getComputedStyle(icon).scale).toBe('-1 1')
    } finally {
      document.documentElement.dir = 'ltr'
    }
  })
})

describe('the header\'s room', () => {
  // a header laid out as the library's, 600 px wide, its plugins' buttons 38 px each and out of its row once wrapped
  const room = () => document.querySelector('header')!
  const own = () => room().firstElementChild as HTMLElement
  let tools: HTMLStyleElement
  beforeEach(() => {
    tools = document.createElement('style')
    tools.textContent = 'header .tool { flex: none; width: 38px; height: 38px; padding: 0 } header .word { display: inline-block; width: 200px }'
      + ' header[data-plugins-wrapped] > .plugins { position: absolute }'
    document.head.append(tools)
  })
  afterEach(() => { tools.remove() })
  const crowded = (item: React.ReactNode, width = 600) => withHost(
    <header style={{ display: 'flex', alignItems: 'center', gap: 12, width, padding: '0 18px', boxSizing: 'border-box', position: 'relative' }}>
      {item}
      <HeaderButtons/>
    </header>,
  )

  it('gives the plugins a row of their own while they would reach past it, and none once they fit', async () => {
    for (const at of [1, 2]) await plugin({ buttons: () => [header('go', `Sort ${at}`)] })
    await crowded(<span style={{ flex: 'none', width: 500, height: 38 }}/>)
    await vi.waitFor(() => expect(inline()).toHaveLength(2))
    await vi.waitFor(() => expect(room()).toHaveAttribute('data-plugins-wrapped'))
    own().style.width = '400px'
    await vi.waitFor(() => expect(room(), 'the control: room enough').not.toHaveAttribute('data-plugins-wrapped'))
    room().setAttribute('data-searching', '')
    own().style.width = '500px'
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(room(), 'left as it was while a search unfolds the field').not.toHaveAttribute('data-plugins-wrapped')
    room().removeAttribute('data-searching')
    own().style.width = '510px'
    await vi.waitFor(() => expect(room()).toHaveAttribute('data-plugins-wrapped'))
  })

  it('gives them a row of their own when, squeezed beside them, an item would wrap and the bar grow', async () => {
    await plugin({ buttons: () => [header('go', 'Sort')] })
    // two words of 200 px: on one line in the 424 px a 460 px bar holds, on two beside a 38 px button and a 12 px gap
    await crowded(<span style={{ flex: '0 1 auto', minWidth: 0, width: 520 }}><span className="word">Alexandra</span> <span className="word">Lindqvist</span></span>, 460)
    await vi.waitFor(() => expect(inline()).toHaveLength(1))
    await vi.waitFor(() => expect(room()).toHaveAttribute('data-plugins-wrapped'))
    room().style.width = '600px'
    await vi.waitFor(() => expect(room(), 'the control: room for both words beside it').not.toHaveAttribute('data-plugins-wrapped'))
  })
})

describe('a torrent\'s menu', () => {
  it('lists three of each plugin\'s items under its name, and hands a click that torrent\'s info hash alone', async () => {
    const made = await plugin({
      buttons: () => ['1', '2', '3', '4'].map((id) => ({ id, place: 'row-menu' as const, label: `Item ${id}` })),
    })
    await withHost(<div role="menu"><RowMenu infoHash={A.toUpperCase()}/></div>)
    await vi.waitFor(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3))
    const group = document.querySelector('[role="group"]')!
    expect(group).toHaveAccessibleName(made.name)
    expect(group.querySelector('label')).toHaveAttribute('dir', 'auto')
    expect([...group.querySelectorAll('[role="menuitem"] .text')].map((t) => [t.textContent, t.getAttribute('dir')]))
      .toEqual([['Item 1', 'auto'], ['Item 2', 'auto'], ['Item 3', 'auto']])
    await userEvent.click(document.querySelectorAll('[role="menuitem"]')[1]!)
    await vi.waitFor(() => expect(made.clicks).toStrictEqual([['2', { infoHashes: [A] }]]))
  })
})

describe('Settings', () => {
  it('draws a plugin\'s button on its row, clicked with nothing, and Remove takes its buttons away', async () => {
    const made = await plugin({ buttons: () => [{ id: 'prefs', place: 'settings', label: 'Choose trackers' }, header('go', 'Sort')] })
    await withHost(<><header><HeaderButtons/></header><PluginsSection/></>)
    const row = () => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(made.name))
    await vi.waitFor(() => expect(row()?.querySelector('button.plugin')).toHaveAccessibleName('Choose trackers'))
    expect(row()!.querySelectorAll('button.plugin')).toHaveLength(1)
    await userEvent.click(row()!.querySelector('button.plugin')!)
    await vi.waitFor(() => expect(made.clicks).toStrictEqual([['prefs', {}]]))
    expect(inline()).toHaveLength(1)
    await removePlugin(made.uri)
    expect(kept()?.[made.uri]).toBeUndefined()
    await vi.waitFor(() => expect(inline()).toHaveLength(0))
  })
})

describe('a click', () => {
  it('says the plugin is not responding when it does not answer in 10 s, and nothing when it does', async () => {
    const slow = await plugin({ buttons: () => [header('go', 'Slow')], click: () => new Promise(() => {}) })
    await plugin({ buttons: () => [header('go', 'Quick')] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline()).toHaveLength(2))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    inline()[1]!.click()
    await realWait(200)
    await vi.advanceTimersByTimeAsync(CLICK_MS)
    expect(document.querySelector('.toast'), 'the control: an answered click').toBeNull()
    inline()[0]!.click()
    await realWait(200)
    await vi.advanceTimersByTimeAsync(CLICK_MS - 50)
    expect(document.querySelector('.toast')).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(document.querySelector('.toast')).toHaveTextContent(`${slow.name} is not responding`)
    expect(document.querySelector('.toast')).toHaveAttribute('role', 'status')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(document.querySelector('.toast'), 'gone after a moment').toBeNull()
  })

  it('says the plugin is not responding when it does not connect in 10 s', async () => {
    engine.double.start([entry(A)], [], false)
    const stuck = await plugin({ buttons: () => [header('go', 'Stuck')], hangs: true })
    await keepButtons(stuck.uri, { name: stuck.name, installedAt: 1, locales: { en: [header('go', 'Stuck')] } })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline()).toHaveLength(1))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    inline()[0]!.click()
    await vi.advanceTimersByTimeAsync(CLICK_MS - 50)
    expect(document.querySelector('.toast')).toBeNull()
    await vi.advanceTimersByTimeAsync(100)
    expect(document.querySelector('.toast')).toHaveTextContent(`${stuck.name} is not responding`)
    await vi.advanceTimersByTimeAsync(3_000)
  })

  it('asks about a switch this device never answered, goes no further on Cancel, and goes on after Done', async () => {
    const made = await plugin({ asks: ['read', 'change'], answers: { read: true }, buttons: () => [header('go', 'Sort')] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline()).toHaveLength(1))
    await userEvent.click(inline()[0]!)
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect([...sheet()!.querySelectorAll('label')].map((l) => l.textContent)).toEqual(['Pause, resume and organize torrents'])
    await userEvent.click(button(sheet()!, 'Cancel')!)
    await vi.waitFor(() => expect(sheet()).toBeNull())
    expect(made.clicks).toStrictEqual([])
    expect(fkn.calls).not.toContain(`uninstall ${made.uri}`)
    expect(await answersOf(made.uri)).toEqual({ read: true })
    await userEvent.click(inline()[0]!)
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    await userEvent.click(sheet()!.querySelector('input[type=checkbox]')!)
    await userEvent.click(button(sheet()!, 'Done')!)
    await vi.waitFor(() => expect(made.clicks).toStrictEqual([['go', {}]]))
    expect(await answersOf(made.uri)).toEqual({ read: true, change: true })
  })
})

describe('what ripple keeps of a plugin\'s buttons', () => {
  it('is asked once per language, kept for each, and asked again with the others dropped once they changed', async () => {
    const made = await plugin({ buttons: (locale) => [header('go', locale === 'he' ? 'מיון' : 'Sort')] })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline()[0]).toHaveAccessibleName('Sort'))
    await showIn('he', he)
    await vi.waitFor(() => expect(inline()[0]).toHaveAccessibleName('מיון'))
    expect(inline()[0]).toHaveAttribute('data-tooltip-content', '⁨מיון⁩')
    await showEnglish()
    await vi.waitFor(() => expect(inline()[0]).toHaveAccessibleName('Sort'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(made.asked).toEqual(['en', 'he'])
    expect(Object.keys(kept()![made.uri]!.locales)).toEqual(['en', 'he'])

    const ripple = await fkn.rippleOf(made.uri)
    const start = Date.now()
    await Promise.all([ripple.ui.buttonsChanged(), ripple.ui.buttonsChanged(), ripple.ui.buttonsChanged()])
    await vi.waitFor(() => expect(made.asked).toHaveLength(3))
    await vi.waitFor(() => expect(made.asked).toHaveLength(4), { timeout: BUTTONS_CHANGED_MS + 1_000 })
    expect(Date.now() - start).toBeGreaterThanOrEqual(BUTTONS_CHANGED_MS - 50)
    await new Promise((resolve) => setTimeout(resolve, BUTTONS_CHANGED_MS + 200))
    expect(made.asked, 'three calls in a second count twice').toEqual(['en', 'he', 'en', 'en'])
    expect(Object.keys(kept()![made.uri]!.locales)).toEqual(['en'])
  })

  it('draws another tab\'s buttons without connecting, connects on a click, and on a language it kept none in', async () => {
    engine.double.start([entry(A)], [], false)
    const drawn = await plugin({ buttons: () => [header('go', 'Sort')] })
    const missing = await plugin({ buttons: () => [header('go', 'Group')] })
    // as the tab running the engine keeps them
    await keepButtons(drawn.uri, { name: drawn.name, installedAt: 1, locales: { en: [header('go', 'Sort')] } })
    await keepButtons(missing.uri, { name: missing.name, installedAt: 2, locales: { fr: [header('go', 'Grouper')] } })
    await withHost(<header><HeaderButtons/></header>)
    await vi.waitFor(() => expect(inline().map((b) => b.getAttribute('aria-label'))).toEqual(['Sort', 'Group']))
    expect(fkn.calls.filter((call) => call.startsWith('connect'))).toEqual([`connect ${missing.uri}`])
    expect(drawn.asked).toEqual([])
    await userEvent.click(inline()[0]!)
    await vi.waitFor(() => expect(drawn.clicks).toStrictEqual([['go', {}]]))
    expect(fkn.calls).toContain(`connect ${drawn.uri}`)
  })

  it('is drawn nowhere, and asked of nobody, in a frame', async () => {
    const made = await plugin({ buttons: () => [header('go', 'Sort')] })
    await keepButtons(made.uri, { name: made.name, installedAt: 1, locales: { en: [header('go', 'Sort')] } })
    frame.framed = true
    await withHost(<header><HeaderButtons/></header>)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(inline()).toHaveLength(0)
    expect(fkn.calls.filter((call) => call.startsWith('connect'))).toEqual([])
  })
})
