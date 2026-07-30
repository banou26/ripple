// The cross-tab protocol, exercised over real BroadcastChannels.
//
// The case that matters most is the generation guard. A torrent handle is a counter inside a
// libtorrent session, so after a handover the same integer names a different torrent. A tab
// that still holds handles from the previous engine and sends `remove` with deleteFiles
// would destroy another torrent's data. Nothing in the UI would report it, and cloud backup
// would then propagate the missing entry to every other device.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TransportHost } from './engine-protocol'

import { CONTROL_CHANNEL, ENGINE_RESET } from './engine-protocol'
import { createChannelTransport, serveFollowers } from './engine-share'

// BroadcastChannel delivery is a task, not a microtask, so awaiting a promise is not enough.
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }

const makeHost = () => ({ message: vi.fn(), error: vi.fn() }) as TransportHost & {
  message: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

// Enough of an EngineClient for the server to relay into.
const makeClient = (started = true) => {
  const sent: any[] = []
  const raws: Array<(msg: any) => void> = []
  return {
    sent,
    emit: (msg: any) => raws.forEach((cb) => cb(msg)),
    client: {
      sendRaw: (msg: any) => { sent.push(msg) },
      onRaw: (cb: (msg: any) => void) => { raws.push(cb); return () => {} },
      latestList: () => null,
      latestState: () => null,
      started: () => started,
      read: vi.fn(async () => new Uint8Array([1, 2, 3])),
    } as any,
  }
}

// Every test talks over the same channel names, and a server left running by one test would
// answer the next test's hello with its own generation. Rather than thread a test-only
// namespace through the production signatures, give each test its own BroadcastChannel
// namespace by swapping the constructor, and close everything it opened afterwards.
const RealBroadcastChannel = globalThis.BroadcastChannel
let testIndex = 0
let opened: BroadcastChannel[] = []

beforeEach(() => {
  const prefix = `test${++testIndex}:`
  opened = []
  globalThis.BroadcastChannel = class extends RealBroadcastChannel {
    constructor(name: string) {
      super(prefix + name)
      opened.push(this as unknown as BroadcastChannel)
    }
  } as unknown as typeof BroadcastChannel
})

afterEach(() => {
  globalThis.BroadcastChannel = RealBroadcastChannel
  // Node keeps the event loop alive for an open channel, so leaving one behind hangs the run.
  for (const channel of opened) { try { channel.close() } catch { /* already closed */ } }
  opened = []
})

const track = <T>(channel: T): T => channel

describe('the leader server', () => {
  it('relays a command stamped with its own generation', async () => {
    const { client, sent } = makeClient()
    // Listening first: the server announces its generation the moment it starts, and a
    // BroadcastChannel opened afterwards would never see it.
    const control = track(new BroadcastChannel(CONTROL_CHANNEL))
    let gen: string | undefined
    control.addEventListener('message', ({ data }) => { if (data?.to === 'all') gen = data.gen })
    const stop = serveFollowers(client)
    await settle()

    expect(gen, 'the server never announced a generation').toBeTruthy()
    control.postMessage({ to: 'leader', from: 'tab-b', gen, msg: { type: 'pause', handle: 7 } })
    await settle()

    expect(sent).toContainEqual({ type: 'pause', handle: 7 })
    stop()
  })

  it('drops a command carrying a handle from a previous engine', async () => {
    const { client, sent } = makeClient()
    const stop = serveFollowers(client)
    await settle()

    // The exact shape that destroys data: a tab that never noticed the handover asking to
    // delete what it thinks is handle 7.
    control_post({ to: 'leader', from: 'tab-b', gen: 'a-dead-generation', msg: { type: 'remove', handle: 7, deleteFiles: true } })
    await settle()

    expect(sent, 'a stale handle reached the new session').toEqual([])
    stop()
  })

  // A player in a closing tab never gets to unregister itself. Its claim on the shared
  // priority map would otherwise hold sequential mode on and keep its file at top priority
  // for the rest of the session, for everyone.
  it('drops a departing tab\'s viewers when it says goodbye', async () => {
    const { client, sent } = makeClient()
    const stop = serveFollowers(client)
    await settle()

    control_post({ to: 'leader', from: 'tab-b', gen: null, msg: { type: 'bye' } })
    await settle()

    expect(sent).toContainEqual({ type: 'unwatch-owner', owner: 'tab-b' })
    stop()
  })

  it('stays silent to a new follower until its own engine has a session', async () => {
    const { client } = makeClient(false)
    const stop = serveFollowers(client)
    const control = track(new BroadcastChannel(CONTROL_CHANNEL))
    const heard: any[] = []
    control.addEventListener('message', ({ data }) => { if (data?.to === 'all') heard.push(data.msg) })
    await settle()
    heard.length = 0

    control.postMessage({ to: 'leader', from: 'tab-b', gen: null, msg: { type: 'hello' } })
    await settle()

    // Announcing readiness early releases the follower's held commands into a worker that
    // drops every one of them until its session exists.
    expect(heard.filter((m) => m?.type === 'ready')).toEqual([])
    stop()
  })
})

// Posting from a throwaway channel, so the server (a different object) receives it.
const control_post = (data: any) => {
  const channel = new BroadcastChannel(CONTROL_CHANNEL)
  channel.postMessage(data)
  setTimeout(() => channel.close(), 50)
}

describe('the follower transport', () => {
  it('holds commands until a leader announces itself, then sends them', async () => {
    const host = makeHost()
    const transport = createChannelTransport(host, 'test-doc')
    const leader = track(new BroadcastChannel(CONTROL_CHANNEL))
    const fromFollower: any[] = []
    leader.addEventListener('message', ({ data }) => { if (data?.to === 'leader') fromFollower.push(data.msg) })

    transport.post({ type: 'pause', handle: 1 }, [])
    await settle()
    expect(fromFollower.filter((m) => m.type === 'pause'), 'sent into a gap where no leader was listening').toEqual([])

    leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'ready' } })
    await settle()
    expect(fromFollower.filter((m) => m.type === 'pause')).toHaveLength(1)

    transport.destroy()
  })

  it('tells the client to drop everything when the generation changes', async () => {
    const host = makeHost()
    const transport = createChannelTransport(host, 'test-doc')
    const leader = track(new BroadcastChannel(CONTROL_CHANNEL))

    leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'ready' } })
    await settle()
    expect(host.message.mock.calls.flat().filter((m: any) => m?.type === ENGINE_RESET)).toEqual([])

    leader.postMessage({ to: 'all', gen: 'g2', msg: { type: 'ready' } })
    await settle()
    expect(host.message.mock.calls.flat().filter((m: any) => m?.type === ENGINE_RESET)).toHaveLength(1)

    transport.destroy()
  })

  it('stamps its generation on what it sends, so the leader can judge it', async () => {
    const host = makeHost()
    const transport = createChannelTransport(host, 'test-doc')
    const leader = track(new BroadcastChannel(CONTROL_CHANNEL))
    const envelopes: any[] = []
    leader.addEventListener('message', ({ data }) => { if (data?.to === 'leader') envelopes.push(data) })

    leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'ready' } })
    await settle()
    transport.post({ type: 'pause', handle: 1 }, [])
    await settle()

    expect(envelopes.find((e) => e.msg.type === 'pause')?.gen).toBe('g1')
    transport.destroy()
  })
})
