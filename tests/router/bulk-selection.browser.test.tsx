import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it } from 'vitest'
import { renderHook } from 'vitest-browser-react'

import { useBulkSelection } from '../../src/router/bulk-selection'
import { visibleTorrents } from '../../src/torrent/list-view'

/**
 * The selection as the page holds it, fed the list the page shows on every render.
 */
let n = 0
const t = (over: Partial<Torrent> = {}): Torrent => {
  const i = n++
  return {
    id: String(i),
    infoHash: i.toString(16).padStart(40, 'a'),
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

const mount = (shown: Torrent[]) =>
  renderHook((props?: { shown: Torrent[] }) => useBulkSelection(props!.shown), { initialProps: { shown } })

const names = (rows: Torrent[]) => rows.map((x) => x.name)

describe('useBulkSelection', () => {
  it('selects all of what the filter shows, and Select all again empties it', async () => {
    const [a, b] = [t(), t()]
    const hidden = t({ ephemeral: true })
    const { result, act } = await mount(visibleTorrents([a, b, hidden], 'library'))
    await act(() => result.current.toggleAll())
    expect(names(result.current.rows)).toEqual(names([a, b]))
    expect(result.current.picked.has(hidden.infoHash!)).toBe(false)
    expect(result.current.all).toBe(true)
    await act(() => result.current.toggleAll())
    expect(result.current.rows).toEqual([])
  })

  it('lets go of a torrent removed elsewhere, and does not pick it again when it comes back', async () => {
    const [a, b, c] = [t(), t(), t()]
    const { result, rerender, act } = await mount([a, b, c])
    await act(() => { result.current.toggle(a); result.current.toggle(b) })
    expect(names(result.current.rows)).toEqual(names([a, b]))

    await rerender({ shown: [b, c] })
    expect(names(result.current.rows)).toEqual(names([b]))

    await rerender({ shown: [a, b, c] })
    expect(names(result.current.rows), 'the removed torrent came back still ticked').toEqual(names([b]))
  })

  it('lets go of a torrent a filter hides, so an action never reaches a row off screen', async () => {
    const kept = t()
    const temporary = t({ ephemeral: true })
    const all = [kept, temporary]
    const { result, rerender, act } = await mount(visibleTorrents(all, 'all'))
    await act(() => result.current.toggleAll())
    expect(result.current.rows).toHaveLength(2)
    await rerender({ shown: visibleTorrents(all, 'library') })
    expect(names(result.current.rows)).toEqual(names([kept]))
    await rerender({ shown: visibleTorrents(all, 'all') })
    expect(names(result.current.rows)).toEqual(names([kept]))
  })

  it('cannot select anything while every row is still starting', async () => {
    const { result } = await mount([t({ state: 'starting' })])
    expect(result.current.canPick).toBe(false)
    expect(result.current.all).toBe(false)
  })
})
