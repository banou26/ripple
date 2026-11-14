import type { Torrent } from '../../src/torrent/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'
import { useBulkSelection } from '../../src/router/bulk-selection'
import { TorrentTable } from '../../src/router/torrent-table'

/**
 * How a ticked row reads in the cards and in the table: the mark its look hangs on, a layout that stays put, and the
 * contrasts read off the pixels of a screenshot, on a white poster, a black one and none.
 */
const pictures = new Map<string, string>()
vi.mock('../../src/torrent/use-thumbnails', () => ({
  useThumbnail: (infoHash: string | undefined) => (infoHash && pictures.get(infoHash)) || null,
  useThumbnailGeneration: () => {},
}))

let n = 0
const t = (name: string): Torrent => {
  const i = n++
  return {
    id: String(i), infoHash: i.toString(16).padStart(40, 'a'), name, size: 1_000, downloaded: 0, progress: 0.5,
    state: 'downloading', down: 0, up: 0, peers: 0, seeds: 0, eta: '-', flags: 0, queuePosition: -1, stats: null, addedAt: 1_000,
  }
}

const painted = (colour: string) => {
  const canvas = document.createElement('canvas')
  canvas.width = 160
  canvas.height = 90
  const g = canvas.getContext('2d')!
  g.fillStyle = colour
  g.fillRect(0, 0, canvas.width, canvas.height)
  return canvas.toDataURL()
}

const WHITE = t('White.Poster')
const BLACK = t('Black.Poster')
const NONE = t('No.Poster')
const MISSING: Torrent = { ...t('Files.Missing'), state: 'missing' }
const ROWS = [WHITE, BLACK, NONE, MISSING]
pictures.set(WHITE.infoHash!, painted('white'))
pictures.set(BLACK.infoHash!, painted('black'))

/** The library in the page's own style, ticked through the page's own selection; `open` is the row the dock shows. */
const library = async (view: 'cards' | 'table', open?: Torrent) => {
  const { TorrentRow, style } = await import('../../src/router/home')
  const noop = () => {}
  const handlers = { saving: {}, onToggle: noop, onSave: noop, onSaveZip: noop, onStart: noop, onOptions: noop, onSelect: noop, savedToUserStorage: false }
  const Library = () => {
    const bulk = useBulkSelection(ROWS)
    return (
      <div css={style}><main>
        {view === 'table'
          ? (
            <TorrentTable
              torrents={ROWS} sortKey="name" sortDir="asc" onSort={noop}
              selectedId={open?.id ?? null} onSelect={noop} onOptions={noop} picked={bulk.picked} onPick={bulk.toggle}
            />
          )
          : ROWS.map((x) => <TorrentRow key={x.id} t={x} {...handlers} selected={x.id === open?.id} checked={bulk.picked.has(x.infoHash!)} onPick={bulk.toggle}/>)}
      </main></div>
    )
  }
  const screen = await render(<IntlRoot><MemoryRouter><Library/></MemoryRouter></IntlRoot>)
  await Promise.all([...screen.container.querySelectorAll('img')].map((img) => img.decode()))
  const box = (x: Torrent) => screen.getByRole('checkbox', { name: `Select ${x.name}` }).element() as HTMLInputElement
  const row = (x: Torrent) => box(x).closest<HTMLElement>('.torrent, tr')!
  return { screen, box, row }
}

/** The screenshot's colour under a point of the page. */
const drawn = async () => {
  const shot = await page.screenshot({ save: false })
  const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${shot}`)).blob())
  const g = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
  g.drawImage(bitmap, 0, 0)
  const scale = bitmap.width / innerWidth
  return (x: number, y: number) => [...g.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data.slice(0, 3)]
}

const linear = (c: number) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: number[]) => 0.2126 * linear(r!) + 0.7152 * linear(g!) + 0.0722 * linear(b!)
const contrast = (a: number[], b: number[]) => {
  const [one, two] = [luminance(a), luminance(b)]
  return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

afterEach(() => page.viewport(1280, 720))

describe('a ticked row', () => {
  for (const view of ['cards', 'table'] as const) {
    it(`carries the mark its look hangs on in the ${view}, and an unticked row does not`, async () => {
      const { box, row } = await library(view)
      const marked = () => ROWS.map((x) => view === 'cards' ? row(x).classList.contains('picked') : row(x).hasAttribute('data-picked'))
      expect(marked()).toEqual([false, false, false, false])
      await userEvent.click(box(BLACK))
      await userEvent.click(box(MISSING))
      expect(marked()).toEqual([false, true, false, true])
      await userEvent.click(box(BLACK))
      await userEvent.click(box(MISSING))
      expect(marked()).toEqual([false, false, false, false])
    })

    for (const width of [1280, 390]) {
      it(`moves nothing in the ${view} at ${width} px when a row is ticked or unticked`, async () => {
        await page.viewport(width, 900)
        const { screen, box } = await library(view)
        // the check inside a ticked box is the one thing meant to appear
        const boxes = () => [...screen.container.querySelectorAll('*')]
          .filter((element) => !element.closest('.row-check svg'))
          .map((element) => JSON.stringify(element.getBoundingClientRect()))
        const before = boxes()
        await userEvent.click(box(WHITE))
        expect(boxes()).toEqual(before)
        await userEvent.click(box(WHITE))
        expect(boxes()).toEqual(before)
        // the control: a ticked row that took a pixel more is seen to move
        const more = document.head.appendChild(document.createElement('style'))
        more.textContent = '.picked, [data-picked] > td { padding-top: 13px !important }'
        try {
          await userEvent.click(box(WHITE))
          expect(boxes()).not.toEqual(before)
        } finally {
          more.remove()
        }
      })
    }

    it(`is told by an edge 3:1 from the row's own fill in the ${view}, ticked alone or with its details open`, async () => {
      const { box, row } = await library(view, NONE)
      box(BLACK).click()
      box(NONE).click()
      await expect.poll(() => box(NONE).checked).toBe(true)
      const at = await drawn()
      // the edge is 3 px inside the card's 1 px border, or at the table's own edge
      const inset = view === 'cards' ? 1 : 0
      const middle = (x: Torrent) => { const { left, top, height } = row(x).getBoundingClientRect(); return { left, y: top + height / 2 } }
      const edge = (x: Torrent) => at(middle(x).left + inset + 1.5, middle(x).y)
      const fill = (x: Torrent) => at(middle(x).left + inset + 5.5, middle(x).y)
      for (const ticked of [BLACK, NONE]) {
        expect(contrast(edge(ticked), fill(WHITE)), `${ticked.name} against an unticked row`).toBeGreaterThanOrEqual(3)
        expect(contrast(edge(ticked), fill(ticked)), `${ticked.name} against its own tint`).toBeGreaterThanOrEqual(3)
      }
      // the control: an unticked row has no edge, its fill runs to its border
      expect(contrast(edge(WHITE), fill(WHITE))).toBeLessThan(1.1)
    })
  }
})

describe('the box on a poster', () => {
  it('is a checkbox named for its torrent, reached by Tab, and ringed in focus over a white picture', async () => {
    const { box } = await library('cards')
    const white = box(WHITE)
    const { left, top, height } = white.getBoundingClientRect()
    // across the circle's left side at its middle, which no card's fractional top can blur: the outline runs 2 to 4 px
    // outside the box, over a shade 6 px wide
    const ring = (at: (x: number, y: number) => number[]) => contrast(at(left - 2.5, top + height / 2), at(left - 4.5, top + height / 2))
    const unfocused = ring(await drawn())
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.tab()
    expect(document.activeElement).toBe(white)
    expect(ring(await drawn())).toBeGreaterThanOrEqual(3)
    // the control: the same pixels show no ring out of focus
    expect(unfocused).toBeLessThan(1.5)
  })

  it('keeps its ring 3:1 from the shade beside it on a white, a black and an empty poster, ticked or not', async () => {
    const { box } = await library('cards')
    const read = async () => {
      const at = await drawn()
      return ROWS.map((x) => {
        const { left, top, height } = box(x).getBoundingClientRect()
        const y = top + height / 2
        // across the circle's left side: the shade's 1 px outside it, then the 2 px ring
        return { name: x.name, stroke: at(left + 1.5, y), outside: at(left - 0.5, y), picture: at(left + 60, y) }
      })
    }
    for (const { name, stroke, outside } of await read()) {
      expect(contrast(stroke, outside), `${name}, unticked`).toBeGreaterThanOrEqual(3)
    }
    for (const x of ROWS) box(x).click()
    await expect.poll(() => ROWS.every((x) => box(x).checked)).toBe(true)
    const ticked = await read()
    for (const { name, stroke, outside } of ticked) {
      expect(contrast(stroke, outside), `${name}, ticked`).toBeGreaterThanOrEqual(3)
    }
    // the control: the ring alone, with no shade, would be lost on the white picture
    expect(contrast(ticked[0]!.stroke, ticked[0]!.picture)).toBeLessThan(1.5)
  })
})
