import { describe, expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A `.torrent` add is handed out with the name and trackers its file carried, while the identity the
 * worker stores for it stays `xt` alone. Driven through the real add handler, so the key the worker
 * keeps the bytes under and the key the page reads them from are proved to agree.
 */

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 1, quota: 10_000_000_000 }) })

let addedHash = ''

vi.mock('@fkn/lib/net', () => ({}))
vi.mock('@fkn/lib/dgram', () => ({}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async () => fakeSession({ infohash: () => addedHash || null, infohashV2: () => null }),
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

const encoder = new TextEncoder()
const str = (value: string) => `${encoder.encode(value).length}:${value}`

const NAME = 'A small file.txt'
const TRACKERS = ['udp://tracker.one.example:1337/announce', 'https://tracker.two.example/announce']
const WEB_SEED = 'https://seed.example/files/'

const TORRENT = encoder.encode(
  'd'
  + str('announce') + str(TRACKERS[0]!)
  + str('announce-list') + 'l' + TRACKERS.map((tracker) => 'l' + str(tracker) + 'e').join('') + 'e'
  + str('info') + 'd'
  + str('length') + 'i11e' + str('name') + str(NAME) + str('piece length') + 'i16384e' + str('pieces') + str('p'.repeat(20))
  + 'e'
  + str('url-list') + 'l' + str(WEB_SEED) + 'e'
  + 'e',
)

// a private tracker's torrent: its address carries the member's own key
const PRIVATE = encoder.encode(
  'd'
  + str('announce') + str('https://tracker.private.example/0123456789abcdef/announce')
  + str('info') + 'd'
  + str('length') + 'i11e' + str('name') + str(NAME) + str('piece length') + 'i16384e' + str('pieces') + str('p'.repeat(20))
  + str('private') + 'i1e'
  + 'e'
  + 'e',
)

describe('a torrent added from a .torrent file', () => {
  it('is copied, shared and saved with its name and trackers, while its identity stays bare', async () => {
    const { readTorrentFile } = await import('../../src/torrent/torrent-file')
    const { magnetInfoHash, magnetParam, magnetParams } = await import('../../src/torrent/magnet')
    const { knownPrivate, shareableMagnet, torrentFileFor } = await import('../../src/torrent/torrent-export')

    const read = await readTorrentFile(TORRENT)
    addedHash = magnetInfoHash(read?.magnet ?? '') ?? ''
    expect(addedHash, 'the fixture is not a torrent, so this test proves nothing').toMatch(/^[0-9a-f]{40}$/)

    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))
    rig.send({ type: 'add-torrent-file', bytes: TORRENT, savePath: '/dl', ephemeral: false, paused: false })
    await vi.waitFor(() => expect(rig.of('added'), 'the add never landed').toHaveLength(1))
    expect(rig.of('add-failed'), 'a first add was said to be in the list already').toEqual([])

    const identity = rig.of('added')[0]!.magnet as string
    expect(identity, 'the stored identity changed, and every existing library entry is compared against it')
      .toBe(`magnet:?xt=urn:btih:${addedHash}`)

    const shared = await shareableMagnet({ infoHash: addedHash, magnet: identity })
    expect(magnetInfoHash(shared ?? '')).toBe(addedHash)
    expect(magnetParam(shared ?? '', 'dn'), 'the copied magnet has no name').toBe(NAME)
    expect(magnetParams(shared ?? '', 'tr'), 'the copied magnet lost its trackers').toEqual(TRACKERS)
    expect(await knownPrivate(addedHash), 'a public torrent was refused a share link').toBe(false)

    // a clock that is already past the flush wait, so a save that ignores the kept file answers null at once
    let clock = 0
    const saved = await torrentFileFor({
      infoHash: addedHash, magnet: identity, flush: () => {}, now: () => (clock += 60_000), wait: async () => {},
    })
    expect(saved, 'Save .torrent did not hand back the file the torrent was added from').toEqual(TORRENT)
    const text = new TextDecoder().decode(saved ?? new Uint8Array())
    expect(text).toContain(`8:announce${str(TRACKERS[0]!)}`)
    expect(text).toContain(`8:url-list`)
  })

  it('keeps the stored link for a row synced from another device, which has no file here', async () => {
    const { knownPrivate, shareableMagnet } = await import('../../src/torrent/torrent-export')
    const synced = `magnet:?xt=urn:btih:${'d'.repeat(40)}`
    expect(await shareableMagnet({ infoHash: 'd'.repeat(40), magnet: synced })).toBe(synced)
    expect(await knownPrivate('d'.repeat(40))).toBe(false)
  })

  it('is known to be private when the file it was added from says so', async () => {
    const { readTorrentFile } = await import('../../src/torrent/torrent-file')
    const { magnetInfoHash } = await import('../../src/torrent/magnet')
    const { knownPrivate } = await import('../../src/torrent/torrent-export')

    addedHash = magnetInfoHash((await readTorrentFile(PRIVATE))?.magnet ?? '') ?? ''
    expect(addedHash, 'the fixture is not a torrent, so this test proves nothing').toMatch(/^[0-9a-f]{40}$/)
    expect(await knownPrivate(addedHash), 'known before it was added').toBe(false)

    await import('../../src/torrent/worker')
    await vi.waitFor(() => expect(rig.of('ready'), 'the engine never started').toHaveLength(1))
    const before = rig.of('added').length
    rig.send({ type: 'add-torrent-file', bytes: PRIVATE, savePath: '/dl', ephemeral: false, paused: false })
    await vi.waitFor(() => expect(rig.of('added'), 'the add never landed').toHaveLength(before + 1))

    expect(await knownPrivate(addedHash), 'a private tracker\'s torrent would be shared with its key').toBe(true)
  })
})
