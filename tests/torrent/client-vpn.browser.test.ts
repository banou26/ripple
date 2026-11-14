// The page's half of the VPN switch: which engine worker it starts, what it gives each, and that a change of
// the stored choice replaces the worker and leaves exactly one. A browser test because the client registers
// window listeners as it is built.
import { RTCPeerConnection } from '@banou/ponyfill/webrtc'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { destroyTorrentClient, getTorrentClient, setVpn } from '../../src/torrent/client'
import { ICE_SERVERS } from '../../src/torrent/vpn-config'

type Message = { type: string, id?: number, [key: string]: unknown }

class FakeWorker {
  static made: FakeWorker[] = []
  terminated = false
  posted: Message[] = []
  private listeners = new Set<(event: { data: unknown }) => void>()
  constructor (readonly url: URL, readonly options: WorkerOptions) { FakeWorker.made.push(this) }
  postMessage (message: Message) { this.posted.push(message) }
  terminate () { this.terminated = true }
  addEventListener (type: string, listener: (event: { data: unknown }) => void) { if (type === 'message') this.listeners.add(listener) }
  removeEventListener (_type: string, listener: (event: { data: unknown }) => void) { this.listeners.delete(listener) }
  /** The worker speaks to its page. */
  say (data: unknown) { for (const listener of [...this.listeners]) listener({ data }) }
}

const page = vi.hoisted(() => ({ relayed: [] as unknown[], served: [] as { port: unknown, options: unknown }[], closed: 0 }))

// whatever the constant is set to in the source, this file is about the switch working
vi.mock('../../src/torrent/vpn-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/torrent/vpn-config')>()),
  WEBRTC_PEERS: true,
}))
vi.mock('@fkn/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fkn/lib')>()),
  relayWorker: async (worker: unknown) => { page.relayed.push(worker) },
}))
vi.mock('libtorrent-wasm/webtorrent/page', () => ({
  servePeerLinks: (port: unknown, options: unknown) => { page.served.push({ port, options }); return () => { page.closed++ } },
}))

const alive = () => FakeWorker.made.filter((worker) => !worker.terminated)

beforeEach(() => {
  localStorage.removeItem('ripple:vpn')
  FakeWorker.made = []
  page.relayed = []
  page.served = []
  page.closed = 0
  vi.stubGlobal('Worker', FakeWorker)
  // no election: this page runs the engine, as in a browser with no Web Locks
  vi.stubGlobal('navigator', new Proxy(navigator, { get: (target, key) => key === 'locks' ? undefined : Reflect.get(target, key) }))
})

afterEach(() => {
  destroyTorrentClient()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.removeItem('ripple:vpn')
})

it('starts the engine behind the relay, bridged to it, while the VPN is on', () => {
  getTorrentClient()
  expect(FakeWorker.made).toHaveLength(1)
  expect(FakeWorker.made[0]!.options).toEqual({ type: 'module' })
  expect(page.relayed).toEqual([FakeWorker.made[0]])
})

it('starts the engine with no relay, unbridged, and makes its WebRTC connections, while the VPN is off', () => {
  localStorage.setItem('ripple:vpn', 'off')
  const client = getTorrentClient()
  const heard: unknown[] = []
  ;(client as unknown as { onRaw: (cb: (message: unknown) => void) => void }).onRaw((message) => heard.push(message))
  expect(FakeWorker.made).toHaveLength(1)
  expect(FakeWorker.made[0]!.options).toEqual({ type: 'module', name: 'direct' })
  expect(page.relayed, 'a worker that is not bridged cannot reach the relay').toEqual([])

  const { port2 } = new MessageChannel()
  FakeWorker.made[0]!.say({ type: 'peer-links', port: port2 })
  expect(page.served).toEqual([{ port: port2, options: { RTCPeerConnection, iceServers: ICE_SERVERS } }])
  expect(heard, 'the port is the page\'s own business, not an engine message').toEqual([])
})

it('replaces the worker when the VPN is switched, and ends the connections the page made for the old one', async () => {
  localStorage.setItem('ripple:vpn', 'off')
  getTorrentClient()
  FakeWorker.made[0]!.say({ type: 'peer-links', port: new MessageChannel().port2 })

  await setVpn(true)
  expect(localStorage.getItem('ripple:vpn')).toBeNull()
  expect(FakeWorker.made.map((worker) => [worker.options.name, worker.terminated])).toEqual([['direct', true], [undefined, false]])
  expect(page.closed).toBe(1)
  expect(page.relayed).toEqual([FakeWorker.made[1]])

  await setVpn(false)
  expect(localStorage.getItem('ripple:vpn')).toBe('off')
  expect(FakeWorker.made.map((worker) => [worker.options.name, worker.terminated])).toEqual([['direct', true], [undefined, true], ['direct', false]])
})

it('lets a running engine write its resume data first, for 2 s at most', async () => {
  getTorrentClient()
  const first = FakeWorker.made[0]!
  first.say({ type: 'ready' })

  // answered: replaced as soon as it says so
  const off = setVpn(false)
  await vi.waitFor(() => expect(first.posted.map((message) => message.type)).toContain('flush-resume'))
  expect(alive()).toEqual([first])
  first.say({ type: 'answer', id: first.posted.find((message) => message.type === 'flush-resume')!.id })
  await off
  expect(first.terminated).toBe(true)

  // never answered: replaced all the same
  const second = FakeWorker.made[1]!
  second.say({ type: 'ready' })
  vi.useFakeTimers()
  const on = setVpn(true)
  await vi.advanceTimersByTimeAsync(1_999)
  expect(alive()).toEqual([second])
  await vi.advanceTimersByTimeAsync(1)
  await on
  expect(second.terminated).toBe(true)
  expect(alive()).toHaveLength(1)
})

it('follows a change another page stored', async () => {
  getTorrentClient()
  localStorage.setItem('ripple:vpn', 'off')
  window.dispatchEvent(new StorageEvent('storage', { key: 'ripple:vpn' }))
  await vi.waitFor(() => expect(FakeWorker.made).toHaveLength(2))
  expect(FakeWorker.made[0]!.terminated).toBe(true)
  expect(FakeWorker.made[1]!.options.name).toBe('direct')
})

it('leaves one worker, on the last choice, after 20 changes in a row', async () => {
  getTorrentClient()
  const changes: Promise<void>[] = []
  for (let i = 0; i < 20; i++) {
    changes.push(setVpn(i % 2 === 1))
    // some within one step of the change before, some after a worker has answered ready
    if (i % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 3))
    if (i % 5 === 0) FakeWorker.made.at(-1)!.say({ type: 'ready' })
    for (const worker of alive()) {
      const flush = worker.posted.find((message) => message.type === 'flush-resume')
      if (flush) worker.say({ type: 'answer', id: flush.id })
    }
  }
  for (const worker of alive()) {
    const flush = worker.posted.find((message) => message.type === 'flush-resume')
    if (flush) worker.say({ type: 'answer', id: flush.id })
  }
  await Promise.all(changes)

  expect(FakeWorker.made.length).toBeGreaterThan(1)
  expect(alive()).toHaveLength(1)
  expect(alive()[0]).toBe(FakeWorker.made.at(-1))
  expect(alive()[0]!.options.name, 'the last change turned the VPN on').toBeUndefined()
  expect(localStorage.getItem('ripple:vpn')).toBeNull()
})

it('says which transport the engine runs on, to a page that asks later too', () => {
  const client = getTorrentClient()
  const early: string[] = []
  client.onTransport((transport) => early.push(transport))
  expect(early, 'nothing is known before an engine has said').toEqual([])
  FakeWorker.made[0]!.say({ type: 'ready' })
  FakeWorker.made[0]!.say({ type: 'state', torrents: [], transport: 'relay' })
  FakeWorker.made[0]!.say({ type: 'state', torrents: [], transport: 'relay' })
  FakeWorker.made[0]!.say({ type: 'state', torrents: [], transport: 'direct' })
  const late: string[] = []
  client.onTransport((transport) => late.push(transport))
  expect(early).toEqual(['relay', 'direct'])
  expect(late).toEqual(['direct'])
})

it('forgets the transport of an engine it replaced, until the new one says its own', async () => {
  const client = getTorrentClient()
  FakeWorker.made[0]!.say({ type: 'ready' })
  FakeWorker.made[0]!.say({ type: 'state', torrents: [], transport: 'relay' })
  const off = setVpn(false)
  await vi.waitFor(() => expect(FakeWorker.made[0]!.posted.map((message) => message.type)).toContain('flush-resume'))
  FakeWorker.made[0]!.say({ type: 'answer', id: FakeWorker.made[0]!.posted.find((message) => message.type === 'flush-resume')!.id })
  await off

  const told: string[] = []
  client.onTransport((transport) => told.push(transport))
  expect(told, 'the engine that said relay is gone').toEqual([])
  FakeWorker.made[1]!.say({ type: 'ready' })
  FakeWorker.made[1]!.say({ type: 'state', torrents: [], transport: 'direct' })
  expect(told).toEqual(['direct'])
})
