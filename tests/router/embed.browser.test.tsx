import type { PlayerTorrent } from '../../src/torrent/use-player-torrent'

import { NORMALIZE_VOLUME_KEY } from '../../src/router/normalize-volume'
import { PLAYER_VOLUME_KEY } from '../../src/router/player-volume'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page, userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

/**
 * What /watch hands the player, measured where it lands.
 *
 * Both halves used to be wrong on screen while being perfectly well typed: the torrent readout was
 * passed as a `ReactNode` with no say in where a `ReactNode` renders, and it came out painted across
 * the middle of the picture and never hid; the filename was simply never passed, so the one line the
 * player reserves for it stayed empty. Nothing but a measurement can hold either.
 *
 * The byte pipeline is deliberately not exercised here. libav's worker is copied into `build/` by the
 * build script and is not served in a test run, and what is under test is the wiring, not playback,
 * which `@banou/media-player` covers against a real file of its own.
 */
const FILE = { path: 'Release.Folder.Name/Some.Release.Name.S01E04.1080p.mkv', size: 1_400_000_000, offset: 0 }

const torrent = (over: Partial<PlayerTorrent> = {}): PlayerTorrent => ({
  snapshot: {
    handle: 1,
    magnet: 'magnet:?xt=urn:btih:abc',
    files: { storageIndex: 0, pieceLength: 1 << 20, numPieces: 1400, totalSize: FILE.size, files: [FILE] },
    status: { numPeers: 82, uploadRate: 0 },
    bitfield: null,
    recovery: null,
    userPaused: false,
    displayDownloadRate: 8_700_000,
  },
  engineError: null,
  fileIndex: 0,
  read: async () => new ArrayBuffer(0),
  readQuiet: async () => new ArrayBuffer(0),
  prioritizeFrom: () => {},
  ...over,
} as PlayerTorrent)

const state = { current: torrent(), named: [] as (number | undefined)[], framed: true }
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: (_: string | undefined, fileIndex: number | undefined) => {
    state.named.push(fileIndex)
    return state.current
  },
}))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => state.framed }))

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 780 }

const sized = ({ width, height }: { width: number, height: number }) => {
  const container = document.createElement('div')
  container.style.cssText = `width: ${width}px; height: ${height}px;`
  document.body.append(container)
  return { container }
}

/**
 * The VIEWPORT is resized, not only the container. Every breakpoint in the player and in this row is
 * a media query, and a media query reads the viewport, so a narrow box inside a 1280px window renders
 * the desktop layout at a small size: the exact arrangement that hides a phone-only bug.
 */
const mount = async (size = DESKTOP, search = '?magnet=bWFnbmV0Og==') => {
  await page.viewport(size.width, size.height)
  const { default: Embed } = await import('../../src/router/embed')
  return render(
    <MemoryRouter initialEntries={[`/watch${search}`]}>
      <Embed />
    </MemoryRouter>,
    sized(size),
  )
}

describe('the watch route', () => {
  beforeEach(() => { state.current = torrent() })
  // the viewport is shared by every test in the file, so a phone-sized one has to be handed back
  afterEach(async () => { await page.viewport(DESKTOP.width, DESKTOP.height) })

  it('names the file being played, without the folder around it', async () => {
    const screen = await mount()
    await expect.element(screen.getByText('Some.Release.Name.S01E04.1080p.mkv')).toBeInTheDocument()
    // the containing folder repeats the release name the app already shows around the player
    expect(screen.container.textContent).not.toContain('Release.Folder.Name')
  })

  it('puts the torrent readout in the top right, not over the picture', async () => {
    const screen = await mount()
    await expect.element(screen.getByText('82')).toBeInTheDocument()

    const readout = screen.container.querySelector('[data-testid="media-information"]')!.getBoundingClientRect()
    const player = screen.container.firstElementChild!.getBoundingClientRect()

    expect(readout.top - player.top).toBeLessThan(player.height / 4)
    expect(player.right - readout.right).toBeLessThan(player.width / 8)
    // inside the player, not merely near its right edge: the readout ran off the end and lost its
    // upload figure, and an overhang reads as a negative distance, which passes the check above
    expect(readout.right).toBeLessThanOrEqual(player.right)
  })

  it('says what it is waiting for while there is no metadata yet', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, files: null } })
    const screen = await mount()
    await expect.element(screen.getByText('Loading metadata…')).toBeInTheDocument()
    // there is no filename until metadata lands, so the slot that holds it is empty rather than absent
    expect(screen.container.querySelector('.file-name')?.textContent).toBe('')
    // and the player draws no title of its own, which is the whole reason this row exists
    expect(screen.container.querySelector('[class*="css"] > .title')).toBeNull()
  })

  it('lets the filename give way to the numbers rather than running under them', async () => {
    // The bug this replaced: the player drew the title full width in its own layer and the readout
    // in another, so on a phone the filename ellipsized against the WHOLE width and then ran
    // underneath the peer count painted on top of it. One row is what makes the two see each other.
    const screen = await mount(PHONE)

    await expect.element(screen.getByText('82')).toBeInTheDocument()
    const name = screen.container.querySelector('.file-name')!.getBoundingClientRect()
    const readout = screen.container.querySelector('[data-testid="media-information"]')!.getBoundingClientRect()
    const player = screen.container.firstElementChild!.getBoundingClientRect()

    // they share a line and do not overlap, which is the claim
    expect(name.right).toBeLessThanOrEqual(readout.left + 1)
    expect(readout.right).toBeLessThanOrEqual(player.right)
    // the filename was actually truncated rather than pushing the numbers off the edge
    expect(name.width).toBeLessThan(player.width)
    expect(screen.container.querySelector('.file-name')!.scrollWidth)
      .toBeGreaterThan(Math.ceil(name.width))
  })

  it('drops the byte counter before the status text when the row runs out of room', async () => {
    // Both are text on the same line, but only one of them explains a player showing nothing.
    const narrow = await mount(PHONE)
    await expect.element(narrow.getByText('82')).toBeInTheDocument()
    expect(narrow.container.querySelector('.downloaded')).not.toBeNull()
    expect(getComputedStyle(narrow.container.querySelector('.downloaded')!).display).toBe('none')

    state.current = torrent({ engineError: 'The download engine stopped. Reload the page to try again.' })
    const failed = await mount(PHONE)
    await expect.element(failed.getByText(/The download engine stopped/)).toBeInTheDocument()
    expect(getComputedStyle(failed.container.querySelector('.loading-information')!).display)
      .not.toBe('none')
  })

  /**
   * Inside another site's page Firefox holds this player to 10 GiB of its own, which a grant on
   * Ripple's site does not reach and which Ripple's library does not share (measured on Firefox 157,
   * 2026-10-19), so "Remove a download in Ripple" is advice that cannot be followed from here. This
   * same page in a tab of its own is first party and plays the file.
   */
  it('sends a file too big for the storage here to Ripple, where it can play', async () => {
    state.current = torrent({ storageFull: true })
    const screen = await mount(DESKTOP, '?magnet=bWFnbmV0Og==')
    const link = screen.getByRole('link', { name: 'Open it in Ripple' })
    await expect.element(link).toBeInTheDocument()
    expect(screen.container.querySelector('.loading-information')?.textContent)
      .toBe("Too big for this browser's storage here. Open it in Ripple to play it.")
    const href = new URL(link.element().getAttribute('href')!)
    expect(`${href.origin}${href.pathname}`).toBe(`${location.origin}/watch`)
    expect(href.searchParams.get('magnet')).toBe('bWFnbmV0Og==')
    expect(href.searchParams.get('fileIndex')).toBe('0')
    expect(link.element().getAttribute('target')).toBe('_blank')
    // the row takes no pointer events, so a link in it has to ask for them back
    expect(getComputedStyle(link.element()).pointerEvents).toBe('auto')
  })

  it('keeps the advice to remove a download in Ripple itself, where that frees room', async () => {
    state.current = torrent({ storageFull: true })
    state.framed = false
    try {
      const screen = await mount()
      await expect.element(screen.getByText('Out of storage space. Remove a download in Ripple to free room.')).toBeInTheDocument()
      expect(screen.container.querySelector('.loading-information a')).toBeNull()
    } finally { state.framed = true }
  })

  it('reports an engine failure instead of counting bytes that will never arrive', async () => {
    state.current = torrent({ engineError: 'The download engine stopped. Reload the page to try again.' })
    const screen = await mount()
    await expect.element(screen.getByText(/The download engine stopped/)).toBeInTheDocument()
  })

  /**
   * Every param here is written by whoever wrote the embed, so none of it can be trusted to parse.
   *
   * The player used to decode the magnet with a bare `atob`, which THROWS on anything that is not
   * base64, during render, on the route that a missing `mode` selects. A mistyped link took the
   * whole page down rather than showing an empty player. The download path was guarded from the
   * start; this one only looked like it was, because the failure needs a malformed URL to appear.
   */
  it('survives a magnet param that is not base64', async () => {
    const screen = await mount(DESKTOP, '?magnet=not!base64!')
    // the player mounts, having decoded nothing
    await expect.poll(() => screen.container.querySelector('video')).not.toBeNull()
  })

  it('survives a fileIndex that is not a number', async () => {
    state.named = []
    const screen = await mount(DESKTOP, '?magnet=bWFnbmV0Og==&fileIndex=abc')
    await expect.element(screen.getByText('Some.Release.Name.S01E04.1080p.mkv')).toBeInTheDocument()
    // NaN would reach the engine and match no file at all, so it is read as no file named
    expect(state.named.at(-1)).toBeUndefined()
  })

  // the stub plugin names no file, and the first file of a film release can be a special
  it('names no file to play when the link names none, and the one it names otherwise', async () => {
    const cases = [
      ['', undefined],
      ['&fileIndex=', undefined],
      // what /download reads as no file, so swapping the path cannot change which file is meant
      ['&fileIndex=%20', undefined],
      ['&fileIndex=1e1', undefined],
      ['&fileIndex=0', 0],
      ['&fileIndex=2', 2],
    ] as const
    for (const [search, named] of cases) {
      state.named = []
      const screen = await mount(DESKTOP, `?magnet=bWFnbmV0Og==${search}`)
      await expect.element(screen.getByText('Some.Release.Name.S01E04.1080p.mkv')).toBeInTheDocument()
      expect(state.named.at(-1), search).toBe(named)
      await screen.unmount()
    }
  })

  it('downloads the file the button names, once the file list is known', async () => {
    const special = { path: 'Promare/Promare.Galo.Hen.SP01.mkv', size: 200_000_000, offset: 0, pad: false }
    const film = { path: 'Promare/Promare.mkv', size: 2_000_000_000, offset: 200_000_000, pad: false }
    const { snapshot } = torrent()
    const downloadsFile = async (over: Partial<PlayerTorrent>) => {
      state.current = torrent(over)
      const screen = await mount()
      const link = screen.getByTestId('open-download-page')
      await expect.element(link).toBeInTheDocument()
      const label = link.element().getAttribute('aria-label')
      const fileIndex = new URL(link.element().getAttribute('href')!).searchParams.get('fileIndex')
      await screen.unmount()
      return { label, fileIndex }
    }
    expect(await downloadsFile({ fileIndex: 1, snapshot: { ...snapshot!, files: { ...snapshot!.files!, files: [special, film] } } }))
      .toEqual({ label: 'Download Promare.mkv', fileIndex: '1' })
    expect(await downloadsFile({ snapshot: { ...snapshot!, files: null } }))
      .toEqual({ label: 'Download this torrent', fileIndex: null })
  })
})

describe('the volume normalizer switch on /watch', () => {
  beforeEach(() => {
    state.current = torrent()
    localStorage.removeItem(NORMALIZE_VOLUME_KEY)
  })
  afterEach(() => { localStorage.removeItem(NORMALIZE_VOLUME_KEY) })

  const openSwitch = async (screen: Awaited<ReturnType<typeof mount>>) => {
    await expect.poll(() => screen.container.querySelector('button.settings')).not.toBeNull()
    ;(screen.container.querySelector('button.settings') as HTMLElement).click()
    await expect.poll(() => screen.container.querySelector('[role="switch"]')).not.toBeNull()
    return () => screen.container.querySelector('[role="switch"]') as HTMLElement
  }

  /**
   * The player keeps nothing between loads by design, so the switch sticking is ripple's half. The row
   * appearing at all is the other: the player offers it only when it is handed the worklet's url.
   */
  it('is offered in the player\'s settings menu, on with nothing saved, and what it is set to survives a reload', async () => {
    const first = await mount()
    const row = await openSwitch(first)
    expect(row().textContent).toBe('Normalize volume')
    expect(row().getAttribute('aria-checked')).toBe('true')
    row().click()
    await expect.poll(() => row().getAttribute('aria-checked')).toBe('false')
    expect(localStorage.getItem(NORMALIZE_VOLUME_KEY)).toBe('0')
    first.unmount()

    const second = await mount()
    const again = await openSwitch(second)
    expect(again().getAttribute('aria-checked')).toBe('false')
    again().click()
    await expect.poll(() => again().getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem(NORMALIZE_VOLUME_KEY)).toBe('1')
  })
})

describe('the volume on /watch', () => {
  beforeEach(() => {
    state.current = torrent()
    localStorage.removeItem(PLAYER_VOLUME_KEY)
  })
  afterEach(() => { localStorage.removeItem(PLAYER_VOLUME_KEY) })

  it('starts the next visit at the volume and mute the viewer left', async () => {
    const first = await mount()
    await expect.poll(() => first.container.querySelector('button[aria-label="Mute"]')).not.toBeNull()
    const video = first.container.querySelector('video')!
    video.volume = 0.3
    // a real click: a change made before the viewer has used the page is not kept
    await userEvent.click(first.container.querySelector('button[aria-label="Mute"]')!)
    await expect.poll(() => JSON.parse(localStorage.getItem(PLAYER_VOLUME_KEY) ?? 'null'))
      .toEqual({ volume: 0.3, muted: true })
    first.unmount()

    const second = await mount()
    await expect.poll(() => second.container.querySelector('button[aria-label="Mute"]')?.getAttribute('aria-pressed'))
      .toBe('true')
    const again = second.container.querySelector('video')!
    expect([again.volume, again.muted]).toEqual([0.3, true])
  })
})
