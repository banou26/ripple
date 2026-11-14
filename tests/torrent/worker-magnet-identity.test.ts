import type { Session } from 'libtorrent-wasm'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { LIST_KEY } from '../../src/torrent/library'
import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * A magnet the worker adds is listed under the torrent the REAL engine downloads, or refused before the engine sees
 * it. Every way a magnet comes in (the add box, a paste, a drop, `/add`, a share link, the watch and download pages,
 * an embedder's prepare) ends in this one add, with the magnet as it arrived.
 */

const GiB = 1024 ** 3

const engine = vi.hoisted(() => ({ session: null as Session | null, handed: [] as string[] }))
const store = vi.hoisted(() => new Map<string, unknown>())

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * GiB }) })

// an offline network: nothing here names a tracker or a peer, so nothing dials
vi.mock('@fkn/lib/net', () => ({ connect: () => { throw new Error('offline') }, createServer: () => ({ on () {}, listen () {}, close () {} }) }))
vi.mock('@fkn/lib/dgram', () => ({ createSocket: () => ({ on () {}, bind () {}, send () {}, close () {} }) }))
vi.mock('libtorrent-wasm', async (importOriginal) => {
  const real = await importOriginal<typeof import('libtorrent-wasm')>()
  return {
    ...real,
    createSession: async (options: Parameters<typeof real.createSession>[0]) => {
      const session = await real.createSession({ ...options, reserveListenPort: false, enableDht: false })
      const add = session.addMagnet.bind(session)
      session.addMagnet = (magnet: string, savePath?: string) => { engine.handed.push(magnet); return add(magnet, savePath) }
      engine.session = session
      return session
    },
  }
})
vi.mock('../../src/torrent/hybrid-storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/hybrid-storage')>()),
  createHybridStorage: () => ({ usageOf: async () => 0, refusedFile: () => undefined }),
}))
vi.mock('idb-keyval', () => ({
  get: async (key: string) => store.get(key),
  set: async (key: string, value: unknown) => { store.set(key, value) },
  del: async (key: string) => { store.delete(key) },
  update: async (key: string, fn: (prev: unknown) => unknown) => { store.set(key, fn(store.get(key))) },
}))

const base32 = (hex: string) => {
  let bits = ''
  for (const char of hex) bits += parseInt(char, 16).toString(2).padStart(4, '0')
  return bits.match(/.{5}/g)!.map((five) => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(five, 2)]).join('')
}

// made-up hashes, a fresh pair per case so no add finds an earlier one already in the engine
const v1 = (n: number) => n.toString(16).padStart(2, '0').repeat(20)
const v2 = (n: number) => n.toString(16).padStart(2, '0').repeat(32)

/** A magnet, the id it is listed under (null: it names two torrents and is refused), and that id in hex. */
const CASES: [string, string, string | null, string?][] = [
  ['xt and xt.1', `magnet:?xt=urn:btih:${v1(0x11)}&xt.1=urn:btih:${v1(0x12)}&dn=First`, null],
  ['xt twice', `magnet:?xt=urn:btih:${v1(0x21)}&xt=urn:btih:${v1(0x22)}&dn=First`, null],
  ['xt and XT', `magnet:?xt=urn:btih:${v1(0x31)}&XT=urn:btih:${v1(0x32)}&dn=First`, null],
  ['xt and a percent-escaped xt', `magnet:?xt=urn:btih:${v1(0x41)}&xt=urn%3Abtih%3A${v1(0x42)}`, null],
  ['two v2 hashes', `magnet:?xt=urn:btmh:1220${v2(0x51)}&xt=urn:btmh:1220${v2(0x52)}`, null],
  ['xt.1 alone', `magnet:?xt.1=urn:btih:${v1(0x61)}`, v1(0x61)],
  ['a hybrid', `magnet:?xt=urn:btih:${v1(0x71)}&xt=urn:btmh:1220${v2(0x71)}&dn=Hybrid`, v1(0x71)],
  ['a hybrid written xt.1 and xt.2', `magnet:?xt.1=urn:btih:${v1(0x81)}&xt.2=urn:btmh:1220${v2(0x81)}`, v1(0x81)],
  ['one v1 in hex then in base32', `magnet:?xt=urn:btih:${v1(0x91)}&xt=urn:btih:${base32(v1(0x91)).toUpperCase()}`, v1(0x91)],
  ['one v1 in base32 then in hex', `magnet:?xt=urn:btih:${base32(v1(0xa1)).toUpperCase()}&xt=urn:btih:${v1(0xa1)}`, base32(v1(0xa1)), v1(0xa1)],
  ['one v1 in upper then lower case', `magnet:?xt=urn:btih:${v1(0xb1).toUpperCase()}&xt=urn:btih:${v1(0xb1)}`, v1(0xb1)],
  ['an upper case URN:BTIH beside a v2', `magnet:?xt=URN:BTIH:${v1(0xc1)}&xt=urn:btmh:1220${v2(0xc2)}`, v2(0xc2)],
  ['a parameter with no = before a v1, beside a v2', `magnet:?flag&xt=urn:btih:${v1(0xd1)}&xt=urn:btmh:1220${v2(0xd2)}`, v2(0xd2)],
]

const listed = () => (store.get(LIST_KEY) as Persisted[] | undefined) ?? []

it('lists a magnet under the torrent the engine downloads, and refuses one that names two', async () => {
  // the helper's own control: twenty bytes of 0xff are thirty-two sevens
  expect(base32('ff'.repeat(20))).toBe('7'.repeat(32))

  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state')).toHaveLength(1), { timeout: 10_000 })

  const seen: Record<string, { listed: string | null, downloads: string | null }> = {}
  for (const [name, magnet] of CASES) {
    const added = rig.of('added').length
    const failed = rig.of('add-failed').length
    rig.send({ type: 'add-magnet', magnet })
    await vi.waitFor(() => expect(rig.of('added').length + rig.of('add-failed').length, `${name}: the add never answered`).toBe(added + failed + 1), { timeout: 5_000 })
    let downloads: string | null = null
    if (rig.of('added').length > added) {
      const handle = rig.of('added').at(-1)!.handle as number
      await vi.waitFor(() => expect(downloads = engine.session!.infohash(handle), `${name}: the engine never named it`).not.toBeNull(), { timeout: 5_000 })
    }
    seen[name] = { listed: listed().find((e) => e.magnet === magnet)?.infoHash ?? null, downloads }
  }

  expect(seen).toEqual(Object.fromEntries(CASES.map(([name, , key, hex]) => [name, { listed: key, downloads: hex ?? key }])))
  const refused = CASES.filter(([, , key]) => key === null)
  expect(rig.of('add-failed').map((m) => m.message)).toEqual(refused.map(() => ({ message: 'That is not a valid magnet link' })))
  for (const [name, magnet] of refused) expect(engine.handed, `${name}: handed to the engine`).not.toContain(magnet)
}, 60_000)
