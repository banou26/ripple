// A torrent client whose engine is the test: what the page sends lands in `posted`, and `say` speaks for the engine.
import type { Persisted, TorrentClient } from '../../src/torrent/client'

type Real = typeof import('../../src/torrent/client')

export type EngineDouble = {
  client: TorrentClient
  posted: { type: string, [key: string]: unknown }[]
  say: (msg: object) => void
  /** Whether a page made the client, which `runningTorrentClient` answers. */
  running: boolean
  /** Attaches the fake transport without emitting ready, list or state yet. */
  attach: (owns?: boolean) => void
  /** Starts a fresh engine in this tab, owning it or not, with `list` and a state of `live`. */
  start: (list: Persisted[], live?: { handle: number, magnet: string }[], owns?: boolean) => void
}

export const engineDouble = (real: Real): EngineDouble => {
  const client = real.createTorrentClient()
  const attach = (owns = true) => {
    client.useTransport((host) => {
      engine.say = (msg) => host.message(msg)
      return { post: (msg) => { engine.posted.push(msg) }, destroy: () => {}, pending: () => [] }
    }, owns)
  }
  const engine: EngineDouble = {
    client,
    posted: [],
    say: () => {},
    running: true,
    attach,
    start: (list, live = [], owns = true) => {
      attach(owns)
      engine.say({ type: 'ready' })
      engine.say({ type: 'list', list })
      engine.say({ type: 'state', torrents: live.map(snapshot) })
    },
  }
  return engine
}

/** What the engine reports for a torrent it runs, with nothing measured yet. */
export const snapshot = ({ handle, magnet }: { handle: number, magnet: string }) => ({
  handle, magnet, files: null, status: null, bitfield: null, recovery: null, userPaused: false, windowed: false,
  swarmDownloads: -1, uptime: { activeSeconds: 0, seedingSeconds: 0 }, sessionUptime: { activeSeconds: 0, seedingSeconds: 0 },
  totals: { downloaded: 0, uploaded: 0, wasted: 0 },
})

export const entry = (infoHash: string, over: Partial<Persisted> = {}): Persisted =>
  ({ infoHash, magnet: `magnet:?xt=urn:btih:${infoHash}`, savePath: `/dl/${infoHash}`, addedAt: 1, started: true, ...over })

/** An in-memory idb-keyval, the plugins' storage in these tests. */
export const memoryStore = () => {
  const store = new Map<string, unknown>()
  return {
    store,
    module: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => { store.set(key, value) },
      del: async (key: string) => { store.delete(key) },
      update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
    },
  }
}
