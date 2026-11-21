import type { InstalledPackage } from '@fkn/lib/packages'
import type { AddResult, ButtonPage, ClickContext, PageOpen, PageSize, RipplePlugin, Switch } from './contract'
import type { Feed } from './feed'
import type { PluginTab, SuggestedAdd } from './calls'

import { shell } from '@fkn/lib'
import * as packages from '@fkn/lib/packages'
import { useSyncExternalStore } from 'react'

import { isRightToLeft, onLanguageShown, shownLanguage } from '../i18n'
import { getTorrentClient, runningTorrentClient } from '../torrent/client'
import { storedFolder } from '../torrent/use-folder'
import { onVpnChange, vpnOn } from '../torrent/vpn-setting'
import { isFramed } from '../utils/framed'
import { BUTTONS_CHANGED_MS, BUTTONS_MS, cleanButtons, CLICK_MS } from './buttons'
import { rippleFor } from './calls'
import { createFeed } from './feed'
import { answer, answeredUris, answersOf, anyPlugin, forget, keepButtons, keptButtons, OFFERED_SWITCHES } from './switches'

/** The protocol tag ripple connects a plugin with. A breaking change is `ripple-plugin@2`. */
export const PLUGIN_PROTOCOL = 'ripple-plugin@1'
/** How long a plugin gets to connect before its row reads Not responding, as fkn.app's own limit. */
export const CONNECT_MS = 30_000
/** How long a popup page gets to mount before its dialog reads Not responding. */
export const MOUNT_MS = 30_000
/** How long after a click on a plugin's button `ui.open`, `suggest`, `play` and `save` are allowed (also while its page is open). */
export const GESTURE_MS = 10_000
/** How many `suggest` proposals a plugin may make in one gesture window. */
export const SUGGEST_LIMIT = 10
/** How long after its frame closed a plugin is connected again, once FKN still lists it. */
export const RECONNECT_MS = 3_000
/** How many times in a row a plugin whose frame closes within {@link STEADY_MS} of connecting is connected again. */
export const RECONNECTS = 3
const STEADY_MS = 60_000
// FKN's list never settles when no broker answers
const LIST_MS = 5_000
const NOTICE_MS = 2_600

export type PluginStatus = 'connecting' | 'connected' | 'failed'

type Remote = { buttons?: (locale: string) => Promise<unknown>, click?: (id: string, context: ClickContext) => Promise<unknown> }

type Live = {
  abort: AbortController
  status: PluginStatus
  asks: Switch[] | null
  asksReady: Promise<Switch[]>
  remote: Remote | null
  /** Settles once it connected or gave up. */
  ready: Promise<void>
  close: () => void
}

/**
 * The install sheet's question: which of the switches `asks` names to turn on. `asks` is null until it connects. On
 * a click (`onClick`), it asks only the switches never answered, and Cancel leaves the plugin as it was.
 */
export type Asking = { uri: string, name: string, asks: Switch[] | null, failed: boolean, onClick?: (done: boolean) => void }

/** The popup page currently open in this tab, one per tab. */
export type OpenPage = {
  key: number
  uri: string
  name: string
  id: string
  size: PageSize
  context: ClickContext
}

export type PluginsView = {
  /** FKN's install records for ripple, null until listed. */
  installed: InstalledPackage[] | null
  statuses: Readonly<Record<string, PluginStatus>>
  /** What each connected plugin asks, of the switches ripple offers. */
  asks: Readonly<Record<string, Switch[]>>
  asking: Asking | null
  openPage: OpenPage | null
  /** The name of a plugin a click is waiting on past {@link CLICK_MS}, for one short line. */
  unanswered: string | null
}

type Queued = { pkg: InstalledPackage, only?: Switch[], onClick?: (done: boolean) => void }
type Gesture = { until: number, suggests: number }
export type Suggester = (proposal: SuggestedAdd) => Promise<AddResult>
export type Navigator = (to: string) => void

const lives = new Map<string, Live>()
const gestures = new Map<string, Gesture>()
let installed: InstalledPackage[] | null = null
let asking: Asking | null = null
let openPage: OpenPage | null = null
let closingPageKey: number | null = null
let pageSeq = 0
let unanswered: string | null = null
let suggester: Suggester | null = null
let navigatorFn: Navigator | null = null
const queue: Queued[] = []
const listeners = new Set<() => void>()
let view: PluginsView = { installed, statuses: {}, asks: {}, asking, openPage, unanswered }

const notify = () => {
  const entries = [...lives]
  view = {
    installed,
    statuses: Object.fromEntries(entries.map(([uri, live]) => [uri, live.status])),
    asks: Object.fromEntries(entries.flatMap(([uri, live]) => (live.asks ? [[uri, live.asks]] : []))),
    asking,
    openPage,
    unanswered,
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The plugins as Settings, the install sheet and the popup page show them. */
export const usePlugins = (): PluginsView => useSyncExternalStore(subscribe, () => view)

// fkn.app's answer holds while the document lives
let here: boolean | null = isFramed() ? null : true
let hereAsked: Promise<boolean> | undefined

/**
 * Whether plugins connect and show in this page: where ripple is not framed, or in the frame fkn.app's `/app` page
 * mounted for ripple as its tab's own page. fkn.app is asked once, and answers false by its deadline.
 */
export const pluginsHere = (): Promise<boolean> =>
  (hereAsked ??= here !== null ? Promise.resolve(here) : shell.isAppTab().then((yes) => { here = yes; if (yes) notify(); return yes }))

/** {@link pluginsHere} as a component reads it, false until fkn.app answers. Asks nothing itself. */
export const usePluginsHere = (): boolean => useSyncExternalStore(subscribe, () => here === true)

/** Registers the library page's handler for `suggest`, returning its teardown. */
export const registerSuggester = (handler: Suggester): (() => void) => {
  suggester = handler
  return () => { if (suggester === handler) suggester = null }
}

/** Registers the router's navigation handler for `play`, returning its teardown. */
export const registerNavigator = (handler: Navigator): (() => void) => {
  navigatorFn = handler
  return () => { if (navigatorFn === handler) navigatorFn = null }
}

let feed: Feed | null = null

const localeNow = () => ({ locale: shownLanguage(), dir: isRightToLeft(shownLanguage()) ? 'rtl' as const : 'ltr' as const })

// each listener hears a change of the value, not every report of it
const changes = <T>(now: () => T, watch: (heard: () => void) => () => void) => (listener: (value: T) => void) => {
  let last = JSON.stringify(now())
  return watch(() => {
    const value = now()
    if (JSON.stringify(value) === last) return
    last = JSON.stringify(value)
    listener(value)
  })
}

const changedAt = new Map<string, number>()
const changing = new Set<string>()
const quickCloses = new Map<string, number>()

// counted at most once a second, and the last call in a second is answered once it ends
const buttonsChanged = (uri: string) => {
  const wait = (changedAt.get(uri) ?? -Infinity) + BUTTONS_CHANGED_MS - Date.now()
  if (wait <= 0) {
    changedAt.set(uri, Date.now())
    void askButtons(uri, true)
  } else if (!changing.has(uri)) {
    changing.add(uri)
    setTimeout(() => { changing.delete(uri); buttonsChanged(uri) }, wait)
  }
}

const inGesture = (uri: string) =>
  (openPage?.uri === uri && openPage.key !== closingPageKey) || Date.now() < (gestures.get(uri)?.until ?? 0)
const startGesture = (uri: string) => { gestures.set(uri, { until: Date.now() + GESTURE_MS, suggests: 0 }) }
const endGesture = (uri: string) => {
  const g = gestures.get(uri)
  if (g) g.until = 0
}
const takeSuggest = (uri: string) => {
  if (!inGesture(uri)) return false
  const g = gestures.get(uri) ?? { until: 0, suggests: 0 }
  if (g.suggests >= SUGGEST_LIMIT) return false
  g.suggests += 1
  gestures.set(uri, g)
  return true
}

const beginClosePage = (uri: string): number | null => {
  if (openPage?.uri !== uri) return null
  endGesture(uri)
  closingPageKey = openPage.key
  return openPage.key
}

/** Closes the open popup page (matching `byUri` and `byKey` when named) and ends its window so it cannot immediately reopen. */
export const closePage = (byUri?: string, byKey?: number) => {
  if (!openPage || (byUri && openPage.uri !== byUri) || (byKey !== undefined && openPage.key !== byKey)) return
  endGesture(openPage.uri)
  if (closingPageKey === openPage.key) closingPageKey = null
  openPage = null
  notify()
}

const replaceOpenPage = (next: OpenPage) => {
  if (openPage && openPage.uri !== next.uri) endGesture(openPage.uri)
  closingPageKey = null
  openPage = next
  notify()
}

const pluginName = async (uri: string): Promise<string> =>
  installed?.find((p) => p.uri === uri)?.name ?? (await keptButtons(uri))?.name ?? (await nameOf(uri))?.name ?? uri

const openPageFor = async (uri: string, page: PageOpen) => {
  if (lives.get(uri)?.status !== 'connected') throw new Error('unavailable')
  const name = await pluginName(uri)
  if (lives.get(uri)?.status !== 'connected') throw new Error('unavailable')
  if (!inGesture(uri)) throw new Error('not-allowed')
  replaceOpenPage({ key: ++pageSeq, uri, name, id: page.id, size: page.size ?? 'medium', context: { ...(page.context ?? {}) } })
}

const tab: PluginTab = {
  client: getTorrentClient,
  buttonsChanged,
  openPage: openPageFor,
  beginClosePage,
  closePage: (uri, key) => closePage(uri, key),
  inGesture,
  takeSuggest,
  canSuggest: () => suggester !== null,
  suggest: async (uri, item) => {
    const active = suggester
    if (!active || lives.get(uri)?.status !== 'connected') throw new Error('unavailable')
    const from = await pluginName(uri)
    if (suggester !== active || lives.get(uri)?.status !== 'connected') throw new Error('unavailable')
    return active({ ...item, from })
  },
  navigate: (to) => {
    if (!navigatorFn) throw new Error('unavailable')
    navigatorFn(to)
  },
  folder: storedFolder,
  feed: () => (feed ??= createFeed(getTorrentClient())),
  owns: () => runningTorrentClient()?.owns() ?? false,
  vpn: vpnOn,
  locale: localeNow,
  onActive: changes(() => tab.owns(), (heard) => getTorrentClient().onOwnership(heard)),
  onVpn: changes(vpnOn, onVpnChange),
  onLocale: changes(localeNow, onLanguageShown),
}

const within = <T>(work: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([work, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]).catch(() => undefined)

/** FKN's install records, kept for the view; undefined when FKN did not answer. */
export const listPlugins = async (): Promise<InstalledPackage[] | undefined> => {
  const held = await within(packages.list(), LIST_MS)
  if (held) { installed = held; notify() }
  return held
}

const offered = (asks: unknown): Switch[] =>
  Array.isArray(asks) ? OFFERED_SWITCHES.filter((name) => asks.includes(name)) : []

const nameOf = async (uri: string) =>
  (installed?.find((p) => p.uri === uri) ?? (await listPlugins())?.find((p) => p.uri === uri))

/**
 * Asks `uri` for its buttons in the language shown, and keeps them for it, with every other language's dropped when
 * they are `stale`. An answer past {@link BUTTONS_MS} or a refusal leaves what was kept.
 */
const askButtons = async (uri: string, stale = false) => {
  const live = lives.get(uri)
  if (live?.status !== 'connected') return
  const { locale } = localeNow()
  // one with none keeps none, so no tab connects it to find out
  const answer = typeof live.remote?.buttons === 'function'
    ? await within(live.remote.buttons(locale).then((buttons) => ({ buttons })), BUTTONS_MS)
    : { buttons: [] }
  if (!answer) return
  const before = await keptButtons(uri)
  const record = before ?? await nameOf(uri)
  // removed while it answered, which disconnected it first, so nothing is kept for it again
  if (!record || lives.get(uri) !== live) return
  await keepButtons(uri, {
    name: record.name,
    installedAt: record.installedAt,
    locales: { ...(stale ? {} : before?.locales), [locale]: cleanButtons(answer.buttons) },
  })
}

// a language shown that a connected plugin's kept buttons lack is asked for
onLanguageShown(() => {
  for (const uri of lives.keys()) void keptButtons(uri).then((kept) => { if (!kept?.locales[localeNow().locale]) void askButtons(uri) })
})

const disconnect = (uri: string) => {
  const live = lives.get(uri)
  if (!live) return
  lives.delete(uri)
  gestures.delete(uri)
  // the broker never sees a mounted page frame, so the page closes whenever its background connection does
  if (openPage?.uri === uri) {
    if (closingPageKey === openPage.key) closingPageKey = null
    openPage = null
  }
  live.abort.abort()
  live.close()
  notify()
}

/**
 * Mounts `page` into `iframe` over `packages.mount`, under the plugin's same switches, with `remote.page` carrying the
 * page's id and context. Fails after {@link MOUNT_MS} or when the background connection is gone.
 */
export const mountPluginPage = async (
  page: OpenPage,
  iframe: HTMLIFrameElement,
  signal: AbortSignal,
): Promise<{ unmount: () => void }> => {
  if (signal.aborted) throw new Error('aborted')
  const live = lives.get(page.uri)
  if (!live || live.status !== 'connected') throw new Error('unavailable')
  const calls = rippleFor(page.uri, tab, () => live.asksReady, { id: page.id, context: page.context })
  const abort = new AbortController()
  let abandoned = false
  let deadline: ReturnType<typeof setTimeout> | undefined
  let rejectAbort: (error: Error) => void = () => {}
  const onAbort = () => {
    abandoned = true
    abort.abort()
    rejectAbort(new Error('aborted'))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const mounting = packages.mount(page.uri, { iframe, protocol: PLUGIN_PROTOCOL, payload: calls.ripple, signal: abort.signal })
  void mounting.then((mounted) => { if (abandoned) mounted.unmount() }, () => {})
  try {
    const mounted = await Promise.race([
      mounting,
      new Promise<never>((_, reject) => {
        rejectAbort = reject
        if (signal.aborted) { abandoned = true; abort.abort(); reject(new Error('aborted')); return }
        deadline = setTimeout(() => { abandoned = true; abort.abort(); reject(new Error('timeout')) }, MOUNT_MS)
      }),
    ])
    if (signal.aborted || openPage?.key !== page.key) {
      abandoned = true
      mounted.unmount()
      calls.close()
      return { unmount: () => {} }
    }
    let done = false
    const unmount = () => {
      if (done) return
      done = true
      mounted.unmount()
      calls.close()
    }
    void mounted.closed.then(() => {
      calls.close()
      if (!done && openPage?.key === page.key) closePage(page.uri, page.key)
    })
    return { unmount }
  } catch (error) {
    abandoned = true
    calls.close()
    throw error
  } finally {
    clearTimeout(deadline)
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Connects `uri` in this tab, once, where {@link pluginsHere}. A plugin whose frame closes is forgotten once FKN lists it
 * no more, and otherwise connected again in the tab running the engine; another tab connects it on its next use.
 */
export const connectPlugin = async (uri: string): Promise<void> => {
  // in the same task once fkn.app answered, so a click finds the connection it started
  if (!(here ?? await pluginsHere())) return
  const held = lives.get(uri)
  if (held && held.status !== 'failed') return
  let asked!: (asks: Switch[]) => void
  const asksReady = new Promise<Switch[]>((resolve) => { asked = resolve })
  const calls = rippleFor(uri, tab, () => asksReady)
  let settled!: () => void
  const ready = new Promise<void>((resolve) => { settled = resolve })
  const live: Live = { abort: new AbortController(), status: 'connecting', asks: null, asksReady, remote: null, ready, close: calls.close }
  lives.set(uri, live)
  notify()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const connection = await Promise.race([
      packages.connect<RipplePlugin>(uri, { protocol: PLUGIN_PROTOCOL, payload: calls.ripple, signal: live.abort.signal }),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => { live.abort.abort(); reject(new Error('timeout')) }, CONNECT_MS) }),
    ])
    if (lives.get(uri) !== live) return
    live.status = 'connected'
    live.remote = connection.remote
    live.asks = offered((connection.remote as { asks?: unknown } | undefined)?.asks)
    asked(live.asks)
    notify()
    void askButtons(uri)
    const connectedAt = Date.now()
    void connection.closed.then(async () => {
      if (lives.get(uri) !== live) return
      disconnect(uri)
      const held = await listPlugins()
      if (held && !held.some((p) => p.uri === uri)) { await forget(uri); return }
      // one that keeps closing as soon as it connects is left for its next use
      const closes = Date.now() - connectedAt < STEADY_MS ? (quickCloses.get(uri) ?? 0) + 1 : 0
      quickCloses.set(uri, closes)
      if (tab.owns() && closes <= RECONNECTS) setTimeout(() => { void connectPlugin(uri) }, RECONNECT_MS)
    })
  } catch {
    asked([])
    if (lives.get(uri) !== live) return
    live.status = 'failed'
    live.close()
    notify()
  } finally {
    clearTimeout(deadline)
    settled()
  }
  if (asking?.uri === uri) { asking = { ...asking, asks: asking.onClick ? asking.asks : live.asks, failed: live.status === 'failed' }; notify() }
}

/** Connects every plugin FKN lists, where this device ever answered for one. For the tab running the engine. */
export const connectInstalled = async (): Promise<void> => {
  if (!(await anyPlugin()) || !(await pluginsHere())) return
  for (const p of (await listPlugins()) ?? []) void connectPlugin(p.uri)
}

/** Connects each plugin answered for since, in another tab. For the tab running the engine. */
export const connectAnswered = async (): Promise<void> => {
  for (const uri of await answeredUris()) if (!lives.has(uri)) void connectPlugin(uri)
}

const askNext = () => {
  const next = queue.shift()
  const live = next && lives.get(next.pkg.uri)
  asking = next ? { uri: next.pkg.uri, name: next.pkg.name, asks: next.only ?? live?.asks ?? null, failed: live?.status === 'failed', onClick: next.onClick } : null
  notify()
  if (next) void connectPlugin(next.pkg.uri)
}

const ask = (queued: Queued) => {
  queue.push(queued)
  if (!asking) askNext()
}

/** Adds the plugin at `address` behind FKN's confirm, then asks about its switches. False when FKN refused it. */
export const addByAddress = async (address: string): Promise<boolean> => {
  if (!(await pluginsHere())) return false
  const pkg = await packages.install(address.trim()).catch(() => undefined)
  if (pkg === undefined) return false
  if (pkg && !(await answersOf(pkg.uri))) ask({ pkg })
  void listPlugins()
  return true
}

/** FKN's picker over the published ripple plugins; each one picked that this device never answered for is asked about. */
export const browsePlugins = async (): Promise<void> => {
  if (!(await pluginsHere())) return
  const picked = await packages.pick({ type: 'plugin', id: 'ripple' }, { multiple: true }).catch(() => [])
  const held = await listPlugins()
  for (const result of picked) {
    if (await answersOf(result.uri)) continue
    ask({ pkg: held?.find((p) => p.uri === result.uri) ?? { uri: result.uri, name: result.name, version: result.version, installedAt: Date.now() } })
  }
}

/** The sheet's Done, with the switches turned on: every switch it asked is answered. */
export const finishAsking = async (on: readonly Switch[]): Promise<void> => {
  const shown = asking
  if (!shown) return
  await answer(shown.uri, Object.fromEntries((shown.asks ?? []).map((name) => [name, on.includes(name)])))
  askNext()
  shown.onClick?.(true)
}

/** The sheet's Cancel: the plugin is uninstalled, unless a click asked, which then goes no further. */
export const cancelAsking = async (): Promise<void> => {
  const shown = asking
  if (!shown) return
  askNext()
  if (shown.onClick) shown.onClick(false)
  else await removePlugin(shown.uri)
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
const sayUnanswered = (name: string) => {
  unanswered = name
  notify()
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => { unanswered = null; notify() }, NOTICE_MS)
}

/**
 * A press of `uri`'s button `id`: connects it here when it is not, asks about the switches it wants that this device
 * never answered, then opens its popup `page` or hands the click on. Starts a fresh gesture window for `uri`. Says
 * the plugin is not responding when it does not connect or answer in {@link CLICK_MS}. Only where {@link pluginsHere}.
 */
export const clickButton = async (
  uri: string,
  name: string,
  id: string,
  context: ClickContext,
  page?: ButtonPage,
): Promise<void> => {
  if (!(await pluginsHere())) return
  void connectPlugin(uri)
  const live = lives.get(uri)
  if (!live || !(await within(live.ready.then(() => true), CLICK_MS)) || live.status !== 'connected' || (!page && typeof live.remote?.click !== 'function')) {
    sayUnanswered(name)
    return
  }
  const answers = (await answersOf(uri)) ?? {}
  const never = (live.asks ?? []).filter((s) => !(s in answers))
  if (never.length && !(await new Promise<boolean>((onClick) => ask({ pkg: { uri, name, version: null, installedAt: 0 }, only: never, onClick })))) {
    return
  }
  if (lives.get(uri) !== live || live.status !== 'connected') {
    sayUnanswered(name)
    return
  }
  startGesture(uri)
  if (page) {
    replaceOpenPage({ key: ++pageSeq, uri, name, id: page.id, size: page.size ?? 'medium', context: { ...context } })
    return
  }
  const click = live.remote?.click
  if (typeof click !== 'function') { endGesture(uri); sayUnanswered(name); return }
  if (!(await within(click(id, context).then(() => true, () => true), CLICK_MS))) sayUnanswered(name)
}

/** Uninstalls `uri` and deletes what ripple keeps for it. Its torrents stay. */
export const removePlugin = async (uri: string): Promise<void> => {
  disconnect(uri)
  await packages.uninstall(uri).catch(() => {})
  await forget(uri)
  await listPlugins()
}

/** Moves `uri` to its newest version: `current` when it was on it already, `failed` when fkn.app refused. */
export const updatePlugin = async (uri: string): Promise<'updated' | 'current' | 'failed'> => {
  const before = installed?.find((p) => p.uri === uri)?.version
  const pkg = await packages.install(uri, { latest: true }).catch(() => null)
  // the old version's buttons go in every language, and the new one is asked for its own on its next connection
  const kept = pkg && pkg.version !== before ? await keptButtons(uri) : undefined
  if (kept) await keepButtons(uri, { ...kept, locales: {} })
  await listPlugins()
  return !pkg ? 'failed' : pkg.version === before ? 'current' : 'updated'
}
