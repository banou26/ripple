// What crosses to a plugin about a torrent: a fixed list of fields, and a tracker's key in none of them.
import type { Torrent } from '../../src/torrent/types'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { torrentKey } from '../../src/torrent/library'

const store = vi.hoisted(() => new Map<string, unknown>())
vi.mock('idb-keyval', () => ({ get: async (key: string) => store.get(key) }))

const { keptOf, publicTorrentFile, toPluginTorrent, trackerOrigin } = await import('../../src/plugins/project')

const HASH = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00'
const KEY = 'abc123'
const PASSKEY = 'k9x8w7v6'

const encoder = new TextEncoder()
type Value = number | string | Uint8Array | Value[] | { [key: string]: Value }
const bencode = (value: Value): Uint8Array => {
  const join = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const part of parts) { out.set(part, at); at += part.length }
    return out
  }
  if (typeof value === 'number') return encoder.encode(`i${value}e`)
  if (typeof value === 'string' || value instanceof Uint8Array) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value
    return join(encoder.encode(`${bytes.length}:`), bytes)
  }
  if (Array.isArray(value)) return join(encoder.encode('l'), ...value.map(bencode), encoder.encode('e'))
  return join(encoder.encode('d'), ...Object.keys(value).sort().flatMap((k) => [bencode(k), bencode(value[k]!)]), encoder.encode('e'))
}

/** A one-file .torrent announcing to a private tracker, with `private` as given. */
const torrentFile = (isPrivate: boolean) => bencode({
  announce: `https://t.example/${KEY}/announce`,
  info: { length: 1, name: 'Elephants Dream', 'piece length': 16384, pieces: new Uint8Array(20), ...(isPrivate ? { private: 1 } : {}) },
})

const row = (over: Partial<Torrent> = {}): Torrent & { infoHash: string } => ({
  id: '3',
  infoHash: HASH,
  magnet: `magnet:?xt=urn:btih:${HASH}&dn=Elephants%20Dream&tr=${encodeURIComponent(`https://t.example/${KEY}/announce`)}&tr=${encodeURIComponent(`udp://t.example:1337/announce?passkey=${PASSKEY}`)}`,
  name: 'Elephants Dream',
  size: 1,
  downloaded: 0,
  progress: 0.5,
  state: 'downloading',
  down: 10,
  up: 2,
  peers: 4,
  seeds: 1,
  eta: '1m',
  etaSeconds: 60,
  addedAt: 1_700_000_000_000,
  flags: 0,
  queuePosition: 0,
  stats: null,
  noPeers: false,
  ...over,
})

beforeEach(() => store.clear())

describe('a tracker as a plugin sees it', () => {
  it('is its scheme, host and port, with the key in its path, query or user part left out', () => {
    expect(trackerOrigin(`https://t.example/${KEY}/announce`)).toBe('https://t.example')
    expect(trackerOrigin(`udp://t.example:1337/announce?passkey=${PASSKEY}`)).toBe('udp://t.example:1337')
    expect(trackerOrigin(`wss://member:${PASSKEY}@t.example:8443/`)).toBe('wss://t.example:8443')
    expect(trackerOrigin('http://t.example:6969/announce')).toBe('http://t.example:6969')
  })

  it('is nothing for an address that is no tracker', () => {
    expect(trackerOrigin('not a url')).toBeNull()
    expect(trackerOrigin(`javascript:${KEY}`)).toBeNull()
    expect(trackerOrigin(`data:text/plain,${KEY}`)).toBeNull()
  })
})

describe('a torrent as a plugin sees it', () => {
  it('copies a fixed list of fields, and none a row adds', () => {
    const projected = toPluginTorrent(row({ stats: { savePath: '/dl/x' } as Torrent['stats'], retry: { reason: 'stalled', attempt: 1, retryInSeconds: 3 } }), [], null)
    expect(Object.keys(projected).sort()).toEqual([
      'addedAt', 'down', 'downloaded', 'files', 'groups', 'infoHash', 'location', 'magnet', 'name', 'private', 'progress',
      'seedingSeconds', 'size', 'state', 'temporary', 'trackers', 'up', 'uploaded',
    ])
  })

  it('names its state in seven words, its groups by id and its files with the engine\'s index', () => {
    const projected = toPluginTorrent(row({
      state: 'completed',
      files: [{ name: 'a/one', size: 1, offset: 0, index: 0 }, { name: 'a/.pad/2', size: 2, offset: 1, index: 1, pad: true }, { name: 'a/two', size: 1, offset: 3, index: 2 }],
      wantedFiles: [2],
      bitfield: { numPieces: 4, pieceLength: 1, length: 4, pieces: new Uint8Array([0b10000000]) },
      stats: { savePath: '/dl/x', allTimeUpload: 77, seedingSeconds: 9 } as Torrent['stats'],
      ephemeral: true,
    }), [
      { id: 'g1', name: 'Week 2', namedAt: 1, members: [{ infoHash: HASH, at: 1 }] },
      { id: 'g2', name: 'Out', namedAt: 1, members: [{ infoHash: HASH, at: 2, out: true }] },
    ], null)
    expect(projected.state).toBe('done')
    expect(projected.groups).toEqual(['g1'])
    expect(projected.files?.map((f) => [f.index, f.name, f.wanted, f.progress])).toEqual([[0, 'a/one', false, 1], [2, 'a/two', true, 0]])
    expect([projected.uploaded, projected.seedingSeconds, projected.location, projected.temporary]).toEqual([77, 9, 'browser', true])
    expect(toPluginTorrent(row({ state: 'missing', saveTo: 'folder' }), [], null)).toMatchObject({ state: 'missing', location: 'folder', temporary: false })
  })

  it('carries no tracker key from a magnet, while no .torrent is kept to say it is public', () => {
    const projected = toPluginTorrent(row(), [], null)
    expect(projected.private).toBeNull()
    expect(projected.trackers).toEqual(['https://t.example', 'udp://t.example:1337'])
    expect(projected.magnet).toBe(`magnet:?xt=urn:btih:${HASH}&dn=Elephants+Dream`)
    expect(JSON.stringify(projected)).not.toContain(KEY)
    expect(JSON.stringify(projected)).not.toContain(PASSKEY)
  })

  it('carries no key from a kept private .torrent, and gives the file itself to nobody', async () => {
    store.set(torrentKey(HASH), torrentFile(true))
    const facts = await keptOf(HASH)
    expect(facts?.private).toBe(true)
    const projected = toPluginTorrent(row({ magnet: `magnet:?xt=urn:btih:${HASH}` }), [], facts)
    expect(projected.private).toBe(true)
    expect(projected.trackers).toEqual(['https://t.example'])
    expect(JSON.stringify(projected)).not.toContain(KEY)
    expect(await publicTorrentFile(HASH)).toBeNull()
  })

  it('carries the whole trackers, and the file, of a torrent its kept .torrent says is public (control)', async () => {
    const PUBLIC = 'd00d00d00d00d00d00d00d00d00d00d00d00d00d'
    store.set(torrentKey(PUBLIC), torrentFile(false))
    const facts = await keptOf(PUBLIC)
    const projected = toPluginTorrent(row({ infoHash: PUBLIC, magnet: `magnet:?xt=urn:btih:${PUBLIC}` }), [], facts)
    expect(projected.private).toBe(false)
    expect(projected.magnet).toContain(`tr=${encodeURIComponent(`https://t.example/${KEY}/announce`)}`)
    expect(await publicTorrentFile(PUBLIC)).toEqual(torrentFile(false))
  })
})
