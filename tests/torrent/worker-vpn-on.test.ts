// With the VPN on the engine keeps the relay, and takes WebRTC peers beside its ordinary ones through the relay
// too: its own WebRTC stack over one more UDP socket, the trackers through the relay's WebSocket, no STUN host.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'
import { TRACKERS } from '../../src/torrent/vpn-config'

type Listener = (...args: unknown[]) => void

const engine = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, Listener[]>()
    return {
      once: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
      emit: (event: string, ...args: unknown[]) => {
        const waiting = listeners.get(event) ?? []
        listeners.delete(event)
        for (const listener of waiting) listener(...args)
      },
    }
  }
  const state = {
    created: [] as Record<string, unknown>[],
    swarms: [] as { options: Record<string, unknown>, close: ReturnType<typeof vi.fn> }[],
    factories: [] as { options: Record<string, unknown>, RTCPeerConnection: unknown, close: ReturnType<typeof vi.fn> }[],
    linked: [] as Record<string, unknown>[],
    pageLinks: vi.fn(),
    refresh: vi.fn(),
    /** What each bind answers, in order: a port, or false for a relay that refuses. The last repeats. */
    binds: [40_123] as (number | false)[],
    /** The address each probe through the relay reports, in order. The last repeats. */
    addresses: ['203.0.113.7'],
    udp: [] as (ReturnType<typeof emitter> & { type: unknown, bound: unknown[], address: () => { port: number }, close: ReturnType<typeof vi.fn> })[],
    tcp: [] as { options: unknown, destroyed: boolean }[],
  }
  return { ...state, emitter }
})

vi.useFakeTimers()
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

class RelayWebSocket {}

vi.mock('@fkn/lib/dgram', () => ({
  createSocket: (type: unknown) => {
    const answer = engine.binds.length > 1 ? engine.binds.shift()! : engine.binds[0]!
    const socket = {
      ...engine.emitter(),
      type,
      bound: [] as unknown[],
      address: () => ({ port: answer as number }),
      close: vi.fn(() => { socket.emit('close') }),
      bind: (...args: unknown[]) => {
        socket.bound.push(args)
        queueMicrotask(() => answer === false ? socket.emit('error', new Error('refused')) : socket.emit('listening'))
      },
    }
    engine.udp.push(socket)
    return socket
  },
}))
vi.mock('@fkn/lib/net', () => ({
  isIPv4: (address: string) => /^\d+\.\d+\.\d+\.\d+$/.test(address),
  connect: (options: unknown) => {
    const probe = { options, destroyed: false }
    engine.tcp.push(probe)
    const socket = {
      ...engine.emitter(),
      localAddress: engine.addresses.length > 1 ? engine.addresses.shift()! : engine.addresses[0]!,
      destroy: () => { probe.destroyed = true },
    }
    queueMicrotask(() => socket.emit('connect'))
    return socket
  },
}))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: RelayWebSocket }))
vi.mock('libtorrent-wasm/webrtc', () => ({
  createWebRTC: async (options: Record<string, unknown>) => {
    const factory = { options, RTCPeerConnection: class {}, close: vi.fn() }
    engine.factories.push(factory)
    return factory
  },
}))
vi.mock('libtorrent-wasm/webtorrent', () => ({
  webtorrentPeers: (_session: unknown, options: Record<string, unknown>) => {
    const swarm = { options, close: vi.fn() }
    engine.swarms.push(swarm)
    return { refresh: engine.refresh, close: swarm.close, snapshot: () => ({ torrents: [], dropped: 0, unmade: 0 }), onchange: null }
  },
  pageLinks: engine.pageLinks,
  rtcLinks: (options: Record<string, unknown>) => { engine.linked.push(options); return { links: 'of the relay stack' } },
}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async (options: Record<string, unknown>) => {
      engine.created.push(options)
      return fakeSession({
        status: () => ({
          state: 3, paused: false, autoManaged: true, errorCode: 0, totalDone: 0, downloadRate: 0, numPeers: 0,
          activeSeconds: 0, seedingSeconds: 0, allTimeDownload: 0, allTimeUpload: 0, wasted: 0,
        }),
        pauseTorrent: () => {},
        resumeTorrent: () => {},
      })
    },
    offlineHost: () => { throw new Error('an engine behind the relay asked for the host that reaches nothing') },
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

// the smallest module there is, for the stack's wasm
const fetched = vi.fn(async (_url: string) => ({ arrayBuffer: async () => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer }))
vi.stubGlobal('fetch', fetched)

const lastState = () => rig.of('state').at(-1) as unknown as { transport?: string, torrents: { recovery: { reason: string } | null }[] }

it('starts the engine behind the relay as before, with nothing asked of the page', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))

  expect(engine.created).toHaveLength(1)
  const options = engine.created[0]!
  expect(options.net).toBe(await import('@fkn/lib/net'))
  expect(options.dgram).toBe(await import('@fkn/lib/dgram'))
  expect(Object.keys(options).sort()).toEqual(['dgram', 'net', 'storage', 'utpReceiveBufferBytes'])
  expect(rig.of('peer-links')).toEqual([])
  expect(engine.pageLinks).toHaveBeenCalledTimes(0)
  await vi.waitFor(() => expect(lastState().transport).toBe('relay'))
})

it('makes its WebRTC stack over one more UDP socket of the relay, at the address a TCP socket through it reports', async () => {
  await vi.waitFor(() => expect(engine.factories).toHaveLength(1))
  expect(engine.udp).toHaveLength(1)
  expect(engine.udp[0]!.type).toBe('udp4')
  expect(engine.udp[0]!.bound).toEqual([[0]])
  expect(engine.tcp).toEqual([{ options: { host: 'tracker.openwebtorrent.com', port: 443 }, destroyed: true }])

  const { socket, address, port, wasm } = engine.factories[0]!.options
  expect(socket).toBe(engine.udp[0])
  expect({ address, port }).toEqual({ address: '203.0.113.7', port: 40_123 })
  expect(wasm).toBeInstanceOf(WebAssembly.Module)
  expect(fetched.mock.calls.map(([url]) => url)).toEqual([expect.stringMatching(/webrtc.*\.wasm/)])
})

it('finds peers through the relay\'s WebSocket, at the two trackers, with no STUN host', () => {
  expect(engine.linked).toHaveLength(1)
  expect(Object.keys(engine.linked[0]!), 'an ICE server here would be asked by every connection').toEqual(['RTCPeerConnection'])
  expect(engine.linked[0]!.RTCPeerConnection).toBe(engine.factories[0]!.RTCPeerConnection)

  expect(engine.swarms).toHaveLength(1)
  const { options } = engine.swarms[0]!
  expect(options.WebSocket).toBe(RelayWebSocket)
  expect(options.WebSocket).not.toBe(WebSocket)
  expect(options.trackers).toEqual(TRACKERS)
  expect(options.links).toEqual({ links: 'of the relay stack' })
  expect(options.relay).toBe(true)
})

it('lets the swarm act on each pump', async () => {
  const before = engine.refresh.mock.calls.length
  await vi.advanceTimersByTimeAsync(1_500)
  expect(engine.refresh.mock.calls.length - before).toBe(3)
})

it('makes both again on a new socket when the relay went away, with the address read again', async () => {
  // the relay refuses four binds while it is away, then answers as another relay would: a new port and address
  engine.binds.splice(0, 1, false, false, false, false, 51_000)
  engine.addresses.splice(0, 1, '198.51.100.4')
  engine.udp[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(0)
  expect(engine.swarms[0]!.close).toHaveBeenCalledTimes(1)
  expect(engine.factories[0]!.close).toHaveBeenCalledTimes(1)

  // asked again after 500 ms, 1 s, and then every 2 s, however long the relay is away
  for (const [after, sockets] of [[500, 2], [1_000, 3], [2_000, 4], [2_000, 5], [1_999, 5], [1, 6]] as const) {
    await vi.advanceTimersByTimeAsync(after)
    expect(engine.udp, `${after} ms later`).toHaveLength(sockets)
  }
  await vi.waitFor(() => expect(engine.factories).toHaveLength(2))

  const { socket, address, port } = engine.factories[1]!.options
  expect(socket).toBe(engine.udp[5])
  expect({ address, port }).toEqual({ address: '198.51.100.4', port: 51_000 })
  expect(engine.swarms).toHaveLength(2)
  expect(engine.swarms[1]!.options.relay).toBe(true)
  expect(fetched, 'the stack is compiled once').toHaveBeenCalledTimes(1)
  // the swarm that is alive is the one the pump reaches
  const before = engine.refresh.mock.calls.length
  await vi.advanceTimersByTimeAsync(500)
  expect(engine.refresh.mock.calls.length - before).toBe(1)
})

// THE CONTROL of worker-vpn-off.test.ts: behind the relay, a download nobody serves is still kicked
it('still reads a download with nobody for 2 minutes as stalled', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(140_000)
  expect(lastState().torrents[0]!.recovery?.reason).toBe('stalled')
})
