import { describe, expect, it } from 'vitest'

import {
  ALLOWANCE_CHUNKS, MIN_WINDOW_CHUNKS, RUNWAY_CHUNKS, SLACK_CHUNKS, chunksReached, isWindowed, piecesOf, planWindow, shareRoom, shouldTrickle, watchCeiling,
} from '../../src/torrent/window-plan'

const MiB = 1024 * 1024
const GiB = 1024 * MiB
const C = 64 * MiB
// a 25 GiB remux with 16 MiB pieces, alone in its torrent, in the stub frame's 10 GiB on Firefox
const FILM = { offset: 0, size: 25 * GiB, pieceLength: 16 * MiB }
const ROOM = 10 * GiB
const LAST = 25 * GiB / C - 1
const BUDGET = ROOM / C - ALLOWANCE_CHUNKS

const plan = (reader: number, held: number[] = [], file = FILM, room = ROOM, pinned = [] as { start: number, end: number }[]) =>
  planWindow({ file, chunkBytes: C, room, reader, held, pinned })

const chunks = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)
const dropped = (p: ReturnType<typeof plan>, held: number[]) => held.filter((k) => !p!.keep.includes(k))

describe('the window over a file bigger than the room', () => {
  it('keeps the head and the tail, and gives the rest of the room to a stretch from the reader and the slack past it', () => {
    const p = plan(0)!
    expect(BUDGET).toBe(157)
    expect(p.want).toEqual([
      { start: 0, end: 4 },
      { start: 0, end: 154 * 4 },
      { start: 154 * 4, end: (154 + SLACK_CHUNKS) * 4 },
      { start: LAST * 4, end: (LAST + 1) * 4 },
    ])
    expect(p.ahead).toEqual({ start: 0, end: 154 * 4 })
    expect(p.slack).toEqual({ start: 154 * 4, end: (154 + SLACK_CHUNKS) * 4 })
    expect(p.keep).toEqual([...chunks(0, 156), LAST])
  })

  it('keeps all it holds while reading on, and stops the stretch where the room is full', () => {
    const held = [...chunks(0, 156), LAST]
    const p = plan(100 * C, held)!
    expect(p.ahead).toEqual({ start: 100 * 4, end: 154 * 4 })
    expect(dropped(p, held)).toEqual([])
  })

  it('gives up the oldest of what was watched once the runway needs its room', () => {
    const held = [...chunks(0, 156), LAST]
    const p = plan(140 * C, held)!
    expect(p.ahead).toEqual({ start: 140 * 4, end: (140 + RUNWAY_CHUNKS) * 4 })
    // the slack past the runway is two chunks it does not hold yet
    expect(dropped(p, held)).toEqual([1, 2])
    expect(p.keep).toHaveLength(BUDGET)
  })

  it('keeps what was watched behind a seek forward until the new stretch needs the room, the farthest going first', () => {
    // read up to chunk 216, then a seek to just past it: the runway and its slack are 18 chunks it
    // does not hold, which is all that has to go
    const held = [0, ...chunks(64, 216), LAST]
    const p = plan(217 * C, held)!
    expect(dropped(p, held)).toEqual(chunks(64, 79))
    expect(p.ahead).toEqual({ start: 217 * 4, end: (217 + RUNWAY_CHUNKS) * 4 })
    // THE CONTROL: a seek one chunk earlier, onto what is held, gives up the same, so there is no
    // cliff at the edge of what was watched
    expect(dropped(plan(216 * C, held), held)).toEqual(chunks(64, 79))
  })

  it('keeps what was watched ahead of a seek back, giving up its far end first', () => {
    const held = [0, ...chunks(164, 316), LAST]
    const p = plan(20 * C, held)!
    expect(dropped(p, held)).toEqual(chunks(301, 316))
    expect(p.ahead).toEqual({ start: 20 * 4, end: (20 + RUNWAY_CHUNKS) * 4 })
  })

  it('leaves the slack before the last chunk at the end of the file, and wants everything once the reader is past it', () => {
    const end = plan(390 * C, chunks(244, 400))!
    expect(end.slack).toEqual({ start: (LAST - SLACK_CHUNKS) * 4, end: LAST * 4 })
    expect(end.want).toContainEqual(end.slack)
    const past = plan(LAST * C - 10 * MiB, chunks(246, 400))!
    expect(past.ahead).toEqual({ start: (LAST - 1) * 4, end: (LAST + 1) * 4 })
    expect(past.slack).toEqual({ start: 0, end: 0 })
    expect(past.want).toContainEqual(past.ahead)
  })

  it('keeps what is behind the reader over what is as far ahead of it', () => {
    // a room of 24 chunks has one more than the runway, the ends and the slack need
    const held = [0, 40, 160, LAST]
    expect(dropped(plan(100 * C, held, FILM, 24 * C), held)).toEqual([160])
  })

  it('keeps what another reader is reading, and counts it against the room', () => {
    const pinned = [piecesOf(FILM, 300 * C, 300 * C + 8 * MiB)]
    const p = plan(0, [], FILM, ROOM, pinned)!
    expect(p.keep).toContain(300)
    expect(p.ahead.end).toBe(153 * 4)
    expect(p.keep).toHaveLength(BUDGET)
    // and a held chunk it reads stays however far it is from the reader
    const held = [...chunks(0, 156), 300, LAST]
    expect(dropped(plan(140 * C, held, FILM, ROOM, pinned), held)).not.toContain(300)
  })

  it('plans nothing for a file that fits, or for a room too small to hold a window', () => {
    expect(plan(0, [], { ...FILM, size: ROOM })).toBeNull()
    expect(plan(0, [], FILM, (MIN_WINDOW_CHUNKS - 1) * C)).toBeNull()
    expect(plan(0, [], FILM, MIN_WINDOW_CHUNKS * C)).not.toBeNull()
    expect(isWindowed(ROOM + 1, ROOM, C)).toBe(true)
  })
})

describe('pieces that do not fall on chunk edges', () => {
  // the same film 3 MiB into its torrent, so every chunk edge is mid-piece
  const film = { ...FILM, offset: 3 * MiB }

  it('keeps a chunk a wanted piece reaches into', () => {
    // THE CONTROL: aligned, the slack's last piece ends on the chunk edge
    expect(chunksReached(FILM, C, [plan(0)!.slack])).toEqual(new Set([154, 155]))
    const p = plan(0, [], film)!
    // its first piece starts in the chunk before it and its last ends in the chunk after
    const reached = chunksReached(film, C, [p.slack])
    expect(reached.size).toBe(SLACK_CHUNKS + 2)
    for (const k of reached) expect(p.keep).toContain(k)
  })

  it('takes the chunks pieces spill into out of the stretch, so the window still fits its room', () => {
    expect(plan(0, [], film)!.ahead.end).toBeLessThan(plan(0)!.ahead.end)
    expect(plan(0, [], film)!.keep.length).toBeLessThanOrEqual(BUDGET)
    expect(plan(200 * C, chunks(0, LAST + 1), film)!.keep).toHaveLength(BUDGET)
  })
})

describe('the room watched cache files share', () => {
  it('splits it evenly between two films bigger than it', () => {
    expect(shareRoom([25 * GiB, 25 * GiB], 10 * GiB)).toEqual([5 * GiB, 5 * GiB])
  })

  it('gives a file that fits its size and the rest of the room to the other', () => {
    expect(shareRoom([25 * GiB, GiB], 10 * GiB)).toEqual([9 * GiB, GiB])
    // alone, a film has all of it
    expect(shareRoom([25 * GiB], 10 * GiB)).toEqual([10 * GiB])
  })
})

describe('the trickle', () => {
  it('holds the torrent once all ahead is held or the room is short, and only then', () => {
    expect(shouldTrickle(true, 10 * GiB, C)).toBe(true)
    expect(shouldTrickle(false, C - 1, C)).toBe(true)
    // a full window leaves the allowance, three chunks, and that is not short
    expect(shouldTrickle(false, 3 * C, C)).toBe(false)
    expect(shouldTrickle(false, C, C)).toBe(false)
  })
})

describe('telling a fixed ceiling from a floating one', () => {
  const firefox = (usedBytes: number) => ({ usedBytes, headroomBytes: 10 * GiB - usedBytes })
  const chromium = (usedBytes: number) => ({ usedBytes, headroomBytes: 10 * GiB })

  it('calls Firefox fixed once usage rose a chunk while its headroom fell with it', () => {
    let c = watchCeiling(undefined, firefox(128 * MiB), C)
    expect(c.fixed).toBeUndefined()
    c = watchCeiling(c, firefox(160 * MiB), C)
    expect(c.fixed).toBeUndefined()
    c = watchCeiling(c, firefox(200 * MiB), C)
    expect(c.fixed).toBe(true)
    // an eviction lowers usage and changes nothing about the ceiling
    expect(watchCeiling(c, firefox(50 * MiB), C).fixed).toBe(true)
  })

  it('calls Chromium floating once usage rose a chunk, where a 25 GiB file with 128 MiB on disk would otherwise window', () => {
    let c = watchCeiling(undefined, chromium(128 * MiB), C)
    expect(c.fixed).toBeUndefined()
    for (let used = 192 * MiB; used < 2 * GiB; used += C) {
      c = watchCeiling(c, chromium(used), C)
      expect(c.fixed).toBe(false)
    }
    // THE CONTROL: the room those numbers give is one the 25 GiB file would window in
    expect(isWindowed(FILM.size, 10 * GiB, C)).toBe(true)
  })

  it('keeps what an earlier session learned until usage moves enough to tell again', () => {
    const remembered = { ...chromium(3 * GiB), fixed: true }
    expect(watchCeiling(remembered, chromium(3 * GiB + C / 2), C).fixed).toBe(true)
    expect(watchCeiling(remembered, chromium(3 * GiB + C), C).fixed).toBe(false)
  })
})
