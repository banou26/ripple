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
  flags: 0,
  queuePosition: -1,
  stats: {
    allTimeDownload: 1_000_000_000,
    allTimeUpload: 250_000_000,
    sessionDownload: 500_000_000,
    sessionUpload: 100_000_000,
    wasted: 4096,
    swarmSeeds: 40,
    swarmPeers: 12,
    numConnections: 6,
    connectionsLimit: 200,
    availability: 2.4,
    activeSeconds: 3600,
    seedingSeconds: 120,
    addedAt: 1_755_000_000,
    completedAt: 1_755_003_600,
    lastSeenComplete: 1_755_003_600,
    hadIncoming: true,
    savePath: '/downloads',
    pieceLength: 262_144,
    numPieces: 7630,
    numPiecesHave: 3815,
  },
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
  onRemove: vi.fn(), onStart: vi.fn(), onPause: vi.fn(), onEmbed: vi.fn(), onOptions: vi.fn(), selected: false, onSelect: vi.fn(),
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

  /**
   * Both routes to the options, which have to be two ways into one thing rather than two features.
   * The row is the only place either is offered, so a row that forgets to wire one of them takes
   * every per-torrent setting with it silently.
   */
  it('offers its options by right-click and by button, naming the same torrent', async () => {
    thumbnail.current = null
    const t = torrent()
    const { screen, props } = await inPage(t)

    screen.container.querySelector('.torrent')!.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 }),
    )
    expect(props.onOptions).toHaveBeenCalledTimes(1)
    expect(props.onOptions.mock.calls[0]![0].id).toBe(t.id)
    // a point means the menu; the row must not decide which surface, only where
    expect(props.onOptions.mock.calls[0]![1]).toEqual({ x: 120, y: 90 })

    await screen.getByRole('button', { name: `Options for ${t.name}` }).click()
    expect(props.onOptions).toHaveBeenCalledTimes(2)
    // null means the dialog, which is not anchored to anything
    expect(props.onOptions.mock.calls[1]![1]).toBeNull()
  })

  /**
   * Taking over the right button removes Inspect, Copy and Save as, so there has to be a way back.
   * Both modifiers are honoured because Ctrl is the secondary click on macOS while Shift is the
   * one that reads naturally elsewhere, and the menu states the keys in its own footer rather than
   * leaving the escape hatch to be discovered.
   */
  it.each([['shift', { shiftKey: true }], ['ctrl', { ctrlKey: true }]])(
    'lets %s + right-click through to the browser',
    async (_name, modifier) => {
      thumbnail.current = null
      const { screen, props } = await inPage(torrent())
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...modifier })
      screen.container.querySelector('.torrent')!.dispatchEvent(event)

      expect(props.onOptions).not.toHaveBeenCalled()
      // not prevented, so the browser goes on to draw its own menu
      expect(event.defaultPrevented).toBe(false)
    },
  )



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
   * The state, the percentage and the buttons are one right-hand group and have to read as one.
   *
   * They used to sit at three different heights: the first two at the end of the title row, the
   * third centred against the whole body, which looks like three things each aligned to something
   * different. Centres are compared rather than tops, because they are different heights by design.
   */
  it('puts the state, the percentage and the buttons on one line', async () => {
    thumbnail.current = null
    const screen = await mount(torrent())
    const middle = (sel: string) => { const b = box(screen.container.querySelector(sel))!; return b.top + b.height / 2 }
    const badge = middle('.badge')
    expect(Math.abs(middle('.pct') - badge)).toBeLessThan(2)
    expect(Math.abs(middle('.actions') - badge)).toBeLessThan(2)
    // left to right in that order, all of them past the text
    const body = box(screen.container.querySelector('.body'))!
    expect(box(screen.container.querySelector('.badge'))!.left).toBeGreaterThanOrEqual(body.right)
  })

  /**
   * The picture is a column of the whole card, not a thing beside one line of it.
   *
   * With the caveat that the card grows by the entire file list when that is opened, so following it
   * without limit turns a 16:9 frame into a tall column of one cropped stripe. A season pack is 24
   * rows, which is where this stops being a detail.
   */

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
    const side = box(screen.container.querySelector('.side'))!

    // the picture is still its own column, beside everything rather than above it
    expect(poster.right).toBeLessThanOrEqual(body.left)
    expect(side.left).toBeGreaterThanOrEqual(poster.right)
    // and the right-hand group dropped under the name instead of squeezing it
    expect(side.top).toBeGreaterThanOrEqual(body.bottom - 1)
    expect(body.right).toBeGreaterThan(body.left + 100)
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

  /**
   * Selection is what fills the docked details panel, so the ordinary click on a card has to be it.
   * The panel lives at the bottom of the page now rather than inside the row, which is why none of
   * these look at the row for it.
   */
  describe('selection', () => {
    it('selects the torrent when the card is clicked', async () => {
      thumbnail.current = null
      const t = torrent()
      const { screen, props } = await inPage(t)
      ;(screen.container.querySelector('.torrent') as HTMLElement).click()
      expect(props.onSelect).toHaveBeenCalledTimes(1)
      expect(props.onSelect.mock.calls[0]![0].id).toBe(t.id)
    })

    /**
     * Clicking an already-selected row asks for it AGAIN rather than asking to clear it. The row
     * has no way to know it is the selected one for that purpose, and it must not: a dock that
     * toggles shut under a second click closes while the user is reading it, and rows are big
     * enough that clicking one twice is ordinary. Closing has its own controls.
     */
    it('keeps asking for the same torrent when its row is clicked again', async () => {
      thumbnail.current = null
      const t = torrent()
      const { TorrentRow, style } = await import('./home')
      const props = handlers()
      const screen = await render(
        <MemoryRouter>
          <div css={style}><main><TorrentRow t={t} {...props} selected/></main></div>
        </MemoryRouter>,
        sized(),
      )
      const card = screen.container.querySelector('.torrent') as HTMLElement
      card.click()
      card.click()
      expect(props.onSelect).toHaveBeenCalledTimes(2)
      // the same torrent both times, and never a null or an "unselect" signal
      for (const call of props.onSelect.mock.calls) expect(call[0].id).toBe(t.id)
    })

    /** Every button already does something. Selecting as well would fire two actions per click. */
    it('does not select when an action button is used', async () => {
      thumbnail.current = null
      const { screen, props } = await inPage(torrent())
      await screen.getByRole('button', { name: 'Remove' }).click()
      expect(props.onRemove).toHaveBeenCalled()
      expect(props.onSelect).not.toHaveBeenCalled()
    })

    it('does not select when the watch link is followed', async () => {
      thumbnail.current = null
      const { screen, props } = await inPage(torrent())
      const link = screen.container.querySelector('a.primary') as HTMLElement | null
      if (!link) return
      link.click()
      expect(props.onSelect).not.toHaveBeenCalled()
    })

    it('marks the selected row for anyone reading the page', async () => {
      thumbnail.current = null
      const { TorrentRow, style } = await import('./home')
      const props = handlers()
      const screen = await render(
        <MemoryRouter>
          <div css={style}><main><TorrentRow t={torrent()} {...props} selected/></main></div>
        </MemoryRouter>,
        sized(),
      )
      const card = screen.container.querySelector('.torrent')!
      expect(card.classList.contains('selected')).toBe(true)
      expect(card.getAttribute('aria-current')).toBe('true')
    })

    /** Right-click selects first, so the menu and the dock can never disagree about the subject. */
    it('selects before opening the menu on right-click', async () => {
      thumbnail.current = null
      const t = torrent()
      const { screen, props } = await inPage(t)
      screen.container.querySelector('.torrent')!.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
      )
      expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }))
      expect(props.onOptions).toHaveBeenCalled()
    })
  })

})
