import type { Torrent, TorrentState } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'

import { keepShown, pickAll, pickRun, pickable, pickedRows, toPause, toResume, togglePick } from '../../src/router/bulk-selection'
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

  describe('a shift+click', () => {
    const list = () => {
      const rows = [t(), t(), t(), t(), t()]
      return { rows, h: rows.map((x) => x.infoHash!) as [string, string, string, string, string] }
    }

    it('ticks the run from the box clicked before down to the one clicked, both included', () => {
      const { rows, h } = list()
      expect(hashes(pickRun(new Set([h[1]]), rows, h[1], h[3]))).toEqual(hashes(new Set([h[1], h[2], h[3]])))
    })

    it('ticks the run up to a box drawn above the one clicked before', () => {
      const { rows, h } = list()
      expect(hashes(pickRun(new Set([h[3]]), rows, h[3], h[0]))).toEqual(hashes(new Set([h[0], h[1], h[2], h[3]])))
    })

    it('follows the order it is handed, which is the order drawn', () => {
      const { rows, h } = list()
      const drawn = [rows[4]!, rows[0]!, rows[3]!, rows[1]!, rows[2]!]
      expect(hashes(pickRun(new Set([h[0]]), drawn, h[0], h[1]))).toEqual(hashes(new Set([h[0], h[3], h[1]])))
    })

    it('unticks the run when the box clicked was ticked, and leaves the rest as they were', () => {
      const { rows, h } = list()
      expect(hashes(pickRun(new Set(h), rows, h[1], h[3]))).toEqual(hashes(new Set([h[0], h[4]])))
    })

    it('passes over a row in the run that cannot be ticked', () => {
      const starting = t({ state: 'starting' })
      const nameless = t({ infoHash: undefined })
      const [a, b] = [t(), t()]
      const picked = pickRun(new Set([a.infoHash!]), [a, starting, nameless, b], a.infoHash!, b.infoHash!)
      expect(hashes(picked)).toEqual(hashes(new Set([a.infoHash!, b.infoHash!])))
    })

    it('with no box clicked before, ticks the one clicked alone', () => {
      const { rows, h } = list()
      expect(hashes(pickRun(new Set([h[0]]), rows, null, h[3]))).toEqual(hashes(new Set([h[0], h[3]])))
    })

    it('with the box clicked before no longer drawn, ticks or unticks the one clicked alone', () => {
      const { rows, h } = list()
      const gone = t().infoHash!
      expect(hashes(pickRun(new Set([h[0]]), rows, gone, h[3]))).toEqual(hashes(new Set([h[0], h[3]])))
      expect(hashes(pickRun(new Set([h[0], h[3]]), rows, gone, h[3]))).toEqual([h[0]])
    })

    it('from the box that ended a run, ticks on past it or unticks back into it', () => {
      const { rows, h } = list()
      const first = pickRun(new Set([h[0]]), rows, h[0], h[2])
      expect(hashes(pickRun(first, rows, h[2], h[4]))).toEqual(hashes(new Set(h)))
      expect(hashes(pickRun(first, rows, h[2], h[1]))).toEqual([h[0]])
    })
  })

  /** The options menu's rule, row by row. */
  it('pauses every row not stopped, resumes the paused, the queued and the completed, and leaves a ghost to neither', () => {
    const STATES: TorrentState[] = ['downloading', 'seeding', 'paused', 'queued', 'completed', 'error', 'missing', 'retrying', 'checking']
    const rows = STATES.map((state) => t({ state }))
    expect(toPause(rows).map((x) => x.state)).toEqual(['downloading', 'seeding', 'error', 'retrying', 'checking'])
    expect(toResume(rows).map((x) => x.state)).toEqual(['paused', 'queued', 'completed'])
    expect(toPause([t({ state: 'paused' }), t({ state: 'missing' })])).toEqual([])
    expect(toResume([t({ state: 'seeding' }), t({ state: 'missing' })])).toEqual([])
  })
})
