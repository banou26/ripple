import type { Torrent } from '../../src/torrent/types'
import type { PeerInfo, TrackerInfo } from '../../src/torrent/worker'

import { page, userEvent } from '@vitest/browser/context'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
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
const planned: [number, { wanted?: number[], firstLast?: boolean }][] = []
const trackersAdded: [number, string[]][] = []
// what the engine answers an add of trackers with: the urls it refused
let refusing: (urls: string[]) => Promise<string[]> = async () => []
let detailCb: ((detail: any) => void) | null = null

// one client, as the page has: a new one per render would subscribe again on every render, and empty the panel each time
vi.mock('../../src/torrent/client', () => {
  const client = {
    inspect: (handle: number | null) => { inspected.push(handle) },
    onDetail: (cb: (d: any) => void) => { detailCb = cb; return () => { detailCb = null } },
    setPlan: (handle: number, plan: { wanted?: number[], firstLast?: boolean }) => { planned.push([handle, plan]) },
    addTrackers: (handle: number, urls: string[]) => { trackersAdded.push([handle, urls]); return refusing(urls) },
  }
  return { getTorrentClient: () => client, runningTorrentClient: () => null }
})

const { TorrentDetailDock } = await import('../../src/router/torrent-detail')
const { useTorrentDetail } = await import('../../src/torrent/use-torrent-detail')
const { Modal } = await import('../../src/components/modal')
const { IntlRoot, startLanguage } = await import('../../src/i18n')
const { showEnglish, showIn } = await import('../i18n/show-in')
const { default: de } = await import('../../src/locales/de.json')
const { default: fr } = await import('../../src/locales/fr.json')
const CATALOGUES = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
// the dock carries its own css template, so unlike the old per-row panel it needs no page around it

// when the library entry says it was added, in seconds
const LISTED = 1_754_990_000

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
  addedAt: LISTED * 1000,
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
    // deliberately different from the totals: a session figure that echoed the total would pass
    // whichever of the two the panel actually rendered
    sessionActiveSeconds: 900,
    sessionSeedingSeconds: 60,
    completedAt: 1_755_003_600,
    lastSeenComplete: 1_755_003_600,
    hadIncoming: true,
    savePath: '/downloads',
    pieceLength: 262_144,
    numPieces: 7630,
    numPiecesHave: 3815,
    // under size minus downloaded, as a pack with files left out has
    remaining: 600_000_000,
  },
  files: [{ name: 'Pack/E01.mkv', size: 1e9, index: 0 }],
  ...over,
})

const peer = (over: Partial<PeerInfo> = {}): PeerInfo => ({
  endpoint: '203.0.113.7:51413',
  // as the engine fills it for a peer that is not a WebRTC one
  transport: (over.flags ?? 0) & PEER_FLAG.utpSocket ? 'utp' : 'tcp',
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

const mount = async (
  t: Torrent = torrent(),
  handle: number | null = 7,
  extra: { saving?: Record<number, number>, onSave?: (index: number) => void } = {},
) => {
  inspected.length = 0
  planned.length = 0
  detailCb = null
  onClose.mockClear()
  return render(
    <TorrentDetailDock
      t={t}
      handle={handle}
      saving={extra.saving ?? {}}
      onSave={extra.onSave ?? (() => {})}
      onClose={onClose}
    />,
    { ...sized(), wrapper: IntlRoot },
  )
}

const tabButton = (screen: Awaited<ReturnType<typeof mount>>, name: string) =>
  [...screen.container.querySelectorAll<HTMLElement>('.tabs button')]
    .find((b) => b.textContent?.startsWith(name))!

const send = (over: any = {}) => detailCb?.({ handle: 7, peers: [], trackers: [], ...over })

const spaced = (text: string) => text.replace(/\s/gu, ' ')

/** Each piece of text under `element`, in order, joined by ` | `. */
const textsOf = (element: Element) => {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  while (walker.nextNode()) if (walker.currentNode.textContent!.trim()) texts.push(spaced(walker.currentNode.textContent!.trim()))
  return texts.join(' | ')
}

type Screen = Awaited<ReturnType<typeof mount>>

/** The overview as `label: value` lines, in its order. */
const overview = (screen: Screen) => [...screen.container.querySelectorAll('.fact')]
  .map((f) => `${f.querySelector('label')?.textContent}: ${spaced(f.querySelector('span')?.textContent ?? '')}`)

/** The panel's labels a screen reader is given, then its buttons' text. */
const named = (screen: Screen) => [
  ...[...screen.container.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label')),
  ...[...screen.container.querySelectorAll('button')].map(textsOf),
]

const rowsOf = (screen: Screen) => [...screen.container.querySelectorAll('.rows .row')].map(textsOf)

// every branch of the overview the default torrent does not take
const quiet = () => torrent({
  downloaded: 2_000_000_000,
  progress: 0.285,
  seeds: 1,
  peers: 1,
  retry: { reason: 'stopped', attempt: 2, retryInSeconds: 5 },
  stats: {
    ...torrent().stats!,
    allTimeDownload: 0,
    swarmSeeds: -1,
    swarmPeers: -1,
    connectionsLimit: 0,
    completedAt: 0,
    hadIncoming: false,
    numPieces: 0,
    availability: 0.285,
    remaining: 0,
  },
})

const { PEER_FLAG, PEER_SOURCE } = await import('libtorrent-wasm')
// every tag: the first an incoming encrypted seed over uTP from a tracker, with no client name; the second dialled over TCP
const PEERS = [
  peer({ flags: PEER_FLAG.utpSocket | PEER_FLAG.rc4Encrypted | PEER_FLAG.seed, source: PEER_SOURCE.tracker, client: '' }),
  peer({ endpoint: '198.51.100.1:6881', downloadRate: 0, totalDownload: 0, flags: PEER_FLAG.localConnection, source: PEER_SOURCE.dht }),
]
// every state, in tier order
const TRACKERS = [
  tracker(),
  tracker({ url: 'udp://b.invalid:80/announce', fails: 3, tier: 1 }),
  tracker({ url: 'udp://c.invalid:80/announce', fails: -1, seeders: -1, leechers: -1, nextAnnounceIn: -1, tier: 2 }),
  tracker({ url: 'udp://d.invalid:80/announce', updating: true, tier: 3 }),
]

/** The rows of the Content, Peers and Trackers tabs, after what each says before the engine answers. */
const otherTabs = async (screen: Screen) => {
  const open = (i: number) => screen.container.querySelectorAll<HTMLElement>('.tabs button')[i]!.click()
  open(1)
  await expect.poll(() => screen.container.querySelector('.row.file')).toBeTruthy()
  const files = rowsOf(screen)
  open(2)
  await expect.poll(() => screen.container.querySelector('.none')).toBeTruthy()
  const asking = screen.container.querySelector('.none')!.textContent
  send({ peers: [], trackers: [] })
  await expect.poll(() => screen.container.querySelector('.none')?.textContent).not.toBe(asking)
  const nobody = screen.container.querySelector('.none')!.textContent
  open(3)
  await expect.poll(() => screen.container.querySelector('.none')?.textContent).not.toBe(nobody)
  const noTrackers = screen.container.querySelector('.none')!.textContent
  send({ peers: PEERS, trackers: TRACKERS })
  await expect.poll(() => rowsOf(screen).length).toBe(5)
  const trackers = rowsOf(screen)
  open(2)
  await expect.poll(() => rowsOf(screen).length).toBe(3)
  return { files, asking, nobody, noTrackers, peers: rowsOf(screen), trackers }
}

const date = (unixSeconds: number, locale: string) => spaced(new Date(unixSeconds * 1000).toLocaleString(locale))

// as the browser's CLDR writes it: German's narrow hour is `1h` in CLDR 48 (Chrome 156) and `1 Std.` in CLDR 47 (Chrome
// 145, Playwright 1.58's own, which GitHub's runner installs)
const hours = (count: number, locale: string) => new Intl.NumberFormat(locale, { style: 'unit', unit: 'hour', unitDisplay: 'narrow' }).format(count)

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

  /** One Escape closes one thing: a dialog over the panel takes it, and the panel stays. */
  it('stays open on the Escape that closes a dialog over it', async () => {
    await mount()
    const closeDialog = vi.fn()
    render(<Modal onClose={closeDialog}><button type="button" data-in-dialog>in the dialog</button></Modal>)
    await expect.poll(() => document.querySelector<HTMLElement>('[data-in-dialog]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-in-dialog]')!.focus()
    await userEvent.keyboard('{Escape}')
    expect(closeDialog).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
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

  /*
   * A duration reads the same way the byte counters do.
   *
   * The total on its own cannot say whether anything is happening NOW: a torrent that ran for a day
   * last week and has been idle since shows the same "1d" as one that has been running all along.
   * The session figure is what separates them, and it is a delta against the engine's reading when
   * the torrent was added rather than the engine's reading itself, which a resume blob may have
   * started part way up. See uptime.ts.
   */
  it('shows how long a torrent has run in total and in this session', async () => {
    const screen = await mount()
    await expect.element(screen.getByText('1h 0m (15m this session)')).toBeInTheDocument()
    await expect.element(screen.getByText('2m (1m this session)')).toBeInTheDocument()
  })

  // English as the panel wrote it before its text was translated, every branch of it
  describe('in English', () => {
    it('writes each fact of the overview, its dates as toLocaleString() and its numbers as toFixed() do', async () => {
      const { completedAt } = torrent().stats!
      expect(overview(await mount(torrent({ retry: { reason: 'stopped', attempt: 3, retryInSeconds: 5, message: 'file too short' } })))).toEqual([
        'Time active: 1h 0m (15m this session)', 'Time left: 4m', 'Connections: 6 of 200', 'Downloaded: 1 GB (500 MB this session)',
        'Uploaded: 250 MB (100 MB this session)', 'Seeds: 12 connected of 40 known', 'Download speed: 4 MB/s', 'Upload speed: 250 kB/s',
        'Peers: 82 connected of 12 known', 'Share ratio: 0.25', 'Wasted: 4.1 kB', 'Remaining: 600 MB', 'Seeding for: 2m (1m this session)',
        'Availability: 2.40', 'Inbound peers: Yes', 'Total size: 2 GB', 'Browser storage: -', 'Pieces: 7630 x 262.1 kB (have 3815)', 'Progress: 50%',
        `Added on: ${date(LISTED, 'en-US')}`, `Completed on: ${date(completedAt, 'en-US')}`, `Last seen complete: ${date(completedAt, 'en-US')}`,
        'Files: 1', 'Save path: /downloads', 'Info hash: aabbccddeeff00112233445566778899aabbccdd', 'Retrying: attempt 3, file too short',
      ])
      // 0.285 is 0.28499... as a double, which toFixed() rounds down and Intl, reading it as written, up
      expect(overview(await mount(quiet()))).toEqual([
        'Time active: 1h 0m (15m this session)', 'Time left: 4m', 'Connections: 6', 'Downloaded: 0 B (500 MB this session)',
        'Uploaded: 250 MB (100 MB this session)', 'Seeds: 1 connected', 'Download speed: 4 MB/s', 'Upload speed: 250 kB/s',
        'Peers: 1 connected', 'Share ratio: ∞', 'Wasted: 4.1 kB', 'Remaining: Nothing', 'Seeding for: 2m (1m this session)',
        'Availability: 0.28', 'Inbound peers: None yet', 'Total size: 2 GB', 'Browser storage: -', 'Pieces: -', 'Progress: 28%',
        `Added on: ${date(LISTED, 'en-US')}`, 'Completed on: Not yet', `Last seen complete: ${date(completedAt, 'en-US')}`,
        'Files: 1', 'Save path: /downloads', 'Info hash: aabbccddeeff00112233445566778899aabbccdd', 'Retrying: attempt 2',
      ])
      expect(overview(await mount(torrent({ addedAt: undefined }))).find((fact) => fact.startsWith('Added on'))).toBe('Added on: -')
      // under one percent, two places
      expect(overview(await mount(torrent({ stats: null, progress: 0.005 }), null))).toEqual([
        'Time active: -', 'Time left: 4m', 'Connections: -', 'Downloaded: 1 GB', 'Uploaded: -', 'Seeds: 12', 'Download speed: 4 MB/s',
        'Upload speed: 250 kB/s', 'Peers: 82', 'Share ratio: -', 'Wasted: -', 'Remaining: -', 'Seeding for: -', 'Availability: -',
        'Inbound peers: -', 'Total size: 2 GB', 'Pieces: -', 'Progress: 0.50%', `Added on: ${date(LISTED, 'en-US')}`, 'Completed on: -', 'Last seen complete: -',
        'Files: 1', 'Save path: -', 'Info hash: aabbccddeeff00112233445566778899aabbccdd',
      ])
    })

    it('names its parts, and words its other tabs, their columns, tags and states', async () => {
      const screen = await mount()
      expect(named(screen)).toEqual(['Details for Big Buck Bunny', 'Resize the details panel', 'Torrent details', 'Close', 'General', 'Content | 1', 'Peers', 'Trackers'])
      expect(await otherTabs(screen)).toEqual({
        files: ['Pack/ | E01.mkv | 1 GB | Save'],
        asking: 'Asking the engine…',
        nobody: 'Nobody is connected right now.',
        noTrackers: 'No trackers.',
        peers: [
          'Address | Client | Has | Down | Up | Got | Sent',
          '203.0.113.7:51413 | uTP | incoming | encrypted | seed | tracker | unknown | 42% | 120 kB/s | - | 5 MB | -',
          '198.51.100.1:6881 | TCP | DHT | qBittorrent 4.6.5 | 42% | - | - | - | -',
        ],
        trackers: [
          'Tracker | Status | Tier | Seeds | Peers | Next',
          'udp://tracker.opentrackr.org:1337/announce | Working | 0 | 40 | 9 | 28m',
          'udp://b.invalid:80/announce | Failed 3× | 1 | 40 | 9 | 28m',
          'udp://c.invalid:80/announce | Not contacted | 2 | - | - | -',
          'udp://d.invalid:80/announce | Announcing… | 3 | 40 | 9 | 28m',
        ],
      })
    })
  })

  describe('in the language of the page', () => {
    afterEach(showEnglish)

    it('writes its durations in it', async () => {
      await startLanguage({ language: 'fr', languages: ['fr-FR'], catalogues: { '../locales/fr.json': async () => ({}) } })
      const screen = await mount()
      await expect.element(screen.getByText('1h 0min (15min this session)')).toBeInTheDocument()
    })

    // the browser's own language used to write them, so a French page in an English browser read 8/12/2025, 12:00:00 PM
    it('writes its dates as the page\'s language does, not as the browser\'s does', async () => {
      await showIn('fr', fr, 'fr-FR')
      const added = overview(await mount()).find((fact) => fact.startsWith('Ajouté le: '))
      expect(date(LISTED, 'fr-FR')).not.toBe(date(LISTED, navigator.language))
      expect(added).toBe(`Ajouté le: ${date(LISTED, 'fr-FR')}`)
    })

    it('words each fact of the overview in German, with German numbers', async () => {
      await showIn('de', de, 'de-DE')
      const { completedAt } = torrent().stats!
      expect(overview(await mount(torrent({ retry: { reason: 'stopped', attempt: 3, retryInSeconds: 5, message: 'file too short' } })))).toEqual([
        `Aktive Zeit: ${hours(1, 'de-DE')} 0 Min. (15 Min. in dieser Sitzung)`, 'Restzeit: 4m', 'Verbindungen: 6 von 200', 'Heruntergeladen: 1 GB (500 MB in dieser Sitzung)',
        'Hochgeladen: 250 MB (100 MB in dieser Sitzung)', 'Seeder: 12 verbunden von 40 bekannten', 'Download-Geschwindigkeit: 4 MB/s',
        'Upload-Geschwindigkeit: 250 kB/s', 'Peers: 82 verbunden von 12 bekannten', 'Verhältnis: 0,25', 'Verworfen: 4,1 kB', 'Verbleibend: 600 MB',
        'Seed-Zeit: 2 Min. (1 Min. in dieser Sitzung)', 'Verfügbarkeit: 2,40', 'Eingehende Peers: Ja', 'Gesamtgröße: 2 GB', 'Browserspeicher: -',
        'Teile: 7630 × 262,1 kB (vorhanden: 3815)', 'Fortschritt: 50 %', `Hinzugefügt am: ${date(LISTED, 'de-DE')}`,
        `Abgeschlossen am: ${date(completedAt, 'de-DE')}`, `Zuletzt vollständig gesehen: ${date(completedAt, 'de-DE')}`, 'Dateien: 1',
        'Speicherpfad: /downloads', 'Info-Hash: aabbccddeeff00112233445566778899aabbccdd', 'Neuer Versuch: Versuch 3, file too short',
      ])
      expect(overview(await mount(quiet()))).toEqual([
        `Aktive Zeit: ${hours(1, 'de-DE')} 0 Min. (15 Min. in dieser Sitzung)`, 'Restzeit: 4m', 'Verbindungen: 6', 'Heruntergeladen: 0 Byte (500 MB in dieser Sitzung)',
        'Hochgeladen: 250 MB (100 MB in dieser Sitzung)', 'Seeder: 1 verbunden', 'Download-Geschwindigkeit: 4 MB/s', 'Upload-Geschwindigkeit: 250 kB/s',
        'Peers: 1 verbunden', 'Verhältnis: ∞', 'Verworfen: 4,1 kB', 'Verbleibend: Nichts', 'Seed-Zeit: 2 Min. (1 Min. in dieser Sitzung)',
        'Verfügbarkeit: 0,28', 'Eingehende Peers: Noch keine', 'Gesamtgröße: 2 GB', 'Browserspeicher: -', 'Teile: -', 'Fortschritt: 28 %',
        `Hinzugefügt am: ${date(LISTED, 'de-DE')}`, 'Abgeschlossen am: Noch nicht', `Zuletzt vollständig gesehen: ${date(completedAt, 'de-DE')}`,
        'Dateien: 1', 'Speicherpfad: /downloads', 'Info-Hash: aabbccddeeff00112233445566778899aabbccdd', 'Neuer Versuch: Versuch 2',
      ])
    })

    it('names its parts, and words its other tabs, their columns, tags and states, in German', async () => {
      await showIn('de', de, 'de-DE')
      const screen = await mount()
      expect(named(screen)).toEqual(['Details zu Big Buck Bunny', 'Größe des Detailbereichs ändern', 'Torrent-Details', 'Schließen', 'Allgemein', 'Inhalt | 1', 'Peers', 'Tracker'])
      expect(await otherTabs(screen)).toEqual({
        files: ['Pack/ | E01.mkv | 1 GB | Speichern'],
        asking: 'Engine wird abgefragt…',
        nobody: 'Gerade ist niemand verbunden.',
        noTrackers: 'Keine Tracker.',
        peers: [
          'Adresse | Client | Hat | Download | Upload | Erhalten | Gesendet',
          '203.0.113.7:51413 | uTP | eingehend | verschlüsselt | Seeder | Tracker | unbekannt | 42 % | 120 kB/s | - | 5 MB | -',
          '198.51.100.1:6881 | TCP | DHT | qBittorrent 4.6.5 | 42 % | - | - | - | -',
        ],
        trackers: [
          'Tracker | Status | Ebene | Seeder | Peers | Nächste',
          'udp://tracker.opentrackr.org:1337/announce | Funktioniert | 0 | 40 | 9 | 28 Min.',
          'udp://b.invalid:80/announce | 3× fehlgeschlagen | 1 | 40 | 9 | 28 Min.',
          'udp://c.invalid:80/announce | Nicht kontaktiert | 2 | - | - | -',
          'udp://d.invalid:80/announce | Wird angekündigt… | 3 | 40 | 9 | 28 Min.',
        ],
      })
    })

    it('says how much browser storage it takes in German, with a German number', async () => {
      await showIn('de', de, 'de-DE')
      const screen = await mount()
      send({ storageBytes: 3_100_000_000 })
      await expect.poll(() => overview(screen).find((fact) => fact.startsWith('Browserspeicher:'))).toBe('Browserspeicher: 3,1 GB')
    })

    it('agrees connected with a seed or a peer, and with how many', async () => {
      await showIn('fr', fr, 'fr-FR')
      expect(overview(await mount()).filter((fact) => /^(Sources complètes|Pairs):/u.test(fact))).toEqual([
        'Sources complètes: 12 connectées sur 40 au total', 'Pairs: 82 connectés sur 12 au total',
      ])
      expect(overview(await mount(quiet())).filter((fact) => /^(Sources complètes|Pairs):/u.test(fact))).toEqual([
        'Sources complètes: 1 connectée', 'Pairs: 1 connecté',
      ])
    })

    /** What has no room in the trackers' and the peers' tables: a column's name past it or out of line, a name under 80 px. */
    const noRoom = async (screen: Screen) => {
      const problems: string[] = []
      const shown = (row: Element) => [...row.children].filter((cell) => cell.getBoundingClientRect().width > 0)
      for (const [tab, table, rows] of [[3, 'trackers', TRACKERS.length + 1], [2, 'peers', PEERS.length + 1]] as const) {
        screen.container.querySelectorAll<HTMLElement>('.tabs button')[tab]!.click()
        await expect.poll(() => rowsOf(screen).length).toBe(rows)
        const [head, first] = screen.container.querySelectorAll('.rows .row')
        const [labels, cells] = [shown(head!), shown(first!)]
        // right to left, each column follows the one before it on its left
        const rtl = getComputedStyle(head!).direction === 'rtl'
        for (const [i, label] of labels.entries()) {
          const [box, under, before] = [label, cells[i]!, labels[i - 1]].map((cell) => cell?.getBoundingClientRect())
          const overlaps = rtl ? box!.right > (before?.left ?? Infinity) : box!.left < (before?.right ?? 0)
          if (label.scrollWidth > label.clientWidth + 1) problems.push(`${table}: ${label.textContent} runs past its column`)
          else if (Math.abs(box!.left - under!.left) > 0.5 || Math.abs(box!.right - under!.right) > 0.5 || overlaps) {
            problems.push(`${table}: ${label.textContent} is out of line`)
          }
        }
        const room = cells[0]!.getBoundingClientRect().width
        if (room < 80) problems.push(`${table}: ${room} px for a name`)
      }
      return problems
    }

    for (const [path, catalogue] of Object.entries(CATALOGUES)) {
      const language = path.slice(path.lastIndexOf('/') + 1, -'.json'.length)
      it(`gives each column room for its name, and a phone room for an address, in ${language}`, async () => {
        onTestFinished(() => page.viewport(1280, 720))
        await showIn(language, catalogue)
        const screen = await mount()
        screen.container.querySelectorAll<HTMLElement>('.tabs button')[3]!.click()
        send({ peers: PEERS, trackers: TRACKERS })
        expect(await noRoom(screen)).toEqual([])
        await page.viewport(390, 844)
        screen.container.style.width = '390px'
        expect(await noRoom(screen)).toEqual([])
      })
    }
  })

  it('says how much browser storage it takes, holding its place until the engine has measured it, and nothing outside it', async () => {
    const screen = await mount()
    const afterTotal = () => overview(screen)[overview(screen).indexOf('Total size: 2 GB') + 1]
    expect(afterTotal()).toBe('Browser storage: -')
    send({ storageBytes: 3_100_000_000 })
    await expect.poll(afterTotal).toBe('Browser storage: 3.1 GB')
    send({})
    await expect.poll(afterTotal).toBe('Browser storage: -')
    // a folder, a created torrent's own files, and a torrent not on this device
    for (const stats of [{ ...torrent().stats!, savePath: `/native/${'a'.repeat(40)}` }, { ...torrent().stats!, savePath: `/source/${'a'.repeat(40)}` }, null]) {
      const other = await mount(torrent({ stats }))
      send({ storageBytes: 3_100_000_000 })
      await new Promise((r) => setTimeout(r, 50))
      expect(overview(other).filter((fact) => fact.startsWith('Browser storage:')), stats?.savePath).toEqual([])
    }
  })

  it('opens on the overview, which needs no engine round trip', async () => {
    const screen = await mount()
    await expect.element(screen.getByText('aabbccddeeff00112233445566778899aabbccdd')).toBeInTheDocument()
    await expect.element(screen.getByText('/downloads')).toBeInTheDocument()
  })

  it('writes an info hash a magnet gave in base32 as the 40 hex characters other clients show', async () => {
    const screen = await mount(torrent({ infoHash: 'vk54zxpo74abcirtirkwm54itgvlxtg5' }))
    expect(overview(screen)).toContain('Info hash: aabbccddeeff00112233445566778899aabbccdd')
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

  it('gives the next torrent nothing of the last one\'s answer, not even in the render before it resets', async () => {
    const seen: [number, ReturnType<typeof useTorrentDetail>][] = []
    const Probe = ({ handle }: { handle: number }) => {
      seen.push([handle, useTorrentDetail(handle)])
      return null
    }
    const screen = await render(<Probe handle={7}/>)
    send({ peers: [peer()], trackers: [tracker()], storageBytes: 320_000 })
    await expect.poll(() => seen.at(-1)?.[1].storageBytes).toBe(320_000)
    await screen.rerender(<Probe handle={8}/>)
    const next = seen.filter(([handle]) => handle === 8).map(([, view]) => view)
    expect(next.length).toBeGreaterThan(0)
    expect(next).toEqual(next.map(() => ({ peers: [], trackers: [], loaded: false })))
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

  // the engine made the endpoint up for it: a number, where the others have an address
  it('lists a WebRTC peer as one, with no address', async () => {
    const screen = await mount()
    tabButton(screen, 'Peers').click()
    send({ peers: [peer({ endpoint: 'webrtc:3', transport: 'webrtc', downloadRate: 500_000, flags: 1 << 5, source: 1 << 0 })] })
    await expect.element(screen.getByText('WebRTC')).toBeInTheDocument()
    const name = screen.container.querySelector('.rows .row:not(.head) .name')!
    expect([...name.querySelectorAll('.tag')].map((tag) => tag.textContent)).toEqual(['WebRTC', 'tracker'])
    expect(name.querySelector('.mono')!.textContent).toBe('')
    expect(screen.container.textContent).not.toContain('webrtc:3')
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

  it('adds the trackers typed one per line, and keeps and names the ones the engine refused', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    trackersAdded.length = 0
    refusing = async (urls) => urls.filter((url) => !url.includes('://'))
    const field = screen.getByLabelText('Trackers, one per line')
    const add = screen.getByRole('button', { name: 'Add trackers' })
    await field.fill(' \n\n')
    // nothing to add
    await expect.element(add).toBeDisabled()
    await field.fill('  wss://tracker.invalid  \n\nnot a tracker\n')
    await add.click()
    await expect.element(screen.getByText('Not added: not a tracker')).toBeInTheDocument()
    expect(trackersAdded).toEqual([[7, ['wss://tracker.invalid', 'not a tracker']]])
    await expect.element(field).toHaveValue('not a tracker')

    // an engine replaced before it was asked took none of them
    refusing = async () => { throw new Error('the engine was replaced') }
    await field.fill('wss://tracker.invalid\nwss://other.invalid')
    await add.click()
    await expect.element(screen.getByText('Not added: wss://tracker.invalid, wss://other.invalid')).toBeInTheDocument()

    refusing = async () => []
    await add.click()
    await expect.element(field).toHaveValue('')
    expect(screen.container.querySelector('.refused')).toBeNull()
  })

  it('offers no field to add trackers to a torrent that is not on this device', async () => {
    const screen = await mount(torrent(), null)
    tabButton(screen, 'Trackers').click()
    await expect.element(screen.getByText('Asking the engine…')).toBeInTheDocument()
    expect(screen.container.querySelector('.add-trackers')).toBeNull()
  })

  it('takes no second add while one is under way, and starts another torrent with an empty field', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    let answer: (refused: string[]) => void = () => {}
    refusing = () => new Promise((resolve) => { answer = resolve })
    onTestFinished(() => { refusing = async () => [] })
    const field = screen.getByLabelText('Trackers, one per line')
    const add = screen.getByRole('button', { name: 'Add trackers' })
    await field.fill('wss://tracker.invalid\nnot a tracker')
    await add.click()
    await expect.element(add).toBeDisabled()
    answer(['not a tracker'])
    await expect.element(screen.getByText('Not added: not a tracker')).toBeInTheDocument()
    await expect.element(add).toBeEnabled()

    await screen.rerender(<TorrentDetailDock t={torrent({ id: '8', name: 'Sintel' })} handle={8} saving={{}} onSave={() => {}} onClose={onClose}/>)
    await expect.element(screen.getByText('Sintel')).toBeInTheDocument()
    await expect.element(screen.getByLabelText('Trackers, one per line')).toHaveValue('')
    expect(screen.container.querySelector('.refused')).toBeNull()
  })

  it('says a torrent has no trackers instead of leaving the tab blank', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    send({ trackers: [] })
    await expect.element(screen.getByText('No trackers.')).toBeInTheDocument()
  })

  // four pieces of 4 bytes, the first two held: all of the first file and none of the second
  const halfHeld = (dir = 'Pack') => torrent({
    bitfield: { pieces: new Uint8Array([0b1100_0000]), numPieces: 4, pieceLength: 4, length: 16 },
    files: [
      { name: `${dir}/E01.mkv`, size: 8, offset: 0, index: 0 },
      { name: `${dir}/E02.mkv`, size: 8, offset: 8, index: 1 },
    ],
  })

  it('says how much of each file is here, from the pieces held', async () => {
    const screen = await mount(halfHeld())
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E02.mkv')).toBeInTheDocument()
    expect(rowsOf(screen)).toEqual(['Pack/ | E01.mkv | 100% | 8 B | Save', 'Pack/ | E02.mkv | 0% | 8 B | Save'])
    expect([...screen.container.querySelectorAll<HTMLElement>('.row.file .fill')].map((fill) => fill.style.width)).toEqual(['100%', '0%'])
  })

  it('draws how many peers have each piece under the pieces bar, as none, one, or two and more', async () => {
    const screen = await mount(halfHeld())
    const bars = () => [...screen.container.querySelectorAll<HTMLCanvasElement>('.fact.has-bar canvas')]
    expect(bars()).toHaveLength(1)
    // what the engine answers for a torrent with every piece, or one checking its files
    send({ availability: new Uint16Array(0) })
    await new Promise((r) => setTimeout(r, 50))
    expect(bars()).toHaveLength(1)

    send({ availability: new Uint16Array([0, 1, 2, 9]) })
    await expect.poll(() => bars().length).toBe(2)
    const bar = bars()[1]!
    const { data } = bar.getContext('2d')!.getImageData(0, 0, bar.width, 1)
    // each quarter is a piece, read at its middle, its alpha as 0, 1 or 2 peers
    const level = (quarter: number) => Math.round(data[Math.floor((quarter + 0.5) / 4 * bar.width) * 4 + 3]! / 255 * 2)
    expect([0, 1, 2, 3].map(level)).toEqual([0, 1, 2, 2])
    expect(bar.getAttribute('data-tooltip-content')).toBe('Availability')
  })

  it('shades a column of the availability bar by its scarcest piece, so a piece nobody has stays in sight', async () => {
    const screen = await mount(halfHeld())
    const bar = () => screen.container.querySelectorAll<HTMLCanvasElement>('.fact.has-bar canvas')[1]
    const level = (x: number) => Math.round(bar()!.getContext('2d')!.getImageData(x, 0, 1, 1).data[3]! / 255 * 2)
    send({ availability: new Uint16Array([2]) })
    await expect.poll(() => bar()).toBeTruthy()
    // four pieces a column, all held by two peers but one in the middle column, which is not that column's first
    const column = Math.floor(bar()!.width / 2)
    const counts = new Uint16Array(bar()!.width * 4).fill(2)
    counts[column * 4 + 1] = 0
    send({ availability: counts })
    await expect.poll(() => level(column)).toBe(0)
    expect([level(column - 1), level(column + 1)]).toEqual([2, 2])
  })

  it('lays out the pieces fact as any other when it has neither bar', async () => {
    const screen = await mount()
    const pieces = [...screen.container.querySelectorAll('.fact')].find((fact) => fact.querySelector('label')?.textContent === 'Pieces')
    expect(pieces?.className).toBe('fact')
  })

  it('says 100% only when the file is whole', async () => {
    // 1000 pieces of a byte, all held but the last
    const pieces = new Uint8Array(125).fill(0xff)
    pieces[124] = 0xfe
    const screen = await mount(torrent({
      bitfield: { pieces, numPieces: 1000, pieceLength: 1, length: 1000 },
      files: [{ name: 'Film.mkv', size: 1000, offset: 0, index: 0 }],
    }))
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('Film.mkv')).toBeInTheDocument()
    expect(rowsOf(screen)).toEqual(['Film.mkv | 99% | 1 kB | Save'])
  })

  // 0.29 * 100 is 28.999... in floating point
  it('says 29% for a file 29% here', async () => {
    const pieces = new Uint8Array(13)
    pieces.set([0xff, 0xff, 0xff, 0b1111_1000])
    const screen = await mount(torrent({
      bitfield: { pieces, numPieces: 100, pieceLength: 1, length: 100 },
      files: [{ name: 'Film.mkv', size: 100, offset: 0, index: 0 }],
    }))
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('Film.mkv')).toBeInTheDocument()
    expect(rowsOf(screen)).toEqual(['Film.mkv | 29% | 100 B | Save'])
  })

  it('leaves the file bars out on a phone, keeps each box beside its name, and the list inside its width', async () => {
    onTestFinished(() => page.viewport(1280, 720))
    await page.viewport(390, 844)
    const screen = await mount(halfHeld('Some.Show.S01.1080p.WEB-DL.DDP5.1.H.264-GROUP'))
    screen.container.style.width = '390px'
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E02.mkv')).toBeInTheDocument()
    const rows = [...screen.container.querySelectorAll<HTMLElement>('.row.file')]
    expect(rows.map((row) => getComputedStyle(row.querySelector('.bar')!).display)).toEqual(['none', 'none'])
    // beside the text and within its height, not on a line of its own above it
    const besideItsName = (row: HTMLElement) => {
      const box = row.querySelector('input')!
      const text = document.createRange()
      text.setStartAfter(box)
      text.setEndAfter(row.querySelector('.name')!.lastChild!)
      const [at, of] = [box.getBoundingClientRect(), text.getBoundingClientRect()]
      return at.right <= of.left && at.top >= of.top && at.bottom <= of.bottom
    }
    expect(rows.map(besideItsName)).toEqual([true, true])
    const pane = screen.container.querySelector<HTMLElement>('.pane')!
    expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth)
  })

  it('draws the pieces held under Pieces, and nothing before the engine has said', async () => {
    const screen = await mount(halfHeld())
    const canvas = screen.container.querySelector<HTMLCanvasElement>('.fact.has-bar canvas')!
    expect(canvas.closest('.fact')!.querySelector('label')!.textContent).toBe('Pieces')
    const alphaAt = (x: number) => canvas.getContext('2d')!.getImageData(x, 0, 1, 1).data[3]
    await expect.poll(() => alphaAt(0)).toBe(255)
    expect(alphaAt(canvas.width - 1)).toBe(0)
    expect((await mount()).container.querySelector('canvas')).toBeNull()
  })

  it('shades each column of the pieces bar by the share of the pieces under it', async () => {
    // every other piece held, a few hundred to a column
    const screen = await mount(torrent({ bitfield: { pieces: new Uint8Array(12_500).fill(0b1010_1010), numPieces: 100_000, pieceLength: 1, length: 100_000 } }))
    const canvas = screen.container.querySelector<HTMLCanvasElement>('.fact.has-bar canvas')!
    const shades = () => canvas.getContext('2d')!.getImageData(0, 0, canvas.width, 1).data.filter((_, i) => i % 4 === 3)
    await expect.poll(() => shades()[0]).toBeGreaterThan(0)
    expect(canvas.width).toBeLessThan(1000)
    expect(Math.min(...shades())).toBeGreaterThanOrEqual(120)
    expect(Math.max(...shades())).toBeLessThanOrEqual(136)
  })

  /*
   * A PADDED torrent, because an unpadded one cannot tell the two indices apart.
   *
   * The Content tab renders `contentFiles`, which drops the pads a v2 or hybrid torrent carries, so a
   * position in that list is not the engine's file index for anything after the first pad. Both
   * things this tab does with an index address the engine: `onSave` reaches it, and `saving` is keyed
   * in `home.tsx` off the UNFILTERED list. Using the position saved the wrong file under the right
   * name and drew the percentage on the wrong row.
   *
   * The pad sits at index 1 deliberately. With it, E02 is engine index 2 and filtered position 1, so
   * the correct and incorrect answers are different numbers and the test can fail. Without a pad they
   * coincide and this would pass either way.
   */
  const padded = () => torrent({
    files: [
      { name: 'Pack/E01.mkv', size: 1e9, index: 0 },
      { name: 'Pack/.pad/262144', size: 262_144, index: 1, pad: true },
      { name: 'Pack/E02.mkv', size: 1e9, index: 2 },
    ],
  })

  it('saves the file that was clicked, not the one at that position', async () => {
    const saved: number[] = []
    const screen = await mount(padded(), 7, { onSave: (index) => saved.push(index) })
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E02.mkv')).toBeInTheDocument()

    const rows = [...screen.container.querySelectorAll<HTMLElement>('.row.file')]
    // the pad is not offered, so E02 is the SECOND row here while being the third file
    expect(rows.map((r) => r.querySelector('.name')?.textContent)).toEqual(['Pack/E01.mkv', 'Pack/E02.mkv'])
    rows[1]!.querySelector('button')!.click()

    expect(saved, 'the click saved the pad instead of the episode').toEqual([2])
  })

  it('shows a save percentage against the file it belongs to', async () => {
    // keyed the way `home.tsx` keys it: by engine index, so 2 is E02 and nothing is saving E01
    const screen = await mount(padded(), 7, { saving: { 2: 0.42 } })
    tabButton(screen, 'Content').click()
    await expect.element(screen.getByText('E02.mkv')).toBeInTheDocument()

    const rows = [...screen.container.querySelectorAll<HTMLElement>('.row.file')]
    expect(rows[0]!.querySelector('button')!.textContent, 'E01 is not being saved').toBe('Save')
    expect(rows[1]!.querySelector('button')!.textContent, 'the percentage landed on the wrong row').toBe('42%')
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

  describe('which files it downloads', () => {
    const pack = (over: Partial<Torrent> = {}) => torrent({
      firstLast: true,
      files: [
        { name: 'Pack/E01.mkv', size: 1e9, index: 0 },
        { name: 'Pack/E02.mkv', size: 1e9, index: 1 },
        { name: 'Pack/E03.mkv', size: 1e9, index: 2 },
      ],
      ...over,
    })
    const content = async (t: Torrent, handle: number | null = 7) => {
      const screen = await mount(t, handle)
      tabButton(screen, 'Content').click()
      await expect.poll(() => screen.container.querySelectorAll('.row.file').length).toBe(3)
      const rows = [...screen.container.querySelectorAll<HTMLElement>('.row.file')]
      return {
        screen,
        boxes: rows.map((row) => row.querySelector<HTMLInputElement>('input[type=checkbox]')),
        left: rows.map((row) => row.classList.contains('off')),
      }
    }
    const ticks = (screen: Screen) => [...screen.container.querySelectorAll<HTMLInputElement>('.row.file input')].map((box) => box.checked)
    const reported = (screen: Screen, t: Torrent) => screen.rerender(<TorrentDetailDock t={t} handle={Number(t.id)} saving={{}} onSave={() => {}} onClose={onClose}/>)

    // the torrent reports a selection only once the worker has stored it, behind whatever its lane already holds
    it('builds a tick on the one before it, until the torrent reports what was sent', async () => {
      const { screen, boxes } = await content(pack())
      boxes[0]!.click()
      boxes[2]!.click()
      expect(planned).toEqual([[7, { wanted: [1, 2], firstLast: true }], [7, { wanted: [1], firstLast: true }]])
      expect(ticks(screen)).toEqual([false, true, false])
      await reported(screen, pack({ wantedFiles: [1, 2] }))
      expect(ticks(screen)).toEqual([false, true, false])
      await reported(screen, pack({ wantedFiles: [1] }))
      // and from then on, a selection made elsewhere
      await reported(screen, pack({ wantedFiles: [0, 1] }))
      expect(ticks(screen)).toEqual([true, true, false])
    })

    it('leaves a tick sent for one torrent behind when the panel moves to another', async () => {
      const { screen, boxes } = await content(pack())
      boxes[0]!.click()
      await reported(screen, pack({ id: '8' }))
      expect(ticks(screen)).toEqual([true, true, true])
    })

    it('leaves out a file that is unticked, keeping first and last first as it was', async () => {
      const { boxes, left } = await content(pack())
      expect(boxes.map((box) => box!.checked)).toEqual([true, true, true])
      expect(left).toEqual([false, false, false])
      boxes[1]!.click()
      expect(planned).toEqual([[7, { wanted: [0, 2], firstLast: true }]])
    })

    it('strikes through a file left out, and sends no list once every file is ticked again', async () => {
      const { screen, boxes, left } = await content(pack({ wantedFiles: [0, 2] }))
      expect(boxes.map((box) => box!.checked)).toEqual([true, false, true])
      expect(left).toEqual([false, true, false])
      expect([...screen.container.querySelectorAll('.row.file .name')].map((name) => getComputedStyle(name).textDecorationLine))
        .toEqual(['none', 'line-through', 'none'])
      boxes[1]!.click()
      expect(planned).toEqual([[7, { wanted: undefined, firstLast: true }]])
    })

    it('counts the files of a padded torrent without its pads', async () => {
      const screen = await mount(padded())
      tabButton(screen, 'Content').click()
      await expect.poll(() => screen.container.querySelectorAll('.row.file input').length).toBe(2)
      const e02 = screen.container.querySelectorAll<HTMLInputElement>('.row.file input')[1]!
      e02.click()
      e02.click()
      expect(planned.map(([, plan]) => plan.wanted)).toEqual([[0], undefined])
    })

    it('keeps the last ticked file ticked', async () => {
      const { boxes } = await content(pack({ wantedFiles: [1] }))
      expect(boxes.map((box) => box!.disabled)).toEqual([false, true, false])
      boxes[1]!.click()
      expect(planned).toEqual([])
      boxes[0]!.click()
      expect(planned).toEqual([[7, { wanted: [0, 1], firstLast: true }]])
    })

    // a temporary torrent's files follow its player, and a torrent not here has no engine to tell
    it('offers no tick box on a temporary torrent or one not on this device, and still shows what was left out', async () => {
      for (const [t, handle] of [[pack({ ephemeral: true, wantedFiles: [0] }), 7], [pack({ wantedFiles: [0] }), null]] as const) {
        const { boxes, left } = await content(t, handle)
        expect(boxes).toEqual([null, null, null])
        expect(left).toEqual([false, true, true])
      }
    })
  })
})
