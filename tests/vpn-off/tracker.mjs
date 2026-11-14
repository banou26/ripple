// A WebSocket tracker for a swarm that exists only on this machine: it counts the peers of a torrent and passes
// their offers and answers on, as the public WebTorrent trackers do.
import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

/**
 * @param {number} [port] any free one when left out
 * @param {string} [host] the address it listens on
 * @returns {Promise<{
 *   port: number,
 *   seen: { announces: number, offers: number, answers: number, sockets: number, connections: Record<string, number> },
 *   peers: () => number,
 *   candidates: () => string[],
 *   close: () => Promise<void>,
 * }>} `peers` is how many peers are announced right now, over every torrent, `candidates` every
 * `address:port` an offer or an answer said its sender is reached at, and `seen.connections` how many
 * connections came from each address, the ones that never became a WebSocket included.
 */
export const startTracker = async (port = 0, host = '127.0.0.1') => {
  const http = createServer()
  const server = new WebSocketServer({ server: http })
  await new Promise((resolve) => http.listen(port, host, resolve))
  /** info hash to peer id to the peer */
  const swarms = new Map()
  const seen = { announces: 0, offers: 0, answers: 0, sockets: 0, connections: {} }
  http.on('connection', (socket) => { seen.connections[socket.remoteAddress] = (seen.connections[socket.remoteAddress] ?? 0) + 1 })
  const candidates = new Set()
  const note = (description) => {
    for (const [, address, port] of String(description?.sdp).matchAll(/^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ /gim)) candidates.add(`${address}:${port}`)
  }

  server.on('connection', (socket) => {
    seen.sockets++
    socket.on('message', (data) => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message?.action !== 'announce') return
      const { info_hash: hash, peer_id: id } = message
      const swarm = swarms.get(hash) ?? new Map()
      swarms.set(hash, swarm)
      if (message.answer) {
        seen.answers++
        note(message.answer)
        swarm.get(message.to_peer_id)?.socket.send(JSON.stringify({
          action: 'announce', info_hash: hash, peer_id: id, offer_id: message.offer_id, answer: message.answer,
        }))
        return
      }
      seen.announces++
      if (message.event === 'stopped') swarm.delete(id)
      else swarm.set(id, { socket, left: message.left })
      const peers = [...swarm.values()]
      socket.send(JSON.stringify({
        action: 'announce',
        info_hash: hash,
        interval: 60,
        complete: peers.filter((peer) => peer.left === 0).length,
        incomplete: peers.filter((peer) => peer.left > 0).length,
      }))
      const others = [...swarm].filter(([other]) => other !== id)
      for (const [i, { offer, offer_id }] of (message.offers ?? []).entries()) {
        seen.offers++
        note(offer)
        others[i % others.length]?.[1].socket.send(JSON.stringify({ action: 'announce', info_hash: hash, peer_id: id, offer_id, offer }))
      }
    })
    socket.on('close', () => {
      for (const swarm of swarms.values()) for (const [id, peer] of swarm) if (peer.socket === socket) swarm.delete(id)
    })
  })

  return {
    port: http.address().port,
    seen,
    peers: () => [...swarms.values()].reduce((count, swarm) => count + swarm.size, 0),
    candidates: () => [...candidates],
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close()
      http.closeAllConnections()
      http.close(() => resolve())
    }),
  }
}
