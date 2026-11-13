// How long the client waits on the engine: a question other than a read gives up after 2 minutes. A
// browser test because the client registers window listeners as it is built.

import { afterEach, expect, it, vi } from 'vitest'

import type { Transport, TransportHost } from '../../src/torrent/engine-protocol'

import { createTorrentClient } from '../../src/torrent/client'

const clients: ReturnType<typeof createTorrentClient>[] = []

/** A client whose engine is up. */
const running = () => {
  let host!: TransportHost
  const posted: { type: string, id?: number }[] = []
  const factory = (h: TransportHost): Transport => {
    host = h
    return { post: (msg: { type: string, id?: number }) => { posted.push(msg) }, destroy: () => {}, pending: () => [] }
  }
  const client = createTorrentClient()
  clients.push(client)
  client.useTransport(factory, true)
  const say = (msg: object) => host.message(msg)
  say({ type: 'ready' })
  say({ type: 'list', list: [] })
  return { client }
}

/** What `promise` came to so far: still waiting, resolved, or the message it was rejected with. */
const watch = (promise: Promise<unknown>) => {
  let outcome = 'waiting'
  promise.then(() => { outcome = 'resolved' }, (error: Error) => { outcome = error.message })
  return () => outcome
}

afterEach(() => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.destroy()
})

it('any other question to the engine still gives up after 2 minutes', async () => {
  vi.useFakeTimers()
  const { client } = running()
  const asked = watch(client.ask({ type: 'export-start', infoHash: 'a'.repeat(40) }))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(asked()).toBe('export-start timed out after 120000ms')
})
