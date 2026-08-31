import type { PlayerTorrent } from '../../src/torrent/use-player-torrent'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { page } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

/**
 * What the embed route hands the player, measured where it lands.
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
  read: async () => new ArrayBuffer(0),
  readQuiet: async () => new ArrayBuffer(0),
  prioritizeFrom: () => {},
  ...over,
} as PlayerTorrent)

const state = { current: torrent() }
vi.mock('../../src/torrent/use-player-torrent', () => ({ usePlayerTorrent: () => state.current }))

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
    <MemoryRouter initialEntries={[`/embed${search}`]}>
      <Embed />
    </MemoryRouter>,
    sized(size),
  )
}

describe('the embed route', () => {
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
    const screen = await mount(DESKTOP, '?magnet=bWFnbmV0Og==&fileIndex=abc')
    // NaN would reach the engine and match no file at all, so it collapses to the first
    await expect.element(screen.getByText('Some.Release.Name.S01E04.1080p.mkv')).toBeInTheDocument()
  })
})
