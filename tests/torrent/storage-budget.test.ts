import { describe, expect, it } from 'vitest'

import { CACHE_SHARE, MAX_CACHE_BYTES, MIN_FREE_BYTES, cacheBudget, evictionFloor, isOriginFull, planEviction } from '../../src/torrent/storage-budget'
import type { Budget, EvictionCandidate } from '../../src/torrent/storage-budget'

const GB = 1_000_000_000

const candidate = (infoHash: string, usedAt: number, bytesOnDisk: number): EvictionCandidate =>
  ({ infoHash, usedAt, bytesOnDisk })

// a budget roomy enough that the cache ceiling never fires, so a case says what it means to say
const budget = (over: Partial<Budget>): Budget =>
  ({ usedBytes: 0, limitBytes: 100 * GB, pendingBytes: 0, candidates: [], ...over })

describe('evictionFloor', () => {
  it('caps the headroom on a large budget', () => {
    expect(evictionFloor(200 * GB)).toBe(MIN_FREE_BYTES)
  })

  it('scales down rather than swallowing a small budget whole', () => {
    // a fixed 1 GB is a third of a 3.3 GB Chromium origin budget, which would leave no room for an
    // ordinary release at all
    expect(evictionFloor(3_340_836_180)).toBe(334_083_618)
    expect(evictionFloor(3_340_836_180)).toBeLessThan(MIN_FREE_BYTES)
  })

  it('survives a browser that reports no quota', () => {
    expect(evictionFloor(0)).toBe(0)
    expect(evictionFloor(Number.NaN)).toBe(0)
    expect(evictionFloor(-1)).toBe(0)
  })
})

describe('cacheBudget', () => {
  it('is a share of the budget on an ordinary disk', () => {
    expect(cacheBudget(40 * GB, 1 * GB)).toBe(CACHE_SHARE * 40 * GB)
  })

  it('stops following a huge quota up', () => {
    // Chromium derives quota from free disk, so on a roomy machine a share alone is hundreds of GB
    expect(cacheBudget(2_000 * GB, 1 * GB)).toBe(MAX_CACHE_BYTES)
  })

  it('never drops below one whole item', () => {
    // a budget under the size of a single release evicts something and re-downloads it immediately
    expect(cacheBudget(3.3 * GB, 1.4 * GB)).toBe(1.4 * GB)
  })
})

describe('planEviction', () => {
  it('does nothing while there is room', () => {
    expect(planEviction(budget({
      usedBytes: 1 * GB,
      pendingBytes: 2 * GB,
      candidates: [candidate('a', 1, 1 * GB)],
    }))).toEqual([])
  })

  it('reserves what the watched torrent still has to write, not just the floor', () => {
    // 100 GB budget, 97 GB used, 3 GB free. The floor alone (1 GB) is already satisfied, so a
    // floor-only rule would sit still while the 4 GB file being streamed runs into the wall.
    expect(planEviction(budget({
      usedBytes: 97 * GB,
      pendingBytes: 4 * GB,
      candidates: [candidate('old', 1, 6 * GB)],
    }))).toEqual(['old'])
  })

  it('gives up the least recently used first', () => {
    expect(planEviction(budget({
      usedBytes: 99 * GB,
      pendingBytes: 1 * GB,
      candidates: [
        candidate('newest', 300, 3 * GB),
        candidate('oldest', 100, 3 * GB),
        candidate('middle', 200, 3 * GB),
      ],
    }))).toEqual(['oldest'])
  })

  it('stops as soon as the reservation is met', () => {
    expect(planEviction(budget({
      usedBytes: 99.5 * GB,
      pendingBytes: 0.5 * GB,
      candidates: [
        candidate('a', 1, 2 * GB),
        candidate('b', 2, 2 * GB),
        candidate('c', 3, 2 * GB),
      ],
    }))).toEqual(['a'])
  })

  it('takes more than one when one is not enough', () => {
    expect(planEviction(budget({
      usedBytes: 99.8 * GB,
      pendingBytes: 2 * GB,
      candidates: [
        candidate('a', 1, 1 * GB),
        candidate('b', 2, 1 * GB),
        candidate('c', 3, 1 * GB),
        candidate('d', 4, 1 * GB),
      ],
    }))).toEqual(['a', 'b', 'c'])
  })

  it('refuses to empty the cache for a file that can never fit', () => {
    // a 500 GB remux against a 100 GB budget: the reservation moves out of reach no matter what is
    // given up, so evicting past the floor buys nothing and costs everything
    expect(planEviction(budget({
      usedBytes: 99.5 * GB,
      pendingBytes: 500 * GB,
      candidates: [
        candidate('a', 1, 3 * GB),
        candidate('b', 2, 3 * GB),
        candidate('c', 3, 3 * GB),
      ],
    }))).toEqual(['a'])
  })

  it('gives up everything when even the floor is out of reach', () => {
    // almost nothing on disk is Ripple's, so no plan clears the floor; every byte back still helps
    expect(planEviction(budget({
      usedBytes: 99.9 * GB,
      pendingBytes: 1 * GB,
      candidates: [
        candidate('a', 1, 0.02 * GB),
        candidate('b', 2, 0.02 * GB),
      ],
    }))).toEqual(['a', 'b'])
  })

  it('never proposes a torrent with nothing on disk', () => {
    // deleting one frees no bytes, so it is a gratuitous removal that also cannot end the loop
    expect(planEviction(budget({
      usedBytes: 99.5 * GB,
      pendingBytes: 2 * GB,
      candidates: [
        candidate('empty', 1, 0),
        candidate('real', 2, 3 * GB),
      ],
    }))).toEqual(['real'])
  })

  it('trims the cold cache down to its ceiling on a disk with no pressure at all', () => {
    // Chromium hands a roomy machine a quota in the hundreds of GB, so pressure alone would let an
    // embedding page leave a hundred episodes behind before anything was ever reclaimed
    const candidates = Array.from({ length: 30 }, (_, i) => candidate(`h${String(i).padStart(2, '0')}`, i, 1 * GB))
    const plan = planEviction(budget({ usedBytes: 30 * GB, limitBytes: 4_000 * GB, candidates }))
    // 30 GB of cold cache against a 20 GB ceiling
    expect(plan).toEqual(['h00', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09'])
  })

  it('keeps one whole item even when the ceiling is smaller than it', () => {
    // 25% of a 3.3 GB budget is 835 MB, under the size of a single episode: trimming to that would
    // evict the one cached item and re-download it on the next play
    expect(planEviction(budget({
      limitBytes: 3.3 * GB,
      usedBytes: 1.4 * GB,
      candidates: [candidate('only', 1, 1.4 * GB)],
    }))).toEqual([])
  })

  it('is stable when two torrents were last used at the same moment', () => {
    const tie = [candidate('bbb', 5, 2 * GB), candidate('aaa', 5, 2 * GB)]
    const plan = planEviction(budget({ usedBytes: 99.5 * GB, pendingBytes: 1 * GB, candidates: tie }))
    const reversed = planEviction(budget({ usedBytes: 99.5 * GB, pendingBytes: 1 * GB, candidates: [...tie].reverse() }))
    expect(plan).toEqual(reversed)
    expect(plan).toEqual(['aaa'])
  })

  it('does not mutate the candidate list it was handed', () => {
    const candidates = [candidate('z', 9, 1 * GB), candidate('a', 1, 1 * GB)]
    planEviction(budget({ usedBytes: 99.9 * GB, pendingBytes: 1 * GB, candidates }))
    expect(candidates.map((c) => c.infoHash)).toEqual(['z', 'a'])
  })

  it('treats a browser that reports no usable estimate as nothing to do', () => {
    // an unknown quota is not a full disk, and a planner that evicts on one is worse than none
    const candidates = [candidate('a', 1, 1 * GB)]
    expect(planEviction(budget({ limitBytes: 0, usedBytes: 0, candidates }))).toEqual([])
    expect(planEviction(budget({ limitBytes: Number.NaN, usedBytes: 5 * GB, candidates }))).toEqual([])
    expect(planEviction(budget({ limitBytes: 10 * GB, usedBytes: Number.NaN, candidates }))).toEqual([])
    // a quota the browser reports as smaller than what it says is already stored
    expect(planEviction(budget({ limitBytes: 10 * GB, usedBytes: -1, candidates }))).toEqual([])
  })
})

/*
 * The shape a real Chromium origin actually presents, which is not the shape these cases assume.
 *
 * MEASURED 2026-09-03, one machine with 2.7 TiB free, one origin, three 512 MiB sparse writes:
 * Chromium's quota rose 10.737 GB to 12.353 GB, by exactly what was written, and `quota - usage`
 * came back as 10,737,418,240 every single time. Firefox on the same machine held the quota still
 * and let the headroom fall by the 1,613,063,025 bytes written, byte for byte.
 *
 * So on Chromium the browser hands the planner `limit = used + 10 GiB` rather than a fixed limit,
 * and these pin what that does to the two branches. They are here rather than in a comment because
 * the arithmetic is what decides it, and the arithmetic is testable.
 */
describe('an origin whose ceiling floats with its usage, as Chromium reports one', () => {
  const HEADROOM = 10_737_418_240
  const chromiumAt = (usedBytes: number, candidates: EvictionCandidate[]): Budget =>
    ({ usedBytes, limitBytes: usedBytes + HEADROOM, pendingBytes: 0, candidates })

  it('never fires the pressure branch, however much is already used', () => {
    // the floor is min(1 GB, 10% of limit) and the headroom is a constant 10 GiB, so `free < floor`
    // is `10 GiB < 1 GB` at every usage there is
    for (const used of [0, 1 * GB, 50 * GB, 500 * GB]) {
      expect(isOriginFull({ usedBytes: used, limitBytes: used + HEADROOM })).toBe(false)
    }
  })

  it('leaves the size branch as the only one that can reclaim anything there', () => {
    // 8 GB of cold cache against a budget of 25% of (8 GB + 10.74 GiB), which is about 4.7 GB
    const cold = [1, 2, 3, 4].map((n) => candidate(String(n), n, 2 * GB))
    const plan = planEviction(chromiumAt(8 * GB, cold))
    expect(plan.length, 'the cache ceiling still bites even where pressure cannot').toBeGreaterThan(0)
    // oldest first, and no more than the ceiling asks for
    expect(plan[0]).toBe('1')
    expect(plan.length).toBeLessThan(cold.length)
  })

  it('settles at a bounded cache rather than growing without end', () => {
    /*
     * `cold = CACHE_SHARE * (cold + headroom)` solves to headroom/3 with CACHE_SHARE at a quarter,
     * which is about 3.6 GB. Below it nothing is taken, above it something is, so the cache cannot
     * run away on a machine that never feels full: that is what makes the floating ceiling safe
     * rather than merely survivable.
     */
    const settled = HEADROOM / 3
    const under = [candidate('a', 1, Math.floor(settled * 0.9))]
    expect(planEviction(chromiumAt(under[0]!.bytesOnDisk, under))).toEqual([])
    const over = [1, 2].map((n) => candidate(String(n), n, Math.floor(settled * 0.8)))
    const used = over.reduce((sum, c) => sum + c.bytesOnDisk, 0)
    expect(planEviction(chromiumAt(used, over)).length).toBeGreaterThan(0)
  })
})

describe('isOriginFull', () => {
  it('is true only inside the floor', () => {
    expect(isOriginFull({ usedBytes: 99.5 * GB, limitBytes: 100 * GB })).toBe(true)
    expect(isOriginFull({ usedBytes: 98 * GB, limitBytes: 100 * GB })).toBe(false)
  })

  it('is false for a quota the browser will not report, which is not a full origin', () => {
    expect(isOriginFull({ usedBytes: 5 * GB, limitBytes: 0 })).toBe(false)
    expect(isOriginFull({ usedBytes: 5 * GB, limitBytes: Number.NaN })).toBe(false)
  })
})
