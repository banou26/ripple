// The swarm rig's own tracker and name resolver, so that a WebRTC peer is found and a name is looked up with
// nothing leaving this machine. The relay is pointed at the resolver (WEBVPN_DNS_UPSTREAM), which knows one name,
// the tracker's, and answers that every other name does not exist. The tracker listens on the address netns.sh
// gives the machine beside loopback: a connection the relay makes to it leaves from that address, which is then
// what a peer behind the relay says it is reached at, as a relay's public address is.
//
//   GET /seen  { names: { <name asked>: <times> }, tracker: { announces, offers, answers, sockets, connections, peers, candidates } }
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { startTracker } from '../vpn-off/tracker.mjs'

const topology = JSON.parse(readFileSync(new URL('./topology.json', import.meta.url), 'utf8'))
const A = 1
const NO_SUCH_NAME = 3

const tracker = await startTracker(topology.tracker.port, topology.tracker.address)
/** every name the relay asked for, with how often */
const names = {}

/** The name a DNS query asks for, and the offset its question ends at. */
const question = (query) => {
  const labels = []
  let at = 12
  for (let length = query[at]; length; length = query[at]) {
    labels.push(query.subarray(at + 1, at + 1 + length).toString('latin1'))
    at += 1 + length
  }
  return { name: labels.join('.').toLowerCase(), type: query.readUInt16BE(at + 1), end: at + 5 }
}

/** A whole DNS answer to `query`: the tracker's address for its name, and no such name for any other. */
const answer = (query) => {
  const { name, type, end } = question(query)
  names[name] = (names[name] ?? 0) + 1
  const known = name === topology.tracker.name
  const address = known && type === A ? Buffer.from(topology.tracker.address.split('.').map(Number)) : null
  const header = Buffer.from(query.subarray(0, 12))
  // a response, recursion wanted and offered, and the result
  header.writeUInt16BE(0x8180 | (known ? 0 : NO_SUCH_NAME), 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(address ? 1 : 0, 6)
  header.writeUInt32BE(0, 8)
  if (!address) return Buffer.concat([header, query.subarray(12, end)])
  // the name as a pointer to the question's, then A, IN, a minute, four bytes
  const record = Buffer.from([0xc0, 0x0c, 0, A, 0, 1, 0, 0, 0, 60, 0, 4, ...address])
  return Buffer.concat([header, query.subarray(12, end), record])
}

createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/seen') {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ names, tracker: { ...tracker.seen, peers: tracker.peers(), candidates: tracker.candidates(), descriptions: tracker.descriptions() } }))
    return
  }
  if (request.method !== 'POST' || request.url !== '/dns-query') {
    response.statusCode = 404
    response.end()
    return
  }
  const chunks = []
  request.on('data', (chunk) => chunks.push(chunk))
  request.on('end', () => {
    try {
      const body = answer(Buffer.concat(chunks))
      response.setHeader('content-type', 'application/dns-message')
      response.end(body)
    } catch {
      response.statusCode = 400
      response.end()
    }
  })
}).listen(topology.resolver.port, topology.relay.host)
