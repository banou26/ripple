import type { Torrent } from '../../src/torrent/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { ListToolbar } from '../../src/components/list-toolbar'
import { IntlRoot } from '../../src/i18n'
import { TorrentTable } from '../../src/router/torrent-table'

/**
 * Where the scrolled library meets the toolbar above it.
 *
 * The list scrolls inside `main`, and a scroller's padding scrolls away with its content, so the room
 * under the controls has to sit outside the scroller or a scrolled card is cut flush against them and
 * the page reads as cut off. Hit tested, since what counts is what paints in that band.
 */
vi.mock('../../src/torrent/use-thumbnails', () => ({
  useThumbnail: () => null,
  useThumbnailGeneration: () => {},
}))

const torrent = (i: number): Torrent => ({
  id: 'id-' + i,
  magnet: 'magnet:?xt=urn:btih:' + String(i).padStart(40, '0'),
  infoHash: String(i).padStart(40, '0'),
  name: 'Some.Release.Name.S01E' + String(i).padStart(2, '0') + '.1080p',
  size: 1_400_000_000,
  downloaded: 700_000_000,
  progress: 0.5,
  state: 'downloading',
  down: 1_000_000,
  up: 2_000,
  peers: 12,
  seeds: 3,
  eta: '2m',
  etaSeconds: 120,
  flags: 0,
  queuePosition: -1,
  stats: null,
  addedAt: 1_755_000_000_000 - i * 1000,
})

const torrents = Array.from({ length: 30 }, (_, i) => torrent(i))

/** `above` stands in for the header and the stats, `dock` for the details panel under the list. */
const mount = async (view: 'cards' | 'table', { above = 0, dock = 0 } = {}) => {
  const { TorrentRow, style } = await import('../../src/router/home')
  const noop = vi.fn()
  return render(
    <IntlRoot><MemoryRouter>
      <div css={style}>
        {above > 0 && <div style={{ flex: 'none', height: above }}/>}
        <ListToolbar
          filter="all" onFilter={noop} sortKey="added" sortDir="desc" onSort={noop}
          view={view} onView={noop} temporaryCount={0} picked="none" canPick onPickAll={noop}
        />
        <main>
          {view === 'table'
            ? <TorrentTable torrents={torrents} sortKey="added" sortDir="desc" onSort={noop} selectedId={null} onSelect={noop} onOptions={noop} picked={new Set()} onPick={noop}/>
            : torrents.map((t) => (
              <TorrentRow
                key={t.id} t={t} saving={{}} onToggle={noop} onSave={noop} onSaveZip={noop} onRecheck={noop}
                onRemove={noop} onStart={noop} onPause={noop} onEmbed={noop} onOptions={noop}
                selected={false} onSelect={noop} savedToUserStorage={false} checked={false} onPick={noop}
              />
            ))}
        </main>
        {dock > 0 && <section style={{ flex: 'none', height: dock }}/>}
      </div>
    </MemoryRouter></IntlRoot>,
  )
}

const ROOM = 10

/** What paints at each pixel row from `top` down to `bottom`, sampled across the list's width. */
const hits = (main: HTMLElement, top: number, bottom: number) => {
  const box = main.getBoundingClientRect()
  const xs = [box.left + 40, box.left + box.width / 2, box.right - 60]
  const found: Element[] = []
  for (let y = Math.ceil(top); y < bottom; y++) {
    for (const x of xs) {
      const el = document.elementFromPoint(x, y)
      if (el) found.push(el)
    }
  }
  return found
}

const controlsBottom = (c: HTMLElement) =>
  Math.max(...[...c.querySelectorAll('.list-toolbar > *')].map((el) => el.getBoundingClientRect().bottom))

const WIDTHS = [[1440, 900], [390, 844]] as const

describe('the toolbar over a scrolled library', () => {
  afterEach(async () => { await page.viewport(1280, 720) })

  it.each(WIDTHS)('keeps room between the controls and a scrolled card at %ipx', async (width, height) => {
    await page.viewport(width, height)
    const screen = await mount('cards')
    const c = screen.container
    const main = c.querySelector('main')!

    // at rest the gap is the page's own 14px, once and not twice
    const rest = c.querySelector('.torrent')!.getBoundingClientRect().top - controlsBottom(c)
    expect(rest).toBeGreaterThanOrEqual(ROOM)
    expect(rest).toBeLessThanOrEqual(20)

    // half way into the first card, which is the cut the owner saw
    main.scrollTop = 50
    expect(main.scrollTop).toBe(50)
    const bar = controlsBottom(c)

    // the probe can see a card at all: one point well inside the list lands on one
    expect(hits(main, bar + 60, bar + 61).some((el) => el.closest('.torrent'))).toBe(true)
    const under = hits(main, bar + 1, bar + ROOM)
    expect(under.filter((el) => el.closest('.torrent')).length, 'a card paints right under the controls').toBe(0)
  })

  it.each(WIDTHS)('puts the column names right under that room, with no row above them, at %ipx', async (width, height) => {
    await page.viewport(width, height)
    const screen = await mount('table')
    const c = screen.container
    const main = c.querySelector('main')!

    main.scrollTop = 50
    expect(main.scrollTop).toBe(50)
    const bar = controlsBottom(c)
    const head = c.querySelector('thead th')!.getBoundingClientRect()

    expect(head.top - bar, 'the column names keep their room once stuck').toBeGreaterThanOrEqual(ROOM)
    expect(head.top - bar).toBeLessThanOrEqual(20)
    expect(hits(main, head.bottom + 4, head.bottom + 5).some((el) => el.closest('tbody'))).toBe(true)
    const above = hits(main, bar + 1, head.top)
    expect(above.filter((el) => el.closest('tbody')).length, 'a row shows between the controls and the column names').toBe(0)
  })

  /*
   * The details open under the list at their default 300px, in a window the header and the stats
   * already mostly fill: the phone, where the stats stack, and a short desktop window. The third
   * figure is how tall the header and the stats are on the real page at that size.
   */
  const SQUEEZED = [[390, 844, 444], [1280, 520, 166]] as const

  it.each(SQUEEZED)('keeps a card\'s name and numbers in view with the details open at %ipx', async (width, height, above) => {
    await page.viewport(width, height)
    const screen = await mount('cards', { above, dock: 300 })
    const main = screen.container.querySelector('main')!.getBoundingClientRect()
    const name = screen.container.querySelector('.torrent .title')!.getBoundingClientRect()
    const numbers = screen.container.querySelector('.torrent .meta')!.getBoundingClientRect()

    expect(name.top).toBeGreaterThanOrEqual(main.top)
    expect(numbers.bottom, 'the first card\'s name and numbers are cut by the details').toBeLessThanOrEqual(main.bottom)
  })

  it.each(SQUEEZED)('keeps the column names and a row in view with the details open at %ipx', async (width, height, above) => {
    await page.viewport(width, height)
    const screen = await mount('table', { above, dock: 300 })
    const main = screen.container.querySelector('main')!.getBoundingClientRect()
    const head = screen.container.querySelector('thead th')!.getBoundingClientRect()
    const row = screen.container.querySelector('tbody tr')!.getBoundingClientRect()

    expect(head.top).toBeGreaterThanOrEqual(main.top)
    expect(row.bottom, 'the column names and the first row are cut by the details').toBeLessThanOrEqual(main.bottom)
  })
})
