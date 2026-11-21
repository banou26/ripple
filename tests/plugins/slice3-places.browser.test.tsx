// Slice 3 UI places (`file` and `player`), inline popup pages over the player, details-panel isolation,
// and all 8 switches in the install sheet.
import type { Button, ClickContext } from '../../src/plugins/contract'
import type { Torrent } from '../../src/torrent/types'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from '@vitest/browser/context'
import { MemoryRouter } from 'react-router-dom'

import { IntlRoot } from '../../src/i18n'
import { entry, snapshot } from './engine-double'
import { fkn } from './packages-double'

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
const engine = vi.hoisted(() => ({ double: undefined as unknown as import('./engine-double').EngineDouble }))
const playerMock = vi.hoisted(() => ({ unreadable: false }))

vi.mock('@fkn/lib/packages', () => import('./packages-double'))
vi.mock('../../src/utils/framed', () => ({ isFramed: () => false }))
vi.mock('idb-keyval', async () => {
  const made = (await import('./engine-double')).memoryStore()
  memory.store = made.store
  return made.module
})
vi.mock('../../src/torrent/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/torrent/client')>()
  engine.double = (await import('./engine-double')).engineDouble(real)
  return { ...real, getTorrentClient: () => engine.double.client, runningTorrentClient: () => (engine.double.running ? engine.double.client : null) }
})
vi.mock('@banou/media-player', () => ({
  MediaPlayer: ({ overlay, children }: { overlay?: React.ReactNode, children?: React.ReactNode }) => (
    <div className="mock-media-player" data-testid="media-player">
      <style>{'.mock-media-player, .mock-media-player * { box-sizing: border-box; }'}</style>
      <video/>
      {overlay}
      {children}
    </div>
  ),
}))
vi.mock('../../src/torrent/use-player-torrent', () => ({
  usePlayerTorrent: () => ({
    snapshot: playerMock.unreadable ? null : {
      handle: 1,
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      files: { files: [{ path: 'clip.mp4', size: 1024, offset: 0, pad: false }] },
      status: { state: 3, progress: 0.5, totalDone: 512, downloadRate: 0, uploadRate: 0, numPeers: 0, numSeeds: 0, swarmSeeds: -1, swarmPeers: -1 },
      bitfield: null,
      recovery: null,
      userPaused: false,
      windowed: false,
      swarmDownloads: -1,
    },
    read: async () => new ArrayBuffer(0),
    readQuiet: async () => new ArrayBuffer(0),
    prioritizeFrom: () => {},
    fileIndex: 0,
    engineError: null,
    unreadable: playerMock.unreadable,
    storageFull: false,
  }),
}))

const { default: Embed } = await import('../../src/router/embed')
const { TorrentDetailDock } = await import('../../src/router/torrent-detail')
const { PluginHost } = await import('../../src/plugins/plugin-host')
const { browsePlugins, closePage, removePlugin } = await import('../../src/plugins/host')
const { answer, keepButtons } = await import('../../src/plugins/switches')

const HASH_A = 'a'.repeat(40)
const HASH_B = 'b'.repeat(40)
const MAGNET_A = `magnet:?xt=urn:btih:${HASH_A}&dn=Clip`
const MAGNET_B = `magnet:?xt=urn:btih:${HASH_B}&dn=Other`

let seq = 0
const register = async (buttons: Button[], opts: { asks?: ('read' | 'add' | 'change' | 'remove' | 'files' | 'folder' | 'peers' | 'network')[], connect?: boolean } = {}) => {
  const n = ++seq
  const uri = `npm:s3-plugin-${n}`
  const name = `S3 Plugin ${n}`
  const clicks: [string, ClickContext][] = []
  fkn.plugins.set(uri, {
    name,
    version: '1.0.0',
    payload: {
      asks: opts.asks ?? [],
      buttons: () => buttons,
      click: (id: string, ctx: ClickContext) => { clicks.push([id, ctx]) },
    },
  })
  fkn.installed.push({ uri, name, version: '1.0.0', installedAt: n })
  await answer(uri, Object.fromEntries((opts.asks ?? []).map((s) => [s, true])))
  await keepButtons(uri, { name, installedAt: n, locales: { en: buttons } })
  return { uri, name, clicks }
}

beforeEach(() => {
  fkn.reset()
  memory.store.clear()
  playerMock.unreadable = false
  closePage()
  engine.double.running = true
  engine.double.posted.length = 0
  engine.double.start(
    [entry(HASH_A, { name: 'Clip' }), entry(HASH_B, { name: 'Other' })],
    [{ handle: 1, magnet: MAGNET_A }, { handle: 2, magnet: MAGNET_B }],
  )
})

afterEach(async () => {
  closePage()
  for (const uri of [...fkn.plugins.keys()]) await removePlugin(uri)
})

describe('file button place in TorrentDetail', () => {
  it('draws 1 inline + More beside Save and passes { infoHash, file } using engine index past pad files', async () => {
    const p1 = await register([{ id: 'inspect', place: 'file', label: 'Inspect file' }])
    const p2 = await register([{ id: 'sub', place: 'file', label: 'Subtitles' }])
    const t: Torrent = {
      id: '1',
      name: 'Clip',
      magnet: MAGNET_A,
      infoHash: HASH_A,
      state: 'downloading',
      progress: 0.5,
      size: 2048,
      downloaded: 1024,
      down: 0,
      up: 0,
      peers: 1,
      seeds: 1,
      eta: '',
      flags: 0,
      queuePosition: 0,
      stats: null,
      files: [
        { name: '.pad/512', size: 512, index: 0, pad: true },
        { name: 'episode.mkv', size: 1536, index: 1, pad: false },
      ],
    }

    await render(
      <IntlRoot>
        <MemoryRouter>
          <TorrentDetailDock t={t} handle={1} saving={{}} onClose={() => {}} onSave={() => {}}/>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )

    await userEvent.click(document.querySelector('.tabs button:nth-of-type(2)')!)
    await vi.waitFor(() => expect(document.querySelectorAll('.row.file .plugin')).toHaveLength(1))
    expect(document.querySelectorAll('.row.file .plugin-more')).toHaveLength(1)

    await userEvent.click(document.querySelector('.row.file .plugin')!)
    await vi.waitFor(() => expect(p1.clicks).toEqual([['inspect', { infoHash: HASH_A, file: 1 }]]))

    await userEvent.click(document.querySelector('.row.file .plugin-more')!)
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull())
    await userEvent.click(document.querySelector('[role="menuitem"]')!)
    await vi.waitFor(() => expect(p2.clicks).toEqual([['sub', { infoHash: HASH_A, file: 1 }]]))
  })

  it('keeps the details panel on torrent 1 while a plugin queries peers and trackers of torrent 2', async () => {
    const p = await register([{ id: 'check', place: 'detail', label: 'Check other' }], { asks: ['peers'] })
    const t: Torrent = {
      id: '1',
      name: 'Clip',
      magnet: MAGNET_A,
      infoHash: HASH_A,
      state: 'downloading',
      progress: 0.5,
      size: 1024,
      downloaded: 512,
      down: 0,
      up: 0,
      peers: 1,
      seeds: 1,
      eta: '',
      flags: 0,
      queuePosition: 0,
      stats: null,
      files: [{ name: 'clip.mp4', size: 1024, index: 0 }],
    }

    await render(
      <IntlRoot>
        <MemoryRouter>
          <TorrentDetailDock t={t} handle={1} saving={{}} onSave={() => {}} onClose={() => {}}/>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )

    // open Peers tab in TorrentDetailDock and feed handle 1's detail
    await userEvent.click(document.querySelector('.tabs button:nth-of-type(3)')!)
    await vi.waitFor(() => expect(engine.double.posted.some((m) => m.type === 'inspect' && m.handle === 1)).toBe(true))
    engine.double.say({
      type: 'state',
      torrents: [snapshot({ handle: 1, magnet: MAGNET_A }), snapshot({ handle: 2, magnet: MAGNET_B })],
      detail: {
        handle: 1,
        peers: [{ endpoint: '198.51.100.10:6881', client: 'PanelPeer', downloadRate: 100, uploadRate: 0, totalDownload: 100, totalUpload: 0, progress: 1, flags: 0, source: 0, transport: 'tcp', localConnection: false }],
        trackers: [],
      },
    })
    await vi.waitFor(() => expect(document.body.textContent).toContain('198.51.100.10:6881'))

    // connect the plugin and have it read torrent 2's peers & trackers
    await userEvent.click(document.querySelector('section header .plugin')!)
    await vi.waitFor(() => expect(fkn.opened.some((o) => o.uri === p.uri)).toBe(true))
    const remote = await fkn.rippleOf(p.uri)

    const peersPromise = remote.peers(HASH_B)
    await vi.waitFor(() => expect(engine.double.posted.some((m) => m.type === 'torrent-detail' && m.handle === 2)).toBe(true))
    const ask1 = engine.double.posted.find((m) => m.type === 'torrent-detail' && m.handle === 2)!
    engine.double.say({
      type: 'answer',
      id: ask1.id,
      value: {
        peers: [{ endpoint: '203.0.113.99:51413', client: 'PluginPeer', downloadRate: 200, uploadRate: 50, totalDownload: 0, totalUpload: 0, progress: 0.25, flags: 0, source: 0, transport: 'tcp', localConnection: false }],
        trackers: [{ url: 'https://t.example/passkey-secret/announce', message: 'secret', tier: 0, fails: 0, updating: false, verified: true, nextAnnounceIn: 60, seeders: 1, leechers: 0, downloaded: 0 }],
      },
    })
    expect(await peersPromise).toEqual([{ address: '203.0.113.99:51413', client: 'PluginPeer', down: 200, up: 50, progress: 0.25 }])

    // the details panel was never re-inspected to handle 2 and still displays handle 1's peer
    expect(engine.double.posted.some((m) => m.type === 'inspect' && m.handle === 2)).toBe(false)
    expect(document.body.textContent).toContain('198.51.100.10:6881')
  })
})

describe('player button place and inline popup page on /watch', () => {
  it('portals 1 inline + More into .player-links without connecting on cache miss, passes { infoHash, file, time }, and mounts inline popup pages in the player box', async () => {
    const p1 = await register([{ id: 'mark', place: 'player', label: 'Bookmark' }])
    const p2 = await register([{ id: 'subs', place: 'player', label: 'Open subs', page: { id: 'subs-panel', size: 'small' } }])
    // also add an uncached plugin (only answered, no kept buttons): a player tab must NOT connect it at load
    const uncachedUri = 'npm:uncached-player-check'
    fkn.plugins.set(uncachedUri, { name: 'Uncached', version: '1.0.0', payload: { asks: [], buttons: () => [] } })
    fkn.installed.push({ uri: uncachedUri, name: 'Uncached', version: '1.0.0', installedAt: 99 })
    await answer(uncachedUri, {})
    // follower tab (not engine owner) so EngineTab does not auto-connect
    engine.double.start(
      [entry(HASH_A, { name: 'Clip' })],
      [{ handle: 1, magnet: MAGNET_A }],
      false,
    )

    await render(
      <IntlRoot>
        <MemoryRouter initialEntries={[`/watch?fileIndex=0&magnet=${encodeURIComponent(btoa(MAGNET_A))}`]}>
          <Embed/>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )

    await vi.waitFor(() => expect(document.querySelectorAll('.player-links .plugin')).toHaveLength(1))
    expect(document.querySelectorAll('.player-links .plugin-more')).toHaveLength(1)
    // under @banou/media-player's border-box reset, plugin buttons keep the full 40x40 target
    const btnRect = document.querySelector<HTMLButtonElement>('.player-links .plugin')!.getBoundingClientRect()
    expect(btnRect.width).toBeGreaterThanOrEqual(40)
    expect(btnRect.height).toBeGreaterThanOrEqual(40)
    // no plugin was auto-connected on the player tab before a click
    expect(fkn.opened.some((o) => o.uri === p1.uri)).toBe(false)
    expect(fkn.opened.some((o) => o.uri === p2.uri)).toBe(false)
    expect(fkn.opened.some((o) => o.uri === uncachedUri)).toBe(false)

    // set playback time on the <video> element inside the player box
    const video = document.querySelector<HTMLVideoElement>('[data-testid="media-player"] video')!
    Object.defineProperty(video, 'currentTime', { value: 42.5, configurable: true })

    // Space key on the plugin button does not reach the window (which would pause the player)
    const leakedKeys: string[] = []
    const onKey = (e: KeyboardEvent) => { leakedKeys.push(e.key) }
    window.addEventListener('keydown', onKey)
    try {
      const btn = document.querySelector<HTMLButtonElement>('.player-links .plugin')!
      btn.focus()
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(leakedKeys).toEqual([])
    } finally {
      window.removeEventListener('keydown', onKey)
    }

    // clicking inline button connects p1 and hands { infoHash, file, time }
    await userEvent.click(document.querySelector('.player-links .plugin')!)
    await vi.waitFor(() => expect(p1.clicks).toEqual([['mark', { infoHash: HASH_A, file: 0, time: 42.5 }]]))

    // opening player More menu: navigating and player shortcut keys must NOT reach window
    Object.defineProperty(video, 'currentTime', { value: 99, configurable: true })
    await userEvent.click(document.querySelector('.player-links .plugin-more')!)
    await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull())
    leakedKeys.length = 0
    window.addEventListener('keydown', onKey)
    try {
      const menu = document.querySelector<HTMLElement>('[role="menu"]')!
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      const item = document.querySelector<HTMLElement>('[role="menuitem"]')!
      for (const key of ['ArrowUp', 'ArrowDown', 'f', 'k', 'm', 'ArrowRight']) {
        item.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      }
      expect(leakedKeys).toEqual([])
      // Space on the focused menuitem activates it without bubbling to window
      item.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(leakedKeys).toEqual([])
    } finally {
      window.removeEventListener('keydown', onKey)
    }

    await vi.waitFor(() => expect(document.querySelector('[data-testid="media-player"] .plugin-page[data-inline]')).not.toBeNull())
    await vi.waitFor(() => expect(fkn.mountedOf(p2.uri)).toBeDefined())
    const pageRipple = await fkn.mountedOf(p2.uri)!.ripple
    expect(pageRipple.page).toEqual({ id: 'subs-panel', context: { infoHash: HASH_A, file: 0, time: 99 } })

    // keys on inline PluginPage chrome (Close button / modal) must NOT leak to window
    leakedKeys.length = 0
    window.addEventListener('keydown', onKey)
    try {
      const closeBtn = document.querySelector<HTMLButtonElement>('.plugin-page[data-inline] .close')!
      closeBtn.focus()
      for (const key of ['f', 'k', 'm', 'ArrowDown', ' ']) {
        closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      }
      expect(leakedKeys).toEqual([])
    } finally {
      window.removeEventListener('keydown', onKey)
    }
  })

  it('does not mount player plugin buttons when the magnet is unreadable', async () => {
    await register([{ id: 'mark', place: 'player', label: 'Bookmark' }])
    playerMock.unreadable = true
    await render(
      <IntlRoot>
        <MemoryRouter initialEntries={[`/watch?fileIndex=0&magnet=${encodeURIComponent(btoa('magnet:?xt=urn:btih:bad'))}`]}>
          <Embed/>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(document.querySelectorAll('.player-links .plugin')).toHaveLength(0)
    expect(document.querySelectorAll('.player-links .plugin-more')).toHaveLength(0)
  })
})

describe('all 8 switches in the install sheet', () => {
  it('displays every offered switch with its English label', async () => {
    const uri = 'npm:all-switches-plugin'
    fkn.plugins.set(uri, {
      name: 'Everything',
      version: '1.0.0',
      payload: { asks: ['read', 'add', 'change', 'remove', 'files', 'folder', 'peers', 'network'] },
    })

    await render(
      <IntlRoot>
        <MemoryRouter>
          <PluginHost/>
        </MemoryRouter>
      </IntlRoot>,
    )

    fkn.picks = [uri]
    void browsePlugins()
    await vi.waitFor(() => expect(document.querySelector('[aria-labelledby="plugin-sheet-title"]')).not.toBeNull())
    const sheet = document.querySelector('[aria-labelledby="plugin-sheet-title"]')!
    const labels = [...sheet.querySelectorAll('label')].map((l) => l.textContent?.trim())
    expect(labels).toEqual([
      'See your torrents',
      'Add torrents without asking',
      'Pause, resume and organize torrents',
      'Remove torrents',
      'Open your downloaded files',
      'Move files to and from your folder',
      'See peers and trackers, set speed limits',
      'See connection status',
    ])
    // every switch starts off
    expect([...sheet.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((i) => !i.checked)).toBe(true)
  })
})
