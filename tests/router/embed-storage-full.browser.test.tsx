import type { MediaPlayerLocalOptions } from '@banou/media-player'
import type { TorrentSnapshot } from '../../src/torrent/client'
import type { StorageFull } from '../../src/torrent/storage-budget'

import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

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

afterEach(() => { env.framed = true })

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
