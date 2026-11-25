/**
 * Rules for when a completed library torrent stops seeding.
 *
 * Nothing here reads IndexedDB or touches the engine, so the rules and parsers can be tested on
 * their own. The page keeps the chosen policy in `localStorage` for instant Settings rendering and
 * mirrors it to IndexedDB (`SEEDING_POLICY_KEY`) + the engine worker so background playback and
 * reloading tabs start with the active policy.
 */

export const SEEDING_POLICY_KEY = 'ripple:seeding-policy'

export type SeedingPolicyMode = 'keep' | 'stop' | 'ratio' | 'duration'

export type SeedingPolicy =
  | { mode: 'keep' }
  | { mode: 'stop' }
  | { mode: 'ratio', ratio: number }
  | { mode: 'duration', minutes: number }

export const DEFAULT_SEEDING_POLICY: SeedingPolicy = { mode: 'keep' }

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

export const normalizeSeedingPolicy = (raw: unknown): SeedingPolicy => {
  if (!raw || typeof raw !== 'object') return DEFAULT_SEEDING_POLICY
  const source = raw as Partial<Record<string, unknown>>
  if (source.mode === 'stop') return { mode: 'stop' }
  if (source.mode === 'ratio') {
    const ratio = isSeedRatio(source.ratio) ? Math.round(source.ratio * 10_000) / 10_000 : DEFAULT_SEED_RATIO
    return { mode: 'ratio', ratio: isSeedRatio(ratio) ? ratio : DEFAULT_SEED_RATIO }
  }
  if (source.mode === 'duration') {
    const minutes = isSeedMinutes(source.minutes) ? source.minutes : DEFAULT_SEED_MINUTES
    return { mode: 'duration', minutes }
  }
  return DEFAULT_SEEDING_POLICY
}

export const sameSeedingPolicy = (a: SeedingPolicy, b: SeedingPolicy): boolean => {
  if (a.mode !== b.mode) return false
  if (a.mode === 'ratio' && b.mode === 'ratio') return a.ratio === b.ratio
  if (a.mode === 'duration' && b.mode === 'duration') return a.minutes === b.minutes
  return true
}

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

/** Whether a completed library torrent has satisfied the active seeding policy and should stop seeding. */
export const shouldStopSeeding = (
  policy: SeedingPolicy,
  stats: { uploaded: number, downloaded: number, size: number, seedingSeconds: number },
): boolean => {
  if (policy.mode === 'keep') return false
  if (policy.mode === 'stop') return true
  if (policy.mode === 'ratio') {
    const base = stats.downloaded > 0 ? stats.downloaded : stats.size
    return base > 0 && stats.uploaded / base >= policy.ratio
  }
  return stats.seedingSeconds >= policy.minutes * 60
}
