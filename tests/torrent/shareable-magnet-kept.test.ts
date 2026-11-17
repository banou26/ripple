import { expect, it, vi } from 'vitest'

/**
 * A magnet add keeps a .torrent once its metadata lands. Copy magnet and a share link go on handing out the magnet it
 * was added with, which can say what a file cannot (a web seed, the name as written), and the kept file still tells
 * whether the torrent is private, which leaves it out of share links.
 */

const store = new Map<string, unknown>()
vi.mock('idb-keyval', () => ({ get: async (key: string) => store.get(key) }))

const { buildTorrentFile, knownPrivate, shareableMagnet } = await import('../../src/torrent/torrent-export')

const HASH = 'a'.repeat(40)
const encoder = new TextEncoder()
const info = (extra = '') => encoder.encode(`d6:lengthi11e4:name5:x.mkv12:piece lengthi16384e6:pieces20:${'p'.repeat(20)}${extra}e`)

it('copies a magnet add as the magnet it was added with, though a .torrent is kept for it', async () => {
  const magnet = `magnet:?xt=urn:btih:${HASH}&dn=As%20written&tr=udp%3A%2F%2Ft.example%3A1&ws=https%3A%2F%2Fseed.example%2F`
  store.set('ripple:torrent:' + HASH, buildTorrentFile(info(), { trackers: ['udp://t.example:1'] }))
  expect(await shareableMagnet({ infoHash: HASH, magnet })).toBe(magnet)
  // THE CONTROL: a .torrent add's bare identity is still read from its file
  expect(await shareableMagnet({ infoHash: HASH, magnet: `magnet:?xt=urn:btih:${HASH}` })).toContain('dn=x.mkv')
})

it('knows a magnet add to be private once its kept .torrent says so', async () => {
  store.set('ripple:torrent:' + HASH, buildTorrentFile(info('7:privatei1e')))
  expect(await knownPrivate(HASH)).toBe(true)
})
