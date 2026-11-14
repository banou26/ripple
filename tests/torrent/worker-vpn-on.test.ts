// With the VPN on the engine keeps the relay, and takes WebRTC peers beside its ordinary ones through the relay
// too: its own WebRTC stack over one more UDP socket, the trackers through the relay's WebSocket, no STUN host.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'
import { TRACKERS } from '../../src/torrent/vpn-config'

type Listener = (...args: unknown[]) => void

const engine = vi.hoisted(() => {
  const emitter = () => {
    const listeners = new Map<string, { listener: Listener, once: boolean }[]>()
    const add = (once: boolean) => (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), { listener, once }]) }
    return {
      once: add(true),
      on: add(false),
      /** As node's: an `error` nobody listens for is thrown. */
      emit: (event: string, ...args: unknown[]) => {
        const waiting = listeners.get(event) ?? []
        if (event === 'error' && !waiting.length) throw new Error('an error nobody listened for')
        listeners.set(event, waiting.filter(({ once }) => !once))
        for (const { listener } of waiting) listener(...args)
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
    /** Hosts no probe reaches. */
    down: [] as string[],
    udp: [] as (ReturnType<typeof emitter> & { type: unknown, bound: unknown[], listening: boolean, closed: boolean, address: () => { port: number }, close: ReturnType<typeof vi.fn> })[],
    tcp: [] as { options: unknown, destroyed: boolean }[],
    listeners: [] as { closed: boolean }[],
    /** How often the host that reaches nothing was asked for. */
    offline: { asked: 0, sockets: 0 },
  }
  return { ...state, emitter }
})

vi.useFakeTimers()
const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }) })

class RelayWebSocket {}

// whatever the constant is set to in the source, this file is about WebRTC peers running
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))

vi.mock('@fkn/lib/dgram', () => ({
  createSocket: (type: unknown) => {
    const answer = engine.binds.length > 1 ? engine.binds.shift()! : engine.binds[0]!
    const socket = {
      ...engine.emitter(),
      type,
      bound: [] as unknown[],
      address: () => ({ port: answer as number }),
      listening: false,
      closed: false,
      close: vi.fn(() => {
        if (socket.closed) throw new Error('closed twice')
        socket.closed = true
        socket.emit('close')
      }),
      bind: (...args: unknown[]) => {
        socket.bound.push(args)
        queueMicrotask(() => {
          if (answer === false) { socket.emit('error', new Error('refused')); return }
          socket.listening = true
          socket.emit('listening')
        })
      },
    }
    engine.udp.push(socket)
    return socket
  },
}))
vi.mock('@fkn/lib/net', () => ({
  isIPv4: (address: string) => /^\d+\.\d+\.\d+\.\d+$/.test(address),
  connect: (options: { host: string }) => {
    const probe = { options, destroyed: false }
    engine.tcp.push(probe)
    const down = engine.down.includes(options.host)
    const socket = {
      ...engine.emitter(),
      localAddress: down ? undefined : engine.addresses.length > 1 ? engine.addresses.shift()! : engine.addresses[0]!,
      // as FKN's: a destroyed socket says close once the relay has let it go
      destroy: () => {
        if (probe.destroyed) return
        probe.destroyed = true
        queueMicrotask(() => socket.emit('close'))
      },
    }
    queueMicrotask(() => down ? socket.emit('error', new Error('refused')) : socket.emit('connect'))
    return socket
  },
  createServer: () => {
    const listener = { closed: false }
    engine.listeners.push(listener)
    const server = {
      ...engine.emitter(),
      listen: () => queueMicrotask(() => server.emit('listening')),
      close: () => { listener.closed = true; queueMicrotask(() => server.emit('close')) },
    }
    return server
  },
}))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: RelayWebSocket }))
vi.mock('@fkn/lib/dns', () => ({ lookup: async () => undefined }))
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
    offlineHost: () => {
      engine.offline.asked++
      const nothing = () => { engine.offline.sockets++; return { on: () => {}, bind: () => {}, listen: () => {}, send: () => {}, close: () => {}, destroy: () => {} } }
      return { net: { connect: nothing, createServer: nothing }, dgram: { createSocket: nothing }, dnsLookup: async () => undefined }
    },
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
  expect(engine.offline.asked, 'an engine behind the relay was given the host that reaches nothing').toBe(0)
  // the relay looks every name up: with none passed the engine asks 1.1.1.1 from the browser itself
  expect(options.dnsLookup).toBe((await import('@fkn/lib/dns')).lookup)
  expect(Object.keys(options).sort()).toEqual(['dgram', 'dnsLookup', 'net', 'storage', 'utpReceiveBufferBytes'])
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

it('lets the swarm act on each pump, and says which transport it runs on with each', async () => {
  const before = engine.refresh.mock.calls.length
  await vi.advanceTimersByTimeAsync(1_500)
  expect(engine.refresh.mock.calls.length - before).toBe(3)
  expect(rig.of('state').slice(-3).map((state) => state.transport)).toEqual(['relay', 'relay', 'relay'])
})

it('makes both again on a new socket when the relay went away, with the address read again', async () => {
  // the relay refuses four binds while it is away, then answers as another relay would: a new port and address
  engine.binds.splice(0, 1, false, false, false, false, 51_000)
  engine.addresses.splice(0, 1, '198.51.100.4')
  engine.udp[0]!.closed = true
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

it('makes both again when the socket fails without closing, and lets go of the socket', async () => {
  const [socket, swarm, factory] = [engine.udp.at(-1)!, engine.swarms.at(-1)!, engine.factories.at(-1)!]
  socket.emit('error', new Error('send failed'))
  // again, as a socket that keeps failing does: nothing may be left that throws on it
  socket.emit('error', new Error('send failed'))
  await vi.advanceTimersByTimeAsync(0)
  expect(swarm.close).toHaveBeenCalledTimes(1)
  expect(factory.close).toHaveBeenCalledTimes(1)
  expect(socket.close).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(500)
  await vi.waitFor(() => expect(engine.factories).toHaveLength(3))
  expect(engine.factories[2]!.options.socket).toBe(engine.udp.at(-1))
  expect(engine.udp.at(-1)).not.toBe(socket)
})

it('reads the address off the next tracker\'s host when the first is out of reach', async () => {
  engine.down.push(new URL(TRACKERS[0]!).hostname)
  engine.addresses.splice(0, 1, '192.0.2.9')
  const [probes, stacks] = [engine.tcp.length, engine.factories.length]
  const socket = engine.udp.at(-1)!
  socket.closed = true
  socket.emit('close')
  await vi.advanceTimersByTimeAsync(500)
  await vi.waitFor(() => expect(engine.factories).toHaveLength(stacks + 1))

  expect(engine.tcp.slice(probes)).toEqual(TRACKERS.map((tracker) => ({ options: { host: new URL(tracker).hostname, port: 443 }, destroyed: true })))
  expect(engine.factories.at(-1)!.options.address).toBe('192.0.2.9')
  engine.down.length = 0
})

// THE CONTROL of worker-vpn-off.test.ts: behind the relay, a download nobody serves is still kicked
it('still reads a download with nobody for 2 minutes as stalled', async () => {
  rig.send({ type: 'add-magnet', magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` })
  await vi.waitFor(() => expect(rig.of('added')).toHaveLength(1))
  await vi.advanceTimersByTimeAsync(140_000)
  expect(lastState().torrents[0]!.recovery?.reason).toBe('stalled')
})

type Host = {
  net: { connect: (options: unknown) => { destroy: () => void }, createServer: () => { listen: (port: number) => void, emit: (event: string, ...args: unknown[]) => void } }
  dgram: { createSocket: (type: unknown) => { bind: (port: number) => void } }
}
const open = () => ({
  udp: engine.udp.filter((socket) => socket.listening && !socket.closed).length,
  tcp: engine.tcp.filter((socket) => !socket.destroyed).length,
  listeners: engine.listeners.filter((listener) => !listener.closed).length,
})

// the relay keeps a socket until it is closed, and a worker that is ended closes none
it('closes all it holds at the relay when asked, tells the trackers, answers, and opens nothing again', async () => {
  // what the engine opens through the host it was given: a UDP socket, a listener, a peer it dialled, one that dialled in
  const { net, dgram } = engine.created[0] as unknown as Host
  dgram.createSocket({ type: 'udp4' }).bind(0)
  const server = net.createServer()
  server.listen(0)
  net.connect({ host: '198.51.100.20', port: 6881 })
  await vi.advanceTimersByTimeAsync(0)
  server.emit('connection', (await import('@fkn/lib/net')).connect({ host: '198.51.100.21', port: 51_413 } as never))
  const [swarm, factory] = [engine.swarms.at(-1)!, engine.factories.at(-1)!]
  // THE CONTROL: the WebRTC stack's socket and the engine's, the listener, both peers
  expect(open()).toEqual({ udp: 2, tcp: 2, listeners: 1 })
  expect(swarm.close).toHaveBeenCalledTimes(0)

  rig.send({ type: 'close-sockets', id: 7 })
  await vi.waitFor(() => expect(rig.of('answer')).toEqual([{ type: 'answer', id: 7 }]))
  expect(open()).toEqual({ udp: 0, tcp: 0, listeners: 0 })
  expect(swarm.close, 'the trackers were not told stopped').toHaveBeenCalledTimes(1)
  expect(factory.close).toHaveBeenCalledTimes(1)

  // an engine opens a socket again when one closes under it, and the WebRTC half made its own again every 2 s
  const made = { udp: engine.udp.length, tcp: engine.tcp.length, listeners: engine.listeners.length, stacks: engine.factories.length }
  dgram.createSocket({ type: 'udp4' }).bind(0)
  net.createServer().listen(0)
  net.connect({ host: '198.51.100.20', port: 6881 })
  await vi.advanceTimersByTimeAsync(120_000)
  expect({ udp: engine.udp.length, tcp: engine.tcp.length, listeners: engine.listeners.length, stacks: engine.factories.length }).toEqual(made)
  expect(engine.offline.sockets, 'the engine was handed nothing at all, where it needs a socket that carries nothing').toBe(3)
})
