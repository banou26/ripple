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

  it('normalizes malformed inputs to safe defaults', () => {
    expect(normalizeSeedingPolicy(undefined)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy(null)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({ mode: 'unknown' })).toEqual(DEFAULT_SEEDING_POLICY)
    expect(normalizeSeedingPolicy({ mode: 'stop' })).toEqual({ mode: 'stop' })
    expect(normalizeSeedingPolicy({ mode: 'ratio', ratio: 1.25 })).toEqual({ mode: 'ratio', ratio: 1.25 })
    expect(normalizeSeedingPolicy({ mode: 'ratio', ratio: -5 })).toEqual({ mode: 'ratio', ratio: DEFAULT_SEED_RATIO })
    expect(normalizeSeedingPolicy({ mode: 'duration', minutes: 90 })).toEqual({ mode: 'duration', minutes: 90 })
    expect(normalizeSeedingPolicy({ mode: 'duration', minutes: 0 })).toEqual({ mode: 'duration', minutes: DEFAULT_SEED_MINUTES })
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

  it('compares policies accurately', () => {
    expect(sameSeedingPolicy({ mode: 'keep' }, { mode: 'keep' })).toBe(true)
    expect(sameSeedingPolicy({ mode: 'stop' }, { mode: 'keep' })).toBe(false)
    expect(sameSeedingPolicy({ mode: 'ratio', ratio: 1.5 }, { mode: 'ratio', ratio: 1.5 })).toBe(true)
    expect(sameSeedingPolicy({ mode: 'ratio', ratio: 1.5 }, { mode: 'ratio', ratio: 2 })).toBe(false)
    expect(sameSeedingPolicy({ mode: 'duration', minutes: 60 }, { mode: 'duration', minutes: 30 })).toBe(false)
  })

  it('reads, writes, and detects stored policies safely', () => {
    const store = new Map<string, string>()
    expect(hasStoredSeedingPolicy((k) => store.get(k) ?? null)).toBe(false)
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual(DEFAULT_SEEDING_POLICY)

    writeSeedingPolicy({ mode: 'ratio', ratio: 2.5 }, (k, v) => store.set(k, v))
    expect(hasStoredSeedingPolicy((k) => store.get(k) ?? null)).toBe(true)
    expect(JSON.parse(store.get(SEEDING_POLICY_KEY)!)).toEqual({ mode: 'ratio', ratio: 2.5 })
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual({ mode: 'ratio', ratio: 2.5 })

    store.set(SEEDING_POLICY_KEY, '{bad json')
    expect(readSeedingPolicy((k) => store.get(k) ?? null)).toEqual(DEFAULT_SEEDING_POLICY)
    expect(readSeedingPolicy(() => { throw new Error('blocked') })).toEqual(DEFAULT_SEEDING_POLICY)
    expect(hasStoredSeedingPolicy(() => { throw new Error('blocked') })).toBe(false)
  })

  it('evaluates shouldStopSeeding for all modes including zero-download fallback to size', () => {
    expect(shouldStopSeeding({ mode: 'keep' }, { uploaded: 10_000, downloaded: 100, size: 100, seedingSeconds: 99_999 })).toBe(false)
    expect(shouldStopSeeding({ mode: 'stop' }, { uploaded: 0, downloaded: 100, size: 100, seedingSeconds: 0 })).toBe(true)

    expect(shouldStopSeeding({ mode: 'ratio', ratio: 1.5 }, { uploaded: 149, downloaded: 100, size: 100, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ mode: 'ratio', ratio: 1.5 }, { uploaded: 150, downloaded: 100, size: 100, seedingSeconds: 0 })).toBe(true)
    // created or rechecked torrents with downloaded === 0 measure ratio against total content size
    expect(shouldStopSeeding({ mode: 'ratio', ratio: 1 }, { uploaded: 50, downloaded: 0, size: 100, seedingSeconds: 0 })).toBe(false)
    expect(shouldStopSeeding({ mode: 'ratio', ratio: 1 }, { uploaded: 100, downloaded: 0, size: 100, seedingSeconds: 0 })).toBe(true)
    expect(shouldStopSeeding({ mode: 'ratio', ratio: 1 }, { uploaded: 100, downloaded: 0, size: 0, seedingSeconds: 0 })).toBe(false)

    expect(shouldStopSeeding({ mode: 'duration', minutes: 10 }, { uploaded: 0, downloaded: 100, size: 100, seedingSeconds: 599 })).toBe(false)
    expect(shouldStopSeeding({ mode: 'duration', minutes: 10 }, { uploaded: 0, downloaded: 100, size: 100, seedingSeconds: 600 })).toBe(true)
  })
})
