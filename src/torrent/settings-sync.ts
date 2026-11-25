import { useEffect } from 'react'
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
const OPTIMISTIC_TTL_MS = 5_000

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
export type SyncedEntry<T = unknown> = { value: T, updatedAt: number }
export type SyncedEntries = { [K in SettingKey]?: SyncedEntry<SettingsValues[K]> }
export type StoredSettingsSync = { account: string | null, entries: SyncedEntries }
export type ParsedSettingsSync = { entries: SyncedEntries, extra: Record<string, SyncedEntry> }
export type SettingsSyncOutcome = 'signed-out' | 'locked' | 'stale' | 'retry' | 'synced'

export type SettingsSyncResolution = {
  record: StoredSettingsSync
  cloudPayload: Record<string, SyncedEntry>
  apply: Partial<SettingsValues>
  writeCloud: boolean
}

const DEFAULT_PLAYER_VOLUME: PlayerVolume = { volume: 1, muted: false }

export const DEFAULT_SETTINGS: SettingsValues = {
  vpn: true,
  vpnWarningRemembered: false,
  language: null,
  addDialog: false,
  seedingPolicy: DEFAULT_SEEDING_POLICY,
  rateLimits: NO_LIMITS,
  saveLocation: 'browser',
  confirmRemove: false,
  normalizeVolume: true,
  playerVolume: DEFAULT_PLAYER_VOLUME,
  audioLanguage: null,
  subtitleLanguage: null,
  listFilter: 'all',
  listSort: DEFAULT_SORT,
  listView: 'cards',
  listCollapsed: [],
  listExpandedGroups: [],
  dockHeight: DEFAULT_DOCK_HEIGHT,
}

export const SYNCED_SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[]

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

type SettingSpec<K extends SettingKey> = {
  parse: (raw: unknown) => SettingsValues[K] | undefined
  equal: (a: SettingsValues[K], b: SettingsValues[K]) => boolean
}

const SETTINGS_SPEC: { [K in SettingKey]: SettingSpec<K> } = {
  vpn: {
    parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  vpnWarningRemembered: {
    parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  language: {
    parse: (raw) => (raw === null ? null : typeof raw === 'string' && OFFERED.includes(raw) ? raw : undefined),
    equal: (a, b) => a === b,
  },
  addDialog: {
    parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  seedingPolicy: {
    parse: parseSeedingPolicyStrict,
    equal: sameSeedingPolicy,
  },
  rateLimits: {
    parse: (raw) => (isRecord(raw) && isLimit(raw.down) && isLimit(raw.up) ? { down: raw.down, up: raw.up } : undefined),
    equal: (a, b) => a.down === b.down && a.up === b.up,
  },
  saveLocation: {
    parse: (raw) => (raw === 'browser' || raw === 'folder' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  confirmRemove: {
    parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  normalizeVolume: {
    parse: (raw) => (typeof raw === 'boolean' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  playerVolume: {
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
  },
  audioLanguage: {
    parse: cleanLanguageTag,
    equal: (a, b) => a === b,
  },
  subtitleLanguage: {
    parse: cleanLanguageTag,
    equal: (a, b) => a === b,
  },
  listFilter: {
    parse: (raw) => ((FILTERS as readonly unknown[]).includes(raw) ? raw as ListFilter : undefined),
    equal: (a, b) => a === b,
  },
  listSort: {
    parse: (raw) => (
      isRecord(raw) && typeof raw.key === 'string' && raw.key in SORT_LABEL && (raw.dir === 'asc' || raw.dir === 'desc')
        ? { key: raw.key as SortKey, dir: raw.dir }
        : undefined
    ),
    equal: (a, b) => a.key === b.key && a.dir === b.dir,
  },
  listView: {
    parse: (raw) => (raw === 'cards' || raw === 'table' ? raw : undefined),
    equal: (a, b) => a === b,
  },
  listCollapsed: {
    parse: (raw) => (Array.isArray(raw) && raw.every(isListGroup) ? canonicalCollapsed(raw) : undefined),
    equal: arraysEqual,
  },
  listExpandedGroups: {
    parse: (raw) => (
      Array.isArray(raw) && raw.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
        ? canonicalExpanded(raw)
        : undefined
    ),
    equal: arraysEqual,
  },
  dockHeight: {
    parse: (raw) => (
      typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= MIN_DOCK_HEIGHT && raw <= MAX_DOCK_HEIGHT
        ? raw
        : undefined
    ),
    equal: (a, b) => a === b,
  },
}

const isKnownKey = (key: string): key is SettingKey => key in SETTINGS_SPEC

export const equalSetting = <K extends SettingKey>(key: K, a: SettingsValues[K], b: SettingsValues[K]): boolean =>
  SETTINGS_SPEC[key].equal(a, b)

/** Clamps a detail dock height into its allowed `[MIN_DOCK_HEIGHT, MAX_DOCK_HEIGHT]` range. */
export const clampDockHeight = (value: number): number =>
  Math.min(MAX_DOCK_HEIGHT, Math.max(MIN_DOCK_HEIGHT, Math.round(value)))

/** Parses a cloud `ripple/settings.json` payload, keeping valid known keys and preserving unknown `{ value, updatedAt }` entries. */
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
  a === b || (!!a && !!b && a.updatedAt === b.updatedAt && equalSetting(key, a.value, b.value))

const sameStored = (a: StoredSettingsSync | undefined, b: StoredSettingsSync | undefined): boolean => {
  if (a === b) return true
  if (!a || !b || a.account !== b.account) return false
  return SYNCED_SETTING_KEYS.every((key) => sameEntry(key, a.entries[key], b.entries[key]))
}

/**
 * Reconciles every portable setting between local storage (`local`, `stored`) and `cloud.fs`
 * (`remote`, `extra`) per key using LWW timestamps, discarding prior-account state on switch.
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
  now?: number
}): SettingsSyncResolution => {
  const nextEntries: SyncedEntries = {}
  const apply: Partial<SettingsValues> = {}
  let writeCloud = migratedFromLegacyVpn
  const remoteEntries = remote ?? {}
  const accountSwitched = !!stored?.account && stored.account !== accountId

  const setNext = (key: SettingKey, entry: SyncedEntry) => {
    ;(nextEntries as Record<string, SyncedEntry>)[key] = entry
  }
  const setApply = (key: SettingKey, value: unknown) => {
    ;(apply as Record<string, unknown>)[key] = value
  }

  for (const key of SYNCED_SETTING_KEYS) {
    const r = remoteEntries[key]
    if (key === 'vpn' && !hasWebRtc) {
      if (r) setNext('vpn', r)
      continue
    }
    const defaultVal = DEFAULT_SETTINGS[key]
    const localVal = local[key]

    if (accountSwitched && !preserveLocalKeys?.has(key)) {
      const winnerVal = r ? r.value : defaultVal
      if (r) setNext(key, r)
      else if (key === 'vpn') setNext('vpn', { value: true, updatedAt: 0 })
      if (!equalSetting(key, winnerVal, localVal)) setApply(key, winnerVal)
      continue
    }

    const s = stored?.entries[key]
    let candidate: SyncedEntry<SettingsValues[typeof key]>
    if (s && equalSetting(key, s.value, localVal)) {
      candidate = s
    } else if (r && equalSetting(key, localVal, r.value)) {
      candidate = r
    } else if (!equalSetting(key, localVal, defaultVal)) {
      candidate = { value: localVal, updatedAt: r ? 0 : now }
    } else {
      candidate = { value: defaultVal, updatedAt: 0 }
    }

    const remoteAt = r ? r.updatedAt : 0
    if (candidate.updatedAt > remoteAt) {
      setNext(key, candidate)
      writeCloud = true
    } else if (remoteAt > candidate.updatedAt && r) {
      setNext(key, r)
      if (!equalSetting(key, r.value, localVal)) setApply(key, r.value)
    } else {
      const remoteVal = r ? r.value : defaultVal
      if (equalSetting(key, candidate.value, remoteVal)) {
        if (r) setNext(key, r)
        else if (candidate.updatedAt > 0 || !equalSetting(key, candidate.value, defaultVal)) setNext(key, candidate)
      } else if (key === 'vpn') {
        if (candidate.value === true) {
          setNext('vpn', { value: true, updatedAt: candidate.updatedAt })
          writeCloud = true
        } else {
          setNext('vpn', { value: true, updatedAt: remoteAt })
          if (localVal !== true) setApply('vpn', true)
        }
      } else if (r) {
        setNext(key, r)
        if (!equalSetting(key, r.value, localVal)) setApply(key, r.value)
      }
    }
  }

  const cloudPayload: Record<string, SyncedEntry> = { ...extra }
  for (const key of SYNCED_SETTING_KEYS) {
    const entry = nextEntries[key]
    if (!entry) continue
    if (entry.updatedAt === 0 && equalSetting(key, entry.value, DEFAULT_SETTINGS[key])) continue
    cloudPayload[key] = entry
  }

  return {
    record: { account: accountId, entries: nextEntries },
    cloudPayload,
    apply,
    writeCloud,
  }
}

export type CloudReadResult =
  | { kind: 'ok', parsed: ParsedSettingsSync, migratedFromLegacyVpn: boolean }
  | { kind: 'absent' }
  | { kind: 'locked' }
  | { kind: 'error' }

export type SettingsSyncDeps = {
  vpnOffAvailable: () => boolean
  readLocal: () => Promise<SettingsValues> | SettingsValues
  applyLocal: (patch: Partial<SettingsValues>) => Promise<void> | void
  accountInfo: () => Promise<string | null>
  fsAvailable: () => Promise<boolean | null>
  readCloud: () => Promise<CloudReadResult>
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
 * to encrypted `cloud.fs` (`ripple/settings.json`), preventing mid-flight clobbers and account-switch loops.
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

  const seqOf = (key: SettingKey): number => keySeq.get(key) ?? 0
  const maxEntryAt = (entries: SyncedEntries): number => highestRemoteAt(entries)

  const runOnce = async (): Promise<SettingsSyncOutcome> => {
    const gen = accountGen
    const seqAtStart = new Map<SettingKey, number>(SYNCED_SETTING_KEYS.map((key) => [key, seqOf(key)]))
    const switchAtStart = pendingAccountSwitch
    const preservedAtStart = switchAtStart ? new Set(postSwitchKeys) : undefined

    const [available, name] = await Promise.all([deps.fsAvailable(), deps.accountInfo()])
    if (gen !== accountGen) return 'stale'
    if (available !== true) return available === null || name !== null ? 'retry' : 'signed-out'
    if (!name) return 'retry'

    const cloudRead = await deps.readCloud()
    if (gen !== accountGen) return 'stale'
    if (cloudRead.kind === 'locked') return 'locked'
    if (cloudRead.kind === 'error') return 'retry'
    const remote = cloudRead.kind === 'ok' ? cloudRead.parsed.entries : null
    const extra = cloudRead.kind === 'ok' ? cloudRead.parsed.extra : {}
    const migratedFromLegacyVpn = cloudRead.kind === 'ok' ? cloudRead.migratedFromLegacyVpn : false
    if (remote !== null) lastSeenRemoteAt = Math.max(lastSeenRemoteAt, maxEntryAt(remote))

    const tag = await deps.tagAccount(name)
    if (gen !== accountGen || !tag) return 'stale'

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
          ;(nextEntries as Record<SettingKey, SyncedEntry>)[key] = { value: cur.value, updatedAt: bumpAt }
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
    if (pendingAccountSwitch) postSwitchKeys.add(key)
    const stamp = Math.max(deps.now(), lastSeenRemoteAt + 1)
    recordQueue = recordQueue.then(() =>
      deps.writeStored((prev) => {
        const prevEntries = prev?.entries ?? {}
        const prevMax = maxEntryAt(prevEntries)
        const nextEntries: SyncedEntries = { ...prevEntries }
        ;(nextEntries as Record<SettingKey, SyncedEntry>)[key] = {
          value,
          updatedAt: Math.max(stamp, prevMax + 1),
        }
        return { account: prev?.account ?? null, entries: nextEntries }
      }).catch(() => {})
    )
    await recordQueue
    const outcome = await sync()
    if (outcome === 'stale' && !inFlight) return sync()
    return outcome
  }

  const noteAccountSwitch = () => {
    accountGen += 1
    lastSeenRemoteAt = 0
    pendingAccountSwitch = true
    postSwitchKeys.clear()
  }

  return { sync, recordChoice, noteAccountSwitch }
}

const appliedListeners = new Map<SettingKey, Set<(value: unknown) => void>>()

const notifyApplied = <K extends SettingKey>(key: K, value: SettingsValues[K]) => {
  const set = appliedListeners.get(key)
  if (!set) return
  for (const listener of set) listener(value)
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

const clientApi: {
  setVpn?: typeof clientModule.setVpn
  runningTorrentClient?: typeof clientModule.runningTorrentClient
} = clientModule

let optimisticRateLimits: { value: RateLimits, setAt: number } | null = null

const safeGetItem = (key: string): string | null => {
  try { return globalThis.localStorage?.getItem(key) ?? null } catch { return null }
}

const safeSetItem = (key: string, value: string): void => {
  try { globalThis.localStorage?.setItem(key, value) } catch {}
}

const safeRemoveItem = (key: string): void => {
  try { globalThis.localStorage?.removeItem(key) } catch {}
}

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
  const parsed = Number(raw)
  return SETTINGS_SPEC.dockHeight.parse(parsed) ?? DEFAULT_DOCK_HEIGHT
}

const readLocalSettings = async (): Promise<SettingsValues> => {
  const storedLimits = await get<unknown>(RATE_LIMITS_KEY).catch(() => undefined)
  let rateLimits: RateLimits
  if (optimisticRateLimits) {
    const normalizedIdb = storedLimits !== undefined ? normalizeLimits(storedLimits) : undefined
    const expired = Date.now() - optimisticRateLimits.setAt > OPTIMISTIC_TTL_MS
    const idbCaughtUp = normalizedIdb !== undefined && SETTINGS_SPEC.rateLimits.equal(normalizedIdb, optimisticRateLimits.value)
    if (expired || idbCaughtUp) {
      rateLimits = idbCaughtUp ? normalizedIdb : (normalizedIdb ?? optimisticRateLimits.value)
      optimisticRateLimits = null
    } else {
      rateLimits = optimisticRateLimits.value
    }
  } else {
    rateLimits = storedLimits !== undefined
      ? normalizeLimits(storedLimits)
      : (clientApi.runningTorrentClient?.()?.latestRateLimits() ?? NO_LIMITS)
  }
  const defaultLoc = readGlobalDefault(safeGetItem)

  return {
    vpn: vpnOn(),
    vpnWarningRemembered: safeGetItem(VPN_REMEMBERED_KEY) === '1',
    language: readPickedLanguage() ?? null,
    addDialog: dialogEnabled(safeGetItem),
    seedingPolicy: readSeedingPolicy(safeGetItem),
    rateLimits,
    saveLocation: defaultLoc === 'folder' ? 'folder' : 'browser',
    confirmRemove: safeGetItem(CONFIRM_REMOVE_KEY) === 'skip',
    normalizeVolume: normalizeVolumeSaved(safeGetItem),
    playerVolume: readLocalPlayerVolume(),
    audioLanguage: cleanLanguageTag(safeGetItem(AUDIO_LANGUAGE_KEY)) ?? null,
    subtitleLanguage: cleanLanguageTag(safeGetItem(SUBTITLE_LANGUAGE_KEY)) ?? null,
    listFilter: readFilter(safeGetItem),
    listSort: readSort(safeGetItem),
    listView: readView(safeGetItem),
    listCollapsed: LIST_GROUPS.filter((g) => readCollapsed(safeGetItem).has(g)),
    listExpandedGroups: canonicalExpanded([...readExpandedGroups(safeGetItem)]),
    dockHeight: readLocalDockHeight(),
  }
}

const applyLocalSettings = async (patch: Partial<SettingsValues>): Promise<void> => {
  if ('vpn' in patch && patch.vpn !== undefined) {
    await clientApi.setVpn?.(patch.vpn)
    if (vpnOn() !== patch.vpn) storeVpn(patch.vpn)
    notifyApplied('vpn', patch.vpn)
  }
  if ('vpnWarningRemembered' in patch && patch.vpnWarningRemembered !== undefined) {
    if (patch.vpnWarningRemembered) safeSetItem(VPN_REMEMBERED_KEY, '1')
    else safeRemoveItem(VPN_REMEMBERED_KEY)
    notifyApplied('vpnWarningRemembered', patch.vpnWarningRemembered)
  }
  if ('language' in patch && patch.language !== undefined) {
    await pickLanguage(patch.language ?? undefined).catch(() => {})
    notifyApplied('language', patch.language)
  }
  if ('addDialog' in patch && patch.addDialog !== undefined) {
    safeSetItem(ADD_DIALOG_KEY, patch.addDialog ? '1' : '0')
    notifyApplied('addDialog', patch.addDialog)
  }
  if ('seedingPolicy' in patch && patch.seedingPolicy !== undefined) {
    const saved = writeSeedingPolicy(patch.seedingPolicy)
    await set(SEEDING_POLICY_KEY, saved).catch(() => {})
    clientApi.runningTorrentClient?.()?.setSeedingPolicy(saved)
    notifyApplied('seedingPolicy', saved)
  }
  if ('rateLimits' in patch && patch.rateLimits !== undefined) {
    const normalized = normalizeLimits(patch.rateLimits)
    optimisticRateLimits = { value: normalized, setAt: Date.now() }
    await update(RATE_LIMITS_KEY, () => normalized).catch(() => {})
    clientApi.runningTorrentClient?.()?.setSessionLimits(normalized)
    notifyApplied('rateLimits', normalized)
  }
  if ('saveLocation' in patch && patch.saveLocation !== undefined) {
    safeSetItem(SAVE_LOCATION_KEY, patch.saveLocation)
    notifyApplied('saveLocation', patch.saveLocation)
  }
  if ('confirmRemove' in patch && patch.confirmRemove !== undefined) {
    if (patch.confirmRemove) safeSetItem(CONFIRM_REMOVE_KEY, 'skip')
    else safeRemoveItem(CONFIRM_REMOVE_KEY)
    notifyApplied('confirmRemove', patch.confirmRemove)
  }
  if ('normalizeVolume' in patch && patch.normalizeVolume !== undefined) {
    safeSetItem(NORMALIZE_VOLUME_KEY, patch.normalizeVolume ? '1' : '0')
    notifyApplied('normalizeVolume', patch.normalizeVolume)
  }
  if ('playerVolume' in patch && patch.playerVolume !== undefined) {
    safeSetItem(PLAYER_VOLUME_KEY, JSON.stringify(patch.playerVolume))
    notifyApplied('playerVolume', patch.playerVolume)
  }
  if ('audioLanguage' in patch && patch.audioLanguage !== undefined) {
    if (patch.audioLanguage) safeSetItem(AUDIO_LANGUAGE_KEY, patch.audioLanguage)
    else safeRemoveItem(AUDIO_LANGUAGE_KEY)
    notifyApplied('audioLanguage', patch.audioLanguage)
  }
  if ('subtitleLanguage' in patch && patch.subtitleLanguage !== undefined) {
    if (patch.subtitleLanguage) safeSetItem(SUBTITLE_LANGUAGE_KEY, patch.subtitleLanguage === OFF ? OFF : patch.subtitleLanguage)
    else safeRemoveItem(SUBTITLE_LANGUAGE_KEY)
    notifyApplied('subtitleLanguage', patch.subtitleLanguage)
  }
  if ('listFilter' in patch && patch.listFilter !== undefined) {
    safeSetItem(LIST_FILTER_KEY, patch.listFilter)
    notifyApplied('listFilter', patch.listFilter)
  }
  if ('listSort' in patch && patch.listSort !== undefined) {
    safeSetItem(LIST_SORT_KEY, writeSort(patch.listSort.key, patch.listSort.dir))
    notifyApplied('listSort', patch.listSort)
  }
  if ('listView' in patch && patch.listView !== undefined) {
    safeSetItem(LIST_VIEW_KEY, patch.listView)
    notifyApplied('listView', patch.listView)
  }
  if ('listCollapsed' in patch && patch.listCollapsed !== undefined) {
    const serialized = writeCollapsed(new Set(patch.listCollapsed))
    if (serialized) safeSetItem(LIST_COLLAPSED_KEY, serialized)
    else safeRemoveItem(LIST_COLLAPSED_KEY)
    notifyApplied('listCollapsed', patch.listCollapsed)
  }
  if ('listExpandedGroups' in patch && patch.listExpandedGroups !== undefined) {
    const expanded = patch.listExpandedGroups.length ? new Set(patch.listExpandedGroups) : NO_EXPANDED
    const serialized = expanded.size ? writeExpandedGroups(expanded) : ''
    if (serialized) safeSetItem(LIST_EXPANDED_GROUPS_KEY, serialized)
    else safeRemoveItem(LIST_EXPANDED_GROUPS_KEY)
    notifyApplied('listExpandedGroups', patch.listExpandedGroups)
  }
  if ('dockHeight' in patch && patch.dockHeight !== undefined) {
    const height = clampDockHeight(patch.dockHeight)
    safeSetItem(DOCK_HEIGHT_KEY, String(height))
    notifyApplied('dockHeight', height)
  }
}

type ReadOneResult =
  | { kind: 'ok', text: string }
  | { kind: 'absent' }
  | { kind: 'locked' }
  | { kind: 'error' }

const defaultReadCloud = async (): Promise<CloudReadResult> => {
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
      return parsed ? { kind: 'ok', parsed, migratedFromLegacyVpn: false } : { kind: 'absent' }
    } catch {
      return { kind: 'absent' }
    }
  }

  const legacyRaw = await readOne(LEGACY_VPN_SYNC_PATH)
  if (legacyRaw.kind !== 'ok') return { kind: legacyRaw.kind }
  try {
    const legacy = parseLegacyVpnSync(JSON.parse(legacyRaw.text))
    if (!legacy) return { kind: 'absent' }
    return {
      kind: 'ok',
      parsed: { entries: { vpn: { value: legacy.on, updatedAt: legacy.updatedAt } }, extra: {} },
      migratedFromLegacyVpn: true,
    }
  } catch {
    return { kind: 'absent' }
  }
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

/** Records a user-initiated setting update locally and pushes it to `cloud.fs` when signed in. */
export const recordSetting = <K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<SettingsSyncOutcome> => {
  if (key === 'rateLimits') optimisticRateLimits = { value: normalizeLimits(value), setAt: Date.now() }
  return defaultController.recordChoice(key, value)
}

/** Merges a partial session speed limit update with active ceilings and records it for cloud sync. */
export const recordRateLimitsPatch = async (
  patch: { down?: number, up?: number },
  fallback?: RateLimits | null,
): Promise<SettingsSyncOutcome> => {
  if (patch.down !== undefined && patch.up !== undefined) {
    return recordSetting('rateLimits', normalizeLimits({ down: patch.down, up: patch.up }))
  }
  const optimistic = optimisticRateLimits && Date.now() - optimisticRateLimits.setAt <= OPTIMISTIC_TTL_MS
    ? optimisticRateLimits.value
    : null
  let base: RateLimits | null = optimistic ?? (fallback ? normalizeLimits(fallback) : null)
  if (!base) {
    const stored = await get<unknown>(RATE_LIMITS_KEY).catch(() => undefined)
    if (stored !== undefined) base = normalizeLimits(stored)
  }
  if (!base) base = clientApi.runningTorrentClient?.()?.latestRateLimits() ?? NO_LIMITS
  return recordSetting('rateLimits', normalizeLimits({
    down: patch.down ?? base.down,
    up: patch.up ?? base.up,
  }))
}

/** Runs one signed-in settings sync pass against `cloud.fs`. */
export const syncSettings = (): Promise<SettingsSyncOutcome> => defaultController.sync()

/** Keeps every Ripple partition (top-level or embedded) synced with the signed-in account's settings. */
export const useSettingsCloudSync = (): void => {
  useEffect(() => {
    let cancelled = false
    let lastCheckAt = 0
    let lastSignedOut = false
    let retryAttempt = 0
    let retryPending = false
    let retryTimer: number | undefined
    let offAccount: (() => void) | undefined

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
        optimisticRateLimits = null
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
      offAccount?.()
    }
  }, [])
}

export const SettingsCloudSync = () => { useSettingsCloudSync(); return null }
