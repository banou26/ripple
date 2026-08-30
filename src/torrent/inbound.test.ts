import type { PeerInfo } from 'libtorrent-wasm'

import { PEER_FLAG, PEER_SOURCE } from 'libtorrent-wasm'
import { describe, expect, it } from 'vitest'

import { NO_INBOUND, countInbound, inboundLabel, isInbound, peerTransport } from './inbound'

const peer = (over: Partial<PeerInfo> = {}): PeerInfo => ({
  endpoint: '1.2.3.4:5678',
  client: 'whatever',
  flags: 0,
  source: 0,
  connectionType: 0,
  downloadRate: 0,
  uploadRate: 0,
  payloadDownloadRate: 0,
  payloadUploadRate: 0,
  totalDownload: 0,
  totalUpload: 0,
  progress: 0,
  rtt: 0,
  numPieces: 0,
  requestsInFlight: 0,
  failCount: 0,
  ...over,
})

const dialledOut = (over: Partial<PeerInfo> = {}) =>
  peer({ ...over, flags: (over.flags ?? 0) | PEER_FLAG.localConnection })

describe('which peers dialled in', () => {
  it('counts a peer we did not open the connection to', () => {
    expect(isInbound(peer())).toBe(true)
    expect(isInbound(dialledOut())).toBe(false)
  })

  /**
   * Either signal alone is nearly right, and nearly is the problem. `torrent-detail.tsx` tags a peer
   * `incoming` on this same pair, so a strip counting only one of them would show a number beside a
   * peer list tagging a different set, with nothing on screen to say which was true.
   */
  it('counts a peer libtorrent says arrived, even with the local flag set', () => {
    expect(isInbound(dialledOut({ source: PEER_SOURCE.incoming }))).toBe(true)
  })

  it('reads the transport off the socket flag', () => {
    expect(peerTransport(peer())).toBe('tcp')
    expect(peerTransport(peer({ flags: PEER_FLAG.utpSocket }))).toBe('utp')
  })
})

describe('counting what is connected right now', () => {
  it('splits by transport across every torrent', () => {
    const now = countInbound([
      [peer(), peer({ flags: PEER_FLAG.utpSocket }), dialledOut()],
      [peer(), dialledOut({ flags: PEER_FLAG.utpSocket })],
    ])
    expect(now).toEqual({ total: 3, byTransport: { tcp: 2, utp: 1 } })
  })

  it('is nothing at all when every peer was dialled out to', () => {
    expect(countInbound([[dialledOut(), dialledOut()]])).toEqual(NO_INBOUND)
    expect(countInbound([])).toEqual(NO_INBOUND)
    expect(countInbound([[]])).toEqual(NO_INBOUND)
  })

  /**
   * CONNECTIONS, not distinct peers. One address connected to three torrents is three connections,
   * and three is what the acceptor accepted. Deduplicating would also be wrong for the ordinary case
   * of two people behind one address.
   */
  it('counts one address on three torrents as three connections', () => {
    const same = () => peer({ endpoint: '9.9.9.9:1111' })
    expect(countInbound([[same()], [same()], [same()]]).total).toBe(3)
  })

  /** A web seed or an http seed is something Ripple dials, so an inbound one describes nothing. */
  it('leaves out web and http seeds', () => {
    expect(countInbound([[peer({ connectionType: 1 }), peer({ connectionType: 2 })]])).toEqual(NO_INBOUND)
  })

  it('leaves out a transport carrying nothing rather than reporting a zero', () => {
    const now = countInbound([[peer(), peer()]])
    expect(now.byTransport).toEqual({ tcp: 2 })
    expect('utp' in now.byTransport).toBe(false)
  })
})

describe('what the strip says', () => {
  /**
   * `tcp` first, which is alphabetical and happens to be the useful order: this cell is about the
   * announced PORT, and TCP is the transport that depends on that number being real, while uTP can
   * arrive through the DHT's implied port.
   */
  it('names each transport with its count, tcp first', () => {
    expect(inboundLabel(countInbound([[peer(), peer(), peer({ flags: PEER_FLAG.utpSocket })]]))).toBe('2 tcp · 1 utp')
  })

  it('says nothing when nothing is connected in', () => {
    expect(inboundLabel(NO_INBOUND)).toBe('')
  })

  /** A stable order, so the cell does not shuffle itself between ticks as the counts move. */
  it('keeps the same order however the counts arrive', () => {
    const utpFirst = countInbound([[peer({ flags: PEER_FLAG.utpSocket }), peer()]])
    const tcpFirst = countInbound([[peer(), peer({ flags: PEER_FLAG.utpSocket })]])
    expect(inboundLabel(utpFirst)).toBe(inboundLabel(tcpFirst))
  })
})
