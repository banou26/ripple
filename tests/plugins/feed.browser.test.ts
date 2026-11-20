// The library's events as plugins hear them: adds, removals and finishes only where the engine runs, and none for what
// a load, the engine moving or the account's sync brings in.
import type { FeedEvents } from '../../src/plugins/feed'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTorrentClient } from '../../src/torrent/client'
import { engineDouble, entry, snapshot } from './engine-double'

vi.mock('idb-keyval', async () => (await import('./engine-double')).memoryStore().module)

const { createFeed, FEED_MS } = await import('../../src/plugins/feed')

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)
const D = 'd'.repeat(40)

const made: { destroy: () => void }[] = []
afterEach(() => { for (const one of made.splice(0)) one.destroy() })

const watch = (owns = true, list = [entry(A)]) => {
  const engine = engineDouble({ createTorrentClient } as never)
  engine.start(list, [], owns)
  const feed = createFeed(engine.client)
  const heard: FeedEvents[] = []
  feed.listen((events) => heard.push(events))
  made.push(feed, engine.client)
  const all = <K extends keyof FeedEvents>(key: K) => heard.flatMap((events) => events[key] as unknown[])
  const added = () => all('added').map((t) => (t as { infoHash: string }).infoHash)
  const removed = () => all('removed')
  // one feed pass after whatever was said, which is what a plugin waits for too
  const settle = () => new Promise((resolve) => setTimeout(resolve, FEED_MS * 1.5))
  return { engine, feed, heard, added, removed, all, settle }
}

describe('the events of an add and a removal', () => {
  it('names a torrent added or removed here, once the library is known (control)', async () => {
    const { engine, added, removed, settle } = watch()
    await settle()
    engine.say({ type: 'list', list: [entry(A), entry(B)] })
    await vi.waitFor(() => expect(added()).toEqual([B]), { timeout: 3_000 })
    engine.say({ type: 'list', list: [entry(B)] })
    await vi.waitFor(() => expect(removed()).toEqual([A]), { timeout: 3_000 })
  })

  it('names nothing for the first list after a load, and nothing as changed on its first pass', async () => {
    const { added, all, settle } = watch(true, [entry(A), entry(B), entry(C)])
    await settle()
    expect(added()).toEqual([])
    expect(all('changed')).toEqual([])
  })

  it('names nothing for the first list of an engine that moved here or was replaced', async () => {
    const { engine, added, removed, settle } = watch()
    await settle()
    engine.start([entry(B), entry(C)])
    await settle()
    expect(added()).toEqual([])
    expect(removed()).toEqual([])
    engine.say({ type: 'list', list: [entry(B), entry(C), entry(D)] })
    await vi.waitFor(() => expect(added(), 'an add after it (control)').toEqual([D]), { timeout: 3_000 })
  })

  it('names nothing for a list the account\'s sync wrote', async () => {
    const { engine, added, removed, settle } = watch()
    await settle()
    engine.say({ type: 'list', list: [entry(B), entry(C)], synced: true })
    await settle()
    expect(added()).toEqual([])
    expect(removed()).toEqual([])
    engine.say({ type: 'list', list: [entry(B), entry(C), entry(D)] })
    await vi.waitFor(() => expect(added(), 'an add after it (control)').toEqual([D]), { timeout: 3_000 })
  })

  it('names nothing in a tab that does not run the engine, which still hears what changed', async () => {
    const { engine, added, removed, all, settle } = watch(false, [entry(A)])
    await settle()
    engine.say({ type: 'list', list: [entry(B)] })
    engine.say({ type: 'state', torrents: [snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${B}` })] })
    await vi.waitFor(() => expect(all('changed').length).toBeGreaterThan(0), { timeout: 3_000 })
    expect(added()).toEqual([])
    expect(removed()).toEqual([])
  })

  it('leaves a temporary torrent out', async () => {
    const { engine, added, all, settle } = watch()
    await settle()
    engine.say({ type: 'list', list: [entry(A), entry(B, { ephemeral: true })] })
    await settle()
    expect(added()).toEqual([])
    expect(all('changed').map((t) => (t as { infoHash: string }).infoHash)).not.toContain(B)
  })
})

describe('a finish', () => {
  const live = (state: number) => ({
    ...snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }),
    status: { state, paused: false, progress: state === 5 ? 1 : 0.5, totalDone: 1, totalWanted: 2, totalWantedDone: state === 5 ? 2 : 1, downloadRate: 1, uploadRate: 0, flags: 0, queuePosition: 0, numPeers: 1, numSeeds: 1 },
  })

  it('is named once a torrent seen downloading reads finished, where the engine runs', async () => {
    const { engine, all, settle } = watch()
    engine.say({ type: 'state', torrents: [live(3)] })
    await settle()
    engine.say({ type: 'state', torrents: [live(5)] })
    await vi.waitFor(() => expect(all('finished').map((t) => (t as { infoHash: string }).infoHash)).toEqual([A]), { timeout: 3_000 })
  })

  it('is named nowhere else', async () => {
    const { engine, all, settle } = watch(false)
    engine.say({ type: 'state', torrents: [live(3)] })
    await settle()
    engine.say({ type: 'state', torrents: [live(5)] })
    await settle()
    expect(all('finished')).toEqual([])
    expect(all('changed').length, 'it changed (control)').toBeGreaterThan(0)
  })
})

describe('what changed', () => {
  it('is said at most once a second, with only the torrents that changed', async () => {
    const { engine, heard, settle } = watch(true, [entry(A), entry(B)])
    await settle()
    const before = heard.length
    for (const rate of [1, 2, 3, 4]) {
      engine.say({ type: 'state', torrents: [{ ...snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }), status: { state: 3, paused: false, progress: rate / 10, totalDone: rate, totalWanted: 10, downloadRate: rate, uploadRate: 0, flags: 0, queuePosition: 0, numPeers: 1, numSeeds: 0 } }] })
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    await settle()
    const said = heard.slice(before).filter((events) => events.changed.length)
    expect(said.length).toBeLessThanOrEqual(2)
    expect(said.flatMap((events) => events.changed.map((t) => t.infoHash))).not.toContain(B)
  })
})
