// A stand-in for `@fkn/lib/packages`: fkn.app's install records and confirm, its picker, and a connection to each
// plugin over a MessageChannel with osra, as fkn.app's broker hands one over. Nothing here leaves the page.
import type { InstalledPackage, PackageResult } from '@fkn/lib/packages'
import type { Ripple } from '../../src/plugins/contract'

import { expose } from 'osra'

export type FakePlugin = {
  name: string
  version: string
  /** The plugin's payload, or what makes it from the ripple the connection hands it. */
  payload: Record<string, unknown> | ((ripple: Promise<Ripple>) => object)
  /** Never answers the connection when true, as a plugin whose frame hangs. */
  hangs?: boolean
}

type Open = { uri: string, close: () => void, ripple: Promise<Ripple>, protocol?: string }

export const fkn = {
  plugins: new Map<string, FakePlugin>(),
  installed: [] as InstalledPackage[],
  /** What fkn.app's confirm answers. */
  confirms: true,
  /** The uris the picker hands back. */
  picks: [] as string[],
  /** Every connection made, newest last. */
  opened: [] as Open[],
  calls: [] as string[],
  reset: () => {
    fkn.plugins.clear()
    fkn.installed = []
    fkn.confirms = true
    fkn.picks = []
    for (const open of fkn.opened.splice(0)) open.close()
    fkn.calls = []
  },
  /** The ripple a plugin was handed on its newest connection. */
  rippleOf: (uri: string) => fkn.opened.filter((open) => open.uri === uri).at(-1)!.ripple,
  /** Closes every frame of `uri`, as fkn.app does when its install record changes. */
  closeFrames: (uri: string) => { for (const open of fkn.opened) if (open.uri === uri) open.close() },
}

const record = (uri: string): InstalledPackage => {
  const plugin = fkn.plugins.get(uri)
  if (!plugin) throw Object.assign(new Error('unknown package'), { code: 'invalid' })
  return { uri, name: plugin.name, version: plugin.version, installedAt: Date.now() }
}

export const list = async () => { fkn.calls.push('list'); return [...fkn.installed] }

export const install = async (uri: string, options?: { latest?: boolean }) => {
  fkn.calls.push(options?.latest ? `install-latest ${uri}` : `install ${uri}`)
  const held = fkn.installed.find((p) => p.uri === uri)
  if (options?.latest && held) {
    const now = { ...held, version: fkn.plugins.get(uri)!.version }
    fkn.installed = fkn.installed.map((p) => (p.uri === uri ? now : p))
    if (now.version !== held.version) fkn.closeFrames(uri)
    return now
  }
  if (!fkn.confirms) return null
  const fresh = record(uri)
  if (!held) fkn.installed.push(fresh)
  return held ?? fresh
}

export const uninstall = async (uri: string) => {
  fkn.calls.push(`uninstall ${uri}`)
  fkn.installed = fkn.installed.filter((p) => p.uri !== uri)
  fkn.closeFrames(uri)
}

export const pick = async (query: { type: string, id?: string }, options?: { multiple?: boolean }): Promise<PackageResult[]> => {
  fkn.calls.push(`pick ${query.type} ${query.id} ${options?.multiple === true}`)
  return fkn.picks.map((uri) => {
    const held = fkn.installed.find((p) => p.uri === uri) ?? record(uri)
    if (!fkn.installed.includes(held)) fkn.installed.push(held)
    return { uri, origin: 'npm', name: held.name, version: held.version ?? '', description: '', keywords: [], publisher: null, downloadsMonthly: null, links: {}, installed: true }
  })
}

export const connect = async (uri: string, options: { protocol?: string, payload?: unknown, signal?: AbortSignal } = {}) => {
  fkn.calls.push(`connect ${uri}`)
  const plugin = fkn.plugins.get(uri)
  if (!plugin || !fkn.installed.some((p) => p.uri === uri)) throw Object.assign(new Error('not installed'), { code: 'not-installed' })
  if (plugin.hangs) return new Promise<never>(() => {})
  const channel = new MessageChannel()
  let close!: () => void
  const closed = new Promise<void>((resolve) => { close = resolve })
  const unregister = new AbortController()
  let handed!: (ripple: Ripple) => void
  const given = new Promise<Ripple>((resolve) => { handed = resolve })
  const payload = typeof plugin.payload === 'function' ? plugin.payload(given) : plugin.payload
  const ripple = expose<Ripple>(payload as never, { transport: channel.port2, unregisterSignal: unregister.signal }) as Promise<Ripple>
  void ripple.then(handed, () => {})
  fkn.opened.push({ uri, ripple, protocol: options.protocol, close: () => { unregister.abort(); close() } })
  const remote = await expose(options.payload as never, { transport: channel.port1, unregisterSignal: options.signal })
  return { remote, closed, port: channel.port1 }
}
