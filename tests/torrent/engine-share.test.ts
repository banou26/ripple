// A torrent handle is a counter inside a libtorrent session, so without the generation guard
// a `remove` carrying a handle from a previous engine destroys another torrent's data.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TransportHost } from '../../src/torrent/engine-protocol'

import { CONTROL_CHANNEL, ENGINE_RESET, LEADER_SILENCE_MS } from '../../src/torrent/engine-protocol'
import { createChannelTransport, serveFollowers } from '../../src/torrent/engine-share'

// BroadcastChannel delivery is a task, not a microtask, so awaiting a promise is not enough.
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }

const makeHost = () => ({ message: vi.fn(), error: vi.fn() }) as TransportHost & {
  message: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

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

// every test shares the channel names, so each gets its own namespace via the constructor
const RealBroadcastChannel = globalThis.BroadcastChannel
let testIndex = 0
let opened: BroadcastChannel[] = []

beforeEach(() => {
  const prefix = `test${++testIndex}:`
  opened = []
  globalThis.BroadcastChannel = class extends RealBroadcastChannel {
    constructor(name: string) {
      super(prefix + name)
      opened.push(this)
    }
  }
})

afterEach(() => {
  globalThis.BroadcastChannel = RealBroadcastChannel
  // Node keeps the event loop alive for an open channel, so leaving one behind hangs the run.
  for (const channel of opened) { try { channel.close() } catch { } }
  opened = []
})

const track = <T>(channel: T): T => channel

describe('the leader server', () => {
  it('relays a command stamped with its own generation', async () => {
    const { client, sent } = makeClient()
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

    control_post({ to: 'leader', from: 'tab-b', gen: 'a-dead-generation', msg: { type: 'remove', handle: 7, deleteFiles: true } })
    await settle()

    expect(sent, 'a stale handle reached the new session').toEqual([])
    stop()
  })

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

    expect(heard.filter((m) => m?.type === 'ready')).toEqual([])
    stop()
  })
})

// a BroadcastChannel never receives its own posts, so post from a throwaway one
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

  it('recovers from a quiet spell on an ordinary broadcast, not just on ready', async () => {
    vi.useFakeTimers()
    try {
      const host = makeHost()
      const transport = createChannelTransport(host, 'test-doc')
      const leader = track(new BroadcastChannel(CONTROL_CHANNEL))
      const fromFollower: any[] = []
      leader.addEventListener('message', ({ data }) => { if (data?.to === 'leader') fromFollower.push(data.msg) })

      leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'ready' } })
      await vi.advanceTimersByTimeAsync(50)

      await vi.advanceTimersByTimeAsync(LEADER_SILENCE_MS + 1_000)
      leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'state', torrents: [] } })
      await vi.advanceTimersByTimeAsync(50)

      transport.post({ type: 'pause', handle: 1 }, [])
      await vi.advanceTimersByTimeAsync(50)

      expect(fromFollower.filter((m) => m.type === 'pause'), 'the follower never started talking again').toHaveLength(1)
      transport.destroy()
    } finally {
      vi.useRealTimers()
    }
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

// A command issued before any leader has spoken is HELD, and the transport is then replaced the moment
// this document wins the election. Dropping the backlog there loses the page's own request in silence:
// /embed calls addMagnet on mount, inside exactly that window, and the engine then never hears about
// the torrent while the player waits on metadata forever.
describe('a queued command survives the swap to leadership', () => {
  it('hands its undelivered commands to whatever replaces it', async () => {
    const host = makeHost()
    const transport = createChannelTransport(host, 'test-doc')

    // no leader has spoken, so these are held rather than sent
    transport.post({ type: 'add-magnet', magnet: 'magnet:?xt=urn:btih:abc' }, [])
    transport.post({ type: 'watch', viewer: 'v1' }, [])

    const carried = transport.pending!()
    expect(carried.map((m) => m.type)).toEqual(['add-magnet', 'watch'])

    // taken exactly once: replaying a command twice would add the torrent twice
    expect(transport.pending!()).toEqual([])
    transport.destroy()
  })

  it('does not hand over a command it already delivered', async () => {
    const host = makeHost()
    const leader = new BroadcastChannel(CONTROL_CHANNEL)
    const transport = createChannelTransport(host, 'test-doc')

    // any post-session broadcast proves a leader is up, which flushes and un-queues
    leader.postMessage({ to: 'all', gen: 'g1', msg: { type: 'ready' } })
    await settle()
    transport.post({ type: 'pause', handle: 1 }, [])
    await settle()

    expect(transport.pending!()).toEqual([])
    transport.destroy()
    leader.close()
  })
})
