// Plugins as a person adds, answers for, updates and removes them in Settings, connected through a stand-in for
// fkn.app's packages API, and plugins calling ripple across that connection.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

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

const { CONNECT_MS, PLUGIN_PROTOCOL, RECONNECT_MS, addByAddress, connectPlugin, removePlugin, updatePlugin } = await import('../../src/plugins/host')
const { InstallSheet, PluginHost } = await import('../../src/plugins/plugin-host')
const { PluginsSection } = await import('../../src/plugins/plugins-section')
const { answer, answersOf, keptButtons, storeKey } = await import('../../src/plugins/switches')
const { storeVpn } = await import('../../src/torrent/vpn-setting')

const A = 'a'.repeat(40)
let n = 0
/** A plugin of its own for each case, so what one case leaves connected is another uri. */
const plugin = (asks: string[], over: Partial<{ version: string, hangs: boolean }> = {}) => {
  const uri = `npm:@someone/ripple-plugin-${++n}`
  fkn.plugins.set(uri, { name: `Tracker sorter ${n}`, version: over.version ?? '1.0.0', payload: { asks }, hangs: over.hangs })
  return uri
}
const install = (uri: string) => { fkn.installed.push({ uri, name: fkn.plugins.get(uri)!.name, version: fkn.plugins.get(uri)!.version, installedAt: 1 }) }

const settings = () => render(<IntlRoot><MemoryRouter><PluginsSection/><PluginHost/></MemoryRouter></IntlRoot>)
const sheet = () => document.querySelector<HTMLElement>('[role="dialog"]')
const button = (root: ParentNode, text: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === text)

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
  try { localStorage.removeItem('ripple:vpn') } catch {}
  await showEnglish()
})

describe('adding a plugin by its address', () => {
  it('connects it with ripple\'s protocol and asks about each switch it wants that ripple offers, each one off', async () => {
    const uri = plugin(['files', 'change', 'read', 'some-switch'])
    await settings()
    await userEvent.type(document.querySelector('input')!, `  ${uri} {Enter}`)
    await vi.waitFor(() => expect(sheet()?.querySelectorAll('input[type=checkbox]')).toHaveLength(2))
    expect(fkn.calls).toContain(`install ${uri}`)
    expect(fkn.opened.at(-1)?.protocol).toBe(PLUGIN_PROTOCOL)
    expect(sheet()).toHaveAccessibleName(`Tracker sorter ${n}`)
    const boxes = [...sheet()!.querySelectorAll<HTMLInputElement>('input[type=checkbox]')]
    expect(boxes.map((box) => [box.parentElement!.textContent, box.checked])).toEqual([['See your torrents', false], ['Pause, resume and organize torrents', false]])
    await userEvent.click(boxes[1]!)
    await userEvent.click(button(sheet()!, 'Done')!)
    await vi.waitFor(() => expect(sheet()).toBeNull())
    expect(await answersOf(uri)).toEqual({ read: false, change: true })
  })

  it('uninstalls it on Cancel, and keeps nothing for it', async () => {
    const uri = plugin(['read'])
    await settings()
    await userEvent.type(document.querySelector('input')!, `${uri}{Enter}`)
    await vi.waitFor(() => expect(button(sheet()!, 'Done')?.disabled).toBe(false))
    await userEvent.click(button(sheet()!, 'Cancel')!)
    await vi.waitFor(() => expect(fkn.calls).toContain(`uninstall ${uri}`))
    expect(await answersOf(uri)).toBeUndefined()
    expect(fkn.installed).toEqual([])
  })

  it('asks nothing when fkn.app\'s confirm is declined, and says so in one line when the address is no plugin', async () => {
    fkn.confirms = false
    const uri = plugin(['read'])
    await settings()
    await userEvent.type(document.querySelector('input')!, `${uri}{Enter}`)
    await vi.waitFor(() => expect(fkn.calls).toContain(`install ${uri}`))
    expect(sheet()).toBeNull()
    expect(document.querySelector('[role="alert"]')).toBeNull()
    fkn.confirms = true
    await userEvent.type(document.querySelector('input')!, 'npm:@nobody/nothing{Enter}')
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toHaveTextContent('That plugin could not be added'))
  })

  // Done, where the sheet points the focus, is disabled while the plugin connects
  it('takes the focus while the plugin connects, so Escape answers the sheet as Cancel', async () => {
    const uri = plugin(['read'], { hangs: true })
    await settings()
    void addByAddress(uri)
    await vi.waitFor(() => expect(sheet()).toHaveTextContent('Connecting'))
    expect(sheet()!.contains(document.activeElement)).toBe(true)
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() => expect(fkn.calls).toContain(`uninstall ${uri}`))
    expect(sheet()).toBeNull()
  })

  it('reads Not responding on the sheet when the plugin never answers, and Done keeps it with every switch off', async () => {
    const uri = plugin(['read'], { hangs: true })
    await settings()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    void addByAddress(uri)
    await vi.waitFor(() => expect(sheet()).not.toBeNull())
    expect(sheet()).toHaveTextContent('Connecting')
    expect(button(sheet()!, 'Done')!.disabled).toBe(true)
    await vi.advanceTimersByTimeAsync(CONNECT_MS)
    vi.useRealTimers()
    await vi.waitFor(() => expect(sheet()?.querySelector('[role="alert"]')).toHaveTextContent('Not responding'))
    await userEvent.click(button(sheet()!, 'Done')!)
    await vi.waitFor(() => expect(sheet()).toBeNull())
    expect(await answersOf(uri)).toEqual({})
  })
})

describe('browsing fkn.app\'s list', () => {
  it('opens fkn.app\'s picker on ripple plugins, and asks about each one picked this device never answered for', async () => {
    const fresh = plugin(['read'])
    const known = plugin(['read'])
    await answer(known, { read: true })
    fkn.picks = [known, fresh]
    await settings()
    await userEvent.click(button(document, 'Browse')!)
    await vi.waitFor(() => expect(sheet()).toHaveAccessibleName(fkn.plugins.get(fresh)!.name))
    expect(fkn.calls).toContain('pick plugin ripple true')
    await vi.waitFor(() => expect(button(sheet()!, 'Done')?.disabled).toBe(false))
    await userEvent.click(button(sheet()!, 'Done')!)
    await vi.waitFor(() => expect(sheet()).toBeNull())
  })
})

describe('a plugin\'s row', () => {
  const row = (uri: string) => [...document.querySelectorAll('li')].find((li) => li.textContent?.includes(fkn.plugins.get(uri)!.name))

  it('shows its version and the switches it was asked about, and a press turns one on in every tab', async () => {
    const uri = plugin(['read', 'add'])
    install(uri)
    await answer(uri, { read: false, add: false })
    const other = new BroadcastChannel('ripple:plugins')
    let told = 0
    other.onmessage = () => { told++ }
    await settings()
    await vi.waitFor(() => expect(row(uri)).toHaveTextContent('1.0.0'))
    const read = button(row(uri)!, 'See your torrents')!
    expect(read).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(read)
    await vi.waitFor(() => expect(button(row(uri)!, 'See your torrents')).toHaveAttribute('aria-pressed', 'true'))
    expect(await answersOf(uri)).toEqual({ read: true, add: false })
    await vi.waitFor(() => expect(told).toBeGreaterThan(0))
    other.close()
  })

  it('reads Connecting while it connects, and Not responding once it gave up', async () => {
    const uri = plugin(['read'], { hangs: true })
    install(uri)
    await answer(uri, { read: true })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await settings()
    await vi.waitFor(() => expect(row(uri)?.querySelector('.status')).toHaveTextContent('Connecting'))
    await vi.advanceTimersByTimeAsync(CONNECT_MS)
    vi.useRealTimers()
    await vi.waitFor(() => expect(row(uri)?.querySelector('.status')).toHaveTextContent('Not responding'))
  })

  it('moves to the newest version on Update, and says Up to date when there is none', async () => {
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, {})
    await settings()
    await vi.waitFor(() => expect(row(uri)).toHaveTextContent('1.0.0'))
    await userEvent.click(button(row(uri)!, 'Update')!)
    await vi.waitFor(() => expect(row(uri)).toHaveTextContent('Up to date'))
    fkn.plugins.get(uri)!.version = '1.1.0'
    await userEvent.click(button(row(uri)!, 'Update')!)
    await vi.waitFor(() => expect(row(uri)).toHaveTextContent('1.1.0'))
    expect(fkn.calls.filter((call) => call === `install-latest ${uri}`)).toHaveLength(2)
    expect(row(uri)).not.toHaveTextContent('Up to date')
  })

  it('says in one line when fkn.app refuses an Update, rather than Up to date', async () => {
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, {})
    await settings()
    await vi.waitFor(() => expect(row(uri)).toHaveTextContent('1.0.0'))
    const held = row(uri)!
    // the double's install throws for a package it does not know
    const kept = fkn.plugins.get(uri)!
    fkn.plugins.delete(uri)
    await userEvent.click(button(held, 'Update')!)
    await vi.waitFor(() => expect(held.querySelector('[role="alert"]')).toHaveTextContent('That plugin could not be updated'))
    expect(held).not.toHaveTextContent('Up to date')
    fkn.plugins.set(uri, kept)
    await userEvent.click(button(held, 'Update')!)
    await vi.waitFor(() => expect(held).toHaveTextContent('Up to date'))
    expect(held.querySelector('[role="alert"]'), 'one fkn.app answers (control)').toBeNull()
  })

  it('drops the old version\'s buttons in every language on Update, and keeps the new one\'s', async () => {
    const uri = plugin([])
    const version = (v: string) => ({ asks: [], buttons: (locale: string) => [{ id: 'go', place: 'header', label: `${v} ${locale}` }] })
    fkn.plugins.get(uri)!.payload = version('v1')
    install(uri)
    await answer(uri, {})
    await connectPlugin(uri)
    await vi.waitFor(async () => expect((await keptButtons(uri))?.locales.en?.[0]?.label).toBe('v1 en'))
    await showIn('he', he)
    await vi.waitFor(async () => expect((await keptButtons(uri))?.locales.he?.[0]?.label).toBe('v1 he'))
    await showEnglish()
    fkn.plugins.set(uri, { ...fkn.plugins.get(uri)!, version: '2.0.0', payload: version('v2') })
    expect(await updatePlugin(uri)).toBe('updated')
    await vi.waitFor(async () => expect((await keptButtons(uri))?.locales.en?.[0]?.label).toBe('v2 en'), { timeout: RECONNECT_MS + 3_000 })
    const labels = Object.entries((await keptButtons(uri))!.locales).map(([locale, buttons]) => [locale, buttons[0]?.label])
    expect(labels).toEqual([['en', 'v2 en']])
  })

  it('removes it after one sentence, deleting its switches and its store, and keeps its torrents', async () => {
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, { read: true })
    memory.store.set(storeKey(uri), { cursor: '12' })
    await settings()
    await vi.waitFor(() => expect(row(uri)).toBeTruthy())
    await userEvent.click(button(row(uri)!, 'Remove')!)
    const confirm = sheet()!
    expect(confirm).toHaveTextContent('Its data in Ripple is deleted.')
    await userEvent.click(button(confirm, 'Cancel')!)
    expect(fkn.calls).not.toContain(`uninstall ${uri}`)
    await userEvent.click(button(row(uri)!, 'Remove')!)
    await userEvent.click([...sheet()!.querySelectorAll('button')].at(-1)!)
    await vi.waitFor(() => expect(fkn.calls).toContain(`uninstall ${uri}`))
    expect(await answersOf(uri)).toBeUndefined()
    expect(memory.store.has(storeKey(uri))).toBe(false)
    expect(engine.double.posted.some((m) => m.type === 'remove' || m.type === 'remove-missing')).toBe(false)
  })

  it('reads right to left in Hebrew, its name in the direction of its own words and its version left to right', async () => {
    await showIn('he', he)
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, {})
    await settings()
    await vi.waitFor(() => expect(row(uri)).toBeTruthy())
    expect(getComputedStyle(document.querySelector('section')!).direction).toBe('rtl')
    expect(row(uri)!.querySelector('.name')).toHaveAttribute('dir', 'auto')
    expect(row(uri)!.querySelector('.version')).toHaveAttribute('dir', 'ltr')
    expect(getComputedStyle(document.querySelector('input')!).unicodeBidi).toBe('plaintext')
    expect(getComputedStyle(document.querySelector('input')!).textOverflow, 'a placeholder longer than its field').toBe('ellipsis')
    expect(document.querySelector('section')).toHaveTextContent(he['Plugins'])
  })
})

describe('the connection', () => {
  it('is made again after its frame closes while fkn.app still lists it, and forgotten once it does not', async () => {
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, { read: true })
    await connectPlugin(uri)
    expect(fkn.opened.filter((open) => open.uri === uri)).toHaveLength(1)
    fkn.closeFrames(uri)
    await vi.waitFor(() => expect(fkn.opened.filter((open) => open.uri === uri)).toHaveLength(2), { timeout: RECONNECT_MS + 3_000 })
    fkn.installed = []
    fkn.closeFrames(uri)
    await vi.waitFor(async () => expect(await answersOf(uri)).toBeUndefined(), { timeout: 3_000 })
  })

  it('is left closed in a tab that does not run the engine, until its next use there', async () => {
    engine.double.start([entry(A)], [], false)
    const uri = plugin(['read'])
    install(uri)
    await connectPlugin(uri)
    fkn.closeFrames(uri)
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS + 1_000))
    expect(fkn.opened.filter((open) => open.uri === uri)).toHaveLength(1)
    await connectPlugin(uri)
    expect(fkn.opened.filter((open) => open.uri === uri), 'its next use (control)').toHaveLength(2)
  })

  it('carries the calls a plugin makes, each behind its switch', async () => {
    const uri = plugin(['read'])
    install(uri)
    await connectPlugin(uri)
    const ripple = await fkn.rippleOf(uri)
    expect(ripple.version).toBe(1)
    expect(ripple.active).toBe(true)
    await expect(ripple.torrents()).rejects.toThrow('not-allowed')
    await answer(uri, { read: true })
    expect((await ripple.torrents()).map((t) => t.infoHash)).toEqual([A])
    expect(await ripple.torrent(A)).toMatchObject({ infoHash: A, state: 'downloading', private: null })
  })

  it('tells a plugin when this tab switches the VPN off, with no switch needed', async () => {
    const uri = plugin([])
    install(uri)
    await connectPlugin(uri)
    const ripple = await fkn.rippleOf(uri)
    expect(ripple.vpn).toBe(true)
    const heard: boolean[] = []
    await ripple.on('vpn', (on) => { heard.push(on) })
    storeVpn(false)
    await vi.waitFor(() => expect(heard).toEqual([false]))
  })

  it('tells a plugin when the language shown changes, and when this tab stops running the engine', async () => {
    const uri = plugin([])
    install(uri)
    await connectPlugin(uri)
    const ripple = await fkn.rippleOf(uri)
    expect([ripple.locale, ripple.dir]).toEqual(['en', 'ltr'])
    const locales: unknown[] = []
    const active: boolean[] = []
    await ripple.on('locale', (locale) => { locales.push(locale) })
    await ripple.on('active', (on) => { active.push(on) })
    await showIn('he', he)
    await vi.waitFor(() => expect(locales).toEqual([{ locale: 'he', dir: 'rtl' }]))
    engine.double.start([entry(A)], [], false)
    await vi.waitFor(() => expect(active).toEqual([false]))
  })

  it('is made in the tab running the engine for each plugin answered for, and for none on a device that has none', async () => {
    const uri = plugin(['read'])
    install(uri)
    await settings()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fkn.calls, 'no plugin answered for here: fkn.app is not asked').toEqual([])
    await answer(uri, { read: true })
    await vi.waitFor(() => expect(fkn.calls).toContain(`connect ${uri}`))
  })
})

describe('inside a frame', () => {
  it('leaves Settings without its plugins, which show where ripple is not framed (control)', async () => {
    const Settings = (await import('../../src/router/settings')).default
    const page = () => render(<IntlRoot><MemoryRouter><Settings/></MemoryRouter></IntlRoot>)
    const shown = await page()
    await vi.waitFor(() => expect(button(document, 'Browse')).toBeTruthy())
    await shown.unmount()
    frame.framed = true
    await page()
    await vi.waitFor(() => expect(button(document, 'Open torrents with Ripple')).toBeTruthy())
    expect(button(document, 'Browse')).toBeUndefined()
  })

  it('connects nothing, adds nothing and shows no sheet', async () => {
    frame.framed = true
    const uri = plugin(['read'])
    install(uri)
    await answer(uri, { read: true })
    await settings()
    expect(await addByAddress(uri)).toBe(false)
    await connectPlugin(uri)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(fkn.calls.filter((call) => call.startsWith('connect') || call.startsWith('install'))).toEqual([])
  })
})
