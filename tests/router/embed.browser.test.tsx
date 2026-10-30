import type { PlayerTorrent } from '../../src/torrent/use-player-torrent'

import { NORMALIZE_VOLUME_KEY } from '../../src/router/normalize-volume'
import { PLAYER_VOLUME_KEY } from '../../src/router/player-volume'
import { decodeMagnetParam } from '../../src/router/magnet-codec'

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
    status: { numPeers: 82, numSeeds: 0, uploadRate: 0 },
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

const state = { current: torrent(), named: [] as (number | undefined)[], framed: true, reachable: null as unknown }
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: (_: string | undefined, fileIndex: number | undefined) => {
    state.named.push(fileIndex)
    return state.current
  },
}))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => state.framed }))
vi.mock('../../src/torrent/use-reachability', () => ({ useReachability: () => state.reachable }))

const DESKTOP = { width: 1280, height: 720 }
const PHONE = { width: 390, height: 780 }
const SMALL_PHONE = { width: 360, height: 720 }

// the engine's status, with the swarm the trackers reported and the downloads they counted
const withSwarm = (status: Record<string, number>, swarmDownloads = -1, displayDownloadRate = 8_700_000) => {
  const { snapshot } = torrent()
  return torrent({ snapshot: { ...snapshot!, status: { ...snapshot!.status!, ...status }, swarmDownloads, displayDownloadRate } })
}

const VPN_ON = { port: 1, listeners: [{ up: true, healing: false }] }
const ORDINARY = { numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3, uploadRate: 312_000 }
// an info hash, so both links are on the row as they are on a real watch link
const WITH_LINKS = `?magnet=${btoa('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Film')}`

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

/**
 * The chip's text, read on a real hover. The pointer starts and ends on the video, away from the row:
 * a pointer left on a readout opens the chip of whatever the next mount draws under it, and a later
 * `getByText('82')` then also matches "Peers: 82".
 */
const hoverText = async (screen: Awaited<ReturnType<typeof mount>>, testId: string) => {
  const video = screen.container.querySelector('video')!
  await userEvent.hover(video)
  await userEvent.hover(screen.getByTestId(testId).element())
  await expect.poll(() => screen.container.querySelector('[role="tooltip"]')).not.toBeNull()
  const text = (screen.container.querySelector('[role="tooltip"]') as HTMLElement).innerText
  await userEvent.hover(video)
  return text
}

describe('the watch route', () => {
  beforeEach(() => { state.current = torrent(); state.reachable = null })
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
    // a phone hides the upload figure, and a desktop has to get it back
    expect(getComputedStyle(screen.container.querySelector('[data-tooltip-id="upload-speed"]')!).display).not.toBe('none')
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

  it('counts the swarm the trackers report, with the downloads and the connected peers in its hover', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 }, 8054)
    const screen = await mount()
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('216 seeders · 3 leechers')
    expect(await hoverText(screen, 'peers')).toBe('Seeders: 216\nLeechers: 3\nDownloads: 8054\nConnected peers: 28')
  })

  // a UDP tracker never sends the count
  it('leaves the downloads out of the hover when no tracker counted them', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 })
    const screen = await mount()
    expect(await hoverText(screen, 'peers')).toBe('Seeders: 216\nLeechers: 3\nConnected peers: 28')
  })

  // a release just out, with its uploader as the only seeder
  it('says seeder and leecher for a swarm of one', async () => {
    state.current = withSwarm({ numPeers: 2, numSeeds: 1, swarmSeeds: 1, swarmPeers: 1 })
    const screen = await mount()
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('1 seeder · 1 leecher')
  })

  // a tracker that does not carry the hash answers 0 and 0, which is not a dead torrent with 31 peers connected
  it('never counts fewer seeders or leechers than are connected', async () => {
    state.current = withSwarm({ numPeers: 31, numSeeds: 12, swarmSeeds: 0, swarmPeers: 0 }, 0)
    const screen = await mount()
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('12 seeders · 19 leechers')
    expect(await hoverText(screen, 'peers')).toBe('Seeders: 12\nLeechers: 19\nDownloads: 0\nConnected peers: 31')
  })

  // the first seconds, and a magnet with no trackers
  it('shows the connected peers until a tracker has answered with both counts', async () => {
    for (const swarm of [{ swarmSeeds: -1, swarmPeers: -1 }, { swarmSeeds: 216, swarmPeers: -1 }]) {
      state.current = withSwarm({ numPeers: 28, numSeeds: 26, ...swarm }, 8054)
      const screen = await mount()
      await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
      expect((screen.getByTestId('peers').element() as HTMLElement).innerText, JSON.stringify(swarm)).toBe('28')
      expect(await hoverText(screen, 'peers'), JSON.stringify(swarm)).toBe('Peers: 28')
      await screen.unmount()
    }
  })

  it('folds the swarm\'s words on a phone and keeps both numbers', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 })
    const screen = await mount(PHONE)
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('216 · 3')
  })

  /*
   * At 360 to 412px the peer count used to get 2 of its 14px and both speeds lost about half
   * (measured 2026-10-29), and nothing failed, because a readout that ellipsizes still fits the row.
   * So this asserts what the row SHOWS: the count whole whatever it reads, and with a phone's
   * ordinary figures every readout whole.
   */
  it('shows the whole peer count on a 360px phone, and every readout whole with ordinary figures', async () => {
    // what a player shows as it starts
    const VPN_RECONNECTING = { port: null, listeners: [{ up: false, healing: true }] }
    const WIDEST = { numPeers: 99999, numSeeds: 0, swarmSeeds: 99999, swarmPeers: 99999, uploadRate: 999_900_000 }
    const cases = [
      { name: 'ordinary', reachable: VPN_ON, status: ORDINARY, rate: 10_400_000, metadata: true },
      { name: 'widest', reachable: VPN_RECONNECTING, status: WIDEST, rate: 999_900_000, metadata: true },
      // a tracker answers before the metadata lands, so "Loading metadata…" is on the row too
      { name: 'starting', reachable: VPN_RECONNECTING, status: ORDINARY, rate: 0, metadata: false },
      { name: 'widest starting', reachable: VPN_RECONNECTING, status: WIDEST, rate: 0, metadata: false },
    ]
    for (const { name, reachable, status, rate, metadata } of cases) {
      state.reachable = reachable
      const playing = withSwarm(status, 8054, rate)
      state.current = metadata ? playing : { ...playing, snapshot: { ...playing.snapshot!, files: null } }
      const screen = await mount(SMALL_PHONE, WITH_LINKS)
      await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
      const shown = [...screen.container.querySelectorAll('.media-information .item')].filter((item) => item.getClientRects().length)
      const cut = shown.map((item) => item.querySelector(':scope > span')!)
        .filter((span) => span.scrollWidth > span.clientWidth)
        .map((span) => span.textContent)
      expect(cut, `${name}: the peer count is cut`).not.toContain(screen.getByTestId('peers').element().textContent)
      if (name === 'ordinary') expect(cut, name).toEqual([])
      // where each readout is painted: one squeezed under its icon keeps a box that fits and draws the icon past it
      const painted = shown.map((item) => [item.getBoundingClientRect(), item.querySelector('svg')!.getBoundingClientRect()] as const)
        .map(([box, icon]) => ({ left: Math.min(box.left, icon.left), right: Math.max(box.right, icon.right) }))
      expect(painted.filter((item, i) => i > 0 && item.left < painted[i - 1]!.right - 0.5), `${name}: a readout is drawn over the one before it`)
        .toEqual([])
      expect(painted.at(-1)!.right, `${name}: the last readout hangs off the right edge`)
        .toBeLessThanOrEqual(screen.container.firstElementChild!.getBoundingClientRect().right)
      expect(getComputedStyle(screen.container.querySelector('[data-tooltip-id="upload-speed"]')!).display, name).toBe('none')
      await screen.unmount()
    }
  })

  // a frame is often 560 to 700px wide, and the swarm's words alone take about 140px of it
  it('keeps every readout whole with ordinary figures in a frame of any width', async () => {
    const forms = { swarm: ORDINARY, peers: { ...ORDINARY, swarmSeeds: -1, swarmPeers: -1 } }
    for (const width of [480, 560, 640, 720, 768, 880, 960, 1280]) {
      for (const [form, status] of Object.entries(forms)) {
        state.reachable = VPN_ON
        state.current = withSwarm(status, 8054, 10_400_000)
        const screen = await mount({ width, height: 720 }, WITH_LINKS)
        await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
        const cut = [...screen.container.querySelectorAll('.media-information .item > span')]
          .filter((span) => span.getClientRects().length && span.scrollWidth > span.clientWidth)
          .map((span) => span.textContent)
        expect(cut, `${form} at ${width}px`).toEqual([])
        await screen.unmount()
      }
    }
  })

  // the tab keeps this player as its opener, to take what it downloaded; with nothing taken it has the magnet to add
  it('opens Ripple with this player as its opener, naming the torrent and carrying its magnet', async () => {
    const hash = '0123456789abcdef0123456789abcdef01234567'
    const magnet = `magnet:?xt=urn:btih:${hash}&dn=Film`
    const screen = await mount(DESKTOP, `?magnet=${btoa(magnet)}`)
    const link = screen.getByTestId('open-in-ripple')
    await expect.element(link).toBeInTheDocument()
    expect(link.element().getAttribute('rel')).toBe('opener')
    expect(link.element().getAttribute('target')).toBe('_blank')
    const href = new URL(link.element().getAttribute('href')!)
    expect(`${href.origin}${href.pathname}`).toBe(`${location.origin}/`)
    expect(href.searchParams.get('torrent')).toBe(hash)
    expect(decodeMagnetParam(href.searchParams)).toBe(magnet)
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

  it('says a file bigger than the room streams as it plays, on the phone too, and says nothing for one that fits', async () => {
    const NOTE = 'Too big to download ahead here, so it streams as you watch. In Ripple (header link), with more room allowed, it can download in full, without next episode, tracking or watch together.'
    // THE CONTROL: a file that fits counts its bytes and carries no note
    const fits = await mount()
    await expect.element(fits.getByText('82')).toBeInTheDocument()
    expect(fits.container.querySelector('.loading-information')).toBeNull()
    expect(fits.container.querySelector('.downloaded')).not.toBeNull()

    state.current = torrent({ snapshot: { ...torrent().snapshot!, windowed: true } })
    const screen = await mount(PHONE)
    await expect.element(screen.getByText(NOTE)).toBeInTheDocument()
    const note = screen.container.querySelector('.loading-information')!
    expect(note.querySelector('a, button')).toBeNull()
    // it wraps under the readouts rather than pushing them off the picture
    const readout = screen.container.querySelector('[data-testid="media-information"]')!.getBoundingClientRect()
    const player = screen.container.firstElementChild!.getBoundingClientRect()
    expect(readout.right).toBeLessThanOrEqual(player.right)
    expect(note.getBoundingClientRect().top).toBeGreaterThanOrEqual(readout.bottom - 1)
    expect(note.getBoundingClientRect().right).toBeLessThanOrEqual(player.right)
  })

  it('leaves the note out of Ripple at the top level, the page it points to', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, windowed: true } })
    state.framed = false
    try {
      const screen = await mount()
      await expect.element(screen.getByText('82')).toBeInTheDocument()
      expect(screen.container.querySelector('.loading-information')).toBeNull()
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
