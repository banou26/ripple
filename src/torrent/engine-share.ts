// The two halves of borrowing an engine that lives in another tab.
//
// Follower side: a transport that looks exactly like the worker one, so the client above it
// does not know or care which tab the engine is in.
//
// Leader side: a server that relays follower commands into its own worker and pushes the
// worker's broadcasts back out.
//
// Both sides move raw worker messages. Nothing here interprets a command, which is what
// keeps a newly added command working across tabs without anyone remembering to add it in a
// second place.

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

// ---- follower -------------------------------------------------------------

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
    // Posting on a closed channel throws. Only happens on the way out.
    catch { /* gone */ }
  }

  // A leader that stops broadcasting has gone away. Its worker posts state on a fixed tick
  // whether or not anything moved, so silence is a real signal rather than a guess, and it
  // is the only way to notice the gap between one leader closing and the next taking over.
  // Commands posted into that gap reach nobody and are never retried by their callers.
  const heardFromLeader = () => {
    clearTimeout(silence)
    silence = setTimeout(() => { leaderUp = false }, LEADER_SILENCE_MS)
  }

  const flush = () => {
    const pending = queued
    queued = []
    for (const held of pending) say(held)
  }

  // A leader announces itself with the worker's own `ready`, never a synthetic one: the
  // worker drops every command that arrives before its session exists, so announcing early
  // would release the held commands straight into a hole.
  const observe = (envelopeGen: Generation, msg: any) => {
    // A different engine entirely. Handles from the old one name other torrents in this one,
    // so the client has to be told before it sees a single message from it.
    const changed = gen !== null && envelopeGen !== gen
    gen = envelopeGen
    if (changed) { leaderUp = false; host.message({ type: ENGINE_RESET }) }
    heardFromLeader()
    // Its whole job was to carry the new generation, which the change above already acted
    // on. A tab that had no engine to begin with has nothing to reset.
    if (msg?.type === ENGINE_RESET) return
    if (msg?.type === 'ready' && !leaderUp) { leaderUp = true; flush() }
    host.message(msg)
  }

  const onControl = ({ data }: MessageEvent) => {
    const env = data as { to?: string, gen?: Generation, msg?: any }
    // BroadcastChannel never delivers to the poster, so a follower only ever sees leader
    // broadcasts here, not the commands other followers are sending.
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

  // Announces this tab so a leader that is already running replies with its latched state.
  // A leader that starts later broadcasts to everyone instead, so a hello lost into an empty
  // channel costs nothing.
  say({ type: 'hello' })

  // The leader keeps a channel open per follower it has heard from, and nothing else ever
  // tells it this tab is gone: the client is only destroyed on the no-Web-Locks path.
  // Optional so the protocol can be exercised outside a document.
  const onPageHide = () => say({ type: 'bye' })
  globalThis.addEventListener?.('pagehide', onPageHide)

  return {
    // The transfer list is dropped rather than honoured: BroadcastChannel takes no transfer
    // list at all, so the payload is copied. Only add-torrent-file passes one, and a
    // .torrent file is small enough that the copy does not matter.
    post: (msg) => {
      if (!leaderUp) { queued.push(msg); return }
      say(msg)
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

// ---- leader ---------------------------------------------------------------

export const serveFollowers = (client: EngineClient): () => void => {
  const control = new BroadcastChannel(CONTROL_CHANNEL)
  const followers = new Map<string, BroadcastChannel>()
  // Names this engine session. Followers echo it on everything they send, and anything
  // stamped with a previous one is dropped: a `remove` carrying a handle from the session
  // before this one would delete a different torrent's files.
  const gen = newGeneration()

  const broadcast = (msg: any) => {
    try { control.postMessage({ to: 'all', gen, msg }) } catch { /* closing */ }
  }

  const reply = (clientId: string, msg: any) => {
    // A lookup, never a create. A read that finishes after its follower said goodbye would
    // otherwise reopen the channel that was just closed for it, and nothing would close it
    // again.
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
      // A player in that tab never got to unregister itself, and a claim left behind would
      // hold sequential mode on and keep its file at top priority for the rest of the
      // session. The viewer ids it handed out are prefixed with the id it is saying goodbye
      // under, so the engine can find them.
      client.sendRaw({ type: 'unwatch-owner', owner: from })
      return
    }

    if (msg.type === 'hello') {
      // A follower has no generation yet, so hello is the one message accepted without one.
      if (!followers.has(from)) followers.set(from, new BroadcastChannel(replyChannel(from)))
      // Saying ready before the session exists would release the follower's held commands
      // into a worker that drops all of them. Stay quiet instead: the worker's own ready is
      // broadcast to everyone when it arrives.
      if (!client.started()) return
      reply(from, { type: 'ready' })
      const list = client.latestList()
      if (list) reply(from, { type: 'list', list })
      const state = client.latestState()
      if (state) reply(from, { type: 'state', torrents: state })
      return
    }

    // Anything from a follower still talking to a previous engine. Its handles mean nothing
    // here.
    if (env.gen !== gen) return

    if (msg.type === 'read') {
      // Routed through the leader's own client rather than posted at the worker directly, so
      // read ids stay in one space and the follower's id is only ever a label to send back.
      // Two followers can both use id 1 without colliding, because the reply goes to the
      // channel that belongs to one of them.
      client
        .read(msg.handle, msg.fileIndex, msg.offset, msg.len, msg.prioritize)
        .then((data) => reply(from, { type: 'read-result', id: msg.id, data }))
        .catch((error) => reply(from, { type: 'read-error', id: msg.id, error: String(error?.message ?? error) }))
      return
    }

    // Everything else is a command this tab's worker already understands.
    client.sendRaw(msg)
  }

  control.addEventListener('message', onControl)

  const offRaw = client.onRaw((msg) => {
    if (msg?.type && BROADCAST_TYPES.has(msg.type)) broadcast(msg)
  })

  // Tells tabs that were talking to a previous engine that it is gone, before this one says
  // anything at all. Their handles, their pending reads and any error they are showing all
  // belonged to it.
  broadcast({ type: ENGINE_RESET })

  return () => {
    offRaw()
    control.removeEventListener('message', onControl)
    for (const clientId of [...followers.keys()]) drop(clientId)
    try { control.close() } catch { /* already closed */ }
  }
}
