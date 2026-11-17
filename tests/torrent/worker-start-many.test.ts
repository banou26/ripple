import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * Download all of a group, and the bar's Download for many ticked rows, start every row in one command. The list is
 * read once, written once and posted once, with one state, so each tab draws the list once for all of them rather than
 * once per torrent. A row this device keeps a .torrent of starts from it, as a single Download does, and a created
 * source is refused alone.
 */

const ROWS = Array.from({ length: 20 }, (_, i) => (i + 1).toString(16).padStart(40, '0'))
const KEPT = ROWS[3]!
const SOURCE = 'e'.repeat(40)
const UNKNOWN = 'f'.repeat(40)
// asked in an order of the page's own, not the list's
const ASKED = [...ROWS].reverse()

const engine = vi.hoisted(() => ({ adds: [] as [string, string][], ticks: 0 }))
const io = vi.hoisted(() => ({ reads: 0, writes: 0 }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({
      addMagnet: (_magnet: string, savePath: string) => engine.adds.push(['magnet', savePath]),
      addTorrentFile: (_bytes: Uint8Array, savePath: string) => engine.adds.push(['file', savePath]),
      // once per tick, which posts a state of its own
      popAlerts: () => { engine.ticks++; return [] },
    }),
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const row = (infoHash: string, over: Partial<Persisted> = {}): Persisted => ({
    infoHash, magnet: 'magnet:?xt=urn:btih:' + infoHash, savePath: '/dl/' + infoHash, addedAt: 1, started: false, ephemeral: false, ...over,
  })
  store.set('ripple:torrents', [...ROWS.map((infoHash) => row(infoHash)), row(SOURCE, { savePath: '/source/' + SOURCE, saveTo: 'source' })])
  store.set('ripple:torrent:' + KEPT, new Uint8Array([1, 2, 3]))
  return {
    get: async (key: string) => { if (key === 'ripple:torrents') io.reads++; return store.get(key) },
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => {
      if (key === 'ripple:torrents') io.writes++
      store.set(key, fn(store.get(key)))
    },
  }
})

const entryOf = (infoHash: string) => (store.get('ripple:torrents') as Persisted[]).find((e) => e.infoHash === infoHash)

it('starts every row asked for with one read of the list, one write, one state and one list', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  const from = rig.posted.length
  const [reads, writes, ticks] = [io.reads, io.writes, engine.ticks]

  rig.send({ type: 'start-many', id: 7, infoHashes: [...ASKED, SOURCE, UNKNOWN] })
  // answered on arrival, before the work, so a page can tell this engine from an older one, which drops the command
  expect(rig.posted.slice(from)).toEqual([{ type: 'answer', id: 7, value: true }])

  await vi.waitFor(() => expect(ROWS.filter((infoHash) => !entryOf(infoHash)?.started)).toEqual([]))
  const posted = rig.posted.slice(from)
  expect(posted.filter((m) => m.type === 'list')).toHaveLength(1)
  expect(io.reads - reads).toBe(1)
  expect(io.writes - writes).toBe(1)
  expect(posted.filter((m) => m.type === 'state').length - (engine.ticks - ticks)).toBe(1)

  // in the order asked, the kept .torrent's row from its file
  expect(engine.adds).toEqual(ASKED.map((infoHash) => [infoHash === KEPT ? 'file' : 'magnet', '/dl/' + infoHash]))
  expect(entryOf(ROWS[0]!)).toMatchObject({ started: true, paused: false, ephemeral: false, savePath: '/dl/' + ROWS[0] })
  // a created source has nothing to download it from, and is refused on its own
  expect(posted.filter((m) => m.type === 'add-failed')).toEqual([
    { type: 'add-failed', message: { message: 'Nothing to download this from. Create it again from the same files.' } },
  ])
  expect(entryOf(SOURCE)?.started).toBe(false)
}, 20_000)
