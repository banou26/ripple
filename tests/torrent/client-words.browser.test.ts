// What the client hands on from the engine, in the page's language: the worker's own words come as ripple's messages
// (src/i18n/said.ts), and the reasons a read fails reach the download page's failure line. A browser test because the
// client registers window listeners as it is built.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Transport, TransportHost } from '../../src/torrent/engine-protocol'

import { createTorrentClient } from '../../src/torrent/client'
import { showEnglish, showIn } from '../i18n/show-in'

import de from '../../src/locales/de.json'

const clients: ReturnType<typeof createTorrentClient>[] = []

/** A client whose engine is up, and `say`, through which the engine speaks to it. */
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
  return { client, say, posted, swap: () => client.useTransport(factory, true) }
}

/** The message `read` rejects with. */
const failure = (read: Promise<unknown>) => read.then(() => 'resolved', (error: Error) => error.message)

afterEach(async () => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) client.destroy()
  await showEnglish()
})

describe('the engine\'s words, as the client hands them on', () => {
  it('in English, as they read before they were translated', async () => {
    const { client, say, posted } = running()
    const refused: string[] = []
    client.onAddFailed((message) => refused.push(message))
    say({ type: 'add-failed', message: { message: 'That is not a valid magnet link' } })
    expect(refused).toEqual(['That is not a valid magnet link'])

    const read = client.read(1, 0, 0, 16)
    await vi.waitFor(() => expect(posted.at(-1)?.type).toBe('read'))
    say({ type: 'read-error', id: posted.at(-1)!.id, error: { message: 'torrent paused' } })
    expect(await failure(read)).toBe('torrent paused')
  })

  it('in German, the refusal, a read the worker failed, and one the tab of another engine already worded', async () => {
    await showIn('de', de, 'de-DE')
    const { client, say, posted } = running()
    const refused: string[] = []
    client.onAddFailed((message) => refused.push(message))
    say({ type: 'add-failed', message: { message: 'That is not a valid magnet link' } })
    expect(refused).toEqual(['Das ist kein gültiger Magnet-Link'])

    for (const [error, said] of [[{ message: 'torrent removed to make room' }, 'Torrent entfernt, um Platz zu schaffen'], ['Torrent pausiert', 'Torrent pausiert']] as const) {
      const read = client.read(1, 0, 0, 16)
      await vi.waitFor(() => expect(posted.at(-1)?.type).toBe('read'))
      say({ type: 'read-error', id: posted.at(-1)!.id, error })
      expect(await failure(read)).toBe(said)
    }
  })

  it('in German, a read the engine was replaced under, and one that waited too long', async () => {
    await showIn('de', de, 'de-DE')
    const replaced = running()
    // issued for this engine, then sent after the next one took over
    replaced.say({ type: 'engine-reset' })
    const stale = replaced.client.read(1, 0, 0, 16)
    replaced.say({ type: 'ready' })
    expect(await failure(stale)).toBe('die Engine wurde ersetzt, während dieser Lesevorgang wartete')

    vi.useFakeTimers()
    const { client } = running()
    const read = client.read(1, 0, 0, 16)
    vi.advanceTimersByTime(120_000)
    expect(await failure(read)).toBe('Zeitüberschreitung beim Lesen nach 120000 ms')
  })
})
