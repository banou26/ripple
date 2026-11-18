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

/** Both ways the library is drawn, handed `drawn` the way the page hands it, with the selection the page holds. */
const library = async (view: 'cards' | 'table', drawn: Torrent[]) => {
  const { TorrentRow, style } = await import('../../src/router/home')
  const onSelect = vi.fn()
  const onOptions = vi.fn()
  const handlers = {
    saving: {}, onToggle: vi.fn(), onSave: vi.fn(), onSaveZip: vi.fn(), onStart: vi.fn(), onOptions,
    selected: false, onSelect, savedToUserStorage: false,
  }
  const Library = () => {
    const bulk = useBulkSelection(drawn)
    return view === 'table'
      ? (
        <TorrentTable
          torrents={drawn} sortKey="name" sortDir="asc" onSort={vi.fn()}
          selectedId={null} onSelect={onSelect} onOptions={onOptions} picked={bulk.picked} onPick={bulk.toggle}
        />
      )
      : (
        <div css={style}><main>
          {drawn.map((x) => <TorrentRow key={x.id} t={x} {...handlers} checked={bulk.picked.has(x.infoHash!)} onPick={bulk.toggle}/>)}
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
  return { screen, box, ticked, onSelect, onOptions }
}

/**
 * Real boxes, clicked with shift held, in each of the two ways the library is drawn. Both are handed the list the way
 * the page hands it, sorted by name, so the order on screen is not the order the torrents arrived in. Fig is a ghost,
 * whose card draws its box in a component of its own.
 */
describe('shift+clicking the boxes', () => {
  const ARRIVED = [...['Cherry', 'Apple', 'Elder', 'Banana', 'Date'].map((name) => t({ name })), t({ name: 'Fig', state: 'missing' })]
  const DRAWN = sortTorrents(ARRIVED, 'name', 'asc')

  for (const view of ['cards', 'table'] as const) {
    it(`ticks and unticks a run in the order the ${view} draw`, async () => {
      const { box, ticked } = await library(view, DRAWN)
      expect(DRAWN.map((x) => x.name)).toEqual(['Apple', 'Banana', 'Cherry', 'Date', 'Elder', 'Fig'])
      await userEvent.click(box('Apple'))
      await userEvent.click(box('Cherry'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([true, true, true, false, false, false])
      // Banana is ticked, so the run from Cherry unticks
      await userEvent.click(box('Banana'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([true, false, false, false, false, false])
      await userEvent.click(box('Fig'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([true, true, true, true, true, true])
      // the control: without shift a click is one box
      await userEvent.click(box('Elder'))
      expect(ticked()).toEqual([true, true, true, true, false, true])
    })

    /**
     * Chrome otherwise selects the text between the two clicks there, and Firefox does not pass a shift+click from the
     * label on to the box. This file also runs in Firefox for that (vite.config.ts).
     */
    it(`ticks the run and selects no text in the ${view} when the shift+click lands beside the box`, async () => {
      const { screen, ticked } = await library(view, DRAWN)
      const beside = (i: number) => [...screen.container.querySelectorAll<HTMLElement>('.row-check')][i]!
      window.getSelection()?.removeAllRanges()
      await userEvent.click(beside(0), { position: { x: 2, y: 2 } })
      expect(ticked()).toEqual([true, false, false, false, false, false])
      await userEvent.click(beside(2), { position: { x: 2, y: 2 }, modifiers: ['Shift'] })
      expect(window.getSelection()?.toString()).toBe('')
      expect(ticked()).toEqual([true, true, true, false, false, false])
    })
  }
})

/**
 * A click on a row itself with Ctrl, Cmd or Shift held picks it as its box would, as on a file manager's rows, and
 * leaves the detail panel alone. Jujube has a Watch link, which is not the row's to take; Peach is still starting, so
 * it cannot be picked; Olive is a ghost, whose card is a component of its own.
 */
describe('a click on a row with Ctrl, Cmd or Shift held', () => {
  const DRAWN = sortTorrents([
    t({ name: 'Jujube', magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40), files: [{ name: 'Jujube.mkv', size: 1_000, index: 0 }] }),
    ...['Kiwi', 'Lime', 'Mango', 'Nectarine'].map((name) => t({ name })),
    t({ name: 'Olive', state: 'missing' }),
    t({ name: 'Peach', state: 'starting' }),
  ], 'name', 'asc')
  const NONE = [false, false, false, false, false, false]

  for (const view of ['cards', 'table'] as const) {
    it(`picks in the ${view} as the box would, and opens nothing`, async () => {
      const { screen, ticked, onSelect } = await library(view, DRAWN)
      expect(DRAWN.map((x) => x.name)).toEqual(['Jujube', 'Kiwi', 'Lime', 'Mango', 'Nectarine', 'Peach', 'Olive'])
      const row = (name: string) => screen.getByText(name, { exact: true })
      window.getSelection()?.removeAllRanges()
      await userEvent.click(row('Lime'), { modifiers: ['Control'] })
      expect(ticked()).toEqual([false, false, true, false, false, false])
      // Firefox selects a table cell under a Ctrl+click of its own
      expect(window.getSelection()?.toString()).toBe('')
      await userEvent.click(row('Lime'), { modifiers: ['Meta'] })
      expect(ticked()).toEqual(NONE)
      await userEvent.click(row('Kiwi'), { modifiers: ['Meta'] })
      await userEvent.click(row('Olive'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([false, true, true, true, true, true])
      // nor any text from the click before it
      expect(window.getSelection()?.toString()).toBe('')
      // Lime is ticked, so the run from Olive back to it unticks
      await userEvent.click(row('Lime'), { modifiers: ['Control', 'Shift'] })
      expect(ticked()).toEqual([false, true, false, false, false, false])
      await userEvent.click(row('Peach'), { modifiers: ['Control'] })
      await userEvent.click(row('Peach'), { modifiers: ['Shift'] })
      expect(ticked()).toEqual([false, true, false, false, false, false])
      expect(onSelect).not.toHaveBeenCalled()
      // the control: with no key held the click opens the row, and picks nothing
      await userEvent.click(row('Mango'))
      expect(onSelect).toHaveBeenCalledOnce()
      expect(ticked()).toEqual([false, true, false, false, false, false])
    })

    it(`leaves a Ctrl+click on a control of the row's own to it in the ${view}`, async () => {
      const { screen, ticked, onSelect, onOptions } = await library(view, DRAWN)
      await userEvent.click(screen.getByRole('button', { name: 'Options for Lime' }), { modifiers: ['Control'] })
      expect(onOptions).toHaveBeenCalledWith(expect.objectContaining({ name: 'Lime' }), null)
      await userEvent.click(screen.getByRole('button', { name: 'Options for Olive' }), { modifiers: ['Shift'] })
      expect(onOptions).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Olive' }), null)
      expect(ticked()).toEqual(NONE)
      expect(onSelect).not.toHaveBeenCalled()
    })
  }

  // the cards alone draw a Watch link
  it('leaves a Ctrl+click on a row\'s link to the link, which opens it in a tab', async () => {
    const { screen, ticked, onSelect } = await library('cards', DRAWN)
    const prevented: boolean[] = []
    // after the row's own handlers, and in their place the tab is not opened
    const stop = (e: MouseEvent) => { prevented.push(e.defaultPrevented); e.preventDefault() }
    document.addEventListener('click', stop)
    try {
      await userEvent.click(screen.getByRole('link', { name: 'Watch Jujube' }), { modifiers: ['Control'] })
    } finally {
      document.removeEventListener('click', stop)
    }
    expect(prevented).toEqual([false])
    expect(ticked()).toEqual(NONE)
    expect(onSelect).not.toHaveBeenCalled()
  })
})
