import type { Torrent } from '../torrent/types'
import type { PeerInfo, TrackerInfo } from '../torrent/worker'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * The detail panel: what it shows, and what it deliberately does not.
 *
 * Two guarantees are load-bearing beyond "the right text appears".
 *
 * The first is that a shut panel costs nothing. `<details>` keeps its children in the DOM rather
 * than unmounting them, so a library of thirty torrents would otherwise carry thirty hidden peer
 * tables, and the engine would be asked to compute every one of them.
 *
 * The second is that the panel never asks about a torrent it is not showing. The engine computes
 * this for one torrent at a time, so a panel that forgets to release its claim leaves the engine
 * working for a closed view, and one that renders an answer meant for the previous torrent shows a
 * stranger's peers under this torrent's name.
 */

const inspected: (number | null)[] = []
let detailCb: ((detail: any) => void) | null = null

vi.mock('../torrent/client', () => ({
  getTorrentClient: () => ({
    inspect: (handle: number | null) => { inspected.push(handle) },
    onDetail: (cb: (d: any) => void) => { detailCb = cb; return () => { detailCb = null } },
  }),
}))

const { TorrentDetailPanel } = await import('./torrent-detail')
// the panel's styles are nested under `.torrent .content` in the route's one css template, so a
// bare mount gets none of them and every measurement is whatever the browser default happens to be
const { style } = await import('./home')

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
  files: [{ name: 'Pack/E01.mkv', size: 1e9, progress: 0.5 }],
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

const mount = async (t: Torrent = torrent(), handle: number | null = 7) => {
  inspected.length = 0
  detailCb = null
  return render(
    <div css={style}>
      <main>
        <div className="torrent surface">
          <div className="content">
            <TorrentDetailPanel t={t} handle={handle} saving={{}} onSave={() => {}}/>
          </div>
        </div>
      </main>
    </div>,
    sized(),
  )
}

const open = async (screen: Awaited<ReturnType<typeof mount>>) => {
  ;(screen.container.querySelector('.detail summary') as HTMLElement).click()
  await expect.poll(() => screen.container.querySelector('.detail .tabs')).not.toBeNull()
}

const tabButton = (screen: Awaited<ReturnType<typeof mount>>, name: string) =>
  [...screen.container.querySelectorAll<HTMLElement>('.detail .tabs button')]
    .find((b) => b.textContent?.startsWith(name))!

const send = (over: any = {}) => detailCb?.({ handle: 7, peers: [], trackers: [], ...over })

describe('the torrent detail panel', () => {
  it('shows nothing but its own handle until it is opened', async () => {
    const screen = await mount()
    expect(screen.container.querySelector('.detail .tabs')).toBeNull()
    expect(screen.container.querySelector('.detail .pane')).toBeNull()
    // the name is in the row above; a shut panel must not put a second copy of the torrent in the DOM
    expect(screen.container.querySelector('.detail')!.textContent).toBe('Details')
  })

  /** A shut panel that still claimed a subject would have the engine computing peers for nobody. */
  it('does not ask the engine for anything until it is opened', async () => {
    await mount()
    expect(inspected.filter((h) => h !== null)).toEqual([])
  })

  it('claims its torrent on open and releases it on close', async () => {
    const screen = await mount()
    await open(screen)
    expect(inspected).toContain(7)

    ;(screen.container.querySelector('.detail summary') as HTMLElement).click()
    await expect.poll(() => screen.container.querySelector('.detail .tabs')).toBeNull()
    // the last word to the engine has to be the release, whatever order the effects ran in
    expect(inspected[inspected.length - 1]).toBeNull()
  })

  it('opens on the overview, which needs no engine round trip', async () => {
    const screen = await mount()
    await open(screen)
    await expect.element(screen.getByText('82 peers, 12 of them seeds')).toBeInTheDocument()
    await expect.element(screen.getByText('aabbccddeeff00112233445566778899aabbccdd')).toBeInTheDocument()
  })

  it('says nobody is connected rather than showing an empty table', async () => {
    const screen = await mount()
    await open(screen)
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
    await open(screen)
    tabButton(screen, 'Peers').click()
    send({ handle: 99, peers: [peer({ endpoint: '198.51.100.1:6881' })] })
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.container.textContent).not.toContain('198.51.100.1')
    // and it still reads as not-yet-loaded rather than as an empty swarm
    await expect.element(screen.getByText('Asking the engine…')).toBeInTheDocument()
  })

  it('lists peers busiest first, with their transport and where they came from', async () => {
    const screen = await mount()
    await open(screen)
    tabButton(screen, 'Peers').click()
    send({
      peers: [
        peer({ endpoint: '198.51.100.1:6881', downloadRate: 1_000, uploadRate: 0, flags: 0, source: 1 << 1 }),
        peer({ endpoint: '203.0.113.7:51413', downloadRate: 900_000, uploadRate: 0, flags: 1 << 17, source: 1 << 5 }),
      ],
    })
    await expect.element(screen.getByText('203.0.113.7:51413')).toBeInTheDocument()
    const rows = [...screen.container.querySelectorAll('.detail .rows .row:not(.head) .name')]
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
    await open(screen)
    tabButton(screen, 'Trackers').click()
    send({ trackers: [tracker({ fails: -1, seeders: -1, leechers: -1, nextAnnounceIn: -1 })] })
    await expect.element(screen.getByText('Not contacted')).toBeInTheDocument()
    const row = screen.container.querySelector('.detail .rows .row:not(.head)')!
    const nums = [...row.querySelectorAll('.num')].map((n) => n.textContent)
    expect(nums).toEqual(['-', '-', '-'])
  })

  it('separates a working tracker from one that has never been tried', async () => {
    const screen = await mount()
    await open(screen)
    tabButton(screen, 'Trackers').click()
    send({ trackers: [tracker({ fails: 0 }), tracker({ url: 'udp://b.invalid:80/announce', fails: 3 })] })
    await expect.element(screen.getByText('Working')).toBeInTheDocument()
    await expect.element(screen.getByText('Failed 3×')).toBeInTheDocument()
  })

  it('explains a torrent with no trackers instead of leaving the tab blank', async () => {
    const screen = await mount()
    await open(screen)
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
        { name: 'Pack/E01.mkv', size: 1e9, progress: 0.5 },
        { name: 'Pack/E02.mkv', size: 1e9, progress: 0.5 },
      ],
    }))
    await open(screen)
    tabButton(screen, 'Files').click()
    await expect.element(screen.getByText('E01.mkv')).toBeInTheDocument()
    expect(screen.container.querySelector('.detail .bar')).toBeNull()
  })

  it('keeps a long swarm inside its own scroll rather than growing the page', async () => {
    const screen = await mount()
    await open(screen)
    tabButton(screen, 'Peers').click()
    send({ peers: Array.from({ length: 80 }, (_, i) => peer({ endpoint: `203.0.113.${i % 250}:${6881 + i}` })) })
    await expect.element(screen.getByText('203.0.113.1:6882')).toBeInTheDocument()
    const pane = screen.container.querySelector('.detail .pane') as HTMLElement
    expect(pane.scrollHeight).toBeGreaterThan(pane.clientHeight)
  })

  /** A library ghost has no engine handle, and asking about one would be asking about nothing. */
  it('never claims a torrent that is not in the session', async () => {
    const screen = await mount(torrent(), null)
    await open(screen)
    expect(inspected.filter((h) => h !== null)).toEqual([])
    // the overview still works: it is drawn from the row's own data, not from the engine
    await expect.element(screen.getByText('82 peers, 12 of them seeds')).toBeInTheDocument()
  })
})
