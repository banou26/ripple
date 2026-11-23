import { useRef, useSyncExternalStore } from 'react'
import { get, update } from 'idb-keyval'

import { SYNC_ACCOUNT_KEY } from './constants'
import { accountTag } from './groups'
import { forgetThumbnail, saveCustomThumbnail, subscribeThumbnails, thumbnailFor } from './thumbnail-store'

export const PRESET_ICONS = [
  'folder', 'film', 'tv', 'music', 'gamepad', 'book', 'image', 'archive', 'code', 'star', 'heart', 'globe',
] as const

export type PresetIconId = typeof PRESET_ICONS[number]

export type GroupIcon =
  | { kind: 'default' }
  | { kind: 'preset', icon: PresetIconId }
  | { kind: 'image', hash: string }

export type GroupAppearance = {
  id: string
  icon: GroupIcon
  updatedAt: number
}

export type StoredAppearance = { account: string | null, items: GroupAppearance[] }

export const GROUP_APPEARANCE_KEY = 'ripple:group-appearance'
export const GROUP_APPEARANCE_PATH = 'ripple/group-appearance.json'
const CHANNEL = 'ripple:group-appearance'

export const groupImageKey = (id: string, hash: string) => `group:${id}:${hash}`

const PRESET_SET = new Set<string>(PRESET_ICONS)
const HASH_RE = /^[0-9a-f]{16}$/
const isTime = (value: unknown): value is number => Number.isSafeInteger(value)
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const syncedTag = () => {
  let name: string | null = null
  try { name = localStorage.getItem(SYNC_ACCOUNT_KEY) } catch {}
  return accountTag(name)
}

const heldFor = (stored: StoredAppearance | undefined, tag: string | null) =>
  stored?.account && tag && stored.account !== tag ? [] : stored?.items

const validIcon = (raw: unknown): GroupIcon | null => {
  const icon = raw as Partial<GroupIcon> | null
  if (icon?.kind === 'default') return { kind: 'default' }
  if (icon?.kind === 'preset' && typeof icon.icon === 'string' && PRESET_SET.has(icon.icon)) {
    return { kind: 'preset', icon: icon.icon as PresetIconId }
  }
  if (icon?.kind === 'image' && typeof icon.hash === 'string' && HASH_RE.test(icon.hash)) {
    return { kind: 'image', hash: icon.hash }
  }
  return null
}

const checked = (raw: unknown): GroupAppearance | null => {
  const entry = raw as Partial<GroupAppearance> | null
  if (typeof entry?.id !== 'string' || !entry.id || !isTime(entry.updatedAt)) return null
  const icon = validIcon(entry.icon)
  if (!icon) return null
  return { id: entry.id, icon, updatedAt: entry.updatedAt }
}

const later = (a: GroupAppearance, b: GroupAppearance): GroupAppearance => {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  return JSON.stringify(a.icon) > JSON.stringify(b.icon) ? a : b
}

/** Combines local, other-tab, and cloud copies by latest `updatedAt` per group id. */
export const mergeAppearance = (...sources: unknown[]): GroupAppearance[] => {
  const byId = new Map<string, GroupAppearance>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      const entry = checked(raw)
      if (!entry) continue
      const was = byId.get(entry.id)
      byId.set(entry.id, was ? later(was, entry) : entry)
    }
  }
  return [...byId.values()].sort((a, b) => order(a.id, b.id))
}

export const DEFAULT_ICON: GroupIcon = { kind: 'default' }

let shownItems: GroupAppearance[] = []
let shownMap: ReadonlyMap<string, GroupIcon> = new Map()
const listeners = new Set<() => void>()
let channel: BroadcastChannel | undefined

const updateShown = (items: GroupAppearance[]) => {
  shownItems = items
  shownMap = new Map(items.filter((i) => i.icon.kind !== 'default').map((i) => [i.id, i.icon]))
}

const reread = async () => {
  const tag = await syncedTag()
  const stored = await get<StoredAppearance>(GROUP_APPEARANCE_KEY).catch(() => undefined)
  updateShown(mergeAppearance(heldFor(stored, tag)))
  listeners.forEach((listener) => listener())
}

const channelOf = () => {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL)
    channel.onmessage = () => { void reread() }
  }
  return channel
}

const announce = async () => {
  channelOf().postMessage(null)
  await reread()
}

export const subscribeGroupAppearance = (listener: () => void): (() => void) => {
  channelOf()
  listeners.add(listener)
  if (listeners.size === 1) void reread()
  return () => { listeners.delete(listener) }
}

export const currentGroupAppearance = (): ReadonlyMap<string, GroupIcon> => shownMap

export const currentGroupAppearances = (): readonly GroupAppearance[] => shownItems

export const useGroupAppearance = (): ReadonlyMap<string, GroupIcon> =>
  useSyncExternalStore(subscribeGroupAppearance, currentGroupAppearance)

/** Merges cloud appearance records under `tag`, drops local blobs replaced by newer icons, and returns merged items. */
export const takeGroupAppearance = async (tag: string | null, incoming: unknown, fresh = false): Promise<GroupAppearance[]> => {
  let items: GroupAppearance[] = []
  let changed = false
  const droppedKeys: string[] = []
  await update<StoredAppearance | undefined>(GROUP_APPEARANCE_KEY, (stored) => {
    const before = fresh ? [] : mergeAppearance(heldFor(stored, tag))
    items = mergeAppearance(before, incoming)
    const afterMap = new Map(items.map((item) => [item.id, item.icon]))
    for (const prev of before) {
      if (prev.icon.kind !== 'image') continue
      const next = afterMap.get(prev.id)
      if (!next || next.kind !== 'image' || next.hash !== prev.icon.hash) {
        droppedKeys.push(groupImageKey(prev.id, prev.icon.hash))
      }
    }
    const next: StoredAppearance = { account: tag ?? stored?.account ?? null, items }
    changed = (!!stored || items.length > 0) && JSON.stringify(next) !== JSON.stringify(stored)
    return changed ? next : stored
  })
  for (const dropped of droppedKeys) await forgetThumbnail(dropped).catch(() => {})
  if (changed) await announce()
  return items
}

/** Updates one group's icon and forgets any replaced local custom image, returning its cache key for cloud cleanup. */
export const setGroupIcon = async (id: string, icon: GroupIcon): Promise<string | null> => {
  const tag = await syncedTag()
  let previousKey: string | null = null
  let changed = false
  await update<StoredAppearance | undefined>(GROUP_APPEARANCE_KEY, (stored) => {
    const items = mergeAppearance(heldFor(stored, tag))
    const prev = items.find((item) => item.id === id)
    if (prev?.icon.kind === 'image' && (icon.kind !== 'image' || icon.hash !== prev.icon.hash)) {
      previousKey = groupImageKey(id, prev.icon.hash)
    }
    if (prev && JSON.stringify(prev.icon) === JSON.stringify(icon)) return stored
    const at = Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1)
    changed = true
    return { account: tag ?? stored?.account ?? null, items: mergeAppearance(items, [{ id, icon, updatedAt: at }]) }
  })
  if (previousKey) await forgetThumbnail(previousKey).catch(() => {})
  if (changed) await announce()
  return previousKey
}

const imageHash = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...digest].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Shrinks `file` to thumbnail bounds, persists it under a content-addressed key, and updates group `id`. */
export const saveGroupImage = async (id: string, file: Blob): Promise<{ hash: string, previousKey: string | null }> => {
  const { shrinkThumbnail } = await import('./thumbnail-store')
  const shrunk = await shrinkThumbnail(file)
  const hash = await imageHash(shrunk)
  await saveCustomThumbnail(groupImageKey(id, hash), shrunk)
  const previousKey = await setGroupIcon(id, { kind: 'image', hash })
  return { hash, previousKey }
}

/** Resets group `id` to the default icon, forgetting any stored custom image key. */
export const clearGroupAppearance = (id: string): Promise<string | null> =>
  setGroupIcon(id, DEFAULT_ICON)

/** Up to 4 cached member thumbnail URLs for a group's default 2x2 folder collage, referentially stable when unchanged. */
export const useGroupPreviewThumbnails = (infoHashes: readonly string[]): string[] => {
  const cached = useRef<{ sig: string, urls: string[] }>({ sig: '', urls: [] })
  return useSyncExternalStore(subscribeThumbnails, () => {
    const urls: string[] = []
    for (const infoHash of infoHashes) {
      const url = thumbnailFor(infoHash)
      if (!url) continue
      urls.push(url)
      if (urls.length === 4) break
    }
    const sig = urls.join('\0')
    if (sig === cached.current.sig) return cached.current.urls
    cached.current = { sig, urls }
    return urls
  })
}
