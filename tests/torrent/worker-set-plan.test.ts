// A file left out of a torrent's download and then ticked again downloads again: the plan back to every file reaches
// the engine, where it used to be skipped as a plan with nothing to say.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const HASH = 'a'.repeat(40)

// each clear of the stream window, and each map the engine was given as the priorities in it
const log = vi.hoisted(() => [] as string[])
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  // two files of 10 pieces each
  const layout = { storageIndex: 0, pieceLength: MiB, numPieces: 20, totalSize: 20 * MiB, contentSize: 20 * MiB, files: [
    { path: 'Pack/E01.mkv', offset: 0, size: 10 * MiB, pad: false },
    { path: 'Pack/E02.mkv', offset: 10 * MiB, size: 10 * MiB, pad: false },
  ] }
  return {
    createSession: async () => fakeSession({
      status: () => DOWNLOADING,
      files: () => layout,
      clearStreamWindow: () => { log.push('clear') },
      saveResumeData: async () => new Uint8Array([1]),
      prioritizePieces: (_h: number, map: Uint8Array) => { log.push([...new Set(map)].join(' ')) },
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const hash = 'a'.repeat(40)
  const entry: Persisted = { infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, savePath: `/dl/${hash}`, addedAt: 1, started: true, paused: false }
  store.set('ripple:torrents', [entry])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const entry = () => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === HASH)!

it('downloads a file again once it is ticked back', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  await vi.waitFor(() => expect(rig.of('state').at(-1)?.torrents).toHaveLength(1))
  const handle = (rig.of('state').at(-1)!.torrents as { handle: number }[])[0]!.handle
  // the restore clears the window, and a torrent with nothing chosen is given nothing past it
  await vi.waitFor(() => expect(log).toContain('clear'))
  expect(log).toEqual(['clear'])

  rig.send({ type: 'set-plan', handle, wanted: [0], firstLast: false })
  await vi.waitFor(() => expect(log.at(-1)).toBe('4 0'))
  await vi.waitFor(() => expect(entry().wantedFiles).toEqual([0]))

  rig.send({ type: 'set-plan', handle, firstLast: false })
  await vi.waitFor(() => expect(log.at(-1)).toBe('4'))
  await vi.waitFor(() => expect(entry().wantedFiles).toBeUndefined())
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
