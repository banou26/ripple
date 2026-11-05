import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import { keepShown, pickAll, pickable, pickedRows, togglePick } from '../../src/router/bulk-selection'
import { visibleTorrents } from '../../src/torrent/list-view'

/**
 * Which torrents a bulk action reaches. The page shows the filtered list, so "all" is what is shown,
 * and a torrent that leaves the list leaves the selection with it.
 */
let n = 0
const t = (over: Partial<Torrent> = {}): Torrent => {
  const i = n++
  return {
    id: String(i),
    infoHash: i.toString(16).padStart(40, '0'),
    name: 'A torrent ' + i,
    size: 1_000,
    downloaded: 0,
    progress: 0,
    state: 'downloading',
    down: 0,
    up: 0,
    peers: 0,
    seeds: 0,
    eta: '-',
    flags: 0,
    queuePosition: -1,
    stats: null,
    addedAt: 1_000,
    ...over,
  }
}

const hashes = (picked: ReadonlySet<string>) => [...picked].sort()

describe('the bulk selection', () => {
  it('takes a row the engine has reported or a ghost, and never one still starting or one with no info hash', () => {
    expect(pickable(t())).toBe(true)
    expect(pickable(t({ state: 'missing' }))).toBe(true)
    expect(pickable(t({ state: 'starting' }))).toBe(false)
    expect(pickable(t({ infoHash: undefined }))).toBe(false)
  })

  it('selects all of the rows a filter shows, and none it hides', () => {
    const kept = [t(), t({ ephemeral: false })]
    const temporary = [t({ ephemeral: true }), t({ ephemeral: true })]
    const library = [...kept, ...temporary]
    expect(hashes(pickAll(visibleTorrents(library, 'library')))).toEqual(hashes(new Set(kept.map((x) => x.infoHash!))))
    expect(hashes(pickAll(visibleTorrents(library, 'temporary')))).toEqual(hashes(new Set(temporary.map((x) => x.infoHash!))))
    expect(pickAll(visibleTorrents(library, 'all')).size).toBe(4)
  })

  it('leaves out of "all" a row that cannot be ticked', () => {
    const starting = t({ state: 'starting' })
    const live = t()
    expect(hashes(pickAll([starting, live]))).toEqual([live.infoHash])
  })

  it('ticks and unticks one torrent at a time', () => {
    const a = t()
    const once = togglePick(new Set(), a.infoHash!)
    expect(once.has(a.infoHash!)).toBe(true)
    expect(togglePick(once, a.infoHash!).has(a.infoHash!)).toBe(false)
  })

  it('drops a torrent that left the list, removed here or anywhere else', () => {
    const [a, b, c] = [t(), t(), t()]
    const picked = new Set([a.infoHash!, b.infoHash!])
    const after = keepShown(picked, [b, c].map((x) => x.infoHash))
    expect(hashes(after)).toEqual([b.infoHash])
  })

  it('returns the same set when nothing left, so the page does not render again for it', () => {
    const [a, b] = [t(), t()]
    const picked = new Set([a.infoHash!])
    expect(keepShown(picked, [a, b].map((x) => x.infoHash))).toBe(picked)
  })

  it('keeps a torrent through a handover, when its row is starting again under a new id', () => {
    const a = t()
    const picked = new Set([a.infoHash!])
    const reconnecting = { ...a, id: 'starting:' + a.infoHash, state: 'starting' as const }
    expect(keepShown(picked, [reconnecting.infoHash])).toBe(picked)
    // but a bulk action does not reach it until the engine reports it again
    expect(pickedRows([reconnecting], picked)).toEqual([])
    const back = { ...a, id: '42' }
    expect(pickedRows([back], picked)).toEqual([back])
  })
})
