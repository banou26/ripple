/**
 * Rules for when a completed torrent stops seeding (qBittorrent-style opt-in limits).
 *
 * Limits are off by default so finished torrents keep seeding unless the user opts into a share
 * ratio and/or seeding-time threshold. Nothing here reads IndexedDB or touches the engine, so the
 * rules and parsers can be tested on their own.
 */

export const SEEDING_POLICY_KEY = 'ripple:seeding-policy'

export type SeedingPolicy = {
  ratio: number | null
  minutes: number | null
}

export const DEFAULT_SEEDING_POLICY: SeedingPolicy = { ratio: null, minutes: null }

export const DEFAULT_SEED_RATIO = 1
export const MIN_SEED_RATIO = 0.01
export const MAX_SEED_RATIO = 1000

export const DEFAULT_SEED_MINUTES = 60
export const MIN_SEED_MINUTES = 1
export const MAX_SEED_MINUTES = 525_600

export const isSeedRatio = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= MIN_SEED_RATIO && value <= MAX_SEED_RATIO

export const isSeedMinutes = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= MIN_SEED_MINUTES && value <= MAX_SEED_MINUTES

export const hasSeedingLimit = (policy: SeedingPolicy): boolean =>
  policy.ratio !== null || policy.minutes !== null

const cleanRatio = (value: unknown): number | null => {
  if (!isSeedRatio(value)) return null
  const rounded = Math.round(value * 10_000) / 10_000
  return isSeedRatio(rounded) ? rounded : null
}

export const normalizeSeedingPolicy = (raw: unknown): SeedingPolicy => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DEFAULT_SEEDING_POLICY
  const source = raw as Partial<Record<string, unknown>>
  // Migrate 0.0.104 discriminated policies into opt-in limits, dropping the removed stop-immediately mode.
  if ('mode' in source) {
    if (source.mode === 'ratio') return { ratio: cleanRatio(source.ratio) ?? DEFAULT_SEED_RATIO, minutes: null }
    if (source.mode === 'duration') return { ratio: null, minutes: isSeedMinutes(source.minutes) ? source.minutes : DEFAULT_SEED_MINUTES }
    return DEFAULT_SEEDING_POLICY
  }
  const ratio = cleanRatio(source.ratio)
  const minutes = isSeedMinutes(source.minutes) ? source.minutes : null
  if (ratio === null && minutes === null) return DEFAULT_SEEDING_POLICY
  return { ratio, minutes }
}

export const sameSeedingPolicy = (a: SeedingPolicy, b: SeedingPolicy): boolean =>
  a.ratio === b.ratio && a.minutes === b.minutes

/**
 * Parse a share-ratio input string (accepting `.` or `,` decimal separators).
 * Returns null for empty, non-numeric, or out-of-range inputs so an incomplete edit is never applied.
 */
export const parseSeedRatio = (text: string): number | null => {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value * 10_000) / 10_000
  return isSeedRatio(rounded) ? rounded : null
}

/**
 * Parse a seeding-duration input string in whole minutes.
 * Returns null for empty, fractional, non-numeric, or out-of-range inputs.
 */
export const parseSeedMinutes = (text: string): number | null => {
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return isSeedMinutes(value) ? value : null
}

const defaultGetItem = (key: string): string | null => localStorage.getItem(key)
const defaultSetItem = (key: string, value: string): void => { localStorage.setItem(key, value) }

const listeners = new Set<(policy: SeedingPolicy) => void>()

export const hasStoredSeedingPolicy = (getItem: (key: string) => string | null = defaultGetItem): boolean => {
  try {
    return getItem(SEEDING_POLICY_KEY) !== null
  } catch {
    return false
  }
}

export const readSeedingPolicy = (getItem: (key: string) => string | null = defaultGetItem): SeedingPolicy => {
  try {
    const raw = getItem(SEEDING_POLICY_KEY)
    if (!raw) return DEFAULT_SEEDING_POLICY
    return normalizeSeedingPolicy(JSON.parse(raw))
  } catch {
    return DEFAULT_SEEDING_POLICY
  }
}

export const writeSeedingPolicy = (
  policy: SeedingPolicy,
  setItem: (key: string, value: string) => void = defaultSetItem,
): SeedingPolicy => {
  const normalized = normalizeSeedingPolicy(policy)
  try {
    setItem(SEEDING_POLICY_KEY, JSON.stringify(normalized))
  } catch {}
  if (setItem === defaultSetItem) {
    for (const listener of listeners) listener(normalized)
  }
  return normalized
}

/** Calls back when another tab of this storage changes `ripple:seeding-policy`. Returns an unsubscribe callback. */
export const onSeedingPolicyStored = (changed: (policy: SeedingPolicy) => void): (() => void) => {
  const listener = (event: StorageEvent) => {
    if (event.key !== SEEDING_POLICY_KEY && event.key !== null) return
    changed(readSeedingPolicy())
  }
  window.addEventListener('storage', listener)
  return () => window.removeEventListener('storage', listener)
}

/** Calls back when this page or another tab of this storage changes `ripple:seeding-policy`. */
export const onSeedingPolicyChange = (changed: (policy: SeedingPolicy) => void): (() => void) => {
  listeners.add(changed)
  const offStored = onSeedingPolicyStored(changed)
  return () => {
    listeners.delete(changed)
    offStored()
  }
}

/** Whether a completed torrent has reached any enabled seeding limit and should stop seeding. */
export const shouldStopSeeding = (
  policy: SeedingPolicy,
  stats: { uploaded: number, downloaded: number, size: number, seedingSeconds: number },
): boolean => {
  if (policy.ratio !== null) {
    // qBittorrent fallback: ignore tiny initial downloaded counts (< 1% of size) so ratio isn't skewed.
    const base = stats.downloaded > 0 && (stats.size <= 0 || stats.downloaded >= stats.size * 0.01)
      ? stats.downloaded
      : stats.size
    if (base > 0 && stats.uploaded / base >= policy.ratio) return true
  }
  if (policy.minutes !== null && stats.seedingSeconds >= policy.minutes * 60) return true
  return false
}
