import type { PeerInfo } from 'libtorrent-wasm'

import { PEER_FLAG, PEER_SOURCE } from 'libtorrent-wasm'

/**
 * How many peers are dialled IN right now, split by transport.
 *
 * `Reachability.inbound` and `inboundByTransport` cannot answer this. Their own documentation says
 * so: they accumulate from alerts and "stay true forever", so they are the number of connections
 * ever accepted since the session started. That is the right number for "does inbound work at all"
 * and the wrong one for a strip cell somebody reads next to a torrent's peer count, which is how it
 * got reported as a bug twice.
 *
 * There is no session-level live count in the engine, so this is computed from the peer lists: a
 * peer we did not dial is one that dialled us. The engine offers nothing cheaper, and the two other
 * candidates are worse rather than cheaper: `TorrentStatus.numConnections` does not say which
 * direction or which transport, and maintaining a running count from connect and disconnect alerts
 * would mean changes inside the wasm.
 */

/**
 * Whether this peer opened the connection to us.
 *
 * Two tests, not one, and deliberately the same pair `torrent-detail.tsx` already used to tag a peer
 * `incoming`. `localConnection` absent is libtorrent's own statement that we did not dial, and
 * `PEER_SOURCE.incoming` is how the peer was discovered. Either alone is nearly right, which is the
 * problem: a strip counting one rule beside a peer list tagging the other shows two numbers about
 * one thing that disagree, and nothing on screen would say which to believe.
 */
export const isInbound = (peer: PeerInfo): boolean =>
  !(peer.flags & PEER_FLAG.localConnection) || !!(peer.source & PEER_SOURCE.incoming)

/** `utp` or `tcp`, lowercased to match the keys `Reachability.inboundByTransport` uses. */
export const peerTransport = (peer: PeerInfo): 'utp' | 'tcp' =>
  peer.flags & PEER_FLAG.utpSocket ? 'utp' : 'tcp'

export type InboundNow = {
  total: number
  /** Keyed `utp` and `tcp`, and a transport with no connections is ABSENT rather than zero. */
  byTransport: Record<string, number>
}

export const NO_INBOUND: InboundNow = { total: 0, byTransport: {} }

/**
 * Count across every torrent's peer list.
 *
 * CONNECTIONS, not distinct peers. One address connected to three torrents is three connections, and
 * three is what the acceptor accepted, which is what this readout is about. Deduplicating by address
 * would also be wrong for the ordinary case of two people behind one address.
 *
 * A transport with nothing on it is left out rather than reported as zero, so the label reads
 * `3 tcp` rather than `3 tcp · 0 utp`: the interesting fact is which transports are carrying, and a
 * zero adds a number without adding one.
 */
export const countInbound = (lists: Iterable<readonly PeerInfo[]>): InboundNow => {
  const byTransport: Record<string, number> = {}
  let total = 0
  for (const list of lists) {
    for (const peer of list) {
      if (!isInbound(peer)) continue
      // web seeds and http seeds are things we dial, so an inbound one is not a case to describe
      if (peer.connectionType !== 0) continue
      total += 1
      const transport = peerTransport(peer)
      byTransport[transport] = (byTransport[transport] ?? 0) + 1
    }
  }
  return { total, byTransport }
}

/** `3 tcp · 1 utp`, or an empty string when nothing is connected in. */
export const inboundLabel = ({ byTransport }: InboundNow): string =>
  Object.entries(byTransport)
    // a fixed order, so the cell does not reorder itself between ticks as counts change
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([transport, n]) => `${n} ${transport}`)
    .join(' · ')
