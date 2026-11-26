import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SEED_MINUTES,
  DEFAULT_SEED_RATIO,
  DEFAULT_SEEDING_POLICY,
  MAX_SEED_MINUTES,
  MAX_SEED_RATIO,
  MIN_SEED_MINUTES,
  MIN_SEED_RATIO,
  SEEDING_POLICY_KEY,
  hasSeedingLimit,
  hasStoredSeedingPolicy,
  isSeedMinutes,
  isSeedRatio,
  normalizeSeedingPolicy,
  parseSeedMinutes,
  parseSeedRatio,
  readSeedingPolicy,
  sameSeedingPolicy,
  shouldStopSeeding,
  writeSeedingPolicy,
} from '../../src/torrent/seeding-policy'

describe('seeding-policy rules', () => {
  it('validates share ratio and duration bounds strictly', () => {
    expect(isSeedRatio(MIN_SEED_RATIO)).toBe(true)
    expect(isSeedRatio(MAX_SEED_RATIO)).toBe(true)
    expect(isSeedRatio(0)).toBe(false)
    expect(isSeedRatio(-1)).toBe(false)
    expect(isSeedRatio(NaN)).toBe(false)
    expect(isSeedRatio(Infinity)).toBe(false)
    expect(isSeedRatio('1')).toBe(false)

    expect(isSeedMinutes(MIN_SEED_MINUTES)).toBe(true)
    expect(isSeedMinutes(MAX_SEED_MINUTES)).toBe(true)
    expect(isSeedMinutes(0)).toBe(false)
    expect(isSeedMinutes(1.5)).toBe(false)
    expect(isSeedMinutes(MAX_SEED_MINUTES + 1)).toBe(false)
    expect(isSeedMinutes('60')).toBe(false)
  })

  it('normalizes new and legacy 0.0.104 policies safely', () => {
    expect(normalizeSeedingPolicy(undefined)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy(null)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({})).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({ ratio: 1.25, minutes: null })).toEqual({ ratio: 1.25, minutes: null })
    expect(normalizeSeedingPolicy({ ratio: null, minutes: 90 })).toEqual({ ratio: null, minutes: 90 })
    expect(normalizeSeedingPolicy({ ratio: 2.5, minutes: 45 })).toEqual({ ratio: 2.5, minutes: 45 })
    expect(normalizeSeedingPolicy({ ratio: -5, minutes: 0 })).toEqual(DEFAULT_SEEDING_POLICY)

    // Legacy 0.0.104 discriminated policies migrate to qBittorrent-style opt-in limits (stop-immediately removed)
    expect(normalizeSeedingPolicy({ mode: 'keep' })).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({ mode: 'stop' })).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({ mode: 'ratio', ratio: 1.5 })).toEqual({ ratio: 1.5, minutes: null })
    expect(normalizeSeedingPolicy({ mode: 'ratio', ratio: -5 })).toEqual({ ratio: DEFAULT_SEED_RATIO, minutes: null })
    expect(normalizeSeedingPolicy({ mode: 'duration', minutes: 90 })).toEqual({ ratio: null, minutes: 90 })
    expect(normalizeSeedingPolicy({ mode: 'duration', minutes: 0 })).toEqual({ ratio: null, minutes: DEFAULT_SEED_MINUTES })
  })

  it('parses decimal ratios and integer minutes without accepting trailing junk', () => {
    expect(parseSeedRatio('1.5')).toBe(1.5)
    expect(parseSeedRatio(' 2,25 ')).toBe(2.25)
    expect(parseSeedRatio('')).toBeNull()
    expect(parseSeedRatio('0')).toBeNull()
    expect(parseSeedRatio('1.5abc')).toBeNull()

    expect(parseSeedMinutes('45')).toBe(45)
    expect(parseSeedMinutes(' 120 ')).toBe(120)
    expect(parseSeedMinutes('1.5')).toBeNull()
    expect(parseSeedMinutes('0')).toBeNull()
    expect(parseSeedMinutes('-10')).toBeNull()
    expect(parseSeedMinutes('60m')).toBeNull()
  })

  it('compares policies and detects active limits accurately', () => {
    expect(hasSeedingLimit({ ratio: null, minutes: null })).toBe(false)
    expect(hasSeedingLimit({ ratio: 1, minutes: null })).toBe(true)
    expect(hasSeedingLimit({ ratio: null, minutes: 30 })).toBe(true)
    expect(hasSeedingLimit({ ratio: 1, minutes: 30 })).toBe(true)

    expect(sameSeedingPolicy({ ratio: null, minutes: null }, { ratio: null, minutes: null })).toBe(true)
    expect(sameSeedingPolicy({ ratio: 1.5, minutes: null }, { ratio: 1.5, minutes: null })).toBe(true)
    expect(sameSeedingPolicy({ ratio: 1.5, minutes: 60 }, { ratio: 1.5, minutes: 30 })).toBe(false)
    expect(sameSeedingPolicy({ ratio: null, minutes: 60 }, { ratio: 1, minutes: 60 })).toBe(false)
  })

  it('reads, writes, and detects stored policies safely', () => {
    const store = new Map<string, string>()
    expect(hasStoredSeedingPolicy((k) => store.get(k) ?? null)).toBe(false)
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual(DEFAULT_SEEDING_POLICY)

    writeSeedingPolicy({ ratio: 2.5, minutes: 45 }, (k, v) => store.set(k, v))
    expect(hasStoredSeedingPolicy((k) => store.get(k) ?? null)).toBe(true)
    expect(JSON.parse(store.get(SEEDING_POLICY_KEY)!)).toEqual({ ratio: 2.5, minutes: 45 })
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual({ ratio: 2.5, minutes: 45 })

    store.set(SEEDING_POLICY_KEY, '{bad json')
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(readSeedingPolicy(() => { throw new Error('blocked') })).toEqual(DEFAULT_SEEDING_POLICY)
    expect(hasStoredSeedingPolicy(() => { throw new Error('blocked') })).toBe(false)
  })

  it('evaluates shouldStopSeeding with OR semantics and zero-download fallback to size', () => {
    expect(shouldStopSeeding(DEFAULT_SEEDING_POLICY, { uploaded: 10_000, downloaded: 100, size: 100, seedingSeconds: 99_999 })).toBe(false)

    expect(shouldStopSeeding({ ratio: 1.5, minutes: null }, { uploaded: 149, downloaded: 100, size: 100, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ ratio: 1.5, minutes: null }, { uploaded: 150, downloaded: 100, size: 100, seedingSeconds: 0 })).toBe(true)
    // created or rechecked torrents with downloaded === 0 measure ratio against total content size
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 50, downloaded: 0, size: 100, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 100, downloaded: 0, size: 100, seedingSeconds: 0 })).toBe(true)
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 100, downloaded: 0, size: 0, seedingSeconds: 0 })).toBe(false)

    expect(shouldStopSeeding({ ratio: null, minutes: 10 }, { uploaded: 0, downloaded: 100, size: 100, seedingSeconds: 599 })).toBe(false)
    expect(shouldStopSeeding({ ratio: null, minutes: 10 }, { uploaded: 0, downloaded: 100, size: 100, seedingSeconds: 600 })).toBe(true)

    // Combined limits stop when EITHER ratio or duration hits (qBittorrent default OR matching)
    expect(shouldStopSeeding({ ratio: 2, minutes: 10 }, { uploaded: 100, downloaded: 100, size: 100, seedingSeconds: 500 })).toBe(false)
    expect(shouldStopSeeding({ ratio: 2, minutes: 10 }, { uploaded: 200, downloaded: 100, size: 100, seedingSeconds: 10 })).toBe(true)
    expect(shouldStopSeeding({ ratio: 2, minutes: 10 }, { uploaded: 10, downloaded: 100, size: 100, seedingSeconds: 600 })).toBe(true)
  })

  it('uses torrent size instead of downloaded when downloaded is below 1% of size (qBittorrent fallback)', () => {
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 100, downloaded: 50, size: 10_000, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 99, downloaded: 99, size: 10_000, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 100, downloaded: 100, size: 10_000, seedingSeconds: 0 })).toBe(true)
    expect(shouldStopSeeding({ ratio: 1, minutes: null }, { uploaded: 50, downloaded: 50, size: 0, seedingSeconds: 0 })).toBe(true)
  })
})
