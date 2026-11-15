// A .torrent added from the add dialog starts as it was asked to, held until then: its left-out files skipped, in order,
// paused, first in the queue, and all of it stored with its entry. The handle exists only once this add runs, so nothing
// sent after it could do this, and an add with no answers is left as it always was.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const MiB = 1024 * 1024
const ASKED = 'a'.repeat(40)
const PLAIN = 'b'.repeat(40)
const STOPPED = 'c'.repeat(40)
const SEQUENTIAL = 4

// what the engine was told, by handle
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
      // handles count from 1, so each add answers with its own hash on the first poll
      infohash: (handle: number) => [ASKED, PLAIN, STOPPED][handle - 1] ?? null,
      infohashV2: () => null,
      status: () => DOWNLOADING,
      files: () => layout,
      clearStreamWindow: () => {},
      saveResumeData: async () => new Uint8Array([1]),
      prioritizePieces: (handle: number, map: Uint8Array) => { log.push(`${handle} pieces ${[...map].join('')}`) },
      setFlags: (handle: number, flags: number, mask: number) => { log.push(`${handle} flags ${flags} ${mask}`) },
      pauseTorrent: (handle: number) => { log.push(`${handle} pause`) },
      moveInQueue: (handle: number, where: string) => { log.push(`${handle} queue ${where}`) },
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1, sequentialDownload: SEQUENTIAL },
  }
})
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value) },
  del: async (key: string) => { store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
}))

const entry = (hash: string) => (store.get('ripple:torrents') as Persisted[] | undefined)?.find((e) => e.infoHash === hash)
const told = (handle: number) => log.filter((line) => line.startsWith(`${handle} `)).map((line) => line.slice(2))

it('skips the files left out, in order, paused and first in the queue, as stored with its entry', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([1]), wanted: [0], firstLast: true, sequential: true, paused: true, top: true })
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([2]) })
  // every file wanted, only not started
  rig.send({ type: 'add-torrent-file', bytes: new Uint8Array([3]), firstLast: false, sequential: false, paused: true, top: false })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(3))
  await vi.waitFor(() => expect(told(1)).toContainEqual(expect.stringMatching(/^pieces 7+4+7+0{10}$/u)))
  await vi.waitFor(() => expect(told(1)).toContain('pause'))
  await vi.waitFor(() => expect(told(3)).toContain('pause'))

  // held in upload mode from the add until the pump has written the plan, then let go
  expect(told(1)[0]).toBe('flags 1 1')
  await vi.waitFor(() => expect(told(1)).toContain('flags 0 1'))
  expect(told(1).indexOf('flags 0 1')).toBeGreaterThan(told(1).findIndex((line) => line.startsWith('pieces')))
  expect(told(3).slice(0, 3)).toEqual(['flags 1 1', 'flags 0 1', 'pause'])
  expect(entry(STOPPED)).toMatchObject({ paused: true })
  expect(entry(STOPPED)?.wantedFiles).toBeUndefined()
  expect(told(2)).not.toContain('flags 1 1')
  expect(told(1)).toContain(`flags ${SEQUENTIAL} ${SEQUENTIAL}`)
  expect(told(1)).toContain('queue top')
  expect(entry(ASKED)).toMatchObject({ wantedFiles: [0], firstLast: true, paused: true })
  // the control: an add with no answers is written nothing of them, and runs
  expect(told(2).filter((line) => !line.startsWith('flags 0 1'))).toEqual([])
  expect(entry(PLAIN)).toMatchObject({ paused: false })
  expect(entry(PLAIN)?.wantedFiles).toBeUndefined()
  expect([...rig.of('worker-error'), ...rig.of('error')]).toEqual([])
})
