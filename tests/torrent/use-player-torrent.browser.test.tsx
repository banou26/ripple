import type { TorrentSnapshot } from '../../src/torrent/client'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { ENGINE_CHANGE_MS, usePlayerTorrent } from '../../src/torrent/use-player-torrent'
import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

const listeners = vi.hoisted(() => ({
  state: (_: TorrentSnapshot[]) => {},
  reset: () => {},
  watch: vi.fn(),
  unwatch: vi.fn(),
  read: vi.fn(),
  add: vi.fn(),
  unavailable: null as null | (() => void),
  failed: null as null | ((error: { message: string, fatal: boolean }) => void),
}))
vi.mock('../../src/torrent/client', () => ({
  getTorrentClient: () => client,
}))
const client = {
  newViewerId: () => 'player',
  addMagnet: listeners.add,
  onStorageUnavailable: (cb: () => void) => { listeners.unavailable = cb; return () => {} },
  onWorkerError: (cb: NonNullable<typeof listeners.failed>) => { listeners.failed = cb; return () => {} },
  onStorageFull: () => () => {},
  onState: (cb: typeof listeners.state) => { listeners.state = cb; return () => {} },
  onEngineReset: (cb: typeof listeners.reset) => { listeners.reset = cb; return () => {} },
  watch: listeners.watch,
  unwatch: listeners.unwatch,
  read: listeners.read,
}
const MAGNET = `magnet:?xt=urn:btih:${'a'.repeat(40)}`
// a malformed hash, and two torrents in one link
const UNREADABLE = ['magnet:?xt=urn:btih:08ada5a7', `magnet:?xt=urn:btih:${'1a'.repeat(20)}&xt.1=urn:btih:${'2b'.repeat(20)}`]
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

// the engine tells every tab it refused a link, and an open library shows that
it('sends the engine no link it cannot add, and says that link cannot be read', async () => {
  listeners.add.mockClear()
  const Shown = ({ magnet }: { magnet?: string }) => <p>{`unreadable ${usePlayerTorrent(magnet, undefined).unreadable}`}</p>
  const screen = await render(<Shown />)
  await expect.element(screen.getByText('unreadable true')).toBeInTheDocument()
  for (const magnet of UNREADABLE) {
    await screen.rerender(<Shown magnet={magnet} />)
    await expect.element(screen.getByText('unreadable true'), { message: magnet }).toBeInTheDocument()
  }

  // THE CONTROL: a link it can read is added, and by then each link before it has been through the hook's effect
  await screen.rerender(<Shown magnet={MAGNET} />)
  await expect.element(screen.getByText('unreadable false')).toBeInTheDocument()
  await expect.poll(() => listeners.add.mock.calls).toEqual([[MAGNET, { ephemeral: true }]])
  await screen.unmount()
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
    { path: 'Feature/Feature.Extra.SP01.mkv', size: 200_000_000, offset: 0, pad: false },
    { path: 'Feature/Feature.mkv', size: 2_000_000_000, offset: 200_000_000, pad: false },
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

/*
 * A change of engine under a player: the VPN switched, an update, another tab taking the engine over. A read
 * that fails is an error the player draws over the picture and keeps in its list, so a read outlives the
 * change: it waits for the next engine to list the torrent and is asked of that one.
 */
describe('a read across a change of engine', () => {
  let reader: ReturnType<typeof usePlayerTorrent>
  const Reader = () => {
    reader = usePlayerTorrent(MAGNET, 0)
    return <div />
  }
  const listed = (handle: number) => listeners.state([{ handle, magnet: MAGNET, files: RELEASE } as TorrentSnapshot])
  // what an engine answers: the bytes asked for, each one its handle
  const answer = async (handle: number, _file: number, _offset: number, length: number) => new Uint8Array(length).fill(handle)
  const pause = () => new Promise((resolve) => setTimeout(resolve, 20))

  afterEach(() => { vi.useRealTimers() })

  it('asks the next engine for a read the engine was replaced under, and for one asked in between', async () => {
    listeners.read.mockReset()
    const screen = await render(<Reader />)
    listed(7)

    let fail = (_: Error) => {}
    listeners.read.mockImplementationOnce(() => new Promise<Uint8Array>((_, reject) => { fail = reject }))
    const under = reader.read(0, 100)
    await expect.poll(() => listeners.read.mock.calls).toEqual([[7, 0, 0, 100, true, 'player']])
    // as the client does when it replaces its engine: the reset, and every read it had is rejected
    listeners.reset()
    fail(new Error('the engine behind this tab was replaced'))
    const between = reader.read(100, 50)
    await pause()
    expect(listeners.read, 'a read was asked of an engine that is gone').toHaveBeenCalledTimes(1)

    listeners.read.mockImplementation(answer)
    // the next engine lists the torrent before it knows its files, and refuses a read until it does
    listeners.state([{ handle: 7, magnet: MAGNET, files: null } as TorrentSnapshot])
    const early = reader.read(150, 10)
    await pause()
    expect(listeners.read, 'a read was asked of an engine that does not know the files yet').toHaveBeenCalledTimes(1)
    // it numbers its torrents from one again, so the handle alone says nothing
    listed(7)
    expect(new Uint8Array(await under)).toEqual(new Uint8Array(100).fill(7))
    expect(new Uint8Array(await between)).toEqual(new Uint8Array(50).fill(7))
    expect(new Uint8Array(await early)).toEqual(new Uint8Array(10).fill(7))
    // each asked once of the new engine, in whichever order they came to wait
    expect(listeners.read.mock.calls.slice(1)).toHaveLength(3)
    expect(listeners.read.mock.calls.slice(1)).toEqual(expect.arrayContaining([[7, 0, 0, 100, true, 'player'], [7, 0, 100, 50, true, 'player'], [7, 0, 150, 10, true, 'player']]))
    await screen.unmount()
  })

  // THE CONTROL: with no change of engine a failed read fails, as it has to for the player to say so
  it('still fails a read the engine could not answer', async () => {
    listeners.read.mockReset()
    const screen = await render(<Reader />)
    listed(7)
    listeners.read.mockRejectedValueOnce(new Error('read timed out after 240000ms'))
    await expect(reader.read(0, 100)).rejects.toThrow('read timed out after 240000ms')
    expect(listeners.read).toHaveBeenCalledTimes(1)
    await screen.unmount()
  })

  it('gives a read up when no engine lists the torrent again', async () => {
    listeners.read.mockReset()
    const screen = await render(<Reader />)
    listed(7)
    listeners.reset()
    vi.useFakeTimers()
    const waiting = reader.read(0, 100)
    const outcome = vi.fn()
    void waiting.then(outcome, outcome)
    await vi.advanceTimersByTimeAsync(ENGINE_CHANGE_MS - 1)
    expect(outcome, 'given up before an engine had the time to start').not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(waiting).rejects.toThrow('torrent not ready')
    expect(listeners.read).not.toHaveBeenCalled()
    await screen.unmount()
  })
})

// an engine that has just started lists a restored torrent before it knows its files
it('keeps the layout of its torrent through an engine that does not know it yet, and of no other torrent', async () => {
  listeners.watch.mockClear()
  const Shown = ({ magnet }: { magnet: string }) => {
    const { snapshot, fileIndex } = usePlayerTorrent(magnet, undefined)
    return <div data-testid="shown">{`file ${fileIndex} of ${snapshot?.files?.files.length ?? 'none'}`}</div>
  }
  const screen = await render(<Shown magnet={MAGNET} />)
  listeners.state([{ handle: 7, magnet: MAGNET, files: RELEASE } as TorrentSnapshot])
  await expect.element(screen.getByTestId('shown')).toHaveTextContent('file 1 of 2')

  listeners.reset()
  listeners.state([{ handle: 1, magnet: MAGNET, files: null } as TorrentSnapshot])
  await new Promise((resolve) => setTimeout(resolve, 50))
  await expect.element(screen.getByTestId('shown')).toHaveTextContent('file 1 of 2')
  // the film is claimed in the new engine at once, not the first file until the layout lands
  expect(listeners.watch).toHaveBeenLastCalledWith('player', 1, 1)

  // THE CONTROL: another torrent starts with no layout, whatever the last one had
  const other = `magnet:?xt=urn:btih:${'b'.repeat(40)}`
  await screen.rerender(<Shown magnet={other} />)
  listeners.state([{ handle: 2, magnet: other, files: null } as TorrentSnapshot])
  await expect.element(screen.getByTestId('shown')).toHaveTextContent('file 0 of none')
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
