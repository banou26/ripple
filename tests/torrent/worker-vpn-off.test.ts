// With the VPN off the engine has no relay behind it: every peer is a WebRTC peer the page connects, found
// through trackers opened with the browser's own WebSocket.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'
import { TRACKERS } from '../../src/torrent/vpn-config'

const engine = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  swarms: [] as { session: unknown, options: Record<string, unknown> }[],
  ports: [] as unknown[],
  refresh: vi.fn(),
  relay: { createSocket: vi.fn(), connect: vi.fn(), createWebRTC: vi.fn(), rtcLinks: vi.fn() },
  offline: { net: { is: 'no net' }, dgram: { is: 'no dgram' }, dnsLookup: () => {} },
  peers: 0,
}))

// before the worker starts: 130 s pass in this file, on the worker's own timers
vi.useFakeTimers()
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }), name: 'direct' })

// whatever the constant is set to in the source, this file is about WebRTC peers running
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))
vi.mock('@fkn/lib/net', () => ({ connect: engine.relay.connect, isIPv4: () => true }))
vi.mock('@fkn/lib/dgram', () => ({ createSocket: engine.relay.createSocket }))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: class RelayWebSocket {} }))
vi.mock('libtorrent-wasm/webrtc', () => ({ createWebRTC: engine.relay.createWebRTC }))
vi.mock('libtorrent-wasm/webtorrent', () => ({
  webtorrentPeers: (session: unknown, options: Record<string, unknown>) => {
    engine.swarms.push({ session, options })
    return { refresh: engine.refresh, close: () => {}, snapshot: () => ({ torrents: [], dropped: 0, unmade: 0 }), onchange: null }
  },
  pageLinks: (port: unknown) => { engine.ports.push(port); return { links: 'of the page' } },
  rtcLinks: engine.relay.rtcLinks,
}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async (options: Record<string, unknown>) => {
      engine.created.push(options)
      return fakeSession({
        // a download that runs and finds nobody, until `peers` says otherwise
        status: () => ({
          state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: engine.peers,
          activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
        }),
        saveResumeData: async () => new Uint8Array([1]),
        pauseTorrent: () => {},
        resumeTorrent: () => {},
      })
    },
    offlineHost: () => engine.offline,
    PRIORITY: { skip: 0 },
    TORRENT_FLAG: { uploadMode: 1 },
  }
})
vi.mock('idb-keyval', () => {
  const store = new Map<string, unknown>()
  return {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => { store.set(key, value) },
    del: async (key: string) => { store.delete(key) },
    update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
  }
})

const lastState = () => rig.of('state').at(-1) as unknown as { transport?: string, torrents: { noPeersSince?: number, recovery: unknown }[] }

it('starts the engine on a host that reaches nothing, and hands the page the port its connections are asked on', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  expect(engine.created).toHaveLength(1)
  const { net, dgram, dnsLookup, enableDht, reserveListenPort, storage } = engine.created[0]!
  expect({ net, dgram, dnsLookup }).toEqual(engine.offline)
  expect({ enableDht, reserveListenPort }).toEqual({ enableDht: false, reserveListenPort: false })
  expect(storage).toBeDefined()

  const links = rig.of('peer-links')
  expect(links).toHaveLength(1)
  expect(links[0]!.port).toBeInstanceOf(MessagePort)
  expect(engine.ports).toHaveLength(1)
  expect(engine.ports[0]).toBeInstanceOf(MessagePort)
  expect(engine.ports[0], 'the worker keeps one end and the page gets the other').not.toBe(links[0]!.port)
})

it('finds peers through the browser\'s own WebSocket, at the two trackers, with nothing of the relay', () => {
  expect(engine.swarms).toHaveLength(1)
  const { options } = engine.swarms[0]!
  expect(options.WebSocket).toBe(WebSocket)
  expect(options.trackers).toEqual(TRACKERS)
  expect(options.links).toEqual({ links: 'of the page' })
  expect(options.relay).toBeUndefined()
  for (const call of Object.values(engine.relay)) expect(call).toHaveBeenCalledTimes(0)
})

it('says which transport it runs on, and lets the swarm act on each pump', async () => {
  await vi.waitFor(() => expect(lastState().transport).toBe('direct'))
  const before = engine.refresh.mock.calls.length
  await vi.advanceTimersByTimeAsync(1_500)
  expect(engine.refresh.mock.calls.length - before).toBe(3)
  // on every beat: a tab that joins later is told by the one it hears first
  expect(rig.of('state').slice(-3).map((state) => state.transport)).toEqual(['direct', 'direct', 'direct'])
})

it('says since when a download has had nobody, takes it back with a peer, and never calls that a stall', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(1_000)
  const since = lastState().torrents[0]!.noPeersSince
  expect(since).toBeTypeOf('number')

  // past the 10 s a new torrent is left alone and the 120 s after which a relay engine calls it stalled
  await vi.advanceTimersByTimeAsync(140_000)
  expect(lastState().torrents[0]!.noPeersSince, 'the moment it was left alone, not the last look').toBe(since)
  expect(lastState().torrents[0]!.recovery, 'nobody found is ordinary here').toBeNull()

  engine.peers = 1
  await vi.advanceTimersByTimeAsync(1_000)
  expect('noPeersSince' in lastState().torrents[0]!, 'the beat carries it for a torrent that has peers').toBe(false)
})

it('answers a page that waits for the resume data to be written', async () => {
  rig.send({ type: 'flush-resume', id: 41 })
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 41 }]))
})
