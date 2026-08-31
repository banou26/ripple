import type { Torrent } from '../torrent/types'
import type { PeerInfo, TrackerInfo } from '../torrent/worker'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * The docked details panel: what it shows, and what it deliberately does not.
 *
 * The load-bearing guarantee is that it never asks about a torrent it is not showing. The engine
 * computes peers and trackers for ONE torrent at a time, so a dock that forgets to release its
 * claim leaves the engine working for a view nobody is looking at, and one that renders an answer
 * meant for the previous torrent shows a stranger's peers under this torrent's name.
 *
 * The dock is only mounted while something is selected, which is what makes an empty selection cost
 * nothing at all: the page unmounts it and the claim goes with it.
 */

const inspected: (number | null)[] = []
let detailCb: ((detail: any) => void) | null = null

vi.mock('../torrent/client', () => ({
  getTorrentClient: () => ({
    inspect: (handle: number | null) => { inspected.push(handle) },
    onDetail: (cb: (d: any) => void) => { detailCb = cb; return () => { detailCb = null } },
  }),
}))

const { TorrentDetailDock } = await import('./torrent-detail')
// the dock carries its own css template, so unlike the old per-row panel it needs no page around it

const torrent = (over: Partial<Torrent> = {}): Torrent => ({
  id: '7',
  infoHash: 'aabbccddeeff00112233445566778899aabbccdd',
  magnet: 'magnet:?xt=urn:btih:aabbccddeeff00112233445566778899aabbccdd',
  name: 'Big Buck Bunny',
  size: 2_000_000_000,
  downloaded: 1_000_000_000,
  progress: 0.5,
  state: 'downloading',
  down: 4_000_000,
  up: 250_000,
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
  files: [{ name: 'Pack/E01.mkv', size: 1e9, progress: 0.5, index: 0 }],
  ...over,
})

const peer = (over: Partial<PeerInfo> = {}): PeerInfo => ({
  endpoint: '203.0.113.7:51413',
  client: 'qBittorrent 4.6.5',
  flags: 0,
  source: 0,
  connectionType: 0,
  downloadRate: 120_000,
  uploadRate: 0,
  payloadDownloadRate: 120_000,
  payloadUploadRate: 0,
  totalDownload: 5_000_000,
  totalUpload: 0,
  progress: 0.42,
  rtt: 30,
  numPieces: 100,
  requestsInFlight: 4,
  failCount: 0,
  ...over,
})

const tracker = (over: Partial<TrackerInfo> = {}): TrackerInfo => ({
  url: 'udp://tracker.opentrackr.org:1337/announce',
  message: '',
  tier: 0,
  fails: 0,
  updating: false,
  verified: true,
  nextAnnounceIn: 1_700,
  seeders: 40,
  leechers: 9,
  downloaded: 500,
  ...over,
})

const sized = () => {
  const container = document.createElement('div')
  container.style.cssText = 'width: 900px;'
  document.body.append(container)
  return { container }
}

const onClose = vi.fn()

const mount = async (t: Torrent = torrent(), handle: number | null = 7) => {
  inspected.length = 0
  detailCb = null
  onClose.mockClear()
  return render(
    <TorrentDetailDock t={t} handle={handle} saving={{}} onSave={() => {}} onClose={onClose}/>,
    sized(),
  )
}

const tabButton = (screen: Awaited<ReturnType<typeof mount>>, name: string) =>
  [...screen.container.querySelectorAll<HTMLElement>('.tabs button')]
    .find((b) => b.textContent?.startsWith(name))!

const send = (over: any = {}) => detailCb?.({ handle: 7, peers: [], trackers: [], ...over })

describe('the docked torrent details', () => {
  it('names the torrent it is showing, since it sits away from the row', async () => {
    const screen = await mount()
    expect(screen.container.querySelector('.title')?.textContent).toBe('Big Buck Bunny')
    expect(screen.container.querySelector('section')?.getAttribute('aria-label'))
      .toBe('Details for Big Buck Bunny')
  })

  it('claims its torrent as soon as it is shown', async () => {
    await mount()
    expect(inspected).toContain(7)
  })

  /** Mounted only while something is selected, so unmounting is what releases the engine. */
  it('releases the claim when it goes away', async () => {
    const screen = await mount()
    expect(inspected).toContain(7)
    screen.unmount()
    await expect.poll(() => inspected[inspected.length - 1]).toBeNull()
  })

  it('can be dismissed from its own header', async () => {
    const screen = await mount()
    ;(screen.container.querySelector('.close') as HTMLElement).click()
    expect(onClose).toHaveBeenCalled()
  })

  /** The shortcut anyone tries first on a panel like this. */
  it('can be dismissed with Escape', async () => {
    await mount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onClose).toHaveBeenCalled()
  })

  /**
   * libtorrent reports -1 for availability it does not know: before metadata, or before any peer
   * has sent a bitfield. Printed straight it reads as "-1.00 copies", which is a measurement of
   * nothing dressed up as a measurement. Seen live on 2026-08-16 on a seeding torrent with no peers.
   */
  it('shows unknown availability as unknown rather than as minus one', async () => {
    const screen = await mount(torrent({ stats: { ...torrent().stats!, availability: -1 } }))
    const facts = [...screen.container.querySelectorAll('.fact')]
    const availability = facts.find((f) => f.querySelector('label')?.textContent === 'Availability')!
    expect(availability.querySelector('span')?.textContent).toBe('-')
  })

  it('shows a real availability when there is one', async () => {
    const screen = await mount()
    const facts = [...screen.container.querySelectorAll('.fact')]
    const availability = facts.find((f) => f.querySelector('label')?.textContent === 'Availability')!
    expect(availability.querySelector('span')?.textContent).toBe('2.40')
  })

  /** All-time, not this session: a ratio from session figures is wrong for anything ever restarted. */
  it('reports the all-time totals with the session figures beside them', async () => {
    const screen = await mount()
    await expect.element(screen.getByText(/1 GB \(500 MB this session\)/)).toBeInTheDocument()
  })

  it('opens on the overview, which needs no engine round trip', async () => {
    const screen = await mount()
    await expect.element(screen.getByText('aabbccddeeff00112233445566778899aabbccdd')).toBeInTheDocument()
    await expect.element(screen.getByText('/downloads')).toBeInTheDocument()
  })

  it('says nobody is connected rather than showing an empty table', async () => {
    const screen = await mount()
    tabButton(screen, 'Peers').click()
    send({ peers: [] })
    await expect.element(screen.getByText('Nobody is connected right now.')).toBeInTheDocument()
  })

  /**
   * The engine takes a broadcast to change subject, so the first answer after a switch still
   * carries the previous torrent's peers. Rendering those under this torrent's name is worse than
   * rendering nothing, so they are dropped on the handle rather than shown.
   */
  it('ignores an answer meant for a different torrent', async () => {
    const screen = await mount()
    tabButton(screen, 'Peers').click()
    send({ handle: 99, peers: [peer({ endpoint: '198.51.100.1:6881' })] })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.container.textContent).not.toContain('198.51.100.1')
    // and it still reads as not-yet-loaded rather than as an empty swarm
    await expect.element(screen.getByText('Asking the engine…')).toBeInTheDocument()
  })

  it('lists peers busiest first, with their transport and where they came from', async () => {
    const screen = await mount()
    tabButton(screen, 'Peers').click()
    send({
      peers: [
        peer({ endpoint: '198.51.100.1:6881', downloadRate: 1_000, uploadRate: 0, flags: 0, source: 1 << 1 }),
        peer({ endpoint: '203.0.113.7:51413', downloadRate: 900_000, uploadRate: 0, flags: 1 << 17, source: 1 << 5 }),
      ],
    })
    await expect.element(screen.getByText('203.0.113.7:51413')).toBeInTheDocument()
    const rows = [...screen.container.querySelectorAll('.rows .row:not(.head) .name')]
    expect(rows[0]!.textContent).toContain('203.0.113.7:51413')
    expect(rows[0]!.textContent).toContain('uTP')
    expect(rows[0]!.textContent).toContain('incoming')
    expect(rows[1]!.textContent).toContain('TCP')
    expect(rows[1]!.textContent).toContain('DHT')
  })

  /**
   * -1 is libtorrent's "never scraped", and it has to read as unknown. A 0 there would say the
   * tracker answered and knows of nobody, which is a completely different thing to a user deciding
   * whether a torrent is dead.
   */
  it('shows an unscraped tracker as unknown rather than as zero', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    send({ trackers: [tracker({ fails: -1, seeders: -1, leechers: -1, nextAnnounceIn: -1 })] })
    await expect.element(screen.getByText('Not contacted')).toBeInTheDocument()
    const row = screen.container.querySelector('.rows .row:not(.head)')!
    const nums = [...row.querySelectorAll('.num')].map((n) => n.textContent)
    // tier is a real 0; the three scrape counts are the ones that must read as unknown
    expect(nums).toEqual(['0', '-', '-', '-'])
  })

  it('separates a working tracker from one that has never been tried', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    send({ trackers: [tracker({ fails: 0 }), tracker({ url: 'udp://b.invalid:80/announce', fails: 3 })] })
    await expect.element(screen.getByText('Working')).toBeInTheDocument()
    await expect.element(screen.getByText('Failed 3×')).toBeInTheDocument()
  })

  it('explains a torrent with no trackers instead of leaving the tab blank', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    send({ trackers: [] })
    await expect.element(screen.getByText(/finds peers through the DHT/)).toBeInTheDocument()
  })

  /**
   * TorrentFile.progress is the torrent's overall progress copied onto every file
   * (use-torrents.ts), so a per-file bar drawn from it would be a fabrication. The guard is a test
   * because the field is right there and looks usable.
   */
  it('draws no per-file progress, because there is none to draw', async () => {
    const screen = await mount(torrent({
      files: [
        { name: 'Pack/E01.mkv', size: 1e9, progress: 0.5, index: 0 },
        { name: 'Pack/E02.mkv', size: 1e9, progress: 0.5, index: 1 },
      ],
    }))
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E01.mkv')).toBeInTheDocument()
    expect(screen.container.querySelector('.bar')).toBeNull()
  })

  it('keeps a long swarm inside its own scroll rather than growing the page', async () => {
    const screen = await mount()
    tabButton(screen, 'Peers').click()
    send({ peers: Array.from({ length: 80 }, (_, i) => peer({ endpoint: `203.0.113.${i % 250}:${6881 + i}` })) })
    await expect.element(screen.getByText('203.0.113.1:6882')).toBeInTheDocument()
    const pane = screen.container.querySelector('.pane') as HTMLElement
    expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight)
  })

  /** A library ghost has no engine handle, and asking about one would be asking about nothing. */
  it('never claims a torrent that is not in the session', async () => {
    const screen = await mount(torrent(), null)
    expect(inspected.filter((h) => h !== null)).toEqual([])
    // the overview still works: it is drawn from the row's own data, not from the engine
    await expect.element(screen.getByText('Big Buck Bunny')).toBeInTheDocument()
  })

  /**
   * The Content tab of a ghost is new: its file list is synced from the device that has the torrent,
   * so this tab used to be empty here and is now full. Save must not come with it.
   *
   * There is no handle, so the save would be aimed at NaN. The sink opens before the first read, so
   * a real browser download starts with the right name and size, sits at zero, and aborts a few
   * seconds later, directly under a row that correctly says the files are not on this device.
   */
  it('lists the synced files of a ghost without offering to save them', async () => {
    const screen = await mount(torrent(), null)
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E01.mkv')).toBeInTheDocument()
    expect([...screen.container.querySelectorAll('.row.file button')]).toEqual([])
  })

  it('offers Save again for the same list once the torrent is in the session', async () => {
    const screen = await mount(torrent(), 7)
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E01.mkv')).toBeInTheDocument()
    expect(screen.container.querySelectorAll('.row.file button').length).toBe(1)
  })
})
