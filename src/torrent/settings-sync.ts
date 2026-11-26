import { useEffect, useState } from 'react'
import { get, set, update } from 'idb-keyval'
import { account, cloud } from '@fkn/lib'

import type { ListFilter, ListGroup, SortDir, SortKey, ViewMode } from './list-view'
import type { RateLimits } from './rate-limits'
import type { SeedingPolicy } from './seeding-policy'

import { OFFERED, pickLanguage, readPickedLanguage } from '../i18n'
import { NORMALIZE_VOLUME_KEY, normalizeVolumeSaved } from '../router/normalize-volume'
import { AUDIO_LANGUAGE_KEY, OFF, SUBTITLE_LANGUAGE_KEY } from '../router/track-languages'
import { ADD_DIALOG_KEY, dialogEnabled } from './add-options'
import * as clientModule from './client'
import { PLAYER_VOLUME_KEY } from './constants'
import { accountTag } from './groups'
import {
  DEFAULT_SORT, FILTERS, LIST_COLLAPSED_KEY, LIST_EXPANDED_GROUPS_KEY, LIST_FILTER_KEY, LIST_GROUPS, LIST_SORT_KEY,
  LIST_VIEW_KEY, NO_EXPANDED, SORT_LABEL, readCollapsed, readExpandedGroups, readFilter, readSort,
  readView, writeCollapsed, writeExpandedGroups, writeSort,
} from './list-view'
import { NO_LIMITS, RATE_LIMITS_KEY, isLimit, normalizeLimits } from './rate-limits'
import { SAVE_LOCATION_KEY, readGlobalDefault } from './save-location'
import {
  DEFAULT_SEEDING_POLICY, SEEDING_POLICY_KEY, isSeedMinutes, isSeedRatio, readSeedingPolicy, sameSeedingPolicy,
  writeSeedingPolicy,
} from './seeding-policy'
import { storeVpn, vpnOffAvailable, vpnOn } from './vpn-setting'

export const SETTINGS_SYNC_PATH = 'ripple/settings.json'
export const SETTINGS_SYNC_KEY = 'ripple:settings-sync'
export const LEGACY_VPN_SYNC_PATH = 'ripple/vpn.json'
export const LEGACY_VPN_SYNC_KEY = 'ripple:vpn-sync'

export const DOCK_HEIGHT_KEY = 'ripple:dock-height'
export const MIN_DOCK_HEIGHT = 140
export const MAX_DOCK_HEIGHT = 720
export const DEFAULT_DOCK_HEIGHT = 300
export const CONFIRM_REMOVE_KEY = 'ripple:confirm-remove'
export const VPN_REMEMBERED_KEY = 'ripple:vpn-off-remembered'

const BROKER_TIMEOUT = 10_000
const ACCOUNT_TIMEOUT = 4_000
const FOCUS_COOLDOWN_MS = 1_500
const SIGNED_OUT_COOLDOWN_MS = 30_000
const POLL_INTERVAL_MS = 30_000
const RETRY_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000]
const MAX_RERUNS = 3

export type PlayerVolume = { volume: number, muted: boolean }
export type ListSort = { key: SortKey, dir: SortDir }

export type SettingsValues = {
  vpn: boolean
  vpnWarningRemembered: boolean
  language: string | null
  addDialog: boolean
  seedingPolicy: SeedingPolicy
  rateLimits: RateLimits
  saveLocation: 'browser' | 'folder'
  confirmRemove: boolean
  normalizeVolume: boolean
  playerVolume: PlayerVolume
  audioLanguage: string | null
  subtitleLanguage: string | null
  listFilter: ListFilter
  listSort: ListSort
  listView: ViewMode
  listCollapsed: ListGroup[]
  listExpandedGroups: string[]
  dockHeight: number
}

export type SettingKey = keyof SettingsValues
export type SyncedEntry<T = unknown> = { value: T, updatedAt: number, signedOut?: true }
export type SyncedEntries = { [K in SettingKey]?: SyncedEntry<SettingsValues[K]> }
export type PendingVpnOff = { account: string, updatedAt: number }
export type StoredSettingsSync = {
  account: string | null
  entries: SyncedEntries
  declinedVpnOffAt?: number
  legacyVpnChecked?: boolean
}
export type ParsedSettingsSync = { entries: SyncedEntries, extra: Record<string, SyncedEntry> }
export type SettingsSyncOutcome = 'signed-out' | 'locked' | 'stale' | 'retry' | 'synced'

export type SettingsSyncResolution = {
  record: StoredSettingsSync
  cloudPayload: Record<string, SyncedEntry>
  apply: Partial<SettingsValues>
  writeCloud: boolean
  pendingVpnOffAt?: number
}

const DEFAULT_PLAYER_VOLUME: PlayerVolume = { volume: 1, muted: false }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isListGroup = (value: unknown): value is ListGroup =>
  (LIST_GROUPS as readonly unknown[]).includes(value)

const isTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const arraysEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, i) => item === b[i])

const canonicalCollapsed = (groups: readonly ListGroup[]): ListGroup[] => {
  const picked = new Set(groups)
  return LIST_GROUPS.filter((group) => picked.has(group))
}

const canonicalExpanded = (ids: readonly string[]): string[] =>
  [...new Set(ids)].sort()

const cleanLanguageTag = (value: unknown): string | null | undefined => {
  if (value === null) return null
  if (typeof value === 'string' && value.length > 0 && value.length <= 64) return value
  return undefined
}

const parseSeedingPolicyStrict = (raw: unknown): SeedingPolicy | undefined => {
  if (!isRecord(raw)) return undefined
  if ('mode' in raw) {
    if (raw.mode === 'keep' || raw.mode === 'stop') return DEFAULT_SEEDING_POLICY
    if (raw.mode === 'ratio' && isSeedRatio(raw.ratio)) {
      const ratio = Math.round(raw.ratio * 10_000) / 10_000
      return isSeedRatio(ratio) ? { ratio, minutes: null } : undefined
    }
    if (raw.mode === 'duration' && isSeedMinutes(raw.minutes)) {
      return { ratio: null, minutes: raw.minutes }
    }
    return undefined
  }
  let ratio: number | null
  if (raw.ratio === null || raw.ratio === undefined) ratio = null
  else if (isSeedRatio(raw.ratio)) {
    const rounded = Math.round(raw.ratio * 10_000) / 10_000
    if (!isSeedRatio(rounded)) return undefined
    ratio = rounded
  } else {
    return undefined
  }
  let minutes: number | null
  if (raw.minutes === null || raw.minutes === undefined) minutes = null
  else if (isSeedMinutes(raw.minutes)) minutes = raw.minutes
  else return undefined
  return ratio === null && minutes === null ? DEFAULT_SEEDING_POLICY : { ratio, minutes }
}

/** Clamps a detail dock height into its allowed `[MIN_DOCK_HEIGHT, MAX_DOCK_HEIGHT]` range. */
export const clampDockHeight = (value: number): number =>
  Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, Math.round(value)))

const safeGetItem = (key: string): string | null => {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

const safeSetItem = (key: string, value: string): void => {
  try { globalThis.localStorage?.setItem(key, value) } catch {}
}

const safeRemoveItem = (key: string): void => {
  try { globalThis.localStorage?.removeItem(key) } catch {}
}

const clientApi: {
  setVpn?: typeof clientModule.setVpn
  runningTorrentClient?: typeof clientModule.runningTorrentClient
} = clientModule

// Tracks the latest rate-limit write (local or remote) while an engine worker commits RATE_LIMITS_KEY on its serialized lane;
// cleared once IDB matches, sync IDB is reset/replaced, a non-worker write runs, or the account switches.
let pendingWorkerRateLimits: RateLimits | null = null

const readLocalPlayerVolume = (): PlayerVolume => {
  try {
    const raw = JSON.parse(safeGetItem(PLAYER_VOLUME_KEY) ?? '{}')
    return SETTINGS_SPEC.playerVolume.parse(raw) ?? DEFAULT_PLAYER_VOLUME
  } catch {
    return DEFAULT_PLAYER_VOLUME
  }
}

const readLocalDockHeight = (): number => {
  const raw = safeGetItem(DOCK_HEIGHT_KEY)
  if (!raw) return DEFAULT_DOCK_HEIGHT
  return SETTINGS_SPEC.dockHeight.parse(Number(raw)) ?? DEFAULT_DOCK_HEIGHT
}

const migrateLegacyStored = async (): Promise<StoredSettingsSync | undefined> => {
  const current = await get<StoredSettingsSync>(SETTINGS_SYNC_KEY)
  if (current) return current
  const legacy = await get<{ account?: string | null, on?: boolean, updatedAt?: number }>(LEGACY_VPN_SYNC_KEY)
  if (!legacy || typeof legacy.on !== 'boolean' || !isTimestamp(legacy.updatedAt)) return undefined
  const migrated: StoredSettingsSync = {
    account: typeof legacy.account === 'string' ? legacy.account : null,
    entries: { vpn: { value: legacy.on, updatedAt: legacy.updatedAt } },
  }
  let committed: StoredSettingsSync | undefined = migrated
  await update<StoredSettingsSync | undefined>(SETTINGS_SYNC_KEY, (prev) => {
    committed = prev ?? migrated
    return committed
  })
  return committed
}

type SettingSpec<K extends SettingKey> = {
  default: SettingsValues[K]
  parse: (raw: unknown) => SettingsValues[K] | undefined
  equal: (a: SettingsValues[K], b: SettingsValues[K]) => boolean
  read: () => SettingsValues[K] | Promise<SettingsValues[K]>
  write: (value: SettingsValues[K]) => SettingsValues[K] | Promise<SettingsValues[K]>
}

const boolEqual = (a: boolean, b: boolean) => a === b
const scalarEqual = <T>(a: T, b: T) => a === b
const boolParse = (raw: unknown) => (typeof raw === 'boolean' ? raw : undefined)

const SETTINGS_SPEC: { [K in SettingKey]: SettingSpec<K> } = {
  vpn: {
    default: true,
    parse: boolParse,
    equal: boolEqual,
    read: () => vpnOn(),
    write: async (val) => {
      await clientApi.setVpn?.(val)
      if (vpnOn() !== val) storeVpn(val)
      return vpnOn()
    },
  },
  vpnWarningRemembered: {
    default: false,
    parse: boolParse,
    equal: boolEqual,
    read: () => safeGetItem(VPN_REMEMBERED_KEY) === '1',
    write: (val) => {
      if (val) safeSetItem(VPN_REMEMBERED_KEY, '1')
      else safeRemoveItem(VPN_REMEMBERED_KEY)
      return val
    },
  },
  language: {
    default: null,
    parse: (raw) => (raw === null ? null : typeof raw === 'string' && OFFERED.includes(raw) ? raw : undefined),
    equal: scalarEqual,
    read: () => readPickedLanguage() ?? null,
    write: async (val) => {
      await pickLanguage(val ?? undefined).catch(() => {})
      return val
    },
  },
  addDialog: {
    default: false,
    parse: boolParse,
    equal: boolEqual,
    read: () => dialogEnabled(safeGetItem),
    write: (val) => {
      safeSetItem(ADD_DIALOG_KEY, val ? '1' : '0')
      return val
    },
  },
  seedingPolicy: {
    default: DEFAULT_SEEDING_POLICY,
    parse: parseSeedingPolicyStrict,
    equal: sameSeedingPolicy,
    read: () => readSeedingPolicy(safeGetItem),
    write: (val) => {
      const saved = writeSeedingPolicy(val)
      const client = clientApi.runningTorrentClient?.()
      if (client) {
        client.setSeedingPolicy(saved)
        return saved
      }
      return set(SEEDING_POLICY_KEY, saved).catch(() => {}).then(() => saved)
    },
  },
  rateLimits: {
    default: NO_LIMITS,
    parse: (raw) => (isRecord(raw) && isLimit(raw.down) && isLimit(raw.up) ? { down: raw.down, up: raw.up } : undefined),
    equal: (a, b) => a.down === b.down && a.up === b.up,
    read: async () => {
      const storedLimits = await get<unknown>(RATE_LIMITS_KEY).catch(() => undefined)
      const normalizedIdb = storedLimits !== undefined ? normalizeLimits(storedLimits) : undefined
      if (pendingWorkerRateLimits) {
        if (normalizedIdb && SETTINGS_SPEC.rateLimits.equal(normalizedIdb, pendingWorkerRateLimits)) {
          pendingWorkerRateLimits = null
          return normalizedIdb
        }
        const storedSync = await migrateLegacyStored().catch(() => undefined)
        const syncedRate = storedSync?.entries?.rateLimits?.value
        if (syncedRate && SETTINGS_SPEC.rateLimits.equal(syncedRate, pendingWorkerRateLimits)) {
          return pendingWorkerRateLimits
        }
        pendingWorkerRateLimits = null
      }
      if (normalizedIdb) return normalizedIdb
      const storedSync = await migrateLegacyStored().catch(() => undefined)
      if (storedSync?.entries?.rateLimits) return normalizeLimits(storedSync.entries.rateLimits.value)
      return clientApi.runningTorrentClient?.()?.latestRateLimits() ?? NO_LIMITS
    },
    write: async (val) => {
      const normalized = normalizeLimits(val)
      const client = clientApi.runningTorrentClient?.()
      if (client) client.setSessionLimits(normalized)
      // Worker is the sole IDB writer of RATE_LIMITS_KEY while an engine session is running.
      const startedFn = client ? Reflect.get(client, 'started') : undefined
      if (typeof startedFn === 'function' && Boolean((startedFn as () => boolean).call(client))) {
        pendingWorkerRateLimits = normalized
      } else {
        pendingWorkerRateLimits = null
        await update(RATE_LIMITS_KEY, () => normalized).catch(() => {})
      }
      return normalized
    },
  },
  saveLocation: {
    default: 'browser',
    parse: (raw) => (raw === 'browser' || raw === 'folder' ? raw : undefined),
    equal: scalarEqual,
    read: () => (readGlobalDefault(safeGetItem) === 'folder' ? 'folder' : 'browser'),
    write: (val) => {
      safeSetItem(SAVE_LOCATION_KEY, val)
      return val
    },
  },
  confirmRemove: {
    default: false,
    parse: boolParse,
    equal: boolEqual,
    read: () => safeGetItem(CONFIRM_REMOVE_KEY) === 'skip',
    write: (val) => {
      if (val) safeSetItem(CONFIRM_REMOVE_KEY, 'skip')
      else safeRemoveItem(CONFIRM_REMOVE_KEY)
      return val
    },
  },
  normalizeVolume: {
    default: true,
    parse: boolParse,
    equal: boolEqual,
    read: () => normalizeVolumeSaved(safeGetItem),
    write: (val) => {
      safeSetItem(NORMALIZE_VOLUME_KEY, val ? '1' : '0')
      return val
    },
  },
  playerVolume: {
    default: DEFAULT_PLAYER_VOLUME,
    parse: (raw) => (
      isRecord(raw)
      && typeof raw.volume === 'number'
      && Number.isFinite(raw.volume)
      && raw.volume >= 0
      && raw.volume <= 1
      && typeof raw.muted === 'boolean'
        ? { volume: raw.volume, muted: raw.muted }
        : undefined
    ),
    equal: (a, b) => a.volume === b.volume && a.muted === b.muted,
    read: () => readLocalPlayerVolume(),
    write: (val) => {
      safeSetItem(PLAYER_VOLUME_KEY, JSON.stringify(val))
      return val
    },
  },
  audioLanguage: {
    default: null,
    parse: cleanLanguageTag,
    equal: scalarEqual,
    read: () => cleanLanguageTag(safeGetItem(AUDIO_LANGUAGE_KEY)) ?? null,
    write: (val) => {
      if (val) safeSetItem(AUDIO_LANGUAGE_KEY, val)
      else safeRemoveItem(AUDIO_LANGUAGE_KEY)
      return val
    },
  },
  subtitleLanguage: {
    default: null,
    parse: cleanLanguageTag,
    equal: scalarEqual,
    read: () => cleanLanguageTag(safeGetItem(SUBTITLE_LANGUAGE_KEY)) ?? null,
    write: (val) => {
      if (val) safeSetItem(SUBTITLE_LANGUAGE_KEY, val === OFF ? OFF : val)
      else safeRemoveItem(SUBTITLE_LANGUAGE_KEY)
      return val
    },
  },
  listFilter: {
    default: 'all',
    parse: (raw) => ((FILTERS as readonly unknown[]).includes(raw) ? raw as ListFilter : undefined),
    equal: scalarEqual,
    read: () => readFilter(safeGetItem),
    write: (val) => {
      safeSetItem(LIST_FILTER_KEY, val)
      return val
    },
  },
  listSort: {
    default: DEFAULT_SORT,
    parse: (raw) => (
      isRecord(raw) && typeof raw.key === 'string' && raw.key in SORT_LABEL && (raw.dir === 'asc' || raw.dir === 'desc')
        ? { key: raw.key as SortKey, dir: raw.dir }
        : undefined
    ),
    equal: (a, b) => a.key === b.key && a.dir === b.dir,
    read: () => readSort(safeGetItem),
    write: (val) => {
      safeSetItem(LIST_SORT_KEY, writeSort(val.key, val.dir))
      return val
    },
  },
  listView: {
    default: 'cards',
    parse: (raw) => (raw === 'cards' || raw === 'table' ? raw : undefined),
    equal: scalarEqual,
    read: () => readView(safeGetItem),
    write: (val) => {
      safeSetItem(LIST_VIEW_KEY, val)
      return val
    },
  },
  listCollapsed: {
    default: [],
    parse: (raw) => (Array.isArray(raw) && raw.every(isListGroup) ? canonicalCollapsed(raw) : undefined),
    equal: arraysEqual,
    read: () => LIST_GROUPS.filter((g) => readCollapsed(safeGetItem).has(g)),
    write: (val) => {
      const next = canonicalCollapsed(val)
      const serialized = writeCollapsed(new Set(next))
      if (serialized) safeSetItem(LIST_COLLAPSED_KEY, serialized)
      else safeRemoveItem(LIST_COLLAPSED_KEY)
      return next
    },
  },
  listExpandedGroups: {
    default: [],
    parse: (raw) => (
      Array.isArray(raw) && raw.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
        ? canonicalExpanded(raw)
        : undefined
    ),
    equal: arraysEqual,
    read: () => canonicalExpanded([...readExpandedGroups(safeGetItem)]),
    write: (val) => {
      const next = canonicalExpanded(val)
      const expanded = next.length ? new Set(next) : NO_EXPANDED
      const serialized = expanded.size ? writeExpandedGroups(expanded) : ''
      if (serialized) safeSetItem(LIST_EXPANDED_GROUPS_KEY, serialized)
      else safeRemoveItem(LIST_EXPANDED_GROUPS_KEY)
      return next
    },
  },
  dockHeight: {
    default: DEFAULT_DOCK_HEIGHT,
    parse: (raw) => (
      typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= MIN_DOCK_HEIGHT && raw <= MAX_DOCK_HEIGHT
        ? raw
        : undefined
    ),
    equal: scalarEqual,
    read: () => readLocalDockHeight(),
    write: (val) => {
      const height = clampDockHeight(val)
      safeSetItem(DOCK_HEIGHT_KEY, String(height))
      return height
    },
  },
}

export const SYNCED_SETTING_KEYS = Object.keys(SETTINGS_SPEC) as SettingKey[]

export const DEFAULT_SETTINGS = Object.fromEntries(
  SYNCED_SETTING_KEYS.map((key) => [key, SETTINGS_SPEC[key].default]),
) as SettingsValues

const isKnownKey = (key: string): key is SettingKey => key in SETTINGS_SPEC

export const equalSetting = <K extends SettingKey>(key: K, a: SettingsValues[K], b: SettingsValues[K]): boolean =>
  SETTINGS_SPEC[key].equal(a, b)

/**
 * Parses a cloud `ripple/settings.json` payload. Unparseable known keys with valid `updatedAt` timestamps
 * stay inside `extra` so older clients never overwrite newer enum, filter, or schema additions on `cloud.fs`.
 */
export const parseSettingsSync = (raw: unknown): ParsedSettingsSync | null => {
  if (!isRecord(raw)) return null
  const entries: SyncedEntries = {}
  const extra: Record<string, SyncedEntry> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!isRecord(item) || !('value' in item) || !isTimestamp(item.updatedAt)) continue
    if (isKnownKey(key)) {
      const parsed = SETTINGS_SPEC[key].parse(item.value)
      if (parsed !== undefined) {
        ;(entries as Record<string, SyncedEntry>)[key] = { value: parsed, updatedAt: item.updatedAt }
      } else {
        extra[key] = { value: item.value, updatedAt: item.updatedAt }
      }
    } else {
      extra[key] = { value: item.value, updatedAt: item.updatedAt }
    }
  }
  return { entries, extra }
}

/** Parses a legacy `ripple/vpn.json` record for migration when `ripple/settings.json` does not exist yet. */
export const parseLegacyVpnSync = (raw: unknown): { on: boolean, updatedAt: number } | null => {
  if (!isRecord(raw) || typeof raw.on !== 'boolean' || !isTimestamp(raw.updatedAt)) return null
  return { on: raw.on, updatedAt: raw.updatedAt }
}

const sameEntry = <K extends SettingKey>(key: K, a: SyncedEntry<SettingsValues[K]> | undefined, b: SyncedEntry<SettingsValues[K]> | undefined): boolean =>
  a === b || (!!a && !!b && a.updatedAt === b.updatedAt && !!a.signedOut === !!b.signedOut && equalSetting(key, a.value, b.value))

const cleanEntry = <T>(entry: SyncedEntry<T>): SyncedEntry<T> => ({ value: entry.value, updatedAt: entry.updatedAt })

const sameStored = (a: StoredSettingsSync | undefined, b: StoredSettingsSync | undefined): boolean => {
  if (a === b) return true
  if (!a || !b || a.account !== b.account) return false
  if (a.declinedVpnOffAt !== b.declinedVpnOffAt) return false
  if (!!a.legacyVpnChecked !== !!b.legacyVpnChecked) return false
  return SYNCED_SETTING_KEYS.every((key) => sameEntry(key, a.entries[key], b.entries[key]))
}

/**
 * Reconciles every portable setting between local storage (`local`, `stored`) and `cloud.fs`
 * (`remote`, `extra`) per key using LWW timestamps, discarding prior-account state on switch,
 * preserving unrecognized future values in `extra`, and requiring local confirmation for `vpn: false`.
 */
export const resolveSettingsSync = ({
  account: accountId,
  local,
  stored,
  remote,
  extra = {},
  vpnOffAvailable: hasWebRtc = true,
  migratedFromLegacyVpn = false,
  preserveLocalKeys,
  legacyVpnChecked,
  now = Date.now(),
}: {
  account: string
  local: SettingsValues
  stored: StoredSettingsSync | undefined
  remote: SyncedEntries | null
  extra?: Record<string, SyncedEntry>
  vpnOffAvailable?: boolean
  migratedFromLegacyVpn?: boolean
  preserveLocalKeys?: ReadonlySet<SettingKey>
  legacyVpnChecked?: boolean
  now?: number
}): SettingsSyncResolution => {
  const nextEntries: SyncedEntries = {}
  const nextExtra: Record<string, SyncedEntry> = { ...extra }
  const apply: Partial<SettingsValues> = {}
  let writeCloud = migratedFromLegacyVpn
  const remoteEntries = remote ?? {}
  const accountSwitched = !!stored?.account && stored.account !== accountId
  const signedOutCarryover = !stored?.account
  let nextDeclinedVpnOffAt: number | undefined = accountSwitched ? undefined : stored?.declinedVpnOffAt
  let pendingVpnOffAt: number | undefined
  let cloudVpnOverride: SyncedEntry<boolean> | undefined

  const setNext = (key: SettingKey, entry: SyncedEntry) => {
    ;(nextEntries as Record<string, SyncedEntry>)[key] = cleanEntry(entry)
  }
  const setApply = (key: SettingKey, value: unknown) => {
    ;(apply as Record<string, unknown>)[key] = value
  }
  const handleRemoteVpnOff = (r: SyncedEntry<boolean>, localVpn: boolean, storedVpn: SyncedEntry<boolean> | undefined) => {
    if (localVpn) {
      if (nextDeclinedVpnOffAt !== r.updatedAt) pendingVpnOffAt = r.updatedAt
      // Preserve cloud's vpn: false across unrelated writes without marking this device locally false.
      cloudVpnOverride = r
      if (storedVpn && !storedVpn.signedOut && !signedOutCarryover) setNext('vpn', storedVpn)
    } else {
      setNext('vpn', r)
      nextDeclinedVpnOffAt = undefined
    }
  }

  for (const key of SYNCED_SETTING_KEYS) {
    const r = remoteEntries[key]
    if (key === 'vpn' && !hasWebRtc) {
      if (r) setNext('vpn', r)
      continue
    }
    const defaultVal = DEFAULT_SETTINGS[key]
    const localVal = local[key]
    const remoteExtra = nextExtra[key]
    const s = stored?.entries[key]

    // Switching accounts OR signing in with a prior or unrecorded signed-out vpn=false choice:
    // never push signed-out vpn=false to cloud.fs or apply remote vpn=false without local confirmation.
    const isSignedOutVpnOff = key === 'vpn' && !preserveLocalKeys?.has('vpn') && (
      s?.signedOut === true
      || (!s && localVal === false)
      || (signedOutCarryover && s?.value === false)
    )
    if (key === 'vpn' && ((accountSwitched && !preserveLocalKeys?.has('vpn')) || isSignedOutVpnOff)) {
      const rv = r as SyncedEntry<boolean> | undefined
      if (rv) {
        if (rv.value) {
          setNext('vpn', rv)
          if (localVal !== true) setApply('vpn', true)
          nextDeclinedVpnOffAt = undefined
        } else {
          handleRemoteVpnOff(rv, localVal as boolean, s as SyncedEntry<boolean> | undefined)
        }
      } else if (!remoteExtra) {
        setNext('vpn', { value: true, updatedAt: 0 })
        if (localVal !== true) setApply('vpn', true)
        nextDeclinedVpnOffAt = undefined
      }
      continue
    }

    if (accountSwitched && !preserveLocalKeys?.has(key)) {
      if (remoteExtra) continue
      const winnerVal = r ? r.value : defaultVal
      if (r) setNext(key, r)
      if (!equalSetting(key, winnerVal, localVal)) setApply(key, winnerVal)
      continue
    }

    let candidate: SyncedEntry<SettingsValues[typeof key]>
    if (s && equalSetting(key, s.value, localVal)) {
      candidate = s
    } else if (r && equalSetting(key, localVal, r.value)) {
      candidate = r
    } else if (!equalSetting(key, localVal, defaultVal)) {
      candidate = { value: localVal, updatedAt: r || remoteExtra ? 0 : now }
    } else {
      candidate = { value: defaultVal, updatedAt: 0 }
    }

    if (remoteExtra) {
      if (s && candidate.updatedAt > remoteExtra.updatedAt) {
        delete nextExtra[key]
        setNext(key, candidate)
        writeCloud = true
        if (key === 'vpn') nextDeclinedVpnOffAt = undefined
      }
      continue
    }

    const remoteAt = r ? r.updatedAt : 0
    if (candidate.updatedAt > remoteAt) {
      setNext(key, candidate)
      writeCloud = true
      if (key === 'vpn') nextDeclinedVpnOffAt = undefined
    } else if (remoteAt > candidate.updatedAt && r) {
      if (key === 'vpn') {
        const rv = r as SyncedEntry<boolean>
        if (rv.value) {
          setNext('vpn', rv)
          if (localVal !== true) setApply('vpn', true)
          nextDeclinedVpnOffAt = undefined
        } else {
          handleRemoteVpnOff(rv, localVal as boolean, s as SyncedEntry<boolean> | undefined)
        }
      } else {
        setNext(key, r)
        if (!equalSetting(key, r.value, localVal)) setApply(key, r.value)
      }
    } else {
      const remoteVal = r ? r.value : defaultVal
      if (equalSetting(key, candidate.value, remoteVal)) {
        if (r) setNext(key, r)
        else if (candidate.updatedAt > 0 || !equalSetting(key, candidate.value, defaultVal)) setNext(key, candidate)
        if (key === 'vpn' && remoteVal === true) nextDeclinedVpnOffAt = undefined
      } else if (key === 'vpn') {
        if (candidate.value === true) {
          setNext('vpn', { value: true, updatedAt: candidate.updatedAt })
          writeCloud = true
        } else {
          setNext('vpn', { value: true, updatedAt: remoteAt })
          if (localVal !== true) setApply('vpn', true)
        }
        nextDeclinedVpnOffAt = undefined
      } else if (r) {
        setNext(key, r)
        if (!equalSetting(key, r.value, localVal)) setApply(key, r.value)
      }
    }
  }

  const cloudPayload: Record<string, SyncedEntry> = { ...nextExtra }
  for (const key of SYNCED_SETTING_KEYS) {
    const entry = nextEntries[key]
    if (!entry) continue
    if (entry.updatedAt === 0 && equalSetting(key, entry.value, DEFAULT_SETTINGS[key])) continue
    cloudPayload[key] = cleanEntry(entry as SyncedEntry)
  }
  if (cloudVpnOverride) cloudPayload.vpn = cleanEntry(cloudVpnOverride)

  const nextChecked = legacyVpnChecked ?? (!accountSwitched ? stored?.legacyVpnChecked : undefined)
  const record: StoredSettingsSync = {
    account: accountId,
    entries: nextEntries,
    ...(nextDeclinedVpnOffAt !== undefined ? { declinedVpnOffAt: nextDeclinedVpnOffAt } : {}),
    ...(nextChecked ? { legacyVpnChecked: true } : {}),
  }

  return {
    record,
    cloudPayload,
    apply,
    writeCloud,
    ...(pendingVpnOffAt !== undefined ? { pendingVpnOffAt } : {}),
  }
}

export type CloudReadResult =
  | { kind: 'ok', parsed: ParsedSettingsSync, migratedFromLegacyVpn: boolean, legacyChecked?: boolean }
  | { kind: 'absent', legacyChecked?: boolean }
  | { kind: 'locked' }
  | { kind: 'error' }

export type SettingsSyncDeps = {
  vpnOffAvailable: () => boolean
  readLocal: () => Promise<SettingsValues> | SettingsValues
  applyLocal: (patch: Partial<SettingsValues>) => Promise<void> | void
  accountInfo: () => Promise<string | null>
  fsAvailable: () => Promise<boolean | null>
  readCloud: (options?: { account?: string, skipLegacyVpn?: boolean }) => Promise<CloudReadResult>
  writeCloud: (payload: Record<string, SyncedEntry>) => Promise<'ok' | 'locked' | 'error'>
  readStored: () => Promise<StoredSettingsSync | undefined>
  writeStored: (updater: (prev: StoredSettingsSync | undefined) => StoredSettingsSync | undefined) => Promise<void>
  tagAccount: (name: string) => Promise<string | null>
  now: () => number
}

const isLocked = (err: unknown): boolean => (err as { code?: string } | null)?.code === 'FKN_E2E_LOCKED'

const isAbsent = (err: unknown, message: string): boolean =>
  cloud.fs?.isNotFound?.(err) === true
  || (err as { code?: string } | null)?.code === 'FKN_STORAGE_NOT_FOUND'
  || /not found/i.test(message)
  || /\(404\)/.test(message)

const isUnreadable = (err: unknown): boolean => {
  const message = (err as { message?: string } | null)?.message ?? ''
  return message.startsWith('fkn:e2e-integrity') || message.startsWith('fkn:e2e-stale-epoch')
}

const bounded = <T>(work: Promise<T>, fallback: T, ms = BROKER_TIMEOUT): Promise<T> => {
  work.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('broker timed out')), ms)
  })
  return Promise.race([work, timeout])
    .finally(() => { if (timer !== undefined) clearTimeout(timer) })
    .catch((err) => {
      if ((err as Error | null)?.message === 'broker timed out') return fallback
      throw err
    })
}

const highestRemoteAt = (entries: SyncedEntries): number => {
  let maxAt = 0
  for (const key of SYNCED_SETTING_KEYS) {
    const entry = entries[key]
    if (entry && entry.updatedAt > maxAt) maxAt = entry.updatedAt
  }
  return maxAt
}

/**
 * Serialized multi-setting sync controller tying per-key IDB timestamps (`ripple:settings-sync`)
 * to encrypted `cloud.fs` (`ripple/settings.json`), preventing mid-flight clobbers, account-switch leaks,
 * and unconfirmed remote VPN-off changes.
 */
export const createSettingsSyncController = (deps: SettingsSyncDeps) => {
  let accountGen = 0
  let choiceSeq = 0
  const keySeq = new Map<SettingKey, number>()
  let lastSeenRemoteAt = 0
  let pendingAccountSwitch = false
  const postSwitchKeys = new Set<SettingKey>()
  let inFlight: Promise<SettingsSyncOutcome> | null = null
  let rerun = false
  let recordQueue: Promise<void> = Promise.resolve()
  let pendingVpnOff: PendingVpnOff | null = null
  const pendingListeners = new Set<(pending: PendingVpnOff | null) => void>()

  const setPendingVpnOff = (next: PendingVpnOff | null) => {
    const unchanged = (pendingVpnOff?.account ?? null) === (next?.account ?? null)
      && (pendingVpnOff?.updatedAt ?? null) === (next?.updatedAt ?? null)
    if (unchanged) return
    pendingVpnOff = next
    for (const listener of pendingListeners) listener(next)
  }

  const seqOf = (key: SettingKey): number => keySeq.get(key) ?? 0
  const maxEntryAt = (entries: SyncedEntries): number => highestRemoteAt(entries)

  const runOnce = async (): Promise<SettingsSyncOutcome> => {
    const gen = accountGen
    const seqAtStart = new Map<SettingKey, number>(SYNCED_SETTING_KEYS.map((key) => [key, seqOf(key)]))
    const switchAtStart = pendingAccountSwitch
    const preservedAtStart = switchAtStart ? new Set(postSwitchKeys) : undefined

    const [available, name] = await Promise.all([deps.fsAvailable(), deps.accountInfo()])
    if (gen !== accountGen) return 'stale'
    if (available !== true) {
      if (name === null) setPendingVpnOff(null)
      return available === null || name !== null ? 'retry' : 'signed-out'
    }
    if (!name) return 'retry'

    const tag = await deps.tagAccount(name)
    if (gen !== accountGen || !tag) return 'stale'

    const preStored = await deps.readStored().catch(() => undefined)
    if (gen !== accountGen) return 'stale'
    const skipLegacyVpn = preStored?.account === tag && preStored?.legacyVpnChecked === true

    const cloudRead = await deps.readCloud({ account: tag, skipLegacyVpn })
    if (gen !== accountGen) return 'stale'
    if (cloudRead.kind === 'locked') return 'locked'
    if (cloudRead.kind === 'error') return 'retry'
    const remote = cloudRead.kind === 'ok' ? cloudRead.parsed.entries : null
    const extra = cloudRead.kind === 'ok' ? cloudRead.parsed.extra : {}
    const migratedFromLegacyVpn = cloudRead.kind === 'ok' ? cloudRead.migratedFromLegacyVpn : false
    const legacyChecked = cloudRead.legacyChecked || skipLegacyVpn
    if (remote !== null) lastSeenRemoteAt = Math.max(lastSeenRemoteAt, maxEntryAt(remote))

    await recordQueue
    if (gen !== accountGen) return 'stale'
    const changedDuringRead = SYNCED_SETTING_KEYS.filter((key) => seqAtStart.get(key) !== seqOf(key))
    const seqBeforeLocal = choiceSeq
    const [storedRead, local] = await Promise.all([
      deps.readStored().catch(() => undefined),
      Promise.resolve(deps.readLocal()),
    ])
    let stored = storedRead
    if (gen !== accountGen || seqBeforeLocal !== choiceSeq) {
      rerun = true
      return 'stale'
    }

    // Re-stamp any setting changed while this cloud read was in flight so a skewed remote clock cannot undo it.
    if (changedDuringRead.length > 0 && stored && remote) {
      const nextEntries: SyncedEntries = { ...stored.entries }
      let bumpAt = lastSeenRemoteAt
      let needsBump = false
      for (const key of changedDuringRead) {
        const cur = nextEntries[key]
        if (cur && cur.updatedAt <= lastSeenRemoteAt) {
          bumpAt += 1
          ;(nextEntries as Record<SettingKey, SyncedEntry>)[key] = {
            value: cur.value,
            updatedAt: bumpAt,
            ...(cur.signedOut ? { signedOut: true as const } : {}),
          }
          needsBump = true
        }
      }
      if (needsBump) {
        const bumped: StoredSettingsSync = { ...stored, entries: nextEntries }
        let bumpOvertaken = false
        await deps.writeStored((current) => {
          if (!sameStored(current, stored)) {
            bumpOvertaken = true
            return current
          }
          return bumped
        }).catch(() => {})
        if (bumpOvertaken || gen !== accountGen || seqBeforeLocal !== choiceSeq) {
          rerun = true
          return 'stale'
        }
        stored = bumped
      }
    }

    const res = resolveSettingsSync({
      account: tag,
      local,
      stored,
      remote,
      extra,
      vpnOffAvailable: deps.vpnOffAvailable(),
      migratedFromLegacyVpn,
      preserveLocalKeys: preservedAtStart,
      legacyVpnChecked: legacyChecked || undefined,
      now: deps.now(),
    })

    if (res.writeCloud) {
      if (gen !== accountGen || seqBeforeLocal !== choiceSeq) {
        rerun = true
        return 'stale'
      }
      const wrote = await deps.writeCloud(res.cloudPayload)
      if (wrote === 'locked') return 'locked'
      if (wrote === 'error') return 'retry'
    }

    if (gen !== accountGen) return 'stale'
    let overtaken = seqBeforeLocal !== choiceSeq
    if (!overtaken && !sameStored(stored, res.record)) {
      await deps.writeStored((current) => {
        if (seqBeforeLocal !== choiceSeq || !sameStored(current, stored)) {
          overtaken = true
          return current
        }
        return res.record
      }).catch(() => {})
    }
    if (overtaken || gen !== accountGen || seqBeforeLocal !== choiceSeq) {
      if (overtaken || seqBeforeLocal !== choiceSeq) rerun = true
      return 'stale'
    }
    if (switchAtStart && gen === accountGen) {
      pendingAccountSwitch = false
      postSwitchKeys.clear()
    }

    if (Object.keys(res.apply).length > 0) await deps.applyLocal(res.apply)
    setPendingVpnOff(res.pendingVpnOffAt !== undefined ? { account: tag, updatedAt: res.pendingVpnOffAt } : null)
    return 'synced'
  }

  const sync = (): Promise<SettingsSyncOutcome> => {
    if (inFlight) {
      rerun = true
      return inFlight
    }
    const run = (async (): Promise<SettingsSyncOutcome> => {
      let last: SettingsSyncOutcome = 'synced'
      let attempts = 0
      do {
        rerun = false
        last = await runOnce()
        attempts += 1
      } while (rerun && attempts < MAX_RERUNS)
      return last
    })().finally(() => { inFlight = null })
    inFlight = run
    return run
  }

  const recordChoice = async <K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<SettingsSyncOutcome> => {
    if (key === 'vpn' && !deps.vpnOffAvailable()) return 'synced'
    choiceSeq += 1
    keySeq.set(key, seqOf(key) + 1)
    if (key === 'vpn') setPendingVpnOff(null)
    if (pendingAccountSwitch) postSwitchKeys.add(key)
    const stamp = Math.max(deps.now(), lastSeenRemoteAt + 1)
    recordQueue = recordQueue.then(async () => {
      const accountName = await deps.accountInfo().catch(() => null)
      const activeTag = accountName ? await deps.tagAccount(accountName).catch(() => null) : null
      await deps.writeStored((prev) => {
        const prevEntries = prev?.entries ?? {}
        const prevMax = maxEntryAt(prevEntries)
        const nextEntries: SyncedEntries = { ...prevEntries }
        ;(nextEntries as Record<SettingKey, SyncedEntry>)[key] = {
          value,
          updatedAt: Math.max(stamp, prevMax + 1),
          ...(key === 'vpn' && value === false && !activeTag ? { signedOut: true as const } : {}),
        }
        const declinedVpnOffAt = key === 'vpn' ? undefined : prev?.declinedVpnOffAt
        return {
          account: prev?.account ?? activeTag ?? null,
          entries: nextEntries,
          ...(declinedVpnOffAt !== undefined ? { declinedVpnOffAt } : {}),
          ...(prev?.legacyVpnChecked ? { legacyVpnChecked: true } : {}),
        }
      }).catch(() => {})
    })
    await recordQueue
    const outcome = await sync()
    if (outcome === 'stale') return sync()
    return outcome
  }

  const confirmPendingVpnOff = async (): Promise<void> => {
    const current = pendingVpnOff
    if (!current) return
    choiceSeq += 1
    keySeq.set('vpn', seqOf('vpn') + 1)
    setPendingVpnOff(null)
    await deps.applyLocal({ vpn: false })
    recordQueue = recordQueue.then(() =>
      deps.writeStored((prev) => {
        if (prev?.account && prev.account !== current.account) return prev
        const nextEntries: SyncedEntries = {
          ...prev?.entries,
          vpn: { value: false, updatedAt: current.updatedAt },
        }
        return {
          account: current.account,
          entries: nextEntries,
          ...(prev?.legacyVpnChecked ? { legacyVpnChecked: true } : {}),
        }
      }).catch(() => {})
    )
    await recordQueue
  }

  const declinePendingVpnOff = async (): Promise<void> => {
    const current = pendingVpnOff
    if (!current) return
    setPendingVpnOff(null)
    recordQueue = recordQueue.then(() =>
      deps.writeStored((prev) => {
        if (prev?.account && prev.account !== current.account) return prev
        return {
          account: current.account,
          entries: prev?.entries ?? {},
          declinedVpnOffAt: current.updatedAt,
          ...(prev?.legacyVpnChecked ? { legacyVpnChecked: true } : {}),
        }
      }).catch(() => {})
    )
    await recordQueue
  }

  const noteAccountSwitch = () => {
    accountGen += 1
    lastSeenRemoteAt = 0
    pendingAccountSwitch = true
    postSwitchKeys.clear()
    setPendingVpnOff(null)
  }

  const onPendingVpnOff = (listener: (pending: PendingVpnOff | null) => void): (() => void) => {
    pendingListeners.add(listener)
    listener(pendingVpnOff)
    return () => { pendingListeners.delete(listener) }
  }

  return {
    sync,
    recordChoice,
    noteAccountSwitch,
    onPendingVpnOff,
    confirmPendingVpnOff,
    declinePendingVpnOff,
    currentPendingVpnOff: () => pendingVpnOff,
  }
}

const appliedListeners = new Map<SettingKey, Set<(value: unknown) => void>>()

const notifyApplied = <K extends SettingKey>(key: K, value: SettingsValues[K]) => {
  const setForKey = appliedListeners.get(key)
  if (!setForKey) return
  for (const listener of setForKey) listener(value)
}

/** Subscribes to remote setting changes applied by cloud sync for `key`. */
export const onSettingApplied = <K extends SettingKey>(
  key: K,
  listener: (value: SettingsValues[K]) => void,
): (() => void) => {
  let listeners = appliedListeners.get(key)
  if (!listeners) {
    listeners = new Set()
    appliedListeners.set(key, listeners)
  }
  const wrapped = (value: unknown) => listener(value as SettingsValues[K])
  listeners.add(wrapped)
  return () => { listeners.delete(wrapped) }
}

const readLocalSettings = async (): Promise<SettingsValues> => {
  const values: Partial<SettingsValues> = {}
  for (const key of SYNCED_SETTING_KEYS) {
    ;(values as Record<SettingKey, unknown>)[key] = await SETTINGS_SPEC[key].read()
  }
  return values as SettingsValues
}

const applyLocalSettings = async (patch: Partial<SettingsValues>): Promise<void> => {
  for (const key of SYNCED_SETTING_KEYS) {
    if (!(key in patch)) continue
    const next = patch[key]
    if (next === undefined) continue
    const applied = await (SETTINGS_SPEC[key].write as (value: unknown) => unknown)(next)
    notifyApplied(key, applied as SettingsValues[typeof key])
  }
}

type ReadOneResult =
  | { kind: 'ok', text: string }
  | { kind: 'absent' }
  | { kind: 'locked' }
  | { kind: 'error' }

const defaultReadCloud = async (options?: { account?: string, skipLegacyVpn?: boolean }): Promise<CloudReadResult> => {
  const readOne = async (path: string): Promise<ReadOneResult> => {
    let text: string | null = null
    try {
      text = await bounded<string | null>(cloud.fs.promises.readFile(path, 'utf8').then(String), null)
    } catch (err) {
      if (isLocked(err)) return { kind: 'locked' }
      const msg = (err as { message?: string } | null)?.message ?? String(err)
      if (isAbsent(err, msg) || isUnreadable(err)) return { kind: 'absent' }
      return { kind: 'error' }
    }
    return text === null ? { kind: 'error' } : { kind: 'ok', text }
  }

  const raw = await readOne(SETTINGS_SYNC_PATH)
  if (raw.kind === 'locked') return { kind: 'locked' }
  if (raw.kind === 'error') return { kind: 'error' }
  if (raw.kind === 'ok') {
    try {
      const parsed = parseSettingsSync(JSON.parse(raw.text))
      return parsed ? { kind: 'ok', parsed, migratedFromLegacyVpn: false, legacyChecked: true } : { kind: 'absent', legacyChecked: true }
    } catch {
      return { kind: 'absent', legacyChecked: true }
    }
  }

  if (options?.skipLegacyVpn) {
    return { kind: 'absent', legacyChecked: true }
  }

  const legacyRaw = await readOne(LEGACY_VPN_SYNC_PATH)
  if (legacyRaw.kind === 'locked') return { kind: 'locked' }
  if (legacyRaw.kind === 'error') return { kind: 'error' }
  if (legacyRaw.kind === 'absent') {
    return { kind: 'absent', legacyChecked: true }
  }
  try {
    const legacy = parseLegacyVpnSync(JSON.parse(legacyRaw.text))
    if (!legacy) {
      return { kind: 'absent', legacyChecked: true }
    }
    return {
      kind: 'ok',
      parsed: { entries: { vpn: { value: legacy.on, updatedAt: legacy.updatedAt } }, extra: {} },
      migratedFromLegacyVpn: true,
    }
  } catch {
    return { kind: 'absent', legacyChecked: true }
  }
}

const defaultWriteStored = async (updater: (prev: StoredSettingsSync | undefined) => StoredSettingsSync | undefined): Promise<void> => {
  await migrateLegacyStored().catch(() => {})
  await update<StoredSettingsSync | undefined>(SETTINGS_SYNC_KEY, updater)
}

const defaultController = createSettingsSyncController({
  vpnOffAvailable,
  readLocal: readLocalSettings,
  applyLocal: applyLocalSettings,
  accountInfo: () => bounded(account.info().then((info) => info?.name ?? null), null, ACCOUNT_TIMEOUT).catch(() => null),
  fsAvailable: () => bounded<boolean | null>(cloud.fs.available().then(Boolean), null, BROKER_TIMEOUT).catch(() => null),
  readCloud: defaultReadCloud,
  writeCloud: async (payload) => {
    try {
      await bounded(
        cloud.fs.promises.writeFile(SETTINGS_SYNC_PATH, JSON.stringify(payload), { contentType: 'application/json' }).then(() => true),
        false,
      ).then((ok) => { if (!ok) throw new Error('write timed out') })
      return 'ok'
    } catch (err) {
      return isLocked(err) ? 'locked' : 'error'
    }
  },
  readStored: migrateLegacyStored,
  writeStored: defaultWriteStored,
  tagAccount: accountTag,
  now: () => Date.now(),
})

/** Records a user-initiated setting update locally (without touching localStorage/worker) and syncs it to `cloud.fs`. */
export const recordSetting = <K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<SettingsSyncOutcome> => {
  if (key === 'rateLimits') pendingWorkerRateLimits = normalizeLimits(value)
  return defaultController.recordChoice(key, value)
}

/**
 * Applies a user-initiated setting update to local storage/runtime through {@link SETTINGS_SPEC} and records
 * it for cloud sync. Synchronous `localStorage` keys flush before the returned Promise resolves.
 */
export const setSetting = async <K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<SettingsSyncOutcome> => {
  const written = await (SETTINGS_SPEC[key] as SettingSpec<K>).write(value)
  return recordSetting(key, written)
}

/** Merges a partial session speed limit update with active ceilings and records it for cloud sync. */
export const recordRateLimitsPatch = async (
  patch: { down?: number, up?: number },
  fallback?: RateLimits | null,
): Promise<SettingsSyncOutcome> => {
  if (patch.down !== undefined && patch.up !== undefined) {
    return recordSetting('rateLimits', normalizeLimits({ down: patch.down, up: patch.up }))
  }
  const storedLimits = await get<unknown>(RATE_LIMITS_KEY).catch(() => undefined)
  const storedSync = await migrateLegacyStored().catch(() => undefined)
  let base: RateLimits | null = null
  if (pendingWorkerRateLimits && storedSync?.entries?.rateLimits && SETTINGS_SPEC.rateLimits.equal(storedSync.entries.rateLimits.value, pendingWorkerRateLimits)) {
    base = pendingWorkerRateLimits
  } else if (storedLimits !== undefined) {
    base = normalizeLimits(storedLimits)
  } else if (storedSync?.entries?.rateLimits) {
    base = normalizeLimits(storedSync.entries.rateLimits.value)
  } else if (fallback) {
    base = normalizeLimits(fallback)
  } else {
    base = clientApi.runningTorrentClient?.()?.latestRateLimits() ?? NO_LIMITS
  }
  return recordSetting('rateLimits', normalizeLimits({
    down: patch.down ?? base.down,
    up: patch.up ?? base.up,
  }))
}

/** Runs one signed-in settings sync pass against `cloud.fs`. */
export const syncSettings = (): Promise<SettingsSyncOutcome> => defaultController.sync()

/** Keeps every Ripple partition (top-level or embedded) synced with the signed-in account's settings. */
export const useSettingsCloudSync = (): PendingVpnOff | null => {
  const [pendingVpnOff, setPendingVpnOff] = useState<PendingVpnOff | null>(null)

  useEffect(() => {
    let cancelled = false
    let lastCheckAt = 0
    let lastSignedOut = false
    let retryAttempt = 0
    let retryPending = false
    let retryTimer: number | undefined
    let offAccount: (() => void) | undefined
    const offPending = defaultController.onPendingVpnOff((pending) => {
      if (!cancelled) setPendingVpnOff(pending)
    })

    const trigger = (force = false) => {
      if (cancelled) return
      const now = Date.now()
      const cooldown = lastSignedOut ? SIGNED_OUT_COOLDOWN_MS : FOCUS_COOLDOWN_MS
      if (!force && lastCheckAt > 0 && now - lastCheckAt < cooldown) return
      lastCheckAt = now
      window.clearTimeout(retryTimer)
      void defaultController.sync().then((outcome) => {
        if (cancelled) return
        if (outcome === 'retry') {
          lastSignedOut = false
          const delay = RETRY_BACKOFF_MS[Math.min(retryAttempt, RETRY_BACKOFF_MS.length - 1)] ?? 30_000
          retryAttempt += 1
          window.clearTimeout(retryTimer)
          if (document.visibilityState === 'hidden') {
            retryPending = true
            return
          }
          retryPending = false
          retryTimer = window.setTimeout(() => {
            if (cancelled) return
            if (document.visibilityState === 'hidden') {
              retryPending = true
              return
            }
            trigger(true)
          }, delay)
          return
        }
        retryAttempt = 0
        retryPending = false
        lastSignedOut = outcome === 'signed-out'
      })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const due = retryPending
        retryPending = false
        trigger(due)
      }
    }
    const onFocus = () => { trigger(false) }
    const onOnline = () => { trigger(true) }

    account.onChange((change?: { switched?: boolean }) => {
      if (cancelled) return
      if (change?.switched) {
        pendingWorkerRateLimits = null
        defaultController.noteAccountSwitch()
      }
      trigger(true)
    })
      .then((off) => { if (cancelled) off(); else offAccount = off })
      .catch(() => {})

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onOnline)
    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !lastSignedOut) trigger(false)
    }, POLL_INTERVAL_MS)

    trigger(true)

    return () => {
      cancelled = true
      window.clearTimeout(retryTimer)
      window.clearInterval(pollTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onOnline)
      offPending()
      offAccount?.()
    }
  }, [])

  return pendingVpnOff
}

export const confirmPendingVpnOff = (): Promise<void> => defaultController.confirmPendingVpnOff()
export const declinePendingVpnOff = (): Promise<void> => defaultController.declinePendingVpnOff()
