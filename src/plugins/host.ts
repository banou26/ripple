import type { InstalledPackage } from '@fkn/lib/packages'
import type { RipplePlugin, Switch } from './contract'
import type { Feed } from './feed'
import type { PluginTab } from './calls'

import * as packages from '@fkn/lib/packages'
import { useSyncExternalStore } from 'react'

import { isRightToLeft, onLanguageShown, shownLanguage } from '../i18n'
import { getTorrentClient, runningTorrentClient } from '../torrent/client'
import { onVpnChange, vpnOn } from '../torrent/vpn-setting'
import { isFramed } from '../utils/framed'
import { rippleFor } from './calls'
import { OFFERED_SWITCHES, PLUGIN_PROTOCOL } from './contract'
import { createFeed } from './feed'
import { answer, answeredUris, answersOf, anyPlugin, forget } from './switches'

/** How long a plugin gets to connect before its row reads Not responding, as fkn.app's own limit. */
export const CONNECT_MS = 30_000
/** How long after its frame closed a plugin is connected again, once FKN still lists it. */
export const RECONNECT_MS = 3_000
// FKN's list never settles when no broker answers
const LIST_MS = 5_000

export type PluginStatus = 'connecting' | 'connected' | 'failed'

type Live = { abort: AbortController, status: PluginStatus, asks: Switch[] | null, close: () => void }

/** The install sheet's question: which of the switches `asks` names to turn on. `asks` is null until it connects. */
export type Asking = { uri: string, name: string, asks: Switch[] | null, failed: boolean }

export type PluginsView = {
  /** FKN's install records for ripple, null until listed. */
  installed: InstalledPackage[] | null
  statuses: Readonly<Record<string, PluginStatus>>
  /** What each connected plugin asks, of the switches ripple offers. */
  asks: Readonly<Record<string, Switch[]>>
  asking: Asking | null
}

const lives = new Map<string, Live>()
let installed: InstalledPackage[] | null = null
let asking: Asking | null = null
const queue: InstalledPackage[] = []
const listeners = new Set<() => void>()
let view: PluginsView = { installed, statuses: {}, asks: {}, asking }

const notify = () => {
  const entries = [...lives]
  view = {
    installed,
    statuses: Object.fromEntries(entries.map(([uri, live]) => [uri, live.status])),
    asks: Object.fromEntries(entries.flatMap(([uri, live]) => (live.asks ? [[uri, live.asks]] : []))),
    asking,
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

const tab: PluginTab = {
  client: getTorrentClient,
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

const disconnect = (uri: string) => {
  const live = lives.get(uri)
  if (!live) return
  lives.delete(uri)
  live.abort.abort()
  live.close()
  notify()
}

/**
 * Connects `uri` in this tab, once: never in a frame. A plugin whose frame closes is connected again while FKN still
 * lists it, and forgotten once FKN lists it no more.
 */
export const connectPlugin = async (uri: string): Promise<void> => {
  const held = lives.get(uri)
  if (isFramed() || (held && held.status !== 'failed')) return
  let asked!: (asks: Switch[]) => void
  const asks = new Promise<Switch[]>((resolve) => { asked = resolve })
  const calls = rippleFor(uri, tab, () => asks)
  const live: Live = { abort: new AbortController(), status: 'connecting', asks: null, close: calls.close }
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
    live.asks = offered((connection.remote as { asks?: unknown } | undefined)?.asks)
    asked(live.asks)
    notify()
    void connection.closed.then(async () => {
      if (lives.get(uri) !== live) return
      disconnect(uri)
      const held = await listPlugins()
      if (held && !held.some((p) => p.uri === uri)) { await forget(uri); return }
      setTimeout(() => { void connectPlugin(uri) }, RECONNECT_MS)
    })
  } catch {
    asked([])
    if (lives.get(uri) !== live) return
    live.status = 'failed'
    live.close()
    notify()
  } finally {
    clearTimeout(deadline)
  }
  if (asking?.uri === uri) { asking = { ...asking, asks: live.asks, failed: live.status === 'failed' }; notify() }
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
  asking = next ? { uri: next.uri, name: next.name, asks: lives.get(next.uri)?.asks ?? null, failed: lives.get(next.uri)?.status === 'failed' } : null
  notify()
  if (next) void connectPlugin(next.uri)
}

const ask = (pkg: InstalledPackage) => {
  queue.push(pkg)
  if (!asking) askNext()
}

/** Adds the plugin at `address` behind FKN's confirm, then asks about its switches. False when FKN refused it. */
export const addByAddress = async (address: string): Promise<boolean> => {
  if (isFramed()) return false
  const pkg = await packages.install(address.trim()).catch(() => undefined)
  if (pkg === undefined) return false
  if (pkg && !(await answersOf(pkg.uri))) ask(pkg)
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
    ask(held?.find((p) => p.uri === result.uri) ?? { uri: result.uri, name: result.name, version: result.version, installedAt: Date.now() })
  }
}

/** The sheet's Done, with the switches turned on: every switch it asked is answered. */
export const finishAsking = async (on: readonly Switch[]): Promise<void> => {
  const shown = asking
  if (!shown) return
  await answer(shown.uri, Object.fromEntries((shown.asks ?? []).map((name) => [name, on.includes(name)])))
  askNext()
}

/** The sheet's Cancel: the plugin is uninstalled. */
export const cancelAsking = async (): Promise<void> => {
  const shown = asking
  if (!shown) return
  askNext()
  await removePlugin(shown.uri)
}

/** Uninstalls `uri` and deletes what ripple keeps for it. Its torrents stay. */
export const removePlugin = async (uri: string): Promise<void> => {
  disconnect(uri)
  await packages.uninstall(uri).catch(() => {})
  await forget(uri)
  await listPlugins()
}

/** Moves `uri` to its newest version. Answers whether its version changed. */
export const updatePlugin = async (uri: string): Promise<boolean> => {
  const before = installed?.find((p) => p.uri === uri)?.version
  const pkg = await packages.install(uri, { latest: true }).catch(() => null)
  await listPlugins()
  return !!pkg && pkg.version !== before
}
