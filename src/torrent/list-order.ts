import { useSyncExternalStore } from 'react'
import { get, update } from 'idb-keyval'

import { SYNC_ACCOUNT_KEY } from './constants'
import { accountTag } from './groups'

export type OrderKey = `g:${string}` | `t:${string}`
export type GroupMemberOrder = { updatedAt: number, members: string[] }
export type ListOrder = {
  updatedAt: number
  top: OrderKey[]
  groups: Record<string, GroupMemberOrder>
}
export type StoredListOrder = { account: string | null, order: ListOrder }

export const EMPTY_LIST_ORDER: ListOrder = { updatedAt: 0, top: [], groups: {} }
export const LIST_ORDER_KEY = 'ripple:list-order'
export const LIST_ORDER_PATH = 'ripple/order.json'
const CHANNEL = 'ripple:list-order'

const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const dedup = <K extends string>(items: readonly K[]): K[] => {
  const seen = new Set<K>()
  const out: K[] = []
  for (const item of items) {
    if (!seen.has(item)) { seen.add(item); out.push(item) }
  }
  return out
}

const validOrderKey = (value: unknown): value is OrderKey =>
  typeof value === 'string' && value.length > 2 && (value.startsWith('g:') || value.startsWith('t:'))

const validMember = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const syncedTag = () => {
  let name: string | null = null
  try { name = localStorage.getItem(SYNC_ACCOUNT_KEY) } catch {}
  return accountTag(name)
}

const heldFor = (stored: StoredListOrder | undefined, tag: string | null): ListOrder | undefined =>
  stored?.account && tag && stored.account !== tag ? EMPTY_LIST_ORDER : stored?.order

const checkedTop = (raw: unknown): { updatedAt: number, top: OrderKey[] } => {
  const o = raw as Partial<ListOrder> | null
  if (!o || !isTime(o.updatedAt) || !Array.isArray(o.top)) return { updatedAt: 0, top: [] }
  return { updatedAt: o.updatedAt, top: dedup(o.top.filter(validOrderKey)) }
}

const checkedGroupOrder = (raw: unknown): GroupMemberOrder | null => {
  const g = raw as Partial<GroupMemberOrder> | null
  if (!g || !isTime(g.updatedAt) || !Array.isArray(g.members)) return null
  return { updatedAt: g.updatedAt, members: dedup(g.members.filter(validMember)) }
}

const preferList = <T extends string>(
  aAt: number, aList: readonly T[],
  bAt: number, bList: readonly T[],
): { updatedAt: number, list: T[] } => {
  if (aAt !== bAt) return aAt > bAt ? { updatedAt: aAt, list: [...aList] } : { updatedAt: bAt, list: [...bList] }
  const aj = aList.join(',')
  const bj = bList.join(',')
  return aj >= bj ? { updatedAt: aAt, list: [...aList] } : { updatedAt: bAt, list: [...bList] }
}

/** Merges top-level order and per-group member orders independently by latest `updatedAt`. */
export const mergeListOrder = (...sources: unknown[]): ListOrder => {
  let topAt = 0
  let top: OrderKey[] = []
  const byGroup = new Map<string, GroupMemberOrder>()

  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const o = source as Partial<ListOrder>
    const candTop = checkedTop(o)
    const chosenTop = preferList(topAt, top, candTop.updatedAt, candTop.top)
    topAt = chosenTop.updatedAt
    top = chosenTop.list

    if (o.groups && typeof o.groups === 'object' && !Array.isArray(o.groups)) {
      for (const [id, rawGroup] of Object.entries(o.groups)) {
        if (!id) continue
        const candGroup = checkedGroupOrder(rawGroup)
        if (!candGroup) continue
        const prev = byGroup.get(id)
        if (!prev) { byGroup.set(id, candGroup); continue }
        const chosenGroup = preferList(prev.updatedAt, prev.members, candGroup.updatedAt, candGroup.members)
        byGroup.set(id, { updatedAt: chosenGroup.updatedAt, members: chosenGroup.list })
      }
    }
  }

  const groups: Record<string, GroupMemberOrder> = {}
  for (const id of [...byGroup.keys()].sort(cmp)) {
    groups[id] = byGroup.get(id)!
  }
  return { updatedAt: topAt, top, groups }
}

/**
 * Reorders `dragged` relative to `target` within `visibleKeys`, keeping visible items in their current
 * drawn positions while anchoring any hidden keys from `existingOrder` right after their nearest
 * visible predecessor before splicing `dragged` around `target`.
 */
export const reorderKeys = <K extends string>(
  visibleKeys: readonly K[],
  existingOrder: readonly K[],
  dragged: K,
  target: K,
  place: 'before' | 'after',
): K[] => {
  if (dragged === target) return dedup([...visibleKeys, ...existingOrder])
  const visible = dedup(visibleKeys)
  const visibleSet = new Set(visible)
  const existing = dedup(existingOrder)

  const combined: K[] = [...visible]
  const present = new Set(combined)
  let cursor = 0
  for (const k of existing) {
    if (visibleSet.has(k)) {
      cursor = combined.indexOf(k) + 1
    } else if (!present.has(k)) {
      combined.splice(cursor, 0, k)
      present.add(k)
      cursor++
    }
  }

  const withoutDragged = combined.filter((k) => k !== dragged)
  const targetIdx = withoutDragged.indexOf(target)
  if (targetIdx < 0) return withoutDragged
  const insertAt = place === 'before' ? targetIdx : targetIdx + 1
  const result = [...withoutDragged]
  result.splice(insertAt, 0, dragged)
  return dedup(result)
}

let shownOrder: ListOrder = EMPTY_LIST_ORDER
const listeners = new Set<() => void>()
let channel: BroadcastChannel | undefined

const reread = async () => {
  const tag = await syncedTag()
  const stored = await get<StoredListOrder>(LIST_ORDER_KEY).catch(() => undefined)
  shownOrder = mergeListOrder(heldFor(stored, tag))
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

export const subscribeListOrder = (listener: () => void): (() => void) => {
  channelOf()
  listeners.add(listener)
  if (listeners.size === 1) void reread()
  return () => { listeners.delete(listener) }
}

export const currentListOrder = (): ListOrder => shownOrder

export const useListOrder = (): ListOrder =>
  useSyncExternalStore(subscribeListOrder, currentListOrder)

const emptyOrder = (o: ListOrder) => o.updatedAt === 0 && o.top.length === 0 && Object.keys(o.groups).length === 0

/** Merges cloud list order under `tag` into IndexedDB and notifies tabs when changed. */
export const takeListOrder = async (tag: string | null, incoming: unknown, fresh = false): Promise<ListOrder> => {
  let order = EMPTY_LIST_ORDER
  let changed = false
  await update<StoredListOrder | undefined>(LIST_ORDER_KEY, (stored) => {
    const before = fresh ? EMPTY_LIST_ORDER : heldFor(stored, tag)
    order = mergeListOrder(before, incoming)
    const next: StoredListOrder = { account: tag ?? stored?.account ?? null, order }
    changed = (!!stored || !emptyOrder(order)) && JSON.stringify(next) !== JSON.stringify(stored)
    return changed ? next : stored
  })
  if (changed) await announce()
  return order
}

export const saveTopOrder = async (top: readonly OrderKey[]): Promise<void> => {
  const tag = await syncedTag()
  const nextTop = dedup(top.filter(validOrderKey))
  let changed = false
  await update<StoredListOrder | undefined>(LIST_ORDER_KEY, (stored) => {
    const base = mergeListOrder(heldFor(stored, tag))
    const updatedAt = Math.max(Date.now(), base.updatedAt + 1)
    changed = true
    return { account: tag ?? stored?.account ?? null, order: { ...base, updatedAt, top: nextTop } }
  })
  if (changed) await announce()
}

export const saveGroupMemberOrder = async (groupId: string, members: readonly string[]): Promise<void> => {
  if (!groupId) return
  const tag = await syncedTag()
  const nextMembers = dedup(members.filter(validMember))
  let changed = false
  await update<StoredListOrder | undefined>(LIST_ORDER_KEY, (stored) => {
    const base = mergeListOrder(heldFor(stored, tag))
    const prev = base.groups[groupId]
    const updatedAt = Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1)
    changed = true
    return {
      account: tag ?? stored?.account ?? null,
      order: { ...base, groups: { ...base.groups, [groupId]: { updatedAt, members: nextMembers } } },
    }
  })
  if (changed) await announce()
}
