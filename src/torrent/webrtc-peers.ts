import type { Session, TrackerInfo } from 'libtorrent-wasm'
import type { WebtorrentPeers } from 'libtorrent-wasm/webtorrent'

import * as net from '@fkn/lib/net'
import * as dgram from '@fkn/lib/dgram'
import { WebSocket as RelayWebSocket } from '@fkn/lib/websocket'
import { createWebRTC } from 'libtorrent-wasm/webrtc'
import { pageLinks, rtcLinks, webtorrentPeers } from 'libtorrent-wasm/webtorrent'
// its own file, fetched: inlined, it would put 4 MB more in the chunks the service worker keeps
import wasmUrl from 'libtorrent-wasm/webrtc.wasm?url&no-inline'

import { TRACKERS } from './vpn-config'

/**
 * The engine's WebRTC half. `refresh` goes after each pump of the session, so the swarm acts on what it left.
 * `trackers` is the WebSocket trackers a running torrent is announced to, in the shape of the engine's own
 * tracker rows, which never list them.
 */
export type WebrtcPeers = { refresh: () => void, trackers: (handle: number) => TrackerInfo[] }

const trackerRows = (peers: WebtorrentPeers | null, handle: number): TrackerInfo[] =>
  (peers?.snapshot().torrents.find((torrent) => torrent.handle === handle)?.trackers ?? []).map((tracker) => ({
    url: tracker.url,
    message: tracker.failure ?? '',
    tier: 0,
    // never contacted is not zero failures: a tracker that has not answered yet says so
    fails: tracker.failure ? 1 : tracker.answeredAt === null ? -1 : 0,
    updating: false,
    verified: tracker.answeredAt !== null,
    nextAnnounceIn: -1,
    seeders: tracker.seeders ?? -1,
    leechers: tracker.leechers ?? -1,
    downloaded: -1,
  }))

/**
 * WebRTC peers for a session with no relay behind it. The page that owns the worker makes the connections, a worker
 * having no RTCPeerConnection: it is handed the other end of `post`'s port, and the STUN host is its to pass.
 * The trackers are opened from here, with the browser's own WebSocket.
 */
export const directPeers = (session: Session, post: (message: unknown, transfer: Transferable[]) => void): WebrtcPeers => {
  const { port1, port2 } = new MessageChannel()
  post({ type: 'peer-links', port: port2 }, [port2])
  const peers = webtorrentPeers(session, { links: pageLinks(port1), WebSocket, trackers: TRACKERS })
  return { refresh: () => peers.refresh(), trackers: (handle) => trackerRows(peers, handle) }
}

const RETRY_MIN_MS = 500
// a relay that is away refuses the bind, and is asked again as often as the engine asks for its own sockets
const BIND_RETRY_MAX_MS = 2_000
// anything else that failed (the address, the stack's own file) is not back within moments
const RETRY_MAX_MS = 30_000
const ADDRESS_TIMEOUT_MS = 10_000

const bound = () => new Promise<dgram.Socket>((resolve, reject) => {
  const socket = dgram.createSocket('udp4')
  socket.once('listening', () => resolve(socket))
  // kept for the socket's life: an error nobody listens for is thrown
  socket.on('error', reject)
  socket.bind(0)
})

/**
 * The address a TCP socket connected through the relay to `host` left from, which is the relay's public IPv4
 * address. The socket is closed again with nothing sent.
 */
const addressSeenFrom = (host: string) => new Promise<string>((resolve, reject) => {
  const socket = net.connect({ host, port: 443 })
  const end = (address?: string) => {
    clearTimeout(timer)
    socket.destroy()
    if (address && net.isIPv4(address)) resolve(address)
    else reject(new Error('the relay did not say its address'))
  }
  const timer = setTimeout(end, ADDRESS_TIMEOUT_MS)
  socket.once('connect', () => end(socket.localAddress))
  socket.on('error', () => end())
  socket.once('close', () => end())
})

/**
 * The relay's public IPv4 address, which nothing FKN answers names: a UDP socket and a listener answer the
 * wildcard they bound, and FKN looks up no name of its own for an app, the relay's included. So it is read off
 * a connection to a tracker's host, each tried in turn, since those hosts hear from the relay anyway.
 */
const relayAddress = async () => {
  for (const tracker of TRACKERS) {
    const address = await addressSeenFrom(new URL(tracker).hostname).catch(() => null)
    if (address) return address
  }
  throw new Error('the relay did not say its address')
}

/**
 * WebRTC peers beside the session's ordinary ones, every packet through the relay: the engine's own WebRTC stack
 * over one more UDP socket, the trackers through the relay's WebSocket, and no STUN host, the relay's address and
 * the socket's port being the one candidate.
 *
 * The stack ends with its socket, so each time the relay goes away it is made again on a new socket, with the
 * address read again: after a failover it is another relay's.
 */
export const relayPeers = (session: Session): WebrtcPeers => {
  let peers: WebtorrentPeers | null = null
  let wasm: WebAssembly.Module | undefined
  const run = async () => {
    let wait = RETRY_MIN_MS
    for (;;) {
      const socket = await bound().catch(() => null)
      if (socket) {
        let open = true
        // an error after the bind ends the stack as a close does, and may come with no close
        const ended = new Promise<void>((resolve) => {
          const end = () => { open = false; resolve() }
          socket.once('close', end)
          socket.once('error', end)
        })
        try {
          const address = await relayAddress()
          wasm ??= await WebAssembly.compile(await (await fetch(wasmUrl)).arrayBuffer())
          if (open) {
            const webrtc = await createWebRTC({ socket, address, port: socket.address().port, wasm })
            peers = webtorrentPeers(session, {
              links: rtcLinks({ RTCPeerConnection: webrtc.RTCPeerConnection }),
              WebSocket: RelayWebSocket,
              trackers: TRACKERS,
              relay: true,
            })
            wait = RETRY_MIN_MS
            await ended
            peers.close()
            peers = null
            webrtc.close()
          }
        } catch { /* asked for again below */ }
        try { socket.close() } catch { /* it closed by itself */ }
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
      wait = Math.min(wait * 2, socket ? RETRY_MAX_MS : BIND_RETRY_MAX_MS)
    }
  }
  void run()
  return { refresh: () => peers?.refresh(), trackers: (handle) => trackerRows(peers, handle) }
}
