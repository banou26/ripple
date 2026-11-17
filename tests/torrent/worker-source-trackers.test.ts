// A torrent made from the person's own files keeps no resume data, so the trackers added to it are kept apart, given
// back to the engine each time the page starts it again, and dropped with the torrent.
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const SOURCE = 'd'.repeat(40)
const OTHER = 'e'.repeat(40)
const PLAIN = 'a'.repeat(40)
const KEPT = 'udp://kept.invalid:6969/announce'

const engine = vi.hoisted(() => ({ ids: new Map<string, number>(), log: [] as string[] }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { DOWNLOADING, fakeSession } = await import('../utils/worker-rig')
  const add = (key: string) => {
    const h = engine.ids.size + 1
    engine.ids.set(key, h)
    return h
  }
  return {
    createSession: async () => fakeSession({
      addMagnet: (magnet: string) => add(magnet),
      addTorrentFile: (_: Uint8Array, savePath: string) => add(savePath),
      status: () => DOWNLOADING,
      saveResumeData: async () => new Uint8Array([1]),
      addTrackers: (h: number, urls: string[]) => {
        engine.log.push(`add ${h} ${urls.join(' ')}`)
        return urls.filter((url) => !url.includes('://'))
      },
    }),
    PRIORITY: { skip: 0, normal: 4, top: 7 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const entry = (infoHash: string): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/source/' + infoHash, saveTo: 'source', addedAt: 1, started: true, paused: false,
  })
  store.set('ripple:torrents', [entry(SOURCE), entry(OTHER)])
  store.set('ripple:torrent:' + SOURCE, new Uint8Array([1]))
  store.set('ripple:torrent:' + OTHER, new Uint8Array([1]))
  // added on an earlier load
  store.set('ripple:trackers:' + SOURCE, [KEPT])
  store.set('ripple:trackers:' + OTHER, [KEPT])
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

it('gives a created torrent the trackers added to it on an earlier load, keeps new ones, and drops them with it', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  rig.send({ type: 'start-source', infoHash: SOURCE, handles: [{ name: 'Film.mkv' }] })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  const source = engine.ids.get('/source/' + SOURCE)!
  expect(engine.log, 'the reload lost the trackers added to it').toEqual([`add ${source} ${KEPT}`])

  rig.send({ type: 'add-trackers', id: 4, handle: source, urls: ['wss://new.invalid', 'just words', KEPT] })
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 4, value: ['just words'] }]))
  expect(store.get('ripple:trackers:' + SOURCE), 'a tracker added now would not outlive the reload').toEqual([KEPT, 'wss://new.invalid'])

  // THE CONTROL: a download keeps its added trackers in its resume data, not here
  rig.send({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:' + PLAIN })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(2))
  rig.send({ type: 'add-trackers', id: 5, handle: engine.ids.get('magnet:?xt=urn:btih:' + PLAIN), urls: ['wss://new.invalid'] })
  await vi.waitFor(() => expect(rig.of('answer')).toHaveLength(2))
  expect(store.has('ripple:trackers:' + PLAIN)).toBe(false)

  rig.send({ type: 'remove', handle: source })
  await vi.waitFor(() => expect(store.has('ripple:torrent:' + SOURCE)).toBe(false))
  expect(store.has('ripple:trackers:' + SOURCE), 'a removed torrent left its trackers behind').toBe(false)

  rig.send({ type: 'clear-list' })
  await vi.waitFor(() => expect(store.has('ripple:torrent:' + OTHER)).toBe(false))
  expect(store.has('ripple:trackers:' + OTHER), 'a cleared list left a torrent\'s trackers behind').toBe(false)
  expect([...rig.of('worker-error'), ...rig.of('error'), ...rig.of('add-failed')]).toEqual([])
})
