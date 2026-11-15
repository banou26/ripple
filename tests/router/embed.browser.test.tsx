import type { PlayerTorrent } from '../../src/torrent/use-player-torrent'

import { NORMALIZE_VOLUME_KEY } from '../../src/router/normalize-volume'
import { PLAYER_VOLUME_KEY } from '../../src/router/player-volume'
import { decodeMagnetParam } from '../../src/router/magnet-codec'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { cdp, page, userEvent } from '@vitest/browser/context'
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

const state = { current: torrent(), named: [] as (number | undefined)[], framed: true, reachable: null as unknown, transport: null as unknown, quota: null as unknown }
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: (_: string | undefined, fileIndex: number | undefined) => {
    state.named.push(fileIndex)
    return state.current
  },
}))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => state.framed }))
vi.mock('../../src/torrent/use-reachability', () => ({ useReachability: () => state.reachable, useEngineTransport: () => state.transport }))
// the FKN quota as fkn.app's broker would read it, which no test here asks
vi.mock('../../src/torrent/use-quota', () => ({ useQuota: () => state.quota }))
// whatever the constant is set to in the source, the row here has the VPN's switch
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))
// the warning's second sentence follows the machine's time zone, so each case says which it is about
const country = vi.hoisted(() => ({ listed: false }))
vi.mock('../../src/torrent/country-line', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/country-line')>()),
  inListedCountry: () => country.listed,
}))
// the choice is stored and no engine follows it: none of this file's players runs one of its own
const setVpn = vi.hoisted(() => vi.fn())
vi.mock('../../src/torrent/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/client')>()),
  setVpn,
}))

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
const watching = async (search: string) => {
  const { default: Embed } = await import('../../src/router/embed')
  const { IntlRoot } = await import('../../src/i18n')
  return (
    <IntlRoot><MemoryRouter initialEntries={[`/watch${search}`]}>
      <Embed />
    </MemoryRouter></IntlRoot>
  )
}

const mount = async (size = DESKTOP, search = '?magnet=bWFnbmV0Og==') => {
  await page.viewport(size.width, size.height)
  return render(await watching(search), sized(size))
}

/**
 * The chip's text, read on a real hover. The pointer starts and ends on the video, away from the row:
 * a pointer left on a readout opens the chip of whatever the next mount draws under it, and a later
 * `getByText('82')` then also matches "Connected peers: 82".
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

/**
 * Runs `inside` with Chrome's touch emulation on, as a phone, handing it a finger's tap at an element's centre. A mouse
 * click would hover the element first, and so open a chip whether or not a tap does. The test runs in a frame, so a
 * point in it is moved and scaled by the frame's rect.
 */
const asPhone = async (inside: (tap: (element: Element) => Promise<void>) => Promise<void>) => {
  const session = cdp()
  const tap = async (element: Element) => {
    const frame = window.frameElement!.getBoundingClientRect()
    const scale = frame.width / window.innerWidth
    const { left, top, width, height } = element.getBoundingClientRect()
    const point = { x: frame.left + (left + width / 2) * scale, y: frame.top + (top + height / 2) * scale }
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  try { await inside(tap) } finally { await session.send('Emulation.setTouchEmulationEnabled', { enabled: false }) }
}

/** The description Chrome gives a screen reader for the element at `selector`, read from its own accessibility tree. */
const describedAs = async (selector: string) => {
  const session = cdp()
  const { result } = await session.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('iframe')].map(frame => frame.contentDocument?.querySelector(${JSON.stringify(selector)})).find(Boolean)`,
  })
  const { nodes } = await session.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false })
  return nodes[0]?.description?.value
}

/** Stores the VPN's choice as another page would, so a player that is already drawn follows it. */
const storeVpnChoice = (on: boolean) => {
  if (on) localStorage.removeItem('ripple:vpn'); else localStorage.setItem('ripple:vpn', 'off')
  window.dispatchEvent(new StorageEvent('storage', { key: 'ripple:vpn' }))
}

beforeEach(async () => {
  localStorage.removeItem('ripple:vpn')
  localStorage.removeItem('ripple:vpn-off-remembered')
  const { storeVpn } = await import('../../src/torrent/vpn-setting')
  setVpn.mockReset().mockImplementation(async (on: boolean) => { storeVpn(on) })
})

describe('the watch route', () => {
  beforeEach(() => { state.current = torrent(); state.reachable = null; state.transport = null })
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
    await expect.element(screen.getByText('82', { exact: true })).toBeInTheDocument()

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

  it('names the torrent\'s state in the language of the page, as a library row does', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const { default: de } = await import('../../src/locales/de.json')
    await showIn('de', de)
    const screen = await mount()
    await expect.element(screen.getByTestId('torrent-state')).toHaveTextContent('Lädt herunter')
    await showEnglish()
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

  // the engine lists no torrent for such a link, so "Loading metadata…" would stand for good
  it('says a link the engine cannot add is not a valid one, and offers no way out to the same link', async () => {
    state.current = torrent({ snapshot: null, unreadable: true })
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.element(screen.getByText('That is not a valid magnet link')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('Loading metadata…')
    expect(screen.container.querySelector('[data-testid="open-in-ripple"]')).toBeNull()
    expect(screen.container.querySelector('[data-testid="open-download-page"]')).toBeNull()
    await screen.unmount()

    // THE CONTROL: the same link, readable, is waited on and has both links
    state.current = torrent({ snapshot: null })
    const readable = await mount(DESKTOP, WITH_LINKS)
    await expect.element(readable.getByText('Loading metadata…')).toBeInTheDocument()
    expect(readable.container.querySelector('[data-testid="open-in-ripple"]')).not.toBeNull()
    expect(readable.container.querySelector('[data-testid="open-download-page"]')).not.toBeNull()
  })

  it('lets the filename give way to the numbers rather than running under them', async () => {
    // The bug this replaced: the player drew the title full width in its own layer and the readout
    // in another, so on a phone the filename ellipsized against the WHOLE width and then ran
    // underneath the peer count painted on top of it. One row is what makes the two see each other.
    const screen = await mount(PHONE)

    await expect.element(screen.getByText('82', { exact: true })).toBeInTheDocument()
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
    await expect.element(narrow.getByText('82', { exact: true })).toBeInTheDocument()
    expect(narrow.container.querySelector('.downloaded')).not.toBeNull()
    expect(getComputedStyle(narrow.container.querySelector('.downloaded')!).display).toBe('none')

    state.current = torrent({ engineError: 'The download engine stopped. Reload the page to try again.' })
    const failed = await mount(PHONE)
    await expect.element(failed.getByText(/The download engine stopped/)).toBeInTheDocument()
    expect(getComputedStyle(failed.container.querySelector('.loading-information')!).display)
      .not.toBe('none')
  })

  // the words a library row gives its peers, and the swarm the trackers report in the hover
  it('shows the connected peers, with the swarm the trackers report and its downloads in its hover', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 }, 8054)
    const screen = await mount()
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('28 peers')
    expect(await hoverText(screen, 'peers')).toBe('Connected peers: 28\nSeeders: 216 · Leechers: 3 · Downloads: 8054')
  })

  // a UDP tracker never sends the count
  it('leaves the downloads out of the hover when no tracker counted them', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 })
    const screen = await mount()
    expect(await hoverText(screen, 'peers')).toBe('Connected peers: 28\nSeeders: 216 · Leechers: 3')
  })

  // a tracker that does not carry the hash answers 0 and 0, which is not a dead torrent with 31 peers connected
  it('never counts fewer seeders or leechers than are connected', async () => {
    state.current = withSwarm({ numPeers: 31, numSeeds: 12, swarmSeeds: 0, swarmPeers: 0 }, 0)
    const screen = await mount()
    expect(await hoverText(screen, 'peers')).toBe('Connected peers: 31\nSeeders: 12 · Leechers: 19 · Downloads: 0')
  })

  // in English at 1280px "Downloads:" ended one line and "8054" began the next, and in French "Sources" / "partielles : 973"
  it('keeps each of the swarm\'s counts on one line with its words in every language, as wide as they get', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    const facts = { 'Seeders: {count}': 216, 'Leechers: {count}': 973, 'Downloads: {count}': 8054 }
    // how many lines the chip draws `text` across, wherever its text nodes split it
    const linesOf = (chip: Element, text: string) => {
      const nodes: Text[] = []
      const walker = document.createTreeWalker(chip, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
      const starts = nodes.map((_, i) => nodes.slice(0, i).reduce((length, node) => length + node.data.length, 0))
      const at = nodes.map(node => node.data).join('').indexOf(text)
      if (at < 0) return 0
      const range = document.createRange()
      const place = (offset: number) => {
        const i = starts.findLastIndex(start => start <= offset)
        return [nodes[i]!, offset - starts[i]!] as const
      }
      range.setStart(...place(at))
      range.setEnd(...place(at + text.length))
      return new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top))).size
    }
    const split: string[] = []
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        for (const size of [SMALL_PHONE, DESKTOP]) {
          state.current = withSwarm({ numPeers: 999, numSeeds: 26, swarmSeeds: 216, swarmPeers: 973 }, 8054)
          const screen = await mount(size)
          const video = screen.container.querySelector('video')!
          await userEvent.hover(video)
          await userEvent.hover(screen.getByTestId('peers').element())
          await expect.poll(() => screen.container.querySelector('[role="tooltip"]')).not.toBeNull()
          const chip = screen.container.querySelector('[role="tooltip"]')!
          const words = Object.entries(facts).map(([id, count]) => (catalogue?.[id] ?? id).replace('{count}', String(count)))
          for (const [i, fact] of words.entries()) {
            const shown = i < words.length - 1 ? `${fact} ·` : fact
            const lines = linesOf(chip, shown)
            if (lines !== 1) split.push(`${language} at ${size.width}px: ${shown} on ${lines} lines`)
          }
          await userEvent.hover(video)
          await screen.unmount()
        }
      }
    } finally { await showEnglish() }
    expect(languages).toHaveLength(13)
    expect(split).toEqual([])
  }, 60_000)

  // the first seconds, and a magnet with no trackers
  it('says only the connected peers in its hover until a tracker has answered with both counts', async () => {
    for (const swarm of [{ swarmSeeds: -1, swarmPeers: -1 }, { swarmSeeds: 216, swarmPeers: -1 }]) {
      state.current = withSwarm({ numPeers: 28, numSeeds: 26, ...swarm }, 8054)
      const screen = await mount()
      await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
      expect((screen.getByTestId('peers').element() as HTMLElement).innerText, JSON.stringify(swarm)).toBe('28 peers')
      expect(await hoverText(screen, 'peers'), JSON.stringify(swarm)).toBe('Connected peers: 28')
      await screen.unmount()
    }
  })

  it('says one peer in the singular', async () => {
    state.current = withSwarm({ numPeers: 1, numSeeds: 1 })
    const screen = await mount()
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('1 peer')
  })

  it('folds the word on a phone and keeps the number', async () => {
    state.current = withSwarm({ numPeers: 28, numSeeds: 26, swarmSeeds: 216, swarmPeers: 3 })
    const screen = await mount(PHONE)
    await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
    expect((screen.getByTestId('peers').element() as HTMLElement).innerText).toBe('28')
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
      expect(cut, `${name}: the peer count is cut`).not.toContain(String(status.numPeers))
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

  // a frame is often 560 to 700px wide
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

  /*
   * The same ordinary figures in every state a player can show, with the VPN in each of its own, at the narrowest width
   * of each layout the row has: a phone's, then with the upload speed, then with the byte counter, then with the state's
   * and the peer count's words, then with the VPN's and a larger font. In DejaVu Sans, Turkish's speed was cut at 480px, and
   * VPN Reconnecting beside Retrying cut both speeds at 768px in English, Portuguese and Turkish (measured 2026-11-03).
   * It drew 1365 frames with four states of the VPN, which took 15.8 s on GitHub's runner on 2026-11-05, past the
   * default 15 s, and draws 2275 with the fifth.
   */
  it('keeps every readout whole with ordinary figures in every language, state and width', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    const { snapshot } = withSwarm(ORDINARY, 8054, 10_400_000)
    const states: Record<string, PlayerTorrent['snapshot']> = {
      downloading: snapshot!,
      seeding: { ...snapshot!, status: { ...snapshot!.status!, state: 5 } },
      completed: { ...snapshot!, status: { ...snapshot!.status!, state: 5, paused: true } },
      checking: { ...snapshot!, status: { ...snapshot!.status!, state: 1 } },
      queued: { ...snapshot!, status: { ...snapshot!.status!, paused: true } },
      paused: { ...snapshot!, status: { ...snapshot!.status!, paused: true }, userPaused: true },
      retrying: { ...snapshot!, recovery: { reason: 'stalled', attempt: 1, retryAt: 0 } },
    }
    // off is the engine with no relay, which has no port and no listener either; waiting is a choice no engine has followed yet
    const vpns = { on: VPN_ON, reconnecting: { port: null, listeners: [{ up: false, healing: true }] }, unreachable: { port: null, listeners: [] }, off: { port: null, listeners: [] }, waiting: VPN_ON }
    const cut: string[] = []
    const seen = new Set<string>()
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        for (const width of [360, 480, 560, 768, 960]) {
          const screen = await mount({ width, height: 720 }, WITH_LINKS)
          for (const [name, played] of Object.entries(states)) {
            for (const [vpn, reachable] of Object.entries(vpns)) {
              state.current = torrent({ snapshot: played })
              state.reachable = reachable
              state.transport = vpn === 'off' ? 'direct' : 'relay'
              storeVpnChoice(vpn !== 'off' && vpn !== 'waiting')
              await screen.rerender(await watching(WITH_LINKS))
              await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
              cut.push(...[...screen.container.querySelectorAll('.media-information .item > span')]
                .filter((span) => span.getClientRects().length && span.scrollWidth > span.clientWidth)
                .map((span) => `${language} at ${width}px, ${name} with the VPN ${vpn}: ${span.textContent}`))
              if (language === 'en' && width === 960) seen.add(screen.getByTestId('media-information').element().textContent)
            }
          }
          await screen.unmount()
        }
      }
    } finally { await showEnglish() }
    expect(languages).toHaveLength(13)
    // each state drawn as its own, so none of them was measured as another
    expect(seen.size).toBe(35)
    expect(cut).toEqual([])
  }, 90_000)

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

  it('says a file bigger than the room streams as it plays, and says nothing for one that fits', async () => {
    // THE CONTROL: a file that fits counts its bytes and carries no note
    const fits = await mount()
    await expect.element(fits.getByText('82', { exact: true })).toBeInTheDocument()
    expect(fits.container.querySelector('.loading-information')).toBeNull()
    expect(fits.container.querySelector('.downloaded')).not.toBeNull()

    state.current = torrent({ snapshot: { ...torrent().snapshot!, windowed: true } })
    const screen = await mount(PHONE)
    await expect.element(screen.getByText('Streams as you watch', { exact: true })).toBeInTheDocument()
    expect(screen.container.querySelector('.loading-information a, .loading-information button')).toBeNull()
  })

  /*
   * The sentence itself took the whole row: it wrapped at 1280px inside stub's frame, and in a 1992px one it left the
   * filename no room at all. So the row says a few words, on one line beside the readouts where they fit and under them
   * on a phone, and their chip says the rest on a hover, a tap or Tab.
   */
  it('says a file streams through a window in a few words on one line, with the whole sentence in their chip', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const { default: de } = await import('../../src/locales/de.json')
    const languages = [['en', 'Streams as you watch', STREAMS], ['de', 'Wird beim Ansehen gestreamt', STREAMS_DE]] as const
    const chip = () => document.getElementById('window-note')?.innerText
    try {
      for (const [language, words, sentence] of languages) {
        await (language === 'de' ? showIn('de', de) : showEnglish())
        for (const size of [DESKTOP, PHONE]) {
          const at = `${language} at ${size.width}px`
          state.reachable = VPN_ON
          const { snapshot } = withSwarm(ORDINARY, 8054, 10_400_000)
          state.current = torrent({ snapshot: { ...snapshot!, windowed: true } })
          const screen = await mount(size, WITH_LINKS)
          await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
          const note = screen.container.querySelector<HTMLElement>('.loading-information')!
          expect(note.innerText, at).toBe(words)
          const text = document.createRange()
          const lines = new Set([...note.querySelectorAll('*'), note].flatMap(element => [...element.childNodes])
            .filter(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
            .flatMap(node => { text.selectNodeContents(node); return [...text.getClientRects()].map(line => Math.round(line.bottom)) }))
          expect(lines.size, `${at}: lines of the note`).toBe(1)

          const box = (selector: string) => screen.container.querySelector(selector)!.getBoundingClientRect()
          const player = screen.container.firstElementChild!.getBoundingClientRect()
          const readouts = box('[data-testid="media-information"]')
          expect(note.getBoundingClientRect().right, at).toBeLessThanOrEqual(player.right)
          expect(readouts.right, at).toBeLessThanOrEqual(player.right)
          const cut = [...screen.container.querySelectorAll('.media-information .item > span')]
            .filter((span) => span.getClientRects().length && span.scrollWidth > span.clientWidth)
            .map((span) => span.textContent)
          expect(cut, at).toEqual([])
          if (size === DESKTOP) {
            // on the row's one line, beside the readouts, and the filename keeps its room
            expect(note.getBoundingClientRect().top, at).toBeLessThan(readouts.bottom)
            expect(note.getBoundingClientRect().bottom, at).toBeGreaterThan(readouts.top)
            expect(box('.file-name').width, at).toBeGreaterThan(100)
          }

          const anchor = screen.container.querySelector<HTMLElement>('[data-tooltip-id="window-note"]')!
          const video = screen.container.querySelector('video')!
          // a screen reader has the sentence while the chip is closed, when it is not in the document
          expect(chip(), at).toBeUndefined()
          expect(await describedAs('[data-tooltip-id="window-note"]'), `${at}: described`).toBe(sentence)
          await userEvent.hover(anchor)
          await expect.poll(chip, { message: `${at}: hovered` }).toBe(sentence)
          await userEvent.hover(video)
          await expect.poll(chip).toBeUndefined()
          // Tab from the link before it, and Escape puts the chip away with the note still focused
          screen.getByTestId('open-download-page').element().focus()
          await userEvent.tab()
          expect(document.activeElement, at).toBe(anchor)
          await expect.poll(chip, { message: `${at}: focused` }).toBe(sentence)
          await userEvent.keyboard('{Escape}')
          await expect.poll(chip, { message: `${at}: Escape` }).toBeUndefined()
          expect(document.activeElement, at).toBe(anchor)
          anchor.blur()
          if (size === PHONE) {
            await asPhone(async (tap) => {
              await tap(anchor)
              await expect.poll(chip, { message: `${at}: tapped` }).toBe(sentence)
            })
            anchor.blur()
            await userEvent.hover(video)
          }
          await screen.unmount()
        }
      }
    } finally { await showEnglish() }
  })

  it('leaves the note out of Ripple at the top level, the page it points to', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, windowed: true } })
    state.framed = false
    try {
      const screen = await mount()
      await expect.element(screen.getByText('82', { exact: true })).toBeInTheDocument()
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
    const special = { path: 'Feature/Feature.Extra.SP01.mkv', size: 200_000_000, offset: 0, pad: false }
    const film = { path: 'Feature/Feature.mkv', size: 2_000_000_000, offset: 200_000_000, pad: false }
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
      .toEqual({ label: 'Download Feature.mkv', fileIndex: '1' })
    expect(await downloadsFile({ snapshot: { ...snapshot!, files: null } }))
      .toEqual({ label: 'Download this torrent', fileIndex: null })
  })
})

describe('the tab\'s title on /watch', () => {
  const NEXT = { path: 'Release.Folder.Name/Some.Release.Name.S01E05.1080p.mkv', size: 1_300_000_000, offset: FILE.size, pad: false }
  const episodes = (fileIndex: number) => {
    const { snapshot } = torrent()
    return torrent({ fileIndex, snapshot: { ...snapshot!, files: { ...snapshot!.files!, files: [{ ...FILE, pad: false }, NEXT] } } })
  }
  const rerender = async (screen: Awaited<ReturnType<typeof mount>>) => screen.rerender(await watching('?magnet=bWFnbmV0Og=='))

  beforeEach(() => {
    state.current = torrent()
    state.framed = false
    document.title = 'Ripple Torrent'
  })
  afterEach(() => { state.framed = true })

  it('names the file being played, then the next one, and is the page\'s own again once the player goes', async () => {
    state.current = episodes(0)
    const screen = await mount()
    await expect.poll(() => document.title).toBe('Some.Release.Name.S01E04.1080p.mkv · Ripple Torrent')
    expect(navigator.mediaSession.metadata?.title).toBe('Some.Release.Name.S01E04.1080p.mkv')

    state.current = episodes(1)
    await rerender(screen)
    await expect.poll(() => document.title).toBe('Some.Release.Name.S01E05.1080p.mkv · Ripple Torrent')
    expect(navigator.mediaSession.metadata?.title).toBe('Some.Release.Name.S01E05.1080p.mkv')

    await screen.unmount()
    expect(document.title).toBe('Ripple Torrent')
    expect(navigator.mediaSession.metadata).toBeNull()
  })

  it('keeps the page\'s own title until the file\'s name is known', async () => {
    state.current = torrent({ snapshot: { ...torrent().snapshot!, files: null } })
    const screen = await mount()
    await expect.element(screen.getByText('Loading metadata…')).toBeInTheDocument()
    expect(document.title).toBe('Ripple Torrent')
    expect(navigator.mediaSession.metadata).toBeNull()

    state.current = torrent()
    await rerender(screen)
    await expect.poll(() => document.title).toBe('Some.Release.Name.S01E04.1080p.mkv · Ripple Torrent')
  })

  it('leaves the title and the Media Session to the page framing the player', async () => {
    state.framed = true
    const screen = await mount()
    await expect.element(screen.getByText('Some.Release.Name.S01E04.1080p.mkv')).toBeInTheDocument()
    expect(document.title).toBe('Ripple Torrent')
    expect(navigator.mediaSession.metadata).toBeNull()
  })
})

/*
 * The VPN's switch in the player, which is where most people meet ripple: inside another site's page, often
 * fullscreen, often on a phone. A fullscreen element shows nothing outside itself, so the warning is drawn inside
 * the player, over all of it.
 */
describe('the VPN switch on /watch', () => {
  const SENTENCE = 'Peers and trackers of every running torrent will see your IP address.'
  beforeEach(() => { state.current = torrent(); state.reachable = VPN_ON; state.transport = 'relay' })
  afterEach(async () => {
    state.reachable = null
    state.transport = null
    await page.viewport(DESKTOP.width, DESKTOP.height)
  })

  const control = (screen: Awaited<ReturnType<typeof mount>>) => screen.container.querySelector('.media-information [role="switch"]') as HTMLElement
  const warning = (screen: Awaited<ReturnType<typeof mount>>) => screen.container.querySelector('[role="dialog"]') as HTMLElement | null

  it('is a switch in the row, drawn from the stored choice, with the shield crossed while it is off', async () => {
    const on = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(on)).not.toBeNull()
    expect(control(on).tagName).toBe('BUTTON')
    expect(control(on).getAttribute('aria-checked')).toBe('true')
    expect(control(on).getAttribute('aria-label')).toBe('VPN: On')
    expect(control(on).textContent).toBe('VPN On')
    expect(control(on).querySelector('svg')?.classList.contains('lucide-shield')).toBe(true)
    await on.unmount()

    localStorage.setItem('ripple:vpn', 'off')
    // the engine has not followed yet: the shield is crossed at once, and the word waits
    const off = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(off)).not.toBeNull()
    expect(control(off).getAttribute('aria-checked')).toBe('false')
    expect(control(off).querySelector('svg')?.classList.contains('lucide-shield-off')).toBe(true)
    expect(control(off).textContent).toBe('VPN Waiting')
    expect(control(off).getAttribute('data-state')).toBe('waiting')
    state.transport = 'direct'
    await off.rerender(await watching(WITH_LINKS))
    expect(control(off).textContent).toBe('VPN Off')
    expect(getComputedStyle(control(off)).color, 'Off is a choice and takes no warning colour').toBe(getComputedStyle(off.getByTestId('peers').element()).color)
  })

  // under 960 px the shield is all the row shows: plain, it says peers see the relay's address
  it('keeps the shield crossed after it is switched back on, until the engine is behind the relay', async () => {
    localStorage.setItem('ripple:vpn', 'off')
    state.transport = 'direct'
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    await userEvent.click(control(screen))
    expect(setVpn.mock.calls).toEqual([[true]])
    expect(control(screen).textContent).toBe('VPN Waiting')
    expect(control(screen).getAttribute('aria-checked')).toBe('false')
    expect(control(screen).querySelector('svg')?.classList.contains('lucide-shield-off'), 'the plain shield, with the engine on the person\'s own address').toBe(true)

    state.transport = 'relay'
    await screen.rerender(await watching(WITH_LINKS))
    expect(control(screen).textContent).toBe('VPN On')
    expect(control(screen).getAttribute('aria-checked')).toBe('true')
    expect(control(screen).querySelector('svg')?.classList.contains('lucide-shield')).toBe(true)
  })

  it('is named and pressable on a phone, where its word is folded', async () => {
    const screen = await mount(SMALL_PHONE, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    expect(getComputedStyle(control(screen).querySelector('span')!).display).toBe('none')
    await expect.element(screen.getByRole('switch', { name: 'VPN: On' })).toBeInTheDocument()
    const box = control(screen).getBoundingClientRect()
    expect(box.height).toBeGreaterThanOrEqual(40)
    expect(box.width).toBeGreaterThanOrEqual(32)
    await asPhone(async (tap) => {
      await tap(control(screen))
      await expect.poll(() => warning(screen)).not.toBeNull()
    })
  })

  it('asks inside the player, over all of it, and leaves the VPN on when cancelled', async () => {
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    await userEvent.click(control(screen))
    await expect.poll(() => warning(screen)).not.toBeNull()
    const card = warning(screen)!
    expect(card.textContent).toBe(`${SENTENCE}Remember this decisionCancelTurn off`)

    // in the element the player takes fullscreen, which is the one that holds its picture and its controls
    const player = screen.container.querySelector('.control-bar')!.parentElement!
    expect(player.contains(screen.container.querySelector('video'))).toBe(true)
    expect(player.contains(card)).toBe(true)
    expect(card.getBoundingClientRect()).toEqual(player.getBoundingClientRect())
    // over the player's own controls and over the row, not under them
    for (const under of [screen.container.querySelector('.control-bar button')!, control(screen), screen.getByTestId('open-in-ripple').element()]) {
      const { left, top, width, height } = under.getBoundingClientRect()
      expect(card.contains(document.elementFromPoint(left + width / 2, top + height / 2)), under.className).toBe(true)
    }
    await expect.poll(() => document.activeElement?.textContent).toBe('Cancel')

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }).element())
    await expect.poll(() => warning(screen)).toBeNull()
    expect(setVpn).not.toHaveBeenCalled()
    expect(localStorage.getItem('ripple:vpn')).toBeNull()
    expect(control(screen).getAttribute('aria-checked')).toBe('true')
  })

  it('switches off once confirmed, crosses the shield at once, and switches back on without asking', async () => {
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    await userEvent.click(control(screen))
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }).element())
    await expect.poll(() => warning(screen)).toBeNull()
    expect(setVpn.mock.calls).toEqual([[false]])
    expect(localStorage.getItem('ripple:vpn')).toBe('off')
    expect(control(screen).getAttribute('aria-checked')).toBe('false')
    expect(control(screen).querySelector('svg')?.classList.contains('lucide-shield-off')).toBe(true)

    await userEvent.click(control(screen))
    expect(warning(screen)).toBeNull()
    expect(setVpn.mock.calls).toEqual([[false], [true]])
    expect(control(screen).getAttribute('aria-checked')).toBe('true')
  })

  it('is not asked again in this storage once Remember this decision was ticked', async () => {
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    await userEvent.click(control(screen))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Remember this decision' }).element())
    await userEvent.click(screen.getByRole('button', { name: 'Turn off' }).element())
    await userEvent.click(control(screen))
    await userEvent.click(control(screen))
    expect(warning(screen)).toBeNull()
    expect(setVpn.mock.calls).toEqual([[false], [true], [false]])
  })

  // the player pauses on Space and goes fullscreen on f, from any key that reaches the window
  it('is pressed with Space, which does not reach the player, and neither does a key in the warning', async () => {
    const heard: string[] = []
    const hear = (event: KeyboardEvent) => { heard.push(event.key) }
    window.addEventListener('keydown', hear)
    try {
      const screen = await mount(DESKTOP, WITH_LINKS)
      await expect.poll(() => control(screen)).not.toBeNull()
      // THE CONTROL: a key on one of the row's links is heard
      screen.getByTestId('open-in-ripple').element().focus()
      await userEvent.keyboard('m')
      expect(heard).toEqual(['m'])
      heard.length = 0

      control(screen).focus()
      await userEvent.keyboard(' ')
      await expect.poll(() => warning(screen)).not.toBeNull()
      await expect.poll(() => document.activeElement?.textContent).toBe('Cancel')
      await userEvent.keyboard('f')
      await userEvent.keyboard('m')
      await userEvent.keyboard('{Escape}')
      await expect.poll(() => warning(screen)).toBeNull()
      expect(heard).toEqual([])
      expect(document.activeElement, 'the focus did not come back to the switch').toBe(control(screen))
    } finally { window.removeEventListener('keydown', hear) }
  })

  /*
   * A phone held upright gives a player some 200px of height. The card is drawn smaller there, and where it is
   * still taller than the player it opens at its first line and scrolls.
   */
  it('fits a phone\'s player, its first line on screen and its two actions side by side', async () => {
    const screen = await mount({ width: 360, height: 203 }, WITH_LINKS)
    await expect.poll(() => control(screen)).not.toBeNull()
    await userEvent.click(control(screen))
    await expect.poll(() => warning(screen)).not.toBeNull()
    const card = warning(screen)!
    const player = card.getBoundingClientRect()
    const sentence = card.querySelector('p')!.getBoundingClientRect()
    expect(card.scrollTop).toBe(0)
    expect(sentence.top).toBeGreaterThanOrEqual(player.top)
    const [cancel, off] = [...card.querySelectorAll('.actions button')].map((button) => button.getBoundingClientRect())
    expect(cancel!.top).toBe(off!.top)
    expect(off!.bottom, 'the actions are below the player\'s edge with one sentence').toBeLessThanOrEqual(player.bottom)
    expect(off!.right).toBeLessThanOrEqual(player.right)
  })

  // with its second sentence the card was 192px in eight languages, 13px more than a 203px player had (2026-11-14)
  it('fits a phone\'s player whole with both sentences, in every language', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    const scrolls: string[] = []
    country.listed = true
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        const screen = await mount({ width: 360, height: 203 }, WITH_LINKS)
        await expect.poll(() => control(screen)).not.toBeNull()
        await userEvent.click(control(screen))
        await expect.poll(() => warning(screen)).not.toBeNull()
        const card = warning(screen)!
        expect(card.querySelectorAll('p'), language).toHaveLength(2)
        if (card.scrollHeight > card.clientHeight) scrolls.push(`${language}: ${card.scrollHeight}px in ${card.clientHeight}px`)
        await screen.unmount()
      }
    } finally {
      country.listed = false
      await showEnglish()
    }
    expect(languages).toHaveLength(13)
    expect(scrolls).toEqual([])
  }, 30_000)

  /*
   * At 960px and up the word is on the row, and it changes while somebody watches: On, then Reconnecting as a
   * relay drops, then On. Each state keeps the room of the widest, in each language and in a wider font.
   */
  it('moves no readout beside it when its word changes, in any language', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    const vpns = {
      on: [VPN_ON, 'relay', true], reconnecting: [{ port: null, listeners: [{ up: false, healing: true }] }, 'relay', true],
      unreachable: [{ port: null, listeners: [] }, 'relay', true], off: [{ port: null, listeners: [] }, 'direct', false], waiting: [VPN_ON, 'relay', false],
    } as const
    const fonts = { 'device font': '', 'monospace fallback': 'body * { font-family: monospace !important }' }
    const sheet = document.head.appendChild(document.createElement('style'))
    const moved: string[] = []
    const words = new Set<string>()
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        state.current = withSwarm(ORDINARY, 8054, 10_400_000)
        const screen = await mount({ width: 1280, height: 720 }, WITH_LINKS)
        for (const [font, css] of Object.entries(fonts)) {
          sheet.textContent = css
          const spots: number[] = []
          for (const [reachable, transport, on] of Object.values(vpns)) {
            state.reachable = reachable
            state.transport = transport
            storeVpnChoice(on)
            await screen.rerender(await watching(WITH_LINKS))
            await expect.element(screen.getByTestId('peers')).toBeInTheDocument()
            spots.push(control(screen).getBoundingClientRect().left, screen.getByTestId('peers').element().getBoundingClientRect().left)
            words.add(`${language}: ${control(screen).textContent}`)
          }
          const [switchAt, peersAt] = [spots.filter((_, i) => i % 2 === 0), spots.filter((_, i) => i % 2 === 1)]
          if (new Set(switchAt).size !== 1 || new Set(peersAt).size !== 1) moved.push(`${language}, ${font}: the switch at ${switchAt.join(' ')}, the peer count at ${peersAt.join(' ')}`)
        }
        await screen.unmount()
      }
    } finally {
      sheet.remove()
      await showEnglish()
    }
    expect(words.size).toBe(13 * 5)
    expect(moved).toEqual([])
  }, 60_000)
})

/*
 * The player is where somebody notices the relay slowing down once the day's FKN quota is used up, framed in stub as
 * on its own tab, so the offer to switch the VPN off hangs under its item in the top row, inside the player.
 */
describe('the quota offer on /watch', () => {
  const LINE = 'Your daily FKN quota is used up.'
  const THROTTLED = {
    premium: false, overQuota: true, throttled: true, usedBytes: 5e9, limitBytes: 5e9, remainingBytes: 0,
    bytesPerSecond: 1_048_576, bitsPerSecond: 8_388_608,
  }
  beforeEach(() => {
    state.current = torrent()
    state.reachable = VPN_ON
    state.transport = 'relay'
    state.quota = THROTTLED
    localStorage.removeItem('ripple:quota-offer')
  })
  afterEach(async () => {
    state.reachable = null
    state.transport = null
    state.quota = null
    localStorage.removeItem('ripple:quota-offer')
    await page.viewport(DESKTOP.width, DESKTOP.height)
  })

  type Screen = Awaited<ReturnType<typeof mount>>
  /*
   * Alone in the window, at its top, as a player is. Every mount here leaves its box in the document, so a player
   * drawn under the earlier ones is out of the window, where floating-ui flips the offer above the row.
   */
  const alone = async (size: { width: number, height: number }) => {
    for (const earlier of document.body.querySelectorAll(':scope > div')) earlier.remove()
    return mount(size, WITH_LINKS)
  }
  const control = (screen: Screen) => screen.container.querySelector('.media-information [role="switch"]') as HTMLElement
  const offer = (screen: Screen) => screen.container.querySelector<HTMLElement>('.react-tooltip[role="status"]')
  const shown = (screen: Screen) => offer(screen)?.classList.contains('react-tooltip__show') ?? false
  const action = (screen: Screen, name: string) => [...offer(screen)!.querySelectorAll('button')].find((button) => button.textContent === name)!
  const playerBox = (screen: Screen) => screen.container.firstElementChild!.getBoundingClientRect()
  /** Whether the offer is whole inside the player and under the VPN's item, its arrow pointing at it. */
  const misplaced = (screen: Screen) => {
    const box = offer(screen)!.getBoundingClientRect()
    const player = playerBox(screen)
    const item = control(screen).getBoundingClientRect()
    const arrow = offer(screen)!.querySelector('.react-tooltip-arrow')!.getBoundingClientRect()
    const arrowX = arrow.left + arrow.width / 2
    return [
      box.left < player.left && `left ${box.left} of the player's ${player.left}`,
      box.right > player.right && `right ${box.right} past the player's ${player.right}`,
      box.bottom > player.bottom && `bottom ${box.bottom} under the player's ${player.bottom}`,
      box.top < item.bottom && `top ${box.top} over the item's bottom ${item.bottom}`,
      (arrowX <= item.left || arrowX >= item.right) && `arrow at ${arrowX}, the item from ${item.left} to ${item.right}`,
    ].filter(Boolean)
  }

  it('hangs under the VPN\'s item inside the player, at a desktop\'s and at a phone\'s size', async () => {
    for (const size of [DESKTOP, SMALL_PHONE, { width: 360, height: 203 }]) {
      const screen = await alone(size)
      await expect.poll(() => shown(screen)).toBe(true)
      expect(offer(screen)!.textContent).toBe(`${LINE}Turn off VPNNo thanks`)
      expect(misplaced(screen), `${size.width}x${size.height}`).toEqual([])
      // in the layer the player fades with its controls, which in fullscreen is all there is
      expect(offer(screen)!.closest('.ripple-overlay-content')).not.toBeNull()
      const [off, no] = [action(screen, 'Turn off VPN'), action(screen, 'No thanks')].map((button) => button.getBoundingClientRect())
      expect(off!.top, 'the two actions side by side').toBe(no!.top)
      await screen.unmount()
    }
  })

  // at its narrowest the row has little room under it, and the words run longest in some of the languages
  it('fits a phone\'s player whole, in every language', async () => {
    const { showEnglish, showIn } = await import('../i18n/show-in')
    const catalogues = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
    const languages = [['en', null], ...Object.entries(catalogues).map(([path, catalogue]) => [path.match(/([^/]+)\.json$/)![1]!, catalogue] as const)] as const
    const out: string[] = []
    try {
      for (const [language, catalogue] of languages) {
        await (catalogue ? showIn(language, catalogue) : showEnglish())
        for (const size of [SMALL_PHONE, { width: 360, height: 203 }]) {
          const screen = await alone(size)
          await expect.poll(() => shown(screen)).toBe(true)
          // each language measured in its own words, not in the English left in place
          expect(offer(screen)!.querySelector('p')!.textContent === LINE, language).toBe(language === 'en')
          for (const problem of misplaced(screen)) out.push(`${language} at ${size.width}x${size.height}: ${problem}`)
          await screen.unmount()
        }
      }
    } finally { await showEnglish() }
    expect(languages).toHaveLength(13)
    expect(out).toEqual([])
  }, 60_000)

  it('fades with the controls, and comes back with them', async () => {
    const screen = await alone(DESKTOP)
    await expect.poll(() => shown(screen)).toBe(true)
    const video = screen.container.querySelector('video')!
    // the pointer rests on the picture, which the controls hide over after three seconds
    await userEvent.hover(video)
    await expect.poll(() => getComputedStyle(offer(screen)!).visibility, { timeout: 6_000 }).toBe('hidden')
    const { left, top, width, height } = action(screen, 'No thanks').getBoundingClientRect()
    expect(offer(screen)!.contains(document.elementFromPoint(left + width / 2, top + height / 2)), 'pressable while hidden').toBe(false)
    // hidden, the row takes no pointer, so the pointer moves on the picture
    await userEvent.hover(video, { position: { x: 20, y: 300 } })
    await expect.poll(() => getComputedStyle(offer(screen)!).visibility).toBe('visible')
  })

  it('takes the place of the VPN item\'s chip until it is answered', async () => {
    const screen = await alone(DESKTOP)
    await expect.poll(() => shown(screen)).toBe(true)
    await userEvent.hover(control(screen))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(screen.container.querySelector('[role="tooltip"]'), 'the chip opened under the offer').toBeNull()
    await userEvent.click(action(screen, 'No thanks'))
    await expect.poll(() => offer(screen)).toBeNull()
    expect(localStorage.getItem('ripple:quota-offer')).toMatch(/^\d+$/)
    // THE CONTROL: the chip opens on the same hover once the offer is gone
    await userEvent.hover(screen.container.querySelector('video')!)
    await userEvent.hover(control(screen))
    await expect.poll(() => screen.container.querySelector<HTMLElement>('[role="tooltip"]')?.innerText).toBe('VPN: On')
  })

  it('asks inside the player by Turn off VPN, as the switch does', async () => {
    const screen = await alone(DESKTOP)
    await expect.poll(() => shown(screen)).toBe(true)
    await userEvent.click(action(screen, 'Turn off VPN'))
    const warning = () => screen.container.querySelector<HTMLElement>('[role="dialog"]')
    await expect.poll(warning).not.toBeNull()
    expect(offer(screen)).toBeNull()
    expect(setVpn).not.toHaveBeenCalled()
    const player = screen.container.querySelector('.control-bar')!.parentElement!
    expect(player.contains(warning())).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Turn off', exact: true }).element())
    await expect.poll(warning).toBeNull()
    expect(setVpn.mock.calls).toEqual([[false]])
    expect(control(screen).getAttribute('aria-checked')).toBe('false')
  })

  // the player pauses on Space from any key that reaches the window
  it('keeps Space on its actions from the player', async () => {
    const heard: string[] = []
    const hear = (event: KeyboardEvent) => { heard.push(event.key) }
    window.addEventListener('keydown', hear)
    try {
      const screen = await alone(DESKTOP)
      await expect.poll(() => shown(screen)).toBe(true)
      // THE CONTROL: a key on one of the row's links is heard. Not Space, whose play() the next unmount aborts.
      screen.getByTestId('open-in-ripple').element().focus()
      await userEvent.keyboard('m')
      expect(heard).toEqual(['m'])
      heard.length = 0

      action(screen, 'No thanks').focus()
      await userEvent.keyboard(' ')
      await expect.poll(() => offer(screen)).toBeNull()
      expect(heard).toEqual([])
    } finally { window.removeEventListener('keydown', hear) }
  })

  it('is not made while quota is left, or with the VPN off', async () => {
    state.quota = { ...THROTTLED, overQuota: false, throttled: false, remainingBytes: 1e9 }
    const screen = await alone(DESKTOP)
    await expect.poll(() => control(screen)).not.toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offer(screen), 'made while quota is left').toBeNull()

    state.quota = THROTTLED
    state.transport = 'direct'
    storeVpnChoice(false)
    await screen.rerender(await watching(WITH_LINKS))
    await expect.poll(() => control(screen).getAttribute('aria-checked')).toBe('false')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(offer(screen), 'made with the VPN off').toBeNull()

    // THE CONTROL: the same player makes it once the VPN is back on
    state.transport = 'relay'
    storeVpnChoice(true)
    await screen.rerender(await watching(WITH_LINKS))
    await expect.poll(() => shown(screen)).toBe(true)
  })
})

describe('a download nobody serves, on /watch', () => {
  const searching = (since: number, files = true) => {
    const { snapshot } = torrent()
    return torrent({ snapshot: { ...snapshot!, files: files ? snapshot!.files : null, status: { ...snapshot!.status!, numPeers: 0 }, noPeersSince: Date.now() - since } })
  }
  beforeEach(() => { state.reachable = VPN_ON; state.transport = 'relay' })
  afterEach(() => { state.reachable = null; state.transport = null })

  it('says no peers were found once the first search is over, in place of the loading line', async () => {
    state.current = searching(91_000, false)
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.element(screen.getByText('No peers found. Still searching.')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('Loading metadata…')
    // and for a file whose metadata is known, where the row would count its bytes
    state.current = searching(91_000)
    await screen.rerender(await watching(WITH_LINKS))
    expect(screen.container.querySelector('.loading-information')?.textContent).toBe('No peers found. Still searching.')
    expect(screen.container.querySelector('.downloaded')).toBeNull()
  })

  it('names the VPN where it is off', async () => {
    localStorage.setItem('ripple:vpn', 'off')
    state.transport = 'direct'
    state.current = searching(91_000, false)
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.element(screen.getByText('No peers found with the VPN off. Still searching.')).toBeInTheDocument()
  })

  it('keeps the loading line until then, and takes the line back when a peer connects', async () => {
    state.current = searching(89_000, false)
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.element(screen.getByText('Loading metadata…')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('No peers found')

    state.current = searching(91_000, false)
    await screen.rerender(await watching(WITH_LINKS))
    await expect.element(screen.getByText('No peers found. Still searching.')).toBeInTheDocument()

    // the engine drops the field the moment somebody connects
    const { snapshot } = torrent()
    state.current = torrent({ snapshot: { ...snapshot!, files: null } })
    await screen.rerender(await watching(WITH_LINKS))
    await expect.element(screen.getByText('Loading metadata…')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('No peers found')
  })

  it('gives way to an engine failure and to a full origin, which stop the download for good', async () => {
    state.current = { ...searching(91_000), engineError: 'The download engine stopped. Reload the page to try again.' }
    const screen = await mount(DESKTOP, WITH_LINKS)
    await expect.element(screen.getByText('The download engine stopped. Reload the page to try again.')).toBeInTheDocument()
    expect(screen.container.textContent).not.toContain('No peers found')
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
    // the player's own switch, in its menu: the row above the picture has the VPN's
    await expect.poll(() => screen.container.querySelector('.control-bar [role="switch"]')).not.toBeNull()
    return () => screen.container.querySelector('.control-bar [role="switch"]') as HTMLElement
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

/** The top row's words in each state, by name: what it shows and names, then each readout's chip, hovered, by its id. */
const everyState = async () => {
  const { wordsIn } = await import('../i18n/words-in')
  const shown: Record<string, string[]> = {}
  const read = async (name: string, over: Partial<PlayerTorrent>, { hover = false, framed = true } = {}) => {
    state.current = torrent(over)
    state.framed = framed
    const screen = await mount(DESKTOP, WITH_LINKS)
    const row = () => screen.container.querySelector('.ripple-overlay-content')!
    await expect.poll(() => row().querySelector('.file-name, .loading-information')).not.toBeNull()
    shown[name] = wordsIn(row())
    if (hover) {
      const video = screen.container.querySelector('video')!
      for (const anchor of [...row().querySelectorAll<HTMLElement>('[data-tooltip-id]')]) {
        const id = anchor.dataset.tooltipId!
        await userEvent.hover(anchor)
        await expect.poll(() => document.getElementById(id)?.getAttribute('role')).toBe('tooltip')
        shown[name].push(`${id}: ${document.getElementById(id)!.innerText}`)
        await userEvent.hover(video)
        await expect.poll(() => document.getElementById(id)).toBeNull()
      }
    }
    await screen.unmount()
  }
  state.reachable = VPN_ON
  const { snapshot } = withSwarm(ORDINARY, 8054)
  await read('playing', withSwarm(ORDINARY, 8054), { hover: true })
  await read('before a tracker answers', withSwarm({ ...ORDINARY, swarmSeeds: -1, swarmPeers: -1 }), { hover: true })
  await read('before its metadata', { snapshot: { ...snapshot!, files: null } })
  await read('out of room in a frame', { storageFull: true })
  await read('out of room', { storageFull: true }, { framed: false })
  await read('streaming in a frame', { snapshot: { ...snapshot!, windowed: true } }, { hover: true })
  state.framed = true
  return shown
}

const FILE_NAME = 'Some.Release.Name.S01E04.1080p.mkv'
// the owner's sentence, in the chip of the few words a file streaming through a window shows
const STREAMS = 'Too big to download ahead here, so it streams as you watch. In Ripple (header link), with more room allowed, it can download in full, without next episode, tracking or watch together.'
const STREAMS_DE = 'Zu groß, um es hier im Voraus herunterzuladen, daher wird es beim Ansehen gestreamt. In Ripple (Link oben) kann es mit mehr erlaubtem Platz vollständig heruntergeladen werden, ohne nächste Folge, Tracking und gemeinsames Ansehen.'
const LINKS = ['Open this torrent in Ripple', `Download ${FILE_NAME}`]
// the VPN's switch is named for a screen reader as its chip reads, since a narrow player folds its word
const READOUTS = ['Downloading', 'VPN: On', 'VPN On']
// the connected peers, as a phone and a wider player show them, and the speeds
const PLAYING = ['28', '28 peers', '8.7 MB/s', '312 kB/s']
const PEERS = ['82', '82 peers', '8.7 MB/s', '0 B/s']
const CHIPS = [
  'open-in-ripple: Open this torrent in Ripple', `open-download-page: Download ${FILE_NAME}`, 'torrent-state: Torrent: Downloading',
  'vpn: VPN: On',
]
const SPEEDS = ['download-speed: Download speed: 8.7 MB/s', 'upload-speed: Upload speed: 312 kB/s']
const ENGLISH = {
  playing: [FILE_NAME, ...LINKS, 'Downloaded 0 bytes', ...READOUTS, ...PLAYING, ...CHIPS, 'peers: Connected peers: 28\nSeeders: 216 · Leechers: 3 · Downloads: 8054', ...SPEEDS],
  'before a tracker answers': [FILE_NAME, ...LINKS, 'Downloaded 0 bytes', ...READOUTS, ...PLAYING, ...CHIPS, 'peers: Connected peers: 28', ...SPEEDS],
  'before its metadata': ['Open this torrent in Ripple', 'Download this torrent', 'Loading metadata…', ...READOUTS, ...PLAYING],
  'out of room in a frame': [FILE_NAME, ...LINKS, 'Too big for this browser\'s storage here. Open it in Ripple to play it.', 'Open it in Ripple', ...READOUTS, ...PEERS],
  'out of room': [FILE_NAME, ...LINKS, 'Out of storage space. Remove a download in Ripple to free room.', ...READOUTS, ...PEERS],
  'streaming in a frame': [
    FILE_NAME, ...LINKS, 'Streams as you watch', ...READOUTS, ...PLAYING,
    ...CHIPS.slice(0, 2), `window-note: ${STREAMS}`, ...CHIPS.slice(2), 'peers: Connected peers: 28\nSeeders: 216 · Leechers: 3 · Downloads: 8054', ...SPEEDS,
  ],
}

/** Each English text of the walk above in German, but for the names, which stay as they are. */
const GERMAN: Record<string, string> = {
  'Open this torrent in Ripple': 'Diesen Torrent in Ripple öffnen', [`Download ${FILE_NAME}`]: `${FILE_NAME} herunterladen`,
  'Downloaded 0 bytes': 'Heruntergeladen: 0 Byte', Downloading: 'Lädt herunter', 'VPN On': 'VPN An',
  '28 peers': '28 Peers', '82 peers': '82 Peers', '8.7 MB/s': '8,7 MB/s', '312 kB/s': '312 kB/s', '0 B/s': '0 Byte/s',
  'open-in-ripple: Open this torrent in Ripple': 'open-in-ripple: Diesen Torrent in Ripple öffnen',
  [`open-download-page: Download ${FILE_NAME}`]: `open-download-page: ${FILE_NAME} herunterladen`,
  'torrent-state: Torrent: Downloading': 'torrent-state: Torrent: Lädt herunter', 'vpn: VPN: On': 'vpn: VPN: An', 'VPN: On': 'VPN: An',
  'peers: Connected peers: 28\nSeeders: 216 · Leechers: 3 · Downloads: 8054': 'peers: Verbundene Peers: 28\nSeeder: 216 · Leecher: 3 · Downloads: 8054',
  'peers: Connected peers: 28': 'peers: Verbundene Peers: 28',
  'download-speed: Download speed: 8.7 MB/s': 'download-speed: Download-Geschwindigkeit: 8,7 MB/s', 'upload-speed: Upload speed: 312 kB/s': 'upload-speed: Upload-Geschwindigkeit: 312 kB/s',
  'Download this torrent': 'Diesen Torrent herunterladen', 'Loading metadata…': 'Metadaten werden geladen…',
  'Too big for this browser\'s storage here. Open it in Ripple to play it.': 'Zu groß für den Speicher dieses Browsers hier. Öffne es in Ripple, um es abzuspielen.',
  'Open it in Ripple': 'Öffne es in Ripple',
  'Out of storage space. Remove a download in Ripple to free room.': 'Kein Speicherplatz mehr. Entferne einen Download in Ripple, um Platz zu schaffen.',
  'Streams as you watch': 'Wird beim Ansehen gestreamt',
  [`window-note: ${STREAMS}`]: `window-note: ${STREAMS_DE}`,
}

describe('the top row\'s words', () => {
  afterEach(async () => {
    state.reachable = null
    const { showEnglish } = await import('../i18n/show-in')
    await showEnglish()
  })

  it('in English, as they read before the row was translated', async () => {
    expect(await everyState()).toEqual(ENGLISH)
  })

  it('in German, each value where German puts it', async () => {
    const { showIn } = await import('../i18n/show-in')
    const { default: de } = await import('../../src/locales/de.json')
    await showIn('de', de, 'de-DE')
    const german = Object.fromEntries(Object.entries(ENGLISH).map(([name, words]) => [name, words.map(word => GERMAN[word] ?? word)]))
    expect(await everyState()).toEqual(german)
  })
})
