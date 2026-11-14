// The one constant that stops WebRTC peers: the engine then starts as it did before them, whatever the page named it.
import { expect, it, vi } from 'vitest'

import { installWorkerGlobals } from '../utils/worker-rig'

const engine = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  asked: { createSocket: vi.fn(), connect: vi.fn(), createWebRTC: vi.fn(), webtorrentPeers: vi.fn(), pageLinks: vi.fn(), rtcLinks: vi.fn(), offlineHost: vi.fn() },
}))

const rig = installWorkerGlobals({ estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }), name: 'direct' })

vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: false,
}))
vi.mock('@fkn/lib/net', () => ({ connect: engine.asked.connect }))
vi.mock('@fkn/lib/dgram', () => ({ createSocket: engine.asked.createSocket }))
vi.mock('@fkn/lib/websocket', () => ({ WebSocket: class {} }))
vi.mock('@fkn/lib/dns', () => ({ lookup: async () => undefined }))
vi.mock('libtorrent-wasm/webrtc', () => ({ createWebRTC: engine.asked.createWebRTC }))
vi.mock('libtorrent-wasm/webtorrent', () => ({
  webtorrentPeers: engine.asked.webtorrentPeers,
  pageLinks: engine.asked.pageLinks,
  rtcLinks: engine.asked.rtcLinks,
}))
vi.mock('libtorrent-wasm', async () => {
  const { fakeSession } = await import('../utils/worker-rig')
  return {
    createSession: async (options: Record<string, unknown>) => { engine.created.push(options); return fakeSession() },
    offlineHost: engine.asked.offlineHost,
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

it('starts the engine behind the relay and looks for no WebRTC peer, even in a worker named for the VPN off', async () => {
  await import('../../src/torrent/worker')
  await vi.waitFor(() => expect(rig.of('ready')).toHaveLength(1))
  // two pumps, so anything started after the session had its chance
  await vi.waitFor(() => expect(rig.of('state').length).toBeGreaterThan(2), { timeout: 3_000 })

  const options = engine.created[0]!
  expect(options.net).toBe(await import('@fkn/lib/net'))
  expect(options.dgram).toBe(await import('@fkn/lib/dgram'))
  expect(options.dnsLookup).toBe((await import('@fkn/lib/dns')).lookup)
  expect(Object.keys(options).sort()).toEqual(['dgram', 'dnsLookup', 'net', 'storage', 'utpReceiveBufferBytes'])
  expect(rig.of('state').at(-1)!.transport).toBe('relay')
  expect(rig.of('peer-links')).toEqual([])
  for (const [name, call] of Object.entries(engine.asked)) expect(call, name).toHaveBeenCalledTimes(0)
})
