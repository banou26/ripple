import { describe, expect, it } from 'vitest'

import { mergeGroups, torrentsIn } from '../../src/torrent/groups'
import type { Member, TorrentGroup } from '../../src/torrent/groups'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

const group = (over: Partial<TorrentGroup> = {}): TorrentGroup =>
  ({ id: 'g1', name: 'Orbital Gardeners', namedAt: 1_000, members: [], ...over })

const json = (value: unknown) => JSON.stringify(value)

describe('mergeGroups', () => {
  it('keeps the later name, whichever copy arrives first', () => {
    const earlier = group({ name: 'Old name', namedAt: 1_000 })
    const later = group({ name: 'New name', namedAt: 2_000 })
    expect(mergeGroups([earlier], [later])[0]!.name).toBe('New name')
    expect(mergeGroups([later], [earlier])[0]!.name).toBe('New name')
    expect(mergeGroups([later], [earlier])[0]!.namedAt).toBe(2_000)
  })

  it('keeps an add on one device and a take-out of another torrent on a second', () => {
    // the laptop puts C in at 10:00; the desktop, holding the copy from before, takes B out at 10:05
    const before: Member[] = [{ infoHash: A, at: 100 }, { infoHash: B, at: 100 }]
    const laptop = group({ members: [...before, { infoHash: C, at: 1_000 }] })
    const desktop = group({ members: [{ infoHash: A, at: 100 }, { infoHash: B, at: 1_300, out: true }] })
    for (const merged of [mergeGroups([laptop], [desktop]), mergeGroups([desktop], [laptop])]) {
      expect([...torrentsIn(merged[0]!)].sort()).toEqual([A, C])
      expect(merged[0]!.members).toEqual([{ infoHash: A, at: 100 }, { infoHash: B, at: 1_300, out: true }, { infoHash: C, at: 1_000 }])
    }
  })

  it('keeps a deleted group deleted, with no name or members, and the earliest deletion', () => {
    const live = group({ name: 'Renamed after', namedAt: 9_000, members: [{ infoHash: A, at: 9_000 }] })
    const first = { id: 'g1', name: '', namedAt: 0, members: [], deletedAt: 3_000 }
    const second = { id: 'g1', name: '', namedAt: 0, members: [], deletedAt: 5_000 }
    const tombstone = { id: 'g1', name: '', namedAt: 0, members: [], deletedAt: 3_000 }
    expect(mergeGroups([live], [second], [first])).toEqual([tombstone])
    expect(mergeGroups([first], [live], [second])).toEqual([tombstone])
    expect(mergeGroups([second], [first], [live])).toEqual([tombstone])
    // alone too: a copy from another version may still carry the deleted group's name
    expect(mergeGroups([{ ...live, deletedAt: 3_000, extra: 1 }])).toEqual([tombstone])
  })

  it('breaks a tie the same way whichever copy comes first', () => {
    const one = group({ name: 'Alpha', namedAt: 1_000, members: [{ infoHash: A, at: 500 }] })
    const two = group({ name: 'Beta', namedAt: 1_000, members: [{ infoHash: A, at: 500, out: true }] })
    for (const merged of [mergeGroups([one], [two]), mergeGroups([two], [one])]) {
      expect(merged[0]!.name).toBe('Beta')
      expect(merged[0]!.members).toEqual([{ infoHash: A, at: 500, out: true }])
    }
  })

  it('drops malformed records and entries, since one copy is account JSON written by any version', () => {
    const merged = mergeGroups(
      { not: 'an array' },
      null,
      [
        null, 7, 'g', {},
        { id: '', name: 'empty id', namedAt: 1, members: [] },
        { id: 3, name: 'number id', namedAt: 1, members: [] },
        { id: 'bad-time', name: 'x', namedAt: '1', members: [] },
        { id: 'not-finite', name: 'x', namedAt: Infinity, members: [] },
        { id: 'bad-members', name: 'x', namedAt: 1, members: 'A' },
        { id: 'bad-name', name: 5, namedAt: 1, members: [] },
        { id: 'bad-deletion', name: 'x', namedAt: 1, members: [], deletedAt: 'yesterday' },
        {
          id: 'kept', name: 'Kept', namedAt: 1, extra: 'dropped',
          members: [null, { infoHash: '', at: 1 }, { infoHash: A, at: NaN }, { infoHash: 5, at: 1 }, { infoHash: B, at: 2, out: 'yes' }, { infoHash: C, at: 3, out: true, extra: 1 }],
        },
      ],
    )
    expect(merged).toEqual([{ id: 'kept', name: 'Kept', namedAt: 1, members: [{ infoHash: B, at: 2 }, { infoHash: C, at: 3, out: true }] }])
    expect(json(merged)).not.toContain('extra')
  })

  it('gives the same JSON in any order, any grouping and any number of times', () => {
    // seeded, so a failure names a case that can be run again
    let seed = 78
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
    const pick = <T>(from: readonly T[]): T => from[Math.floor(random() * from.length)]!
    const shuffled = <T>(list: readonly T[]): T[] =>
      list.map((value) => ({ value, key: random() })).sort((a, b) => a.key - b.key).map(({ value }) => value)
    // few ids, names, hashes and times, so the ties the rules settle actually happen
    const copy = (): TorrentGroup[] => Array.from({ length: Math.floor(random() * 4) }, () => {
      const live = {
        id: pick(['g1', 'g2', 'g3']),
        name: pick(['Alpha', 'Beta', 'Gamma']),
        namedAt: pick([1, 2, 3]),
        members: Array.from({ length: Math.floor(random() * 5) }, (): Member => random() < 0.4
          ? { infoHash: pick([A, B, C, 'd'.repeat(64)]), at: pick([1, 2, 3]), out: true }
          : { infoHash: pick([A, B, C, 'd'.repeat(64)]), at: pick([1, 2, 3]) }),
      }
      // a deleted record here still carries a name and members, as one from another version may
      return random() < 0.15 ? { ...live, deletedAt: pick([1, 2, 3, 4]) } : live
    })

    let compared = 0
    for (let n = 0; n < 500; n++) {
      const [x, y, z] = [copy(), copy(), copy()]
      const xyz = json(mergeGroups(x, y, z))
      expect(json(mergeGroups(y, x)), `case ${n}: commutative`).toBe(json(mergeGroups(x, y)))
      expect(json(mergeGroups(mergeGroups(x, y), z)), `case ${n}: associative`).toBe(xyz)
      expect(json(mergeGroups(x, mergeGroups(y, z))), `case ${n}: associative`).toBe(xyz)
      expect(json(mergeGroups(z, y, x)), `case ${n}: reversed`).toBe(xyz)
      expect(json(mergeGroups(mergeGroups(x, y, z))), `case ${n}: idempotent`).toBe(xyz)
      expect(json(mergeGroups(x, x)), `case ${n}: idempotent`).toBe(json(mergeGroups(x)))
      const reordered = shuffled(x).map((g) => ({ ...g, members: shuffled(g.members) }))
      expect(json(mergeGroups(reordered)), `case ${n}: order inside a copy`).toBe(json(mergeGroups(x)))
      if (xyz !== '[]') compared++
    }
    // the generator has to produce copies worth comparing, or the loop above proves nothing
    expect(compared).toBeGreaterThan(400)
  })
})

describe('torrentsIn', () => {
  it('holds the torrents put in and not taken out since', () => {
    const g = group({ members: [{ infoHash: A, at: 1 }, { infoHash: B, at: 2, out: true }, { infoHash: C, at: 3 }] })
    expect([...torrentsIn(g)].sort()).toEqual([A, C])
  })
})
