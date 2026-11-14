// The WebRTC half behind the relay starts from the stack's own file: while that cannot be fetched or compiled,
// which is what a tab on an older build gets after a deploy, nothing is bound at the relay and no tracker's host
// hears from it.
import { afterEach, expect, it, vi } from 'vitest'

import { relayPeers } from '../../src/torrent/webrtc-peers'

type Listener = (...args: unknown[]) => void

const seen = vi.hoisted(() => ({ stacks: 0 }))

vi.mock('@fkn/lib/net', () => ({ isIPv4: () => true }))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: class {} }))
vi.mock('libtorrent-wasm/webrtc', () => ({
  createWebRTC: async () => { seen.stacks++; return { RTCPeerConnection: class {}, close: () => {} } },
}))
vi.mock('libtorrent-wasm/webtorrent', () => ({
  webtorrentPeers: () => ({ refresh: () => {}, close: () => {}, snapshot: () => ({ torrents: [] }) }),
  pageLinks: () => ({}),
  rtcLinks: () => ({}),
}))

/** The relay's sockets, by host asked: binds and the connections the address is read off. */
const relay = () => {
  const asked: string[] = []
  const emitter = () => {
    const listeners = new Map<string, Listener[]>()
    const on = (event: string, listener: Listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]) }
    return { on, once: on, emit: (event: string) => { for (const listener of listeners.get(event) ?? []) listener() } }
  }
  return {
    asked,
    net: {
      connect: ({ host }: { host: string }) => {
        asked.push(host)
        const socket = { ...emitter(), localAddress: '203.0.113.7', destroy: () => {} }
        queueMicrotask(() => socket.emit('connect'))
        return socket
      },
    },
    dgram: {
      createSocket: () => {
        asked.push('the relay, for a UDP socket')
        const socket = { ...emitter(), address: () => ({ port: 40_123 }), close: () => {}, bind: () => queueMicrotask(() => socket.emit('listening')) }
        return socket
      },
    },
  }
}

const WASM = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
const HTML = new TextEncoder().encode('<!doctype html><title>Ripple</title>')

/** The app's page answered for the stack's file. The refusal is the browser's own, made at once so fake time can pass it. */
const notTheStack = () => {
  const fetched = vi.fn(async (_url: string) => ({ arrayBuffer: async () => HTML.buffer }))
  vi.stubGlobal('fetch', fetched)
  vi.spyOn(WebAssembly, 'compile').mockImplementation(async (bytes) => { throw new WebAssembly.CompileError(`${(bytes as ArrayBuffer).byteLength} bytes that are no module`) })
  return fetched
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  seen.stacks = 0
})

it('binds nothing and reaches no tracker\'s host while the stack\'s file is not the stack', async () => {
  vi.useFakeTimers()
  const fetched = notTheStack()
  const sockets = relay()
  const peers = relayPeers({} as never, sockets as never)

  // asked again after 0.5, 1, 2, 4, 8, 16 s and then every 30 s: 7 fetches within the first 32 s, 8 a minute in
  await vi.advanceTimersByTimeAsync(32_000)
  expect(fetched).toHaveBeenCalledTimes(7)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(fetched).toHaveBeenCalledTimes(8)
  expect(sockets.asked, 'the relay or a tracker\'s host was reached for a stack that cannot start').toEqual([])
  expect(seen.stacks).toBe(0)
  peers.close()
})

// THE CONTROL: the same sockets are asked once the file is the stack
it('binds its socket and reads the relay\'s address once the stack compiled, and compiles it once', async () => {
  vi.useFakeTimers()
  const fetched = vi.fn(async (_url: string) => ({ arrayBuffer: async () => WASM.buffer }))
  vi.stubGlobal('fetch', fetched)
  const sockets = relay()
  const peers = relayPeers({} as never, sockets as never)
  await vi.waitFor(() => expect(seen.stacks).toBe(1))
  expect(sockets.asked).toEqual(['the relay, for a UDP socket', 'tracker.openwebtorrent.com'])
  expect(fetched).toHaveBeenCalledTimes(1)
  peers.close()
})
