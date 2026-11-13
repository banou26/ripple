import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import { LISTED_ZONES, inListedCountry } from '../../src/torrent/country-line'

const RELEASE = '2026f'
const FIXTURE = `zone-tab-${RELEASE}.tab`

const zoneTab = () => {
  const ids: Record<string, string[]> = {}
  for (const line of readFileSync(join(import.meta.dirname, FIXTURE), 'utf8').split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [code, , id] = line.split('\t')
    ;(ids[code!] ??= []).push(id!)
  }
  return ids
}

// only the listed codes, so dropping a country is one edit and adding one is the constant plus its rows
const differences = (listed: Readonly<Record<string, readonly string[]>>, rows: Record<string, string[]>) =>
  Object.entries(listed).flatMap(([code, have]) => {
    const want = rows[code]
    if (!want) return [`${FIXTURE} has no ${code} rows: copy them from zone.tab ${RELEASE}`]
    return [
      ...want.filter(id => !have.includes(id)).map(id => `${code} lacks ${id}, which zone.tab ${RELEASE} gives it`),
      ...have.filter(id => !want.includes(id)).map(id => `${code} has ${id}, which zone.tab ${RELEASE} does not give it`),
    ]
  })

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
    expect(differences(LISTED_ZONES, zoneTab())).toEqual([])
  })

  test('a difference says what to fix, and rows of a code no longer listed are none', () => {
    const rows = { DE: ['Europe/Berlin', 'Europe/Busingen'], ES: ['Europe/Madrid'] }
    expect(differences({ DE: ['Europe/Berlin', 'Europe/Stockholm'], SE: ['Europe/Stockholm'] }, rows)).toEqual([
      `DE lacks Europe/Busingen, which zone.tab ${RELEASE} gives it`,
      `DE has Europe/Stockholm, which zone.tab ${RELEASE} does not give it`,
      `${FIXTURE} has no SE rows: copy them from zone.tab ${RELEASE}`,
    ])
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
