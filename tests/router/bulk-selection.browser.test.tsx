import type { Torrent } from '../../src/torrent/types'

import { describe, expect, it, vi } from 'vitest'
import { render, renderHook } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'
import { useBulkSelection } from '../../src/router/bulk-selection'
import { TorrentTable } from '../../src/router/torrent-table'
import { sortTorrents, visibleTorrents } from '../../src/torrent/list-view'

vi.mock('../../src/torrent/use-thumbnails', () => ({
  useThumbnail: () => null,
  useThumbnailGeneration: () => {},
}))

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

  /** The toolbar shows this as its mixed state, so one click there ticks the rest rather than clearing the one. */
  it('is not all while some of what is shown is unticked, and Select all then ticks the rest', async () => {
    const [a, b] = [t(), t()]
    const { result, act } = await mount([a, b])
    await act(() => result.current.toggle(a))
    expect(result.current.all).toBe(false)
    await act(() => result.current.toggleAll())
    expect(names(result.current.rows)).toEqual(names([a, b]))
    expect(result.current.all).toBe(true)
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

  describe('a shift+click', () => {
    it('runs from the box clicked last, which each click moves', async () => {
      const [a, b, c] = [t(), t(), t()]
      const { result, act } = await mount([a, b, c])
      await act(() => result.current.toggle(a))
      await act(() => result.current.toggle(c, true))
      expect(names(result.current.rows)).toEqual(names([a, b, c]))
      // from c, the box clicked last, rather than from a
      await act(() => result.current.toggle(a, true))
      expect(result.current.rows).toEqual([])
    })

    it('runs from a box whose row moved to another engine, kept by its info hash', async () => {
      const [a, b, c] = [t(), t(), t()]
      const { result, rerender, act } = await mount([a, b, c])
      await act(() => result.current.toggle(a))
      const moved = [a, b, c].map((x, i) => ({ ...x, id: String(100 + i) }))
      await rerender({ shown: moved })
      await act(() => result.current.toggle(moved[2]!, true))
      expect(names(result.current.rows)).toEqual(names([a, b, c]))
    })

    it('lets go of the box clicked last when its row leaves the list, even once it is back', async () => {
      const [a, b, c] = [t(), t(), t()]
      const { result, rerender, act } = await mount([a, b, c])
      await act(() => result.current.toggle(a))
      await rerender({ shown: [b, c] })
      await rerender({ shown: [a, b, c] })
      await act(() => result.current.toggle(c, true))
      expect(names(result.current.rows)).toEqual(names([c]))
    })
  })
})

/**
 * Real boxes, clicked with shift held, in each of the two ways the library is drawn. Both are handed the list the way
 * the page hands it, sorted by name, so the order on screen is not the order the torrents arrived in.
 */
describe('shift+clicking the boxes', () => {
  const ARRIVED = ['Cherry', 'Apple', 'Elder', 'Banana', 'Date'].map((name) => t({ name }))
  const DRAWN = sortTorrents(ARRIVED, 'name', 'asc')
  const handlers = {
    saving: {}, onToggle: vi.fn(), onSave: vi.fn(), onSaveZip: vi.fn(), onStart: vi.fn(), onOptions: vi.fn(),
    selected: false, onSelect: vi.fn(), savedToUserStorage: false,
  }

  const library = async (view: 'cards' | 'table') => {
    const { TorrentRow, style } = await import('../../src/router/home')
    const Library = () => {
      const bulk = useBulkSelection(DRAWN)
      return view === 'table'
        ? (
          <TorrentTable
            torrents={DRAWN} sortKey="name" sortDir="asc" onSort={vi.fn()}
            selectedId={null} onSelect={vi.fn()} onOptions={vi.fn()} picked={bulk.picked} onPick={bulk.toggle}
          />
        )
        : (
          <div css={style}><main>
            {DRAWN.map((x) => <TorrentRow key={x.id} t={x} {...handlers} checked={bulk.picked.has(x.infoHash!)} onPick={bulk.toggle}/>)}
          </main></div>
        )
    }
    const container = document.createElement('div')
    container.style.cssText = 'width: 1200px;'
    document.body.append(container)
    const screen = await render(<IntlRoot><MemoryRouter><Library/></MemoryRouter></IntlRoot>, { container })
    const box = (name: string) => screen.getByRole('checkbox', { name: `Select ${name}` })
    // the boxes from the top of the list down
    const ticked = () => [...screen.container.querySelectorAll<HTMLInputElement>('.row-check input')].map((x) => x.checked)
    return { screen, box, ticked }
  }

  for (const view of ['cards', 'table'] as const) {
    it(`ticks and unticks a run in the order the ${view} draw`, async () => {
      const { box, ticked } = await library(view)
      expect(DRAWN.map((x) => x.name)).toEqual(['Apple', 'Banana', 'Cherry', 'Date', 'Elder'])
      await userEvent.click(box('Apple'))
      await userEvent.click(box('Cherry'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([true, true, true, false, false])
      // Cherry was ticked, so the run from it unticks
      await userEvent.click(box('Banana'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([true, false, false, false, false])
      // the control: without shift a click is one box
      await userEvent.click(box('Elder'))
      expect(ticked()).toEqual([true, false, false, false, true])
    })
  }
})
