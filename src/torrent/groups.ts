import { useSyncExternalStore } from 'react'
import { get, update } from 'idb-keyval'

import { SYNC_ACCOUNT_KEY } from './constants'

/** A torrent's place in a group: in, or taken out, as of `at` (ms since epoch). The later change wins. */
export type Member = { infoHash: string, at: number, out?: true }

/**
 * A named set of torrents, by info hash. A torrent can be in several groups.
 *
 * `members` keeps every torrent ever put in or taken out, so a change on one device and another on a
 * second device both survive a merge; the group holds those without `out` (`torrentsIn`). A deleted
 * group keeps only its id and `deletedAt`, so the deletion reaches every copy. Ids are 96 random bits,
 * minted on creation and never reused.
 *
 * The shape is fixed for good: `mergeGroups` drops any field it does not know, so every version strips a
 * field a later one added each time it writes. A change of shape takes a new key and a new file name.
 */
export type TorrentGroup = {
  id: string
  name: string
  /** When the name was last set. The later name wins. */
  namedAt: number
  members: Member[]
  deletedAt?: number
}

/** What this browser keeps: the groups, and the `accountTag` of the account they belong to (null before any sign-in). */
export type StoredGroups = { account: string | null, groups: TorrentGroup[] }

export const GROUPS_KEY = 'ripple:groups'
const CHANNEL = 'ripple:groups'

/** An account's tag: a SHA-256 digest of its name, so the copy says which account it is without keeping the name again. */
export const accountTag = async (name: string | null): Promise<string | null> => {
  if (!name) return null
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name)))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const syncedTag = () => {
  let name: string | null = null
  try { name = localStorage.getItem(SYNC_ACCOUNT_KEY) } catch {}
  return accountTag(name)
}

/*
 * A copy tagged with another account holds none of this account's groups. That covers a ripple from before groups
 * handling an account switch: it clears the list and renames the synced account, and never touches this copy.
 * While either account is unknown (no sign-in yet, or no local storage) the copy is this browser's.
 */
const heldFor = (stored: StoredGroups | undefined, tag: string | null) =>
  stored?.account && tag && stored.account !== tag ? [] : stored?.groups

// past 2^53 a time + 1 is the same time, so an edit could never win over it
const isTime = (value: unknown): value is number => Number.isSafeInteger(value)

// code units rather than a locale, so every device puts the same copies in the same order
const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const tombstone = (id: string, deletedAt: number): TorrentGroup => ({ id, name: '', namedAt: 0, members: [], deletedAt })

const checked = (raw: unknown): TorrentGroup | null => {
  const g = raw as Partial<TorrentGroup> | null
  if (typeof g?.id !== 'string' || !g.id) return null
  if (g.deletedAt !== undefined) return isTime(g.deletedAt) ? tombstone(g.id, g.deletedAt) : null
  if (typeof g.name !== 'string' || !isTime(g.namedAt) || !Array.isArray(g.members)) return null
  const members = (g.members as (Partial<Member> | null)[])
    .filter((m): m is Member => typeof m?.infoHash === 'string' && !!m.infoHash && isTime(m.at))
    .map((m): Member => (m.out === true ? { infoHash: m.infoHash, at: m.at, out: true } : { infoHash: m.infoHash, at: m.at }))
  return { id: g.id, name: g.name, namedAt: g.namedAt, members }
}

const combine = (a: TorrentGroup, b: TorrentGroup): TorrentGroup => {
  if (a.deletedAt !== undefined || b.deletedAt !== undefined) {
    return tombstone(a.id, Math.min(a.deletedAt ?? Infinity, b.deletedAt ?? Infinity))
  }
  const named = a.namedAt !== b.namedAt ? (a.namedAt > b.namedAt ? a : b) : (a.name > b.name ? a : b)
  return { id: a.id, name: named.name, namedAt: named.namedAt, members: [...a.members, ...b.members] }
}

const laterMember = (a: Member, b: Member): Member => (a.at !== b.at ? (a.at > b.at ? a : b) : (a.out ? a : b))

const canonical = (g: TorrentGroup): TorrentGroup => {
  const byHash = new Map<string, Member>()
  for (const m of g.members) {
    const was = byHash.get(m.infoHash)
    byHash.set(m.infoHash, was ? laterMember(was, m) : m)
  }
  return { ...g, members: [...byHash.values()].sort((a, b) => order(a.infoHash, b.infoHash)) }
}

/**
 * The one rule for combining copies of the groups, from this browser, other tabs and the account.
 *
 * Deleted wins, with the earliest `deletedAt`. The later name wins, and on a tie the larger string.
 * Per torrent, the later change wins, and on a tie taken out wins. The result is sorted (groups by
 * id, members by info hash), so the same copies merged in any order, grouping or number of times give
 * the same JSON. Each source is checked, since one is account JSON written by any version: a record
 * or entry that is malformed is dropped.
 */
export const mergeGroups = (...sources: unknown[]): TorrentGroup[] => {
  const byId = new Map<string, TorrentGroup>()
  for (const source of sources) {
    if (!Array.isArray(source)) continue
    for (const raw of source) {
      const group = checked(raw)
      if (!group) continue
      const was = byId.get(group.id)
      byId.set(group.id, was ? combine(was, group) : group)
    }
  }
  return [...byId.values()].map(canonical).sort((a, b) => order(a.id, b.id))
}

/** The info hashes a group holds now. */
export const torrentsIn = (group: TorrentGroup): Set<string> =>
  new Set(group.members.filter((m) => !m.out).map((m) => m.infoHash))

let shown: TorrentGroup[] | undefined
const listeners = new Set<() => void>()
let channel: BroadcastChannel | undefined

// a shared name keeps mergeGroups' id order, since a sort is stable
const byName = (a: TorrentGroup, b: TorrentGroup) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

// no read sequence needed: IndexedDB orders a write between two reads after the first and before the second
const reread = async () => {
  const tag = await syncedTag()
  const stored = await get<StoredGroups>(GROUPS_KEY).catch(() => undefined)
  shown = mergeGroups(heldFor(stored, tag)).filter((g) => g.deletedAt === undefined).sort(byName)
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

/**
 * Calls `listener` whenever the groups may have changed: an edit in this tab, or a notice from another.
 * A BroadcastChannel never delivers to the object that posted, so this tab's own edits are announced
 * here directly.
 */
export const subscribeGroups = (listener: () => void): (() => void) => {
  channelOf()
  listeners.add(listener)
  if (listeners.size === 1) void reread()
  return () => { listeners.delete(listener) }
}

/** The groups that are not deleted, sorted by name; undefined until this browser's copy has been read. */
export const useGroups = (): TorrentGroup[] | undefined => useSyncExternalStore(subscribeGroups, () => shown)

/**
 * One edit: the changed record merged into what is stored, inside one readwrite transaction, so two
 * tabs editing at once cannot lose each other's change.
 */
const write = async (change: (groups: TorrentGroup[]) => TorrentGroup | undefined): Promise<void> => {
  const tag = await syncedTag()
  let changed = false
  await update<StoredGroups | undefined>(GROUPS_KEY, (stored) => {
    const groups = mergeGroups(heldFor(stored, tag))
    const next = change(groups)
    if (!next) return stored
    changed = true
    return { account: tag ?? stored?.account ?? null, groups: mergeGroups(groups, [next]) }
  })
  if (changed) await announce()
}

/**
 * Makes this browser's copy the one of the account `tag` names, with `incoming` (the account's own copy, any
 * JSON) merged in, and resolves to the result. A copy tagged with another account counts as empty, and so does
 * any copy when `fresh` (the sync just switched accounts); a copy with no account yet is adopted. Every tab is
 * told when it changed. Nothing is written for a person with no groups, so no tag of their account is kept.
 */
export const takeGroups = async (tag: string | null, incoming: unknown, fresh = false): Promise<TorrentGroup[]> => {
  let groups: TorrentGroup[] = []
  let changed = false
  await update<StoredGroups | undefined>(GROUPS_KEY, (stored) => {
    groups = mergeGroups(fresh ? [] : heldFor(stored, tag), incoming)
    const next: StoredGroups = { account: tag ?? stored?.account ?? null, groups }
    changed = (!!stored || groups.length > 0) && JSON.stringify(next) !== JSON.stringify(stored)
    return changed ? next : stored
  })
  if (changed) await announce()
  return groups
}

const latest = (g: TorrentGroup) => g.members.reduce((at, m) => Math.max(at, m.at), g.namedAt)

/**
 * An edit of a group this browser holds and has not deleted; on any other id it does nothing, so a
 * tab still holding a record from before an account switch cannot write it back. Stamped after the
 * record's latest time, so a device whose clock is slow can still undo a change it has just seen.
 */
const editGroup = (id: string, change: (group: TorrentGroup, at: number) => TorrentGroup | undefined) =>
  write((groups) => {
    const group = groups.find((g) => g.id === id && g.deletedAt === undefined)
    return group && change(group, Math.max(Date.now(), latest(group) + 1))
  })

const newId = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12)))).replace(/\+/g, '-').replace(/\//g, '_')

/**
 * A name as a group keeps it: trimmed, and cut to its first 200 code points, so a link someone sent cannot store a
 * name of megabytes. Empty for a name that is blank.
 */
export const groupName = (name: string): string => name.trim().replace(/^([\s\S]{200})[\s\S]+/u, '$1').trimEnd()

/** Makes a group of these torrents. Resolves to its id once stored, or null for a name that is empty once trimmed. */
export const createGroup = async (name: string, infoHashes: readonly string[]): Promise<string | null> => {
  const clean = groupName(name)
  if (!clean) return null
  const id = newId()
  const at = Date.now()
  await write(() => ({ id, name: clean, namedAt: at, members: infoHashes.map((infoHash) => ({ infoHash, at })) }))
  return id
}

/** A name that is empty once trimmed is not saved. */
export const renameGroup = (id: string, name: string) => {
  const clean = groupName(name)
  return editGroup(id, (g, at) => (clean && clean !== g.name ? { ...g, name: clean, namedAt: at } : undefined))
}

export const putInGroup = (id: string, infoHashes: readonly string[]) =>
  editGroup(id, (g, at) => {
    const held = torrentsIn(g)
    const fresh = infoHashes.filter((h) => !held.has(h))
    return fresh.length ? { ...g, members: [...g.members, ...fresh.map((infoHash) => ({ infoHash, at }))] } : undefined
  })

export const takeOutOfGroup = (id: string, infoHashes: readonly string[]) =>
  editGroup(id, (g, at) => {
    const held = torrentsIn(g)
    const leaving = infoHashes.filter((h) => held.has(h))
    return leaving.length ? { ...g, members: [...g.members, ...leaving.map((infoHash): Member => ({ infoHash, at, out: true }))] } : undefined
  })

/** Its torrents stay in the list. */
export const deleteGroup = (id: string) => editGroup(id, (g, at) => tombstone(g.id, at))
