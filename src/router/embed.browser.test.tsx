import type { PlayerTorrent } from '../torrent/use-player-torrent'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
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
vi.mock('../torrent/use-player-torrent', () => ({ usePlayerTorrent: () => state.current }))

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 1280px; height: 720px;'
  document.body.append(container)
  return { container }
}

const mount = async () => {
  const { default: Embed } = await import('./embed')
  return render(
    <MemoryRouter initialEntries={['/embed?magnet=bWFnbmV0Og==']}>
      <Embed />
    </MemoryRouter>,
    sized(),
  )
}

describe('the embed route', () => {
  beforeEach(() => { state.current = torrent() })

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
    // no filename to show yet, and no empty line reserved for one
    expect(screen.container.querySelector('.title')).toBeNull()
  })

  it('reports an engine failure instead of counting bytes that will never arrive', async () => {
    state.current = torrent({ engineError: 'The download engine stopped. Reload the page to try again.' })
    const screen = await mount()
    await expect.element(screen.getByText(/The download engine stopped/)).toBeInTheDocument()
  })
})
