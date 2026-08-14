import type { Torrent } from '../torrent/types'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

/**
 * The shape of a library row, measured rather than described.
 *
 * Every claim here is about geometry or about what is on screen at a given state, and both are the
 * kind of thing that looks right in one row and wrong in a list. The picture in particular is a
 * replaced element in a baseline-aligned context, which is a layout that fails quietly: it renders,
 * it just hangs the row off the bottom of the image.
 */
const thumbnail = { current: null as string | null }
vi.mock('../torrent/use-thumbnails', () => ({
  useThumbnail: () => thumbnail.current,
  useThumbnailGeneration: () => {},
}))

const torrent = (over: Partial<Torrent> = {}): Torrent => ({
  id: '7',
  magnet: 'magnet:?xt=urn:btih:abc&dn=Pack',
  infoHash: 'abc',
  name: 'Some.Release.Name.S01.1080p',
  size: 4_500_000_000,
  downloaded: 2_250_000_000,
  progress: 0.5,
  state: 'downloading',
  down: 8_700_000,
  up: 120_000,
  peers: 82,
  seeds: 12,
  eta: '4m',
  files: [
    { name: 'Pack/E01.mkv', size: 1_400_000_000, progress: 1 },
    { name: 'Pack/E02.mkv', size: 1_500_000_000, progress: 0.5 },
    { name: 'Pack/E03.mkv', size: 1_600_000_000, progress: 0 },
  ],
  ...over,
})

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 1200px; height: 400px;'
  document.body.append(container)
  return { container }
}

const handlers = () => ({
  saving: {}, onToggle: vi.fn(), onSave: vi.fn(), onSaveZip: vi.fn(), onRecheck: vi.fn(),
  onRemove: vi.fn(), onStart: vi.fn(), onPause: vi.fn(), onEmbed: vi.fn(),
})

/**
 * The page's own style element has to be mounted around the row.
 *
 * Every rule for `.torrent` is nested inside it and scoped to it, so a row rendered bare has NO css:
 * it renders correctly and reports every box at the origin with zero size, which makes a geometry
 * assertion pass or fail on nothing at all.
 */
const inPage = async (t: Torrent, extra: Partial<Torrent> = {}) => {
  const { TorrentRow, style } = await import('./home')
  const props = handlers()
  const screen = await render(
    <MemoryRouter>
      <div css={style}><main><TorrentRow t={{ ...t, ...extra }} {...props} /></main></div>
    </MemoryRouter>,
    sized(),
  )
  return { screen, props }
}

const mount = async (t: Torrent) => (await inPage(t)).screen

const box = (el: Element | null) => el?.getBoundingClientRect() ?? null

const DESKTOP = { width: 1280, height: 720 }

describe('a library row', () => {
  // the viewport is shared by every test in the file, so a phone-sized one has to be handed back
  afterEach(async () => { await page.viewport(DESKTOP.width, DESKTOP.height) })

  it('holds the picture column even with no picture, so a mixed list stays aligned', async () => {
    thumbnail.current = null
    const screen = await mount(torrent())
    const placeholder = screen.container.querySelector('.poster.placeholder')
    expect(placeholder, 'the box is kept and filled with an icon').not.toBeNull()
    expect(screen.container.querySelector('img.poster')).toBeNull()
    expect(box(placeholder)!.width).toBeGreaterThan(80)
  })

  /**
   * The row aligns on the text BASELINE, and a replaced element's baseline is its bottom edge, so an
   * unaligned picture would sit with its underside on the title's baseline and push the card open.
   * Measured against the title rather than asserted as a style, because align-self is only one of
   * several ways to get this wrong.
   */
  it('puts the picture beside the title rather than hanging the row off its underside', async () => {
    thumbnail.current = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
    const screen = await mount(torrent())
    await expect.poll(() => screen.container.querySelector('img.poster')).not.toBeNull()

    const poster = box(screen.container.querySelector('img.poster'))!
    const title = box(screen.container.querySelector('.title strong'))!
    const card = box(screen.container.querySelector('.torrent'))!

    // to the LEFT of everything, not inline with the name
    expect(poster.right).toBeLessThanOrEqual(title.left)
    // and inside the card, which is what an unaligned replaced element breaks
    expect(poster.top).toBeGreaterThanOrEqual(card.top)
    expect(poster.bottom).toBeLessThanOrEqual(card.bottom + 1)
  })

  it('shows the bar while there is progress to watch', async () => {
    thumbnail.current = null
    const screen = await mount(torrent({ progress: 0.5 }))
    const bar = screen.container.querySelector('.bar .fill') as HTMLElement
    expect(bar).not.toBeNull()
    expect(bar.style.width).toBe('50%')
  })

  /** At 100% it is a solid bar restating the percentage already printed beside the name. */
  it('drops the bar once there is nothing left to watch', async () => {
    thumbnail.current = null
    const screen = await mount(torrent({ progress: 1, state: 'seeding' }))
    expect(screen.container.querySelector('.bar')).toBeNull()
    await expect.element(screen.getByText('100%')).toBeInTheDocument()
  })

  /** A check runs 0 to 1 over an already complete torrent, so this is the one full-progress case. */
  it('keeps the bar while a recheck runs, even at full progress', async () => {
    thumbnail.current = null
    const screen = await mount(torrent({ progress: 1, state: 'checking' }))
    expect(screen.container.querySelector('.bar')).not.toBeNull()
  })

  it('starts the file list under the title rather than under the picture', async () => {
    thumbnail.current = null
    const screen = await mount(torrent())
    const summary = box(screen.container.querySelector('.files summary'))!
    const title = box(screen.container.querySelector('.title strong'))!
    expect(Math.abs(summary.left - title.left)).toBeLessThan(2)
  })

  it('keeps the whole row on one line, with the buttons at the end', async () => {
    thumbnail.current = null
    const screen = await mount(torrent())
    const poster = box(screen.container.querySelector('.poster'))!
    const body = box(screen.container.querySelector('.body'))!
    const actions = box(screen.container.querySelector('.actions'))!
    expect(poster.right).toBeLessThanOrEqual(body.left)
    expect(body.right).toBeLessThanOrEqual(actions.left + 1)
    // the buttons are centred against the row, not stretched down its full height
    expect(actions.height).toBeLessThan(poster.height + 1)
  })

  /**
   * On a phone the row would otherwise squeeze the picture, the text AND six buttons onto one line.
   *
   * The breakpoint had to be rewritten with the layout: the old rule widened `.actions` inside a
   * container that no longer exists, so without this the buttons would simply have stayed inline and
   * crushed the name.
   */
  it('gives the buttons their own line on a phone, keeping the picture beside the text', async () => {
    thumbnail.current = null
    await page.viewport(390, 780)
    const screen = await mount(torrent())

    const poster = box(screen.container.querySelector('.poster'))!
    const body = box(screen.container.querySelector('.body'))!
    const actions = box(screen.container.querySelector('.actions'))!

    // picture and text still share a line
    expect(poster.right).toBeLessThanOrEqual(body.left)
    expect(Math.abs(poster.top - body.top)).toBeLessThan(2)
    // the buttons dropped below both of them
    expect(actions.top).toBeGreaterThanOrEqual(poster.bottom)
    // and the file list is no longer indented past a picture that is not beside it
    const summary = box(screen.container.querySelector('.files summary'))!
    expect(summary.left).toBeLessThan(poster.right)
  })

  /**
   * A torrent moves between missing and present at runtime, and the picture hook is called above
   * that branch precisely so the hook count does not change with it. Rendering both in turn is what
   * would surface the violation React reports as a corrupted render.
   */
  it('survives moving between missing and present', async () => {
    thumbnail.current = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
    const { TorrentRow, style } = await import('./home')
    const props = handlers()
    const row = (t: Torrent) => (
      <MemoryRouter><div css={style}><main><TorrentRow t={t} {...props} /></main></div></MemoryRouter>
    )
    const screen = await render(row(torrent()), sized())

    screen.rerender(row(torrent({ state: 'missing' })))
    await expect.element(screen.getByText(/Files aren't on this device/)).toBeInTheDocument()
    // the cached picture is still shown for a torrent whose files are gone
    expect(screen.container.querySelector('img.poster')).not.toBeNull()

    screen.rerender(row(torrent()))
    await expect.element(screen.getByText('82 peers')).toBeInTheDocument()
  })
})
