import type { EngineClient } from './client'
import type { Generation, Transport, TransportHost } from './engine-protocol'

import {
  BROADCAST_TYPES,
  CONTROL_CHANNEL,
  ENGINE_RESET,
  LEADER_SILENCE_MS,
  newClientId,
  newGeneration,
  replyChannel,
} from './engine-protocol'

export const createChannelTransport = (host: TransportHost, clientId: string): Transport => {
  const control = new BroadcastChannel(CONTROL_CHANNEL)
  const replies = new BroadcastChannel(replyChannel(clientId))
  let gen: Generation | null = null
  let leaderUp = false
  let queued: any[] = []
  let silence: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const say = (msg: any) => {
    if (closed) return
    try { control.postMessage({ to: 'leader', from: clientId, gen, msg }) }
    catch { /* gone */ }
  }

  const heardFromLeader = () => {
    clearTimeout(silence)
    silence = setTimeout(() => { leaderUp = false }, LEADER_SILENCE_MS)
  }

  const flush = () => {
    const pending = queued
    queued = []
    for (const held of pending) say(held)
  }

  // `ready` is sent once and never again, so any of these three proves what ready proves.
  const PROVES_READY = new Set(['ready', 'state', 'list'])

  const observe = (envelopeGen: Generation, msg: any) => {
    const changed = gen !== null && envelopeGen !== gen
    gen = envelopeGen
    if (changed) { leaderUp = false; host.message({ type: ENGINE_RESET }) }
    heardFromLeader()
    if (msg?.type === ENGINE_RESET) return
    if (!leaderUp && PROVES_READY.has(msg?.type)) { leaderUp = true; flush() }
    host.message(msg)
  }

  const onControl = ({ data }: MessageEvent) => {
    const env = data as { to?: string, gen?: Generation, msg?: any }
    // BroadcastChannel never delivers to the poster, so this only ever sees leader broadcasts.
    if (env?.to !== 'all' || !env.msg || !env.gen) return
    observe(env.gen, env.msg)
  }

  const onReply = ({ data }: MessageEvent) => {
    const env = data as { gen?: Generation, msg?: any }
    if (!env?.msg || !env.gen) return
    observe(env.gen, env.msg)
  }

  control.addEventListener('message', onControl)
  replies.addEventListener('message', onReply)

  say({ type: 'hello' })

  const onPageHide = () => say({ type: 'bye' })
  globalThis.addEventListener?.('pagehide', onPageHide)

  return {
    // The transfer list is dropped: BroadcastChannel takes none at all, so the payload is copied.
    post: (msg) => {
      if (!leaderUp) { queued.push(msg); return }
      say(msg)
    },
    // handed to whatever transport replaces this one, so a command held while no leader had spoken is
    // re-issued rather than dropped. Cleared as it is taken: it must never be delivered twice.
    pending: () => {
      const held = queued
      queued = []
      return held
    },
    destroy: () => {
      say({ type: 'bye' })
      closed = true
      clearTimeout(silence)
      globalThis.removeEventListener?.('pagehide', onPageHide)
      control.removeEventListener('message', onControl)
      replies.removeEventListener('message', onReply)
      control.close()
      replies.close()
    },
  }
}

export const serveFollowers = (client: EngineClient): () => void => {
  const control = new BroadcastChannel(CONTROL_CHANNEL)
  const followers = new Map<string, BroadcastChannel>()
  const gen = newGeneration()

  const broadcast = (msg: any) => {
    try { control.postMessage({ to: 'all', gen, msg }) } catch { /* closing */ }
  }

  const reply = (clientId: string, msg: any) => {
    // A lookup, never a create: a read finishing after its follower said goodbye would reopen the channel.
    const channel = followers.get(clientId)
    if (!channel) return
    try { channel.postMessage({ gen, msg }) } catch { /* follower went away */ }
  }

  const drop = (clientId: string) => {
    const channel = followers.get(clientId)
    if (!channel) return
    followers.delete(clientId)
    try { channel.close() } catch { /* already closed */ }
  }

  const onControl = ({ data }: MessageEvent) => {
    const env = data as { to?: string, from?: string, gen?: Generation | null, msg?: any }
    if (env?.to !== 'leader' || !env.from || !env.msg) return
    const from = env.from
    const msg = env.msg

    if (msg.type === 'bye') {
      drop(from)
      // The viewer ids that tab handed out are prefixed with the id it is saying goodbye under.
      client.sendRaw({ type: 'unwatch-owner', owner: from })
      return
    }

    if (msg.type === 'hello') {
      // A follower has no generation yet, so hello is the one message accepted without one.
      if (!followers.has(from)) followers.set(from, new BroadcastChannel(replyChannel(from)))
      // Saying ready before the session exists would release held commands into a worker that drops them.
      if (!client.started()) return
      reply(from, { type: 'ready' })
      const list = client.latestList()
      if (list) reply(from, { type: 'list', list })
      const state = client.latestState()
      if (state) reply(from, { type: 'state', torrents: state })
      return
    }

    if (env.gen !== gen) return

    if (msg.type === 'read') {
      client
        .read(msg.handle, msg.fileIndex, msg.offset, msg.len, msg.prioritize, msg.viewer)
        .then((data) => reply(from, { type: 'read-result', id: msg.id, data }))
        .catch((error) => reply(from, { type: 'read-error', id: msg.id, error: String(error?.message ?? error) }))
      return
    }

    client.sendRaw(msg)
  }

  control.addEventListener('message', onControl)

  const offRaw = client.onRaw((msg) => {
    if (msg?.type && BROADCAST_TYPES.has(msg.type)) broadcast(msg)
  })

  // Tells tabs that were talking to a previous engine that it is gone, before this one says anything.
  broadcast({ type: ENGINE_RESET })

  return () => {
    offRaw()
    control.removeEventListener('message', onControl)
    for (const clientId of [...followers.keys()]) drop(clientId)
    try { control.close() } catch { /* already closed */ }
  }
}
