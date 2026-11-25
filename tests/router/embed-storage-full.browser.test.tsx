import type { MediaPlayerLocalOptions } from '@banou/media-player'
import type { TorrentSnapshot } from '../../src/torrent/client'
import type { StorageFull } from '../../src/torrent/storage-budget'

import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { del } from 'idb-keyval'

const MAGNET = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Film'
const FILE = { path: 'Film.mkv', size: 3_000_000_000, offset: 0, pad: false }

const seen: Partial<MediaPlayerLocalOptions>[] = []
vi.mock('@banou/media-player', () => ({
  MediaPlayer: (props: Partial<MediaPlayerLocalOptions>) => {
    seen.push(props)
    return props.overlay ?? null
  },
}))

const env = vi.hoisted(() => ({
  framed: true,
  state: null as null | ((snaps: TorrentSnapshot[]) => void),
  full: null as null | ((full: StorageFull) => void),
  available: false,
  account: null as string | null,
  files: new Map<string, string>(),
}))

vi.mock('@fkn/lib', () => ({
  account: {
    info: async () => (env.account ? { name: env.account, image: null, premium: false, premiumUntil: null } : null),
    onChange: async () => () => {},
  },
  cloud: {
    fs: {
      available: async () => env.available,
      isNotFound: (err: unknown) => (err as { code?: string } | null)?.code === 'FKN_STORAGE_NOT_FOUND',
      promises: {
        readFile: async (path: string) => {
          const hit = env.files.get(path)
          if (hit === undefined) throw Object.assign(new Error('Not found'), { code: 'FKN_STORAGE_NOT_FOUND' })
          return hit
        },
        writeFile: async (path: string, data: string) => { env.files.set(path, data) },
      },
    },
  },
}))

vi.mock('../../src/utils/framed', () => ({ isFramed: () => env.framed }))
vi.mock('../../src/torrent/use-reachability', () => ({ useReachability: () => null, useEngineTransport: () => null }))
vi.mock('../../src/torrent/use-quota', () => ({ useQuota: () => null }))
vi.mock('../../src/router/embedder', () => ({ useEmbedder: () => {}, tellPicked: () => {} }))
vi.mock('../../src/torrent/client', () => ({
  getTorrentClient: () => ({
    newViewerId: () => 'v1',
    addMagnet: () => {},
    onStorageUnavailable: () => () => {},
    onWorkerError: () => () => {},
    onStorageFull: (cb: NonNullable<typeof env.full>) => { env.full = cb; return () => {} },
    onState: (cb: NonNullable<typeof env.state>) => { env.state = cb; return () => {} },
    onEngineReset: () => () => {},
    watch: () => {},
    unwatch: () => {},
  }),
  setVpn: () => {},
}))

const film = (ephemeral: boolean): TorrentSnapshot => ({
  handle: 2,
  magnet: MAGNET,
  files: { storageIndex: 2, pieceLength: 1 << 20, numPieces: 3000, totalSize: FILE.size, contentSize: FILE.size, files: [FILE] },
  status: { numPeers: 4, numSeeds: 2, uploadRate: 0, downloadRate: 0, totalDone: 0, progress: 0, state: 3, paused: false, autoManaged: true, errorCode: 0, error: '' },
  bitfield: null,
  recovery: null,
  userPaused: false,
  windowed: ephemeral,
  ephemeral,
  swarmDownloads: -1,
  displayDownloadRate: 0,
} as unknown as TorrentSnapshot)

const mount = async () => {
  seen.length = 0
  const { default: Embed } = await import('../../src/router/embed')
  const { IntlRoot } = await import('../../src/i18n')
  return render(
    <IntlRoot>
      <MemoryRouter initialEntries={[`/watch?magnet=${btoa(MAGNET)}&fileIndex=0`]}>
        <Embed />
      </MemoryRouter>
    </IntlRoot>,
  )
}

const latest = () => seen[seen.length - 1]!

afterEach(async () => {
  env.framed = true
  env.available = false
  env.account = null
  env.files.clear()
  localStorage.clear()
  const { SETTINGS_SYNC_KEY } = await import('../../src/torrent/settings-sync')
  await del(SETTINGS_SYNC_KEY).catch(() => {})
})

it('keeps a framed temporary film\'s source when only the person\'s own downloads are out of room', async () => {
  const screen = await mount()
  await expect.poll(() => typeof env.state).toBe('function')
  env.state!([film(true)])
  env.full!('kept')
  await expect.poll(() => latest()?.size).toBe(FILE.size)
  expect(typeof latest().read).toBe('function')
  expect(screen.container.querySelector('.loading-information')?.textContent).toBe('Streams as you watch')

  // THE CONTROL: once the temporary film itself has no room, the frame drops its source
  env.full!(true)
  await expect.poll(() => latest()?.size).toBeUndefined()
  expect(latest().read).toBeUndefined()
  expect(screen.container.querySelector('.loading-information')?.textContent)
    .toBe("Too big for this browser's storage here. Open it in Ripple to play it.")

  // a torrent the person keeps is stopped by 'kept' too
  env.full!('kept')
  env.state!([film(false)])
  await expect.poll(() => screen.container.querySelector('.loading-information')?.textContent)
    .toBe("Too big for this browser's storage here. Open it in Ripple to play it.")
  expect(latest().size).toBeUndefined()
  await screen.unmount()

  // unframed, a kept torrent stopped at the reserve shows the Ripple room line
  env.framed = false
  const tab = await mount()
  env.state!([film(false)])
  env.full!('kept')
  await expect.element(tab.getByText('Out of storage space. Remove a download in Ripple to free room.')).toBeInTheDocument()
  await tab.unmount()
})

it('keeps session alwaysShowSubtitles when a remote subtitleLanguage update arrives', async () => {
  const screen = await mount()
  try {
    await expect.poll(() => typeof env.state).toBe('function')
    env.state!([film(true)])
    await expect.poll(() => typeof latest()?.onAlwaysShowSubtitlesChange).toBe('function')
    latest().onAlwaysShowSubtitlesChange!(false)
    await expect.poll(() => latest().alwaysShowSubtitles).toBe(false)

    const { SETTINGS_SYNC_PATH, syncSettings } = await import('../../src/torrent/settings-sync')
    env.available = true
    env.account = 'alice'
    env.files.set(SETTINGS_SYNC_PATH, JSON.stringify({
      subtitleLanguage: { value: 'ja', updatedAt: Date.now() + 10_000 },
    }))
    expect(await syncSettings()).toBe('synced')

    await expect.poll(() => latest().preferredSubtitleLanguage).toBe('ja')
    expect(latest().alwaysShowSubtitles).toBe(false)
  } finally {
    await screen.unmount()
  }
})
