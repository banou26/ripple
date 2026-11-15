import type { TorrentSnapshot } from '../../src/torrent/client'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

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
/** Every magnet the hook handed the engine to add. */
const added: string[] = []
let emit: ((snapshots: TorrentSnapshot[]) => void) | null = null
/** What the engine says went wrong, as the client hands it to the hook. */
const engine = {
  unavailable: null as null | (() => void),
  failed: null as null | ((error: { message: string, fatal: boolean }) => void),
}

const client = {
  onStorageUnavailable: (cb: () => void) => { engine.unavailable = cb; return () => {} },
  onWorkerError: (cb: (error: { message: string, fatal: boolean }) => void) => { engine.failed = cb; return () => {} },
  onStorageFull: () => () => {},
  onEngineReset: () => () => {},
  onState: (cb: (snapshots: TorrentSnapshot[]) => void) => { emit = cb; return () => {} },
  addMagnet: (magnet: string) => { added.push(magnet) },
  newViewerId: () => 'viewer-1',
  watch: (...args: unknown[]) => { watched.push(args) },
  unwatch: () => {},
}

vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))

const MAGNET = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=Pack.Name`
// a malformed hash, and two torrents in one link
const UNREADABLE = ['magnet:?xt=urn:btih:08ada5a7', `magnet:?xt=urn:btih:${'1a'.repeat(20)}&xt.1=urn:btih:${'2b'.repeat(20)}`]

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
    added.length = 0
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

  // the engine tells every tab it refused a link, and an open library shows that
  it('sends the engine no link it cannot add, and says that link cannot be read', async () => {
    const Shown = ({ magnet }: { magnet?: string }) => <p>{`unreadable ${api.useDownloadTorrent(magnet).unreadable}`}</p>
    const screen = await render(<Shown/>)
    await expect.element(screen.getByText('unreadable true')).toBeInTheDocument()
    for (const magnet of UNREADABLE) {
      await screen.rerender(<Shown magnet={magnet}/>)
      await expect.element(screen.getByText('unreadable true'), { message: magnet }).toBeInTheDocument()
    }

    // THE CONTROL: a link it can read is added, and by then each link before it has been through the hook's effect
    await screen.rerender(<Shown magnet={MAGNET}/>)
    await expect.element(screen.getByText('unreadable false')).toBeInTheDocument()
    await expect.poll(() => added).toEqual([MAGNET])
    await screen.unmount()
  })

  it('holds the torrent a link names in base32 when the engine lists it in hex', async () => {
    // MAGNET's hash, in base32
    const Spelled = () => { api.useDownloadTorrent(`magnet:?xt=urn:btih:${'VK'.repeat(16)}`); return <div/> }
    const screen = await render(<Spelled/>)
    await expect.poll(() => typeof emit).toBe('function')
    emit!([{ ...snapshot(), handle: 3, magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}` }, snapshot()])
    await expect.poll(() => watched).toEqual([['viewer-1', 7, 0, 0, undefined, true]])
    await screen.unmount()
  })

  /** An index the torrent does not have plans NOTHING in the engine, so it is clamped rather than sent. */
  it('clamps a claim to a file the torrent actually has', async () => {
    const page = await mounted()
    page.claim(9)
    expect(watched[1]).toEqual(['viewer-1', 7, 0, undefined, undefined, false, true])
  })
})

describe('the download page hook\'s words', () => {
  afterEach(showEnglish)

  const Shown = () => <p>{api.useDownloadTorrent(MAGNET).engineError}</p>

  /** What the hook says when the engine has no storage, then when it stops for good. */
  const said = async () => {
    api.useDownloadTorrent = (await import('../../src/torrent/use-download-torrent')).useDownloadTorrent
    const words: string[] = []
    for (const fail of [() => engine.unavailable!(), () => engine.failed!({ message: 'gone', fatal: true })]) {
      engine.unavailable = null
      engine.failed = null
      const screen = await render(<Shown/>)
      await expect.poll(() => engine.unavailable && engine.failed).toBeTruthy()
      fail()
      await expect.poll(() => screen.container.textContent).toBeTruthy()
      words.push(screen.container.textContent)
      await screen.unmount()
    }
    return words
  }

  it('says what stopped the engine in the page\'s language', async () => {
    expect(await said()).toEqual(['Ripple needs a normal (non-private) window to download this', 'The download engine stopped. Reload the page to try again.'])
    await showIn('de', de, 'de-DE')
    expect(await said()).toEqual([
      'Ripple braucht ein normales (nicht privates) Fenster, um das herunterzuladen',
      'Die Download-Engine wurde beendet. Lade die Seite neu, um es erneut zu versuchen.',
    ])
  })
})
