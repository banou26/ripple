// The swarm rig's build, which bakes the rig's own tracker in: every peer, tracker and relay of that lane is one
// machine, so the tracker stands in for the public two, no STUN host is asked, the relay's address is read off
// the tracker's own port, and a peer on a private address is taken. And its control: a build with no such
// tracker baked in does none of it.
import { afterEach, expect, it, vi } from 'vitest'

const RIG = 'ws://ripple-tracker.test:5472'

type Listener = (...args: unknown[]) => void

const seen = vi.hoisted(() => ({
  probes: [] as unknown[],
  stacks: [] as Record<string, unknown>[],
  swarms: [] as Record<string, unknown>[],
}))

const emitter = () => {
  const listeners = new Map<string, Listener[]>()
  return {
    once: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    on: (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) },
    emit: (event: string) => { for (const listener of listeners.get(event) ?? []) listener() },
  }
}

vi.mock('@fkn/lib/dgram', () => ({
  createSocket: () => {
    const socket = { ...emitter(), address: () => ({ port: 40_123 }), close: () => {}, bind: () => queueMicrotask(() => socket.emit('listening')) }
    return socket
  },
}))
vi.mock('@fkn/lib/net', () => ({
  isIPv4: () => true,
  connect: (options: unknown) => {
    seen.probes.push(options)
    const socket = { ...emitter(), localAddress: '127.0.0.1', destroy: () => {} }
    queueMicrotask(() => socket.emit('connect'))
    return socket
  },
}))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: class {} }))
vi.mock('libtorrent-wasm/webrtc', () => ({
  createWebRTC: async (options: Record<string, unknown>) => { seen.stacks.push(options); return { RTCPeerConnection: class {}, close: () => {} } },
}))
vi.mock('libtorrent-wasm/webtorrent', () => ({
  webtorrentPeers: (_session: unknown, options: Record<string, unknown>) => { seen.swarms.push(options); return { refresh: () => {}, close: () => {}, snapshot: () => ({ torrents: [] }) } },
  pageLinks: () => ({}),
  rtcLinks: () => ({}),
}))
vi.stubGlobal('fetch', async () => ({ arrayBuffer: async () => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
  for (const list of Object.values(seen)) list.length = 0
})

const behindTheRelay = async () => {
  const config = await import('../../src/torrent/vpn-config')
  const { relayPeers } = await import('../../src/torrent/webrtc-peers')
  relayPeers({} as never, { net: await import('@fkn/lib/net'), dgram: await import('@fkn/lib/dgram') } as never)
  await vi.waitFor(() => expect(seen.swarms).toHaveLength(1))
  return config
}

it('names the rig\'s tracker alone, asks no STUN host, and takes a peer on a private address', async () => {
  vi.stubEnv('VITE_RIPPLE_RIG_TRACKER', RIG)
  const { TRACKERS, ICE_SERVERS, TRACKER_HOSTS, STUN_HOST } = await behindTheRelay()
  expect(TRACKERS).toEqual([RIG])
  expect(ICE_SERVERS).toEqual([])
  // the privacy page still names what a person's build reaches
  expect([TRACKER_HOSTS, STUN_HOST]).toEqual([['tracker.openwebtorrent.com', 'tracker.webtorrent.dev'], 'stun.l.google.com'])

  // the relay's address is read off the tracker's own port, which on the rig is not 443
  expect(seen.probes).toEqual([{ host: 'ripple-tracker.test', port: 5472 }])
  expect(seen.stacks[0]).toMatchObject({ address: '127.0.0.1', port: 40_123, allowPrivateCandidates: true })
  expect(seen.swarms[0]!.trackers).toEqual([RIG])
})

// THE CONTROL: every other build
it('with no rig tracker baked in, keeps the two trackers and the STUN host and refuses a private candidate', async () => {
  const { TRACKERS, ICE_SERVERS } = await behindTheRelay()
  expect(TRACKERS).toEqual(['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'])
  expect(ICE_SERVERS).toEqual([{ urls: 'stun:stun.l.google.com:19302' }])
  expect(seen.probes).toEqual([{ host: 'tracker.openwebtorrent.com', port: 443 }])
  expect(seen.stacks[0]).toMatchObject({ allowPrivateCandidates: false })
  expect(seen.swarms[0]!.trackers).toEqual(TRACKERS)
})
