// Download on many rows asks the engine once for all of them. An engine on an older build, in another tab, drops a
// command it does not know without a word, so when nothing answers within 5 s each row is started on its own. A browser
// test because the client registers window listeners as it is built.

import { afterEach, expect, it, vi } from 'vitest'

import type { Transport, TransportHost } from '../../src/torrent/engine-protocol'

import { createTorrentClient } from '../../src/torrent/client'

const ROWS = ['a', 'b', 'c'].map((c) => c.repeat(40))

const clients: ReturnType<typeof createTorrentClient>[] = []

/** A client whose engine is up, what it posted, and `say`, through which the engine speaks to it. */
const running = () => {
  let host!: TransportHost
  const posted: { type: string, id?: number, infoHash?: string, infoHashes?: string[] }[] = []
  const factory = (h: TransportHost): Transport => {
    host = h
    return { post: (msg: { type: string }) => { posted.push(msg) }, destroy: () => {}, pending: () => [] }
  }
  const client = createTorrentClient()
  clients.push(client)
  client.useTransport(factory, true)
  const say = (msg: object) => host.message(msg)
  say({ type: 'ready' })
  say({ type: 'list', list: [] })
  return { client, say, posted }
}

const startsOf = (posted: { type: string, infoHash?: string }[]) => posted.filter((m) => m.type === 'start').map((m) => m.infoHash)

afterEach(() => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.destroy()
})

it('starts many rows in one command, and nothing more once the engine answers', async () => {
  vi.useFakeTimers()
  const { client, say, posted } = running()
  client.startMany(ROWS)
  await vi.advanceTimersByTimeAsync(0)
  expect(posted.at(-1)?.type).toBe('start-many')
  expect(posted.at(-1)?.infoHashes).toEqual(ROWS)
  say({ type: 'answer', id: posted.at(-1)!.id, value: true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(startsOf(posted)).toEqual([])
  expect(posted.filter((m) => m.type === 'start-many')).toHaveLength(1)
})

it('starts each row on its own when the engine, an older build, does not answer within 5 s', async () => {
  vi.useFakeTimers()
  const { client, posted } = running()
  client.startMany(ROWS)
  // advanced by hand: vi.waitFor moves fake timers on by itself
  await vi.advanceTimersByTimeAsync(0)
  expect(posted.at(-1)?.type).toBe('start-many')
  await vi.advanceTimersByTimeAsync(4_999)
  expect(startsOf(posted)).toEqual([])
  await vi.advanceTimersByTimeAsync(1)
  expect(startsOf(posted)).toEqual(ROWS)
})
