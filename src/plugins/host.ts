import type { InstalledPackage } from '@fkn/lib/packages'
import type { ClickContext, RipplePlugin, Switch } from './contract'
import type { Feed } from './feed'
import type { PluginTab } from './calls'

import * as packages from '@fkn/lib/packages'
import { useSyncExternalStore } from 'react'

import { isRightToLeft, onLanguageShown, shownLanguage } from '../i18n'
import { getTorrentClient, runningTorrentClient } from '../torrent/client'
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
/** How long after its frame closed a plugin is connected again, once FKN still lists it. */
export const RECONNECT_MS = 3_000
// FKN's list never settles when no broker answers
const LIST_MS = 5_000
const NOTICE_MS = 2_600

export type PluginStatus = 'connecting' | 'connected' | 'failed'

type Remote = { buttons?: (locale: string) => Promise<unknown>, click?: (id: string, context: ClickContext) => Promise<unknown> }

type Live = {
  abort: AbortController
  status: PluginStatus
  asks: Switch[] | null
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

export type PluginsView = {
  /** FKN's install records for ripple, null until listed. */
  installed: InstalledPackage[] | null
  statuses: Readonly<Record<string, PluginStatus>>
  /** What each connected plugin asks, of the switches ripple offers. */
  asks: Readonly<Record<string, Switch[]>>
  asking: Asking | null
  /** The name of a plugin a click is waiting on past {@link CLICK_MS}, for one short line. */
  unanswered: string | null
}

type Queued = { pkg: InstalledPackage, only?: Switch[], onClick?: (done: boolean) => void }

const lives = new Map<string, Live>()
let installed: InstalledPackage[] | null = null
let asking: Asking | null = null
let unanswered: string | null = null
const queue: Queued[] = []
const listeners = new Set<() => void>()
let view: PluginsView = { installed, statuses: {}, asks: {}, asking, unanswered }

const notify = () => {
  const entries = [...lives]
  view = {
    installed,
    statuses: Object.fromEntries(entries.map(([uri, live]) => [uri, live.status])),
    asks: Object.fromEntries(entries.flatMap(([uri, live]) => (live.asks ? [[uri, live.asks]] : []))),
    asking,
    unanswered,
  }
  for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The plugins as Settings and the install sheet show them. */
export const usePlugins = (): PluginsView => useSyncExternalStore(subscribe, () => view)

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

const tab: PluginTab = {
  client: getTorrentClient,
  buttonsChanged,
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
  live.abort.abort()
  live.close()
  notify()
}

/**
 * Connects `uri` in this tab, once: never in a frame. A plugin whose frame closes is forgotten once FKN lists it no
 * more, and otherwise connected again in the tab running the engine; another tab connects it on its next use.
 */
export const connectPlugin = async (uri: string): Promise<void> => {
  const held = lives.get(uri)
  if (isFramed() || (held && held.status !== 'failed')) return
  let asked!: (asks: Switch[]) => void
  const asks = new Promise<Switch[]>((resolve) => { asked = resolve })
  const calls = rippleFor(uri, tab, () => asks)
  let settled!: () => void
  const ready = new Promise<void>((resolve) => { settled = resolve })
  const live: Live = { abort: new AbortController(), status: 'connecting', asks: null, remote: null, ready, close: calls.close }
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
    void connection.closed.then(async () => {
      if (lives.get(uri) !== live) return
      disconnect(uri)
      const held = await listPlugins()
      if (held && !held.some((p) => p.uri === uri)) { await forget(uri); return }
      if (tab.owns()) setTimeout(() => { void connectPlugin(uri) }, RECONNECT_MS)
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
  if (isFramed() || !(await anyPlugin())) return
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
  if (isFramed()) return false
  const pkg = await packages.install(address.trim()).catch(() => undefined)
  if (pkg === undefined) return false
  if (pkg && !(await answersOf(pkg.uri))) ask({ pkg })
  void listPlugins()
  return true
}

/** FKN's picker over the published ripple plugins; each one picked that this device never answered for is asked about. */
export const browsePlugins = async (): Promise<void> => {
  if (isFramed()) return
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
 * never answered, then hands the click on. Says the plugin is not responding when it does not connect or answer in
 * {@link CLICK_MS}. Never in a frame.
 */
export const clickButton = async (uri: string, name: string, id: string, context: ClickContext): Promise<void> => {
  if (isFramed()) return
  void connectPlugin(uri)
  const live = lives.get(uri)
  if (!live || !(await within(live.ready.then(() => true), CLICK_MS)) || live.status !== 'connected' || typeof live.remote?.click !== 'function') {
    sayUnanswered(name)
    return
  }
  const answers = (await answersOf(uri)) ?? {}
  const never = (live.asks ?? []).filter((s) => !(s in answers))
  if (never.length && !(await new Promise<boolean>((onClick) => ask({ pkg: { uri, name, version: null, installedAt: 0 }, only: never, onClick })))) return
  if (!(await within(live.remote.click(id, context).then(() => true, () => true), CLICK_MS))) sayUnanswered(name)
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
  await listPlugins()
  return !pkg ? 'failed' : pkg.version === before ? 'current' : 'updated'
}
