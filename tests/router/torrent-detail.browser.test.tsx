import type { Torrent } from '../../src/torrent/types'
import type { PeerInfo, TrackerInfo } from '../../src/torrent/worker'

import { page } from '@vitest/browser/context'
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
let detailCb: ((detail: any) => void) | null = null

// one client, as the page has: a new one per render would subscribe again on every render, and empty the panel each time
vi.mock('../../src/torrent/client', () => {
  const client = {
    inspect: (handle: number | null) => { inspected.push(handle) },
    onDetail: (cb: (d: any) => void) => { detailCb = cb; return () => { detailCb = null } },
  }
  return { getTorrentClient: () => client }
})

const { TorrentDetailDock } = await import('../../src/router/torrent-detail')
const { IntlRoot, startLanguage } = await import('../../src/i18n')
const { showEnglish, showIn } = await import('../i18n/show-in')
const { default: de } = await import('../../src/locales/de.json')
const { default: fr } = await import('../../src/locales/fr.json')
const CATALOGUES = import.meta.glob<Record<string, string>>('../../src/locales/*.json', { import: 'default', eager: true })
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
    // deliberately different from the totals: a session figure that echoed the total would pass
    // whichever of the two the panel actually rendered
    sessionActiveSeconds: 900,
    sessionSeedingSeconds: 60,
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

const mount = async (
  t: Torrent = torrent(),
  handle: number | null = 7,
  extra: { saving?: Record<number, number>, onSave?: (index: number) => void } = {},
) => {
  inspected.length = 0
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
      const { addedAt, completedAt } = torrent().stats!
      expect(overview(await mount(torrent({ retry: { reason: 'stopped', attempt: 3, retryInSeconds: 5, message: 'file too short' } })))).toEqual([
        'Time active: 1h 0m (15m this session)', 'Time left: 4m', 'Connections: 6 of 200', 'Downloaded: 1 GB (500 MB this session)',
        'Uploaded: 250 MB (100 MB this session)', 'Seeds: 12 connected of 40 known', 'Download speed: 4 MB/s', 'Upload speed: 250 kB/s',
        'Peers: 82 connected of 12 known', 'Share ratio: 0.25', 'Wasted: 4.1 kB', 'Remaining: 1 GB', 'Seeding for: 2m (1m this session)',
        'Availability: 2.40', 'Inbound peers: Yes', 'Total size: 2 GB', 'Pieces: 7630 x 262.1 kB (have 3815)', 'Progress: 50%',
        `Added on: ${date(addedAt, 'en-US')}`, `Completed on: ${date(completedAt, 'en-US')}`, `Last seen complete: ${date(completedAt, 'en-US')}`,
        'Files: 1', 'Save path: /downloads', 'Info hash: aabbccddeeff00112233445566778899aabbccdd', 'Retrying: attempt 3, file too short',
      ])
      // 0.285 is 0.28499... as a double, which toFixed() rounds down and Intl, reading it as written, up
      expect(overview(await mount(quiet()))).toEqual([
        'Time active: 1h 0m (15m this session)', 'Time left: 4m', 'Connections: 6', 'Downloaded: 0 B (500 MB this session)',
        'Uploaded: 250 MB (100 MB this session)', 'Seeds: 1 connected', 'Download speed: 4 MB/s', 'Upload speed: 250 kB/s',
        'Peers: 1 connected', 'Share ratio: ∞', 'Wasted: 4.1 kB', 'Remaining: Nothing', 'Seeding for: 2m (1m this session)',
        'Availability: 0.28', 'Inbound peers: None yet', 'Total size: 2 GB', 'Pieces: -', 'Progress: 28%',
        `Added on: ${date(addedAt, 'en-US')}`, 'Completed on: Not yet', `Last seen complete: ${date(completedAt, 'en-US')}`,
        'Files: 1', 'Save path: /downloads', 'Info hash: aabbccddeeff00112233445566778899aabbccdd', 'Retrying: attempt 2',
      ])
      // under one percent, two places
      expect(overview(await mount(torrent({ stats: null, progress: 0.005 }), null))).toEqual([
        'Time active: -', 'Time left: 4m', 'Connections: -', 'Downloaded: 1 GB', 'Uploaded: -', 'Seeds: 12', 'Download speed: 4 MB/s',
        'Upload speed: 250 kB/s', 'Peers: 82', 'Share ratio: -', 'Wasted: -', 'Remaining: 1 GB', 'Seeding for: -', 'Availability: -',
        'Inbound peers: -', 'Total size: 2 GB', 'Pieces: -', 'Progress: 0.50%', 'Added on: -', 'Completed on: -', 'Last seen complete: -',
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
      const { addedAt } = torrent().stats!
      const added = overview(await mount()).find((fact) => fact.startsWith('Ajouté le: '))
      expect(date(addedAt, 'fr-FR')).not.toBe(date(addedAt, navigator.language))
      expect(added).toBe(`Ajouté le: ${date(addedAt, 'fr-FR')}`)
    })

    it('words each fact of the overview in German, with German numbers', async () => {
      await showIn('de', de, 'de-DE')
      const { addedAt, completedAt } = torrent().stats!
      expect(overview(await mount(torrent({ retry: { reason: 'stopped', attempt: 3, retryInSeconds: 5, message: 'file too short' } })))).toEqual([
        `Aktive Zeit: ${hours(1, 'de-DE')} 0 Min. (15 Min. in dieser Sitzung)`, 'Restzeit: 4m', 'Verbindungen: 6 von 200', 'Heruntergeladen: 1 GB (500 MB in dieser Sitzung)',
        'Hochgeladen: 250 MB (100 MB in dieser Sitzung)', 'Seeder: 12 verbunden von 40 bekannten', 'Download-Geschwindigkeit: 4 MB/s',
        'Upload-Geschwindigkeit: 250 kB/s', 'Peers: 82 verbunden von 12 bekannten', 'Verhältnis: 0,25', 'Verworfen: 4,1 kB', 'Verbleibend: 1 GB',
        'Seed-Zeit: 2 Min. (1 Min. in dieser Sitzung)', 'Verfügbarkeit: 2,40', 'Eingehende Peers: Ja', 'Gesamtgröße: 2 GB',
        'Teile: 7630 × 262,1 kB (vorhanden: 3815)', 'Fortschritt: 50 %', `Hinzugefügt am: ${date(addedAt, 'de-DE')}`,
        `Abgeschlossen am: ${date(completedAt, 'de-DE')}`, `Zuletzt vollständig gesehen: ${date(completedAt, 'de-DE')}`, 'Dateien: 1',
        'Speicherpfad: /downloads', 'Info-Hash: aabbccddeeff00112233445566778899aabbccdd', 'Neuer Versuch: Versuch 3, file too short',
      ])
      expect(overview(await mount(quiet()))).toEqual([
        `Aktive Zeit: ${hours(1, 'de-DE')} 0 Min. (15 Min. in dieser Sitzung)`, 'Restzeit: 4m', 'Verbindungen: 6', 'Heruntergeladen: 0 Byte (500 MB in dieser Sitzung)',
        'Hochgeladen: 250 MB (100 MB in dieser Sitzung)', 'Seeder: 1 verbunden', 'Download-Geschwindigkeit: 4 MB/s', 'Upload-Geschwindigkeit: 250 kB/s',
        'Peers: 1 verbunden', 'Verhältnis: ∞', 'Verworfen: 4,1 kB', 'Verbleibend: Nichts', 'Seed-Zeit: 2 Min. (1 Min. in dieser Sitzung)',
        'Verfügbarkeit: 0,28', 'Eingehende Peers: Noch keine', 'Gesamtgröße: 2 GB', 'Teile: -', 'Fortschritt: 28 %',
        `Hinzugefügt am: ${date(addedAt, 'de-DE')}`, 'Abgeschlossen am: Noch nicht', `Zuletzt vollständig gesehen: ${date(completedAt, 'de-DE')}`,
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
        for (const [i, label] of labels.entries()) {
          const [box, under, before] = [label, cells[i]!, labels[i - 1]].map((cell) => cell?.getBoundingClientRect())
          if (label.scrollWidth > label.clientWidth + 1) problems.push(`${table}: ${label.textContent} runs past its column`)
          else if (Math.abs(box!.left - under!.left) > 0.5 || Math.abs(box!.right - under!.right) > 0.5 || box!.left < (before?.right ?? 0)) {
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

  it('says a torrent has no trackers instead of leaving the tab blank', async () => {
    const screen = await mount()
    tabButton(screen, 'Trackers').click()
    send({ trackers: [] })
    await expect.element(screen.getByText('No trackers.')).toBeInTheDocument()
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
      { name: 'Pack/E01.mkv', size: 1e9, progress: 0, index: 0 },
      { name: 'Pack/.pad/262144', size: 262_144, progress: 0, index: 1, pad: true },
      { name: 'Pack/E02.mkv', size: 1e9, progress: 0, index: 2 },
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
})
