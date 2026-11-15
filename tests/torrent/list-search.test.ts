import type { Torrent } from '../../src/torrent/types'

import { expect, it } from 'vitest'

import { matchesSearch } from '../../src/torrent/list-view'

const row = (name: string, infoHash: string) => ({ name, infoHash }) as Torrent

it('matches part of the name in any case, and the start of the info hash as written or in hex', () => {
  expect(matchesSearch(row('A.Season.Pack', 'b'.repeat(40)), 'season')).toBe(true)
  expect(matchesSearch(row('A.Season.Pack', 'b'.repeat(40)), 'BBBB')).toBe(true)
  expect(matchesSearch(row('A.Season.Pack', 'b'.repeat(40)), 'pack.a')).toBe(false)
  // a row listed by the base32 spelling of Sintel's hash, found by the hex one too
  expect(matchesSearch(row('Sintel', 'bcw2lj5gda5k4hqj3ay56z2i2vtaswqq'), 'BCW2')).toBe(true)
  expect(matchesSearch(row('Sintel', 'bcw2lj5gda5k4hqj3ay56z2i2vtaswqq'), '08ada5')).toBe(true)
})
