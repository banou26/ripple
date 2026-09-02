import type { TorrentSnapshot } from '../../src/torrent/client'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

/**
 * What the download page's hook says to the ENGINE, which no test above it can see.
 *
 * `tests/router/download.browser.test.tsx` replaces this hook wholesale, so it can prove the page
 * calls `claim` and `release` and nothing at all about what those do. The whole of `release` is one
 * trailing argument: `held: true` is what keeps the entry out of `activeViewers`, and dropping it
 * turns "stop asking for bytes" into "ask for file 0 instead", which downloads a file nobody chose
 * after every single export. Nothing else in the suite would notice.
 */

/** Every client.watch call, exactly as the hook made it, arguments and all. */
const watched: unknown[][] = []
let emit: ((snapshots: TorrentSnapshot[]) => void) | null = null

const client = {
  onStorageUnavailable: () => () => {},
  onWorkerError: () => () => {},
  onStorageFull: () => () => {},
  onEngineReset: () => () => {},
  onState: (cb: (snapshots: TorrentSnapshot[]) => void) => { emit = cb; return () => {} },
  addMagnet: () => {},
  newViewerId: () => 'viewer-1',
  watch: (...args: unknown[]) => { watched.push(args) },
  unwatch: () => {},
}

vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

const MAGNET = 'magnet:?xt=urn:btih:abc&dn=Pack.Name'

const snapshot = () => ({
  handle: 7,
  magnet: MAGNET,
  files: {
    storageIndex: 0,
    pieceLength: 1 << 20,
    numPieces: 3,
    totalSize: 3_000_000,
    contentSize: 3_000_000,
    files: [
      { path: 'Pack/E01.mkv', size: 1_000_000, offset: 0, pad: false },
      { path: 'Pack/E02.mkv', size: 2_000_000, offset: 1_000_000, pad: false },
    ],
  },
  status: null,
  bitfield: null,
  recovery: null,
  userPaused: false,
} as unknown as TorrentSnapshot)

/** Exposes the hook's own functions to the test, since a hook cannot be called outside a render. */
const Harness = ({ onReady }: { onReady: (api: { claim: (i: number) => void, release: () => void }) => void }) => {
  const { useDownloadTorrent } = api
  const { claim, release, handle } = useDownloadTorrent(MAGNET)
  if (handle != null) onReady({ claim, release })
  return <div/>
}

// imported inside the component's module scope so the mock above is installed first
const api = { useDownloadTorrent: null as never as typeof import('../../src/torrent/use-download-torrent')['useDownloadTorrent'] }

describe('the download page hook', () => {
  beforeEach(async () => {
    watched.length = 0
    emit = null
    api.useDownloadTorrent = (await import('../../src/torrent/use-download-torrent')).useDownloadTorrent
  })

  /** Renders the hook, gives the engine a handle, and hands back what the page would be holding. */
  const mounted = async () => {
    const held: { current: { claim: (i: number) => void, release: () => void } | null } = { current: null }
    render(<Harness onReady={(a) => { held.current = a }}/>)
    // the subscription is made in an effect, so it exists a turn after the render returns
    await expect.poll(() => typeof emit).toBe('function')
    emit!([snapshot()])
    await expect.poll(() => watched.length).toBeGreaterThan(0)
    await expect.poll(() => held.current).not.toBeNull()
    return held.current!
  }

  it('holds on arrival, claims on demand, and holds again when released', async () => {
    const page = await mounted()

    /*
     * The arrival claim, and the trailing `true` is the entire point of it: a HELD claim tells the
     * storage budget somebody has this torrent on screen while asking for no bytes, so the page can
     * show a file list without starting a download.
     */
    expect(watched[0]).toEqual(['viewer-1', 7, 0, 0, undefined, true])

    page.claim(1)
    // an ACTIVE claim: held false, which is what makes the engine plan the swarm around this file,
    // and BULK true, which is what keeps piece deadlines off an export. The whole argument list is
    // asserted rather than a prefix: the two flags are adjacent booleans, and swapping them still
    // downloads the file correctly while quietly restoring every deadline and 61% of extra traffic.
    expect(watched[1]).toEqual(['viewer-1', 7, 1, undefined, undefined, false, true])

    page.release()
    expect(watched[2], 'release must hand back a HELD claim, not re-claim file 0').toEqual(
      ['viewer-1', 7, 0, 0, undefined, true],
    )
  })

  /** An index the torrent does not have plans NOTHING in the engine, so it is clamped rather than sent. */
  it('clamps a claim to a file the torrent actually has', async () => {
    const page = await mounted()
    page.claim(9)
    expect(watched[1]).toEqual(['viewer-1', 7, 0, undefined, undefined, false, true])
  })
})
