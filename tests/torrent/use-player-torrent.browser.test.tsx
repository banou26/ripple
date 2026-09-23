import type { TorrentSnapshot } from '../../src/torrent/client'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { usePlayerTorrent } from '../../src/torrent/use-player-torrent'

const listeners = vi.hoisted(() => ({
  state: (_: TorrentSnapshot[]) => {},
  reset: () => {},
  watch: vi.fn(),
  unwatch: vi.fn(),
}))
vi.mock('../../src/torrent/client', () => ({
  getTorrentClient: () => client,
}))
const client = {
  newViewerId: () => 'player',
  addMagnet: () => {},
  onStorageUnavailable: () => () => {},
  onWorkerError: () => () => {},
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
