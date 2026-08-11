import { describe, expect, it } from 'vitest'

import { planSweep } from './opfs-sweep'
import type { DirEntry, SweepInput } from './opfs-sweep'

const HASH_A = '08ada5a7a6183aae1e09d831df6748d566095a10'
const HASH_B = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const dir = (name: string): DirEntry => ({ name, kind: 'directory' })
const file = (name: string): DirEntry => ({ name, kind: 'file' })

const input = (over: Partial<SweepInput>): SweepInput => ({
  entries: [],
  listedHashes: new Set(),
  claimedNames: new Set(),
  attributable: true,
  ...over,
})

describe('planSweep', () => {
  it('removes a per-torrent directory the library has no entry for', () => {
    expect(planSweep(input({
      entries: [dir(HASH_A), dir(HASH_B)],
      listedHashes: new Set([HASH_A]),
    }))).toEqual([HASH_B])
  })

  it('matches a hash directory case insensitively', () => {
    // the list stores what the magnet carried, which is not always lower case
    expect(planSweep(input({
      entries: [dir(HASH_A.toUpperCase())],
      listedHashes: new Set([HASH_A]),
    }))).toEqual([])
  })

  it('removes a hash directory even when nothing can be attributed by name', () => {
    // its name IS the attribution, so it never depends on knowing any torrent's layout
    expect(planSweep(input({
      entries: [dir(HASH_B)],
      attributable: false,
    }))).toEqual([HASH_B])
  })

  it('keeps a release folder that a known torrent claims', () => {
    expect(planSweep(input({
      entries: [dir('Sintel'), dir('Big Buck Bunny')],
      claimedNames: new Set(['Sintel']),
    }))).toEqual(['Big Buck Bunny'])
  })

  it('keeps a single-file torrent, which has no folder of its own', () => {
    expect(planSweep(input({
      entries: [file('Sintel.mp4'), file('stray.mkv')],
      claimedNames: new Set(['Sintel.mp4']),
    }))).toEqual(['stray.mkv'])
  })

  it('leaves the shared root alone when a torrent in it cannot be accounted for', () => {
    // entries there are named by the torrent's own file paths, so an unaccounted torrent's folder
    // and an orphan look exactly alike, and guessing costs the user a download
    expect(planSweep(input({
      entries: [dir('Sintel'), dir('Big Buck Bunny'), file('stray.mkv')],
      claimedNames: new Set(['Sintel']),
      attributable: false,
    }))).toEqual([])
  })

  it('still removes an unlisted hash directory while the shared root is held back', () => {
    expect(planSweep(input({
      entries: [dir('Big Buck Bunny'), dir(HASH_B)],
      attributable: false,
    }))).toEqual([HASH_B])
  })

  it('keeps a claimed folder that happens to be named like an infohash', () => {
    // a release named after its own hash would otherwise be read as an orphaned per-torrent
    // directory and deleted while its torrent is downloading into it
    expect(planSweep(input({
      entries: [dir(HASH_B)],
      listedHashes: new Set([HASH_A]),
      claimedNames: new Set([HASH_B]),
    }))).toEqual([])
  })

  it('does not mistake a FILE named like an infohash for a per-torrent directory', () => {
    // a single-file torrent whose name is a hash: only the shared-root rule may judge it
    expect(planSweep(input({
      entries: [file(HASH_B)],
      listedHashes: new Set([HASH_A]),
      attributable: false,
    }))).toEqual([])
  })

  it('removes nothing from an empty save root', () => {
    expect(planSweep(input({ entries: [] }))).toEqual([])
  })
})
