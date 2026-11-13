import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { LISTED_ZONES, inListedCountry } from '../../src/torrent/country-line'

const RELEASE = '2026f'

const zoneTab = () => {
  const ids: Record<string, string[]> = {}
  for (const line of readFileSync(join(import.meta.dirname, `zone-tab-${RELEASE}.tab`), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [code, , id] = line.split('\t')
    ;(ids[code!] ??= []).push(id!)
  }
  return ids
}

const LISTED = Object.entries(LISTED_ZONES).flatMap(([code, ids]) => ids.map(id => [code, id] as const))

const TZ = process.env.TZ
afterEach(() => {
  if (TZ === undefined) delete process.env.TZ
  else process.env.TZ = TZ
  vi.restoreAllMocks()
})

// the zone this device reports once set to `id`, as a browser reports the one its system is set to
const deviceSetTo = (id: string) => {
  process.env.TZ = id
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

describe('a listed country', () => {
  test.each(LISTED)('%s %s answers yes', (_, id) => {
    expect(inListedCountry(id)).toBe(true)
  })

  test(`each code has exactly zone.tab's ids at ${RELEASE}`, () => {
    const expected = zoneTab()
    const differences = [...new Set([...Object.keys(expected), ...Object.keys(LISTED_ZONES)])].flatMap(code => {
      const want = new Set(expected[code])
      const have = new Set(LISTED_ZONES[code])
      return [
        ...[...want].filter(id => !have.has(id)).map(id => `${code} lacks ${id}, which zone.tab ${RELEASE} gives it`),
        ...[...have].filter(id => !want.has(id)).map(id => `${code} has ${id}, which zone.tab ${RELEASE} does not give it`),
      ]
    })
    expect(differences).toEqual([])
  })

  // Chrome and Node name the device's zone through ICU, which keeps an older name for three listed ids
  test('each listed id answers yes under the name this runtime reports for it', () => {
    const seen = LISTED.map(([code, id]) => ({ code, id, reported: deviceSetTo(id) }))
    // a name per zone, so the device really was set to each
    expect(new Set(seen.map(({ reported }) => reported)).size).toBe(LISTED.length)
    expect(seen.filter(({ reported }) => !inListedCountry(reported))).toEqual([])
  })
})

describe('anywhere else', () => {
  test.each([
    'Europe/Stockholm', 'Europe/Copenhagen', 'Europe/Oslo', 'Arctic/Longyearbyen', 'Europe/Vienna', 'Europe/Zurich',
    'Europe/Vaduz', 'Europe/Paris', 'Europe/London', 'America/Panama', 'America/Nassau', 'America/Antigua',
    'America/Sao_Paulo', 'Atlantic/Reykjavik', 'UTC', 'Etc/UTC',
    // what Chrome reports for a zone it does not know
    'Etc/Unknown',
    '', 'Mars/Olympus_Mons',
  ])('%j answers no', id => {
    expect(inListedCountry(id)).toBe(false)
  })

  test('a device that reports no zone answers no', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: undefined } as never)
    expect(inListedCountry()).toBe(false)
  })
})

test("reads the device's zone when given none", () => {
  expect([deviceSetTo('Europe/Berlin'), inListedCountry()]).toEqual(['Europe/Berlin', true])
  expect([deviceSetTo('Europe/Stockholm'), inListedCountry()]).toEqual(['Europe/Stockholm', false])
})
