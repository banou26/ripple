import type { Session } from 'libtorrent-wasm'
import type { Persisted } from '../../src/torrent/library'

import { expect, it, vi } from 'vitest'

import { LIST_KEY } from '../../src/torrent/library'
import { magnetInfoHash } from '../../src/torrent/magnet'
import { installWorkerGlobals } from '../utils/worker-rig'

/**
 * One torrent reached by its hash in hex and in base32 (a /watch link, a paste, a link from another device) is one
 * entry, kept under the hash it was first listed with. The page joins a running torrent to its entry by the hash its
 * magnet names, so the running torrent keeps its first magnet too.
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
  createHybridStorage: () => ({ usageOf: async () => 0, usageOfStorage: async () => 0, refusedFile: () => undefined }),
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

// made-up hashes, one per case
const v1 = (n: number) => n.toString(16).padStart(2, '0').repeat(20)
const hexMagnet = (n: number) => `magnet:?xt=urn:btih:${v1(n)}&dn=Hex`
const base32Magnet = (n: number) => `magnet:?xt=urn:btih:${base32(v1(n)).toUpperCase()}&dn=Base32`

const listed = () => (store.get(LIST_KEY) as Persisted[] | undefined) ?? []
const entriesOf = (n: number) => listed().filter((e) => [v1(n), base32(v1(n))].includes(e.infoHash))
const handedOf = (n: number) => engine.handed.filter((magnet) => magnet === hexMagnet(n) || magnet === base32Magnet(n))

// in the library on this device and not started, as a synced entry is
const SYNCED = 0x31
store.set(LIST_KEY, [{ infoHash: v1(SYNCED), magnet: hexMagnet(SYNCED), savePath: `/dl/${v1(SYNCED)}`, addedAt: 1, started: false, wantedFiles: [0] }])

const add = async (magnet: string, options: { ephemeral?: boolean } = {}) => {
  const added = rig.of('added').length
  const failed = rig.of('add-failed').length
  rig.send({ type: 'add-magnet', magnet, ...options })
  await vi.waitFor(() => expect(rig.of('added').length + rig.of('add-failed').length, `${magnet}: the add never answered`).toBe(added + failed + 1), { timeout: 5_000 })
  expect(rig.of('add-failed').length, `${magnet}: refused`).toBe(failed)
  return rig.of('added').at(-1)!.handle as number
}

/** What the latest state message says of a handle, as the page reads it. */
const seen = (handle: number) => {
  const torrents = rig.of('state').at(-1)!.torrents as { handle: number, magnet: string }[]
  return torrents.filter((t) => t.handle === handle).map((t) => magnetInfoHash(t.magnet))
}

it('adds a torrent in the library again in the other spelling of its hash as the same entry', async () => {
  // the helper's own control: twenty bytes of 0xff are thirty-two sevens
  expect(base32('ff'.repeat(20))).toBe('7'.repeat(32))
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(0), { timeout: 10_000 })

  const kept = await add(hexMagnet(0x11))
  const reopened = await add(base32Magnet(0x11), { ephemeral: true })
  expect(reopened, 'a second torrent in the engine').toBe(kept)
  expect(handedOf(0x11), 'a running torrent handed to the engine again').toEqual([hexMagnet(0x11)])
  expect(entriesOf(0x11).map((e) => [e.infoHash, e.ephemeral])).toEqual([[v1(0x11), false]])
  const states = rig.of('state').length
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(states))
  expect(seen(kept)).toEqual([v1(0x11)])

  const first = await add(base32Magnet(0x21))
  expect(await add(hexMagnet(0x21))).toBe(first)
  expect(entriesOf(0x21).map((e) => e.infoHash)).toEqual([base32(v1(0x21))])

  // watched first, then added to the library in the other spelling: kept, under the hash it was watched by
  const watched = await add(hexMagnet(0x41), { ephemeral: true })
  expect(entriesOf(0x41).map((e) => [e.infoHash, e.ephemeral])).toEqual([[v1(0x41), true]])
  expect(await add(base32Magnet(0x41))).toBe(watched)
  expect(entriesOf(0x41).map((e) => [e.infoHash, e.ephemeral])).toEqual([[v1(0x41), false]])
}, 60_000)

it('starts a listed torrent added in the other spelling under its entry, where its bytes are', async () => {
  const h = await add(base32Magnet(SYNCED))
  expect(entriesOf(SYNCED).map((e) => [e.infoHash, e.savePath, e.wantedFiles])).toEqual([[v1(SYNCED), `/dl/${v1(SYNCED)}`, [0]]])
  const states = rig.of('state').length
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(states))
  expect(seen(h)).toEqual([v1(SYNCED)])
}, 30_000)
