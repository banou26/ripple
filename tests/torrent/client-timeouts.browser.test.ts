// How long the client waits on the engine: a read outlasts the worker's longest one, a wait through a
// relay outage included, and any other question still gives up after 2 minutes. A browser test because
// the client registers window listeners as it is built.

import { afterEach, expect, it, vi } from 'vitest'

import type { Transport, TransportHost } from '../../src/torrent/engine-protocol'

import { createTorrentClient } from '../../src/torrent/client'

// (READ_ATTEMPTS 18 + READ_RECONNECTING_ATTEMPTS 20) x READ_ATTEMPT_MS 6 s, in src/torrent/worker.ts
const WORKER_LONGEST_READ_MS = 228_000

const clients: ReturnType<typeof createTorrentClient>[] = []

/** A client whose engine is up, what it posted, and `say`, through which the engine speaks to it. */
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
  return { client, say, posted }
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

it('a read the worker answers at the end of its longest wait still resolves', async () => {
  vi.useFakeTimers()
  const { client, say, posted } = running()
  const read = watch(client.read(1, 0, 0, 16))
  await vi.waitFor(() => expect(posted.at(-1)?.type).toBe('read'))
  await vi.advanceTimersByTimeAsync(WORKER_LONGEST_READ_MS)
  expect(read()).toBe('waiting')
  say({ type: 'read-result', id: posted.at(-1)!.id, data: new Uint8Array(16) })
  await vi.advanceTimersByTimeAsync(0)
  expect(read()).toBe('resolved')
})

it('any other question to the engine still gives up after 2 minutes', async () => {
  vi.useFakeTimers()
  const { client } = running()
  const asked = watch(client.ask({ type: 'export-start', infoHash: 'a'.repeat(40) }))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(asked()).toBe('export-start timed out after 120000ms')
})
