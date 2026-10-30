import type { TorrentSnapshot } from '../../src/torrent/client'
import type { Prepared } from '../../src/torrent/use-prepare'

import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'

import { usePrepare } from '../../src/torrent/use-prepare'

const calls = vi.hoisted(() => ({
  state: (_: TorrentSnapshot[]) => {},
  addMagnet: vi.fn(),
  prepare: vi.fn(),
  unwatch: vi.fn(),
}))
vi.mock('../../src/torrent/client', () => ({ getTorrentClient: () => client }))
const client = {
  newViewerId: () => 'next',
  addMagnet: calls.addMagnet,
  onState: (cb: typeof calls.state) => { calls.state = cb; return () => {} },
  onEngineReset: () => () => {},
  prepare: calls.prepare,
  unwatch: calls.unwatch,
}
const PACK = `magnet:?xt=urn:btih:${'a'.repeat(40)}`
const FILM = `magnet:?xt=urn:btih:${'b'.repeat(40)}`
const layout = (sizes: number[]) => ({
  storageIndex: 0, pieceLength: 1 << 20, numPieces: 100, totalSize: 0, contentSize: 0,
  files: sizes.map((size, i) => ({ path: `f${i}.${i ? 'mkv' : 'nfo'}`, size, offset: 0, pad: false })),
})

let ask: (next: Prepared) => void = () => {}
const Harness = () => {
  ask = usePrepare()
  return <div />
}

it('adds the torrent held and claims the file once its layout lands, until the next is asked or the page goes', async () => {
  const screen = await render(<Harness />)
  ask({ magnet: PACK, fileIndex: 3 })
  await vi.waitFor(() => expect(calls.addMagnet).toHaveBeenCalledExactlyOnceWith(PACK, { ephemeral: true, hold: true }))
  calls.state([{ handle: 4, magnet: PACK, files: null } as TorrentSnapshot])
  expect(calls.prepare).not.toHaveBeenCalled()
  calls.state([{ handle: 4, magnet: PACK, files: layout([10, 20, 30, 40]) } as unknown as TorrentSnapshot])
  calls.state([{ handle: 4, magnet: PACK, files: layout([10, 20, 30, 40]) } as unknown as TorrentSnapshot])
  expect(calls.prepare).toHaveBeenCalledExactlyOnceWith('next', 4, 3)

  // with no file named, the torrent's video file, not its first
  ask({ magnet: FILM })
  await vi.waitFor(() => expect(calls.unwatch).toHaveBeenCalledWith('next'))
  calls.state([{ handle: 5, magnet: FILM, files: layout([1, 900]) } as unknown as TorrentSnapshot])
  expect(calls.prepare).toHaveBeenLastCalledWith('next', 5, 1)

  await screen.unmount()
  expect(calls.unwatch).toHaveBeenCalledTimes(2)
})
