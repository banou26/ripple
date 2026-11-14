// A WebSocket tracker for a swarm that exists only on this machine: it counts the peers of a torrent and passes
// their offers and answers on, as the public WebTorrent trackers do.
import { WebSocketServer } from 'ws'

/**
 * @returns {Promise<{
 *   port: number,
 *   seen: { announces: number, offers: number, answers: number },
 *   peers: () => number,
 *   close: () => Promise<void>,
 * }>} `peers` is how many peers are announced right now, over every torrent.
 */
export const startTracker = async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise((resolve) => server.once('listening', resolve))
  /** info hash to peer id to the peer */
  const swarms = new Map()
  const seen = { announces: 0, offers: 0, answers: 0 }

  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      let message
      try { message = JSON.parse(String(data)) } catch { return }
      if (message?.action !== 'announce') return
      const { info_hash: hash, peer_id: id } = message
      const swarm = swarms.get(hash) ?? new Map()
      swarms.set(hash, swarm)
      if (message.answer) {
        seen.answers++
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
        others[i % others.length]?.[1].socket.send(JSON.stringify({ action: 'announce', info_hash: hash, peer_id: id, offer_id, offer }))
      }
    })
    socket.on('close', () => {
      for (const swarm of swarms.values()) for (const [id, peer] of swarm) if (peer.socket === socket) swarm.delete(id)
    })
  })

  return {
    port: server.address().port,
    seen,
    peers: () => [...swarms.values()].reduce((count, swarm) => count + swarm.size, 0),
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => resolve())
    }),
  }
}
