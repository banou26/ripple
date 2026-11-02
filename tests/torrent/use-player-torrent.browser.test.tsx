import type { TorrentSnapshot } from '../../src/torrent/client'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { usePlayerTorrent } from '../../src/torrent/use-player-torrent'
import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

const listeners = vi.hoisted(() => ({
  state: (_: TorrentSnapshot[]) => {},
  reset: () => {},
  watch: vi.fn(),
  unwatch: vi.fn(),
  unavailable: null as null | (() => void),
  failed: null as null | ((error: { message: string, fatal: boolean }) => void),
}))
vi.mock('../../src/torrent/client', () => ({
  getTorrentClient: () => client,
}))
const client = {
  newViewerId: () => 'player',
  addMagnet: () => {},
  onStorageUnavailable: (cb: () => void) => { listeners.unavailable = cb; return () => {} },
  onWorkerError: (cb: NonNullable<typeof listeners.failed>) => { listeners.failed = cb; return () => {} },
  onStorageFull: () => () => {},
  onState: (cb: typeof listeners.state) => { listeners.state = cb; return () => {} },
  onEngineReset: (cb: typeof listeners.reset) => { listeners.reset = cb; return () => {} },
  watch: listeners.watch,
  unwatch: listeners.unwatch,
}
const MAGNET = `magnet:?xt=urn:btih:${'a'.repeat(40)}`
const Harness = ({ fileIndex = 1 }: { fileIndex?: number }) => {
  usePlayerTorrent(MAGNET, fileIndex)
  return <div />
}

it('claims before metadata, claims once per engine, and releases on file changes', async () => {
  const screen = await render(<Harness />)
  const snapshot = { handle: 7, magnet: MAGNET, files: null } as TorrentSnapshot
  listeners.state([snapshot])
  expect(listeners.watch).toHaveBeenCalledExactlyOnceWith('player', 7, 1)
  listeners.state([snapshot])
  expect(listeners.watch).toHaveBeenCalledTimes(1)

  listeners.reset()
  listeners.state([{ ...snapshot, handle: 8 }])
  expect(listeners.watch).toHaveBeenLastCalledWith('player', 8, 1)
  expect(listeners.watch).toHaveBeenCalledTimes(2)

  await screen.rerender(<Harness fileIndex={2} />)
  expect(listeners.unwatch).toHaveBeenCalledWith('player')
  listeners.state([{ ...snapshot, handle: 8 }])
  expect(listeners.watch).toHaveBeenLastCalledWith('player', 8, 2)
  await screen.unmount()
  expect(listeners.unwatch).toHaveBeenCalledTimes(2)
})

// a film release with a special ahead of the film, opened by a link that names no file, the way
// the stub plugin opens every release
const RELEASE = {
  storageIndex: 0,
  pieceLength: 1 << 20,
  numPieces: 2100,
  totalSize: 2_200_000_000,
  contentSize: 2_200_000_000,
  files: [
    { path: 'Promare/Promare.Galo.Hen.SP01.mkv', size: 200_000_000, offset: 0, pad: false },
    { path: 'Promare/Promare.mkv', size: 2_000_000_000, offset: 200_000_000, pad: false },
  ],
}

const Played = ({ fileIndex }: { fileIndex?: number }) => {
  const { fileIndex: played } = usePlayerTorrent(MAGNET, fileIndex)
  return <div data-testid="played">{played}</div>
}

it('plays the video file when the link names none, not the first file', async () => {
  listeners.watch.mockClear()
  const screen = await render(<Played />)
  const snapshot = { handle: 7, magnet: MAGNET, files: null } as TorrentSnapshot
  listeners.state([snapshot])
  // nothing says which file is the film until the layout lands, and a claim keeps the torrent alive
  expect(listeners.watch).toHaveBeenLastCalledWith('player', 7, 0)

  listeners.state([{ ...snapshot, files: RELEASE }])
  expect(listeners.watch).toHaveBeenLastCalledWith('player', 7, 1)
  await expect.element(screen.getByTestId('played')).toHaveTextContent('1')
  listeners.state([{ ...snapshot, files: RELEASE }])
  expect(listeners.watch).toHaveBeenCalledTimes(2)
  await screen.unmount()
})

it('plays the file a link names, even when another one is bigger', async () => {
  listeners.watch.mockClear()
  const screen = await render(<Played fileIndex={0} />)
  listeners.state([{ handle: 7, magnet: MAGNET, files: RELEASE } as TorrentSnapshot])
  expect(listeners.watch).toHaveBeenCalledExactlyOnceWith('player', 7, 0)
  await expect.element(screen.getByTestId('played')).toHaveTextContent('0')
  await screen.unmount()
})

describe('the player hook\'s words', () => {
  afterEach(showEnglish)

  const Shown = () => <p>{usePlayerTorrent(MAGNET, 0).engineError}</p>

  /** What the hook says when the engine has no storage, then when it stops for good. */
  const said = async () => {
    const words: string[] = []
    for (const fail of [() => listeners.unavailable!(), () => listeners.failed!({ message: 'gone', fatal: true })]) {
      listeners.unavailable = null
      listeners.failed = null
      const screen = await render(<Shown/>)
      await expect.poll(() => listeners.unavailable && listeners.failed).toBeTruthy()
      fail()
      await expect.poll(() => screen.container.textContent).toBeTruthy()
      words.push(screen.container.textContent)
      await screen.unmount()
    }
    return words
  }

  it('says what stopped the engine in the page\'s language', async () => {
    expect(await said()).toEqual(['Ripple needs a normal (non-private) window to play this', 'The download engine stopped. Reload the page to try again.'])
    await showIn('de', de, 'de-DE')
    expect(await said()).toEqual([
      'Ripple braucht ein normales (nicht privates) Fenster, um das abzuspielen',
      'Die Download-Engine wurde beendet. Lade die Seite neu, um es erneut zu versuchen.',
    ])
  })
})
