// Each call a plugin makes checks its switch in storage as it runs, and does what ripple's own screens do.
import type { PluginTab } from '../../src/plugins/calls'
import type { Switch } from '../../src/plugins/contract'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTorrentClient } from '../../src/torrent/client'
import { torrentKey } from '../../src/torrent/library'
import { engineDouble, entry, snapshot } from './engine-double'

const SINTEL = new URL('../../src/assets/sintel.torrent', import.meta.url)

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('idb-keyval', async () => {
  const { memoryStore: make } = await import('./engine-double')
  const made = make()
  memory.store = made.store
  return made.module
})

const { rippleFor, ADD_ANSWER_MS } = await import('../../src/plugins/calls')
const { createFeed } = await import('../../src/plugins/feed')
const { answer } = await import('../../src/plugins/switches')
const { createGroup, currentGroups, subscribeGroups } = await import('../../src/torrent/groups')

const URI = 'npm:@someone/ripple-plugin-test'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const GHOST = 'c'.repeat(40)
const TEMPORARY = 'e'.repeat(40)


const setup = () => {
  const engine = engineDouble({ createTorrentClient } as never)
  engine.start(
    [entry(A), entry(B), entry(GHOST, { started: false }), entry(TEMPORARY, { ephemeral: true })],
    [{ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }, { handle: 2, magnet: `magnet:?xt=urn:btih:${B}` }, { handle: 3, magnet: `magnet:?xt=urn:btih:${TEMPORARY}` }],
  )
  const feed = createFeed(engine.client)
  const tab: PluginTab = {
    client: () => engine.client, buttonsChanged: () => {}, feed: () => feed, owns: () => engine.client.owns(), vpn: () => true,
    locale: () => ({ locale: 'en', dir: 'ltr' }), onActive: () => () => {}, onVpn: () => () => {}, onLocale: () => () => {},
  }
  const { ripple, close } = rippleFor(URI, tab, async () => ['read', 'add', 'change'])
  return { engine, feed, ripple, close }
}

let made: ReturnType<typeof setup>
let groupId = ''
beforeEach(async () => {
  memory.store.clear()
  made = setup()
  subscribeGroups(() => {})()
  groupId = (await createGroup('Week 2', [A]))!
  await vi.waitFor(() => expect(currentGroups()?.length).toBe(1))
})
afterEach(() => { made.close(); made.feed.destroy(); made.engine.client.destroy() })

const refusal = (call: Promise<unknown>) => call.then(() => 'answered', (error: Error) => error.message)

const CALLS: [Switch, string, () => Promise<unknown>][] = [
  ['read', 'torrents', () => made.ripple.torrents()],
  ['read', 'torrent', () => made.ripple.torrent(A)],
  ['read', 'groups', () => made.ripple.groups()],
  ['read', 'torrentFile', () => made.ripple.torrentFile(A)],
  ['read', 'on changed', () => made.ripple.on('changed', () => {})],
  ['read', 'on added', () => made.ripple.on('added', () => {})],
  ['read', 'on finished', () => made.ripple.on('finished', () => {})],
  ['read', 'on removed', () => made.ripple.on('removed', () => {})],
  ['add', 'add', () => made.ripple.add({ magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}` })],
  ['change', 'pause', () => made.ripple.pause(A)],
  ['change', 'resume', () => made.ripple.resume(A)],
  ['change', 'forceStart', () => made.ripple.forceStart(A)],
  ['change', 'recheck', () => made.ripple.recheck(A)],
  ['change', 'reannounce', () => made.ripple.reannounce(A)],
  ['change', 'retry', () => made.ripple.retry(A)],
  ['change', 'start', () => made.ripple.start(GHOST)],
  ['change', 'keep', () => made.ripple.keep(TEMPORARY)],
  ['change', 'setFiles', () => made.ripple.setFiles(A, [])],
  ['change', 'setFirstLast', () => made.ripple.setFirstLast(A, true)],
  ['change', 'setSequential', () => made.ripple.setSequential(A, true)],
  ['change', 'moveInQueue', () => made.ripple.moveInQueue(A, 'top')],
  ['change', 'createGroup', () => made.ripple.createGroup('Week 3', [A])],
  ['change', 'renameGroup', () => made.ripple.renameGroup(groupId, 'Week 9')],
  ['change', 'putInGroup', () => made.ripple.putInGroup(groupId, [B])],
  ['change', 'takeOutOfGroup', () => made.ripple.takeOutOfGroup(groupId, [A])],
  ['change', 'deleteGroup', () => made.ripple.deleteGroup(groupId)],
]

describe('a call while its switch is off', () => {
  it.each(CALLS)('%s: %s is refused, and nothing reaches the engine', async (_name, _call, call) => {
    await answer(URI, { read: false, add: false, change: false })
    const before = made.engine.posted.length
    expect(await refusal(call())).toBe('not-allowed')
    expect(made.engine.posted.length).toBe(before)
  })

  it.each(CALLS.filter(([name]) => name !== 'add'))('%s: %s goes through once its switch is on (control)', async (name, _call, call) => {
    await answer(URI, { [name]: true })
    expect(await refusal(call())).toBe('answered')
  })

  it('is read again on every call, so a switch turned off holds at once', async () => {
    await answer(URI, { read: true })
    expect((await made.ripple.torrents()).map((t) => t.infoHash)).toEqual([A, B, GHOST])
    await answer(URI, { read: false })
    expect(await refusal(made.ripple.torrents())).toBe('not-allowed')
  })

  it('holds each switch apart, and refuses a switch the plugin does not ask for even when it is on', async () => {
    await answer(URI, { read: true })
    expect(await refusal(made.ripple.pause(A))).toBe('not-allowed')
    const asksRead = rippleFor(URI, { ...({} as PluginTab), feed: () => made.feed, locale: () => ({ locale: 'en', dir: 'ltr' }), vpn: () => true, owns: () => true }, async () => ['read'])
    await answer(URI, { read: true, change: true })
    expect(await refusal(asksRead.ripple.pause(A))).toBe('not-allowed')
    expect(await refusal(asksRead.ripple.torrents()), 'one it asks for (control)').toBe('answered')
    await made.ripple.store.set('cursor', '12')
    expect(await made.ripple.store.get('cursor')).toBe('12')
  })
})

describe('the calls that change torrents', () => {
  beforeEach(() => answer(URI, { read: true, change: true }))

  it('send the engine the handle it gave each torrent, named by info hash', async () => {
    await made.ripple.pause(B)
    await made.ripple.setSequential(A, true)
    await made.ripple.moveInQueue(B, 'bottom')
    expect(made.engine.posted.slice(-3)).toEqual([
      { type: 'pause', handle: 2 },
      expect.objectContaining({ type: 'set-flags', handle: 1, mask: expect.any(Number) }),
      { type: 'queue-move', handle: 2, where: 'bottom' },
    ])
  })

  it('answer not-found for a torrent the library does not hold, and unavailable for one the engine does not run', async () => {
    expect(await refusal(made.ripple.pause('d'.repeat(40)))).toBe('not-found')
    expect(await refusal(made.ripple.pause(GHOST))).toBe('unavailable')
    expect(await refusal(made.ripple.moveInQueue(A, 'sideways' as never))).toBe('invalid')
  })

  it('start a torrent this device does not hold, and keep a temporary one, leaving the others as they are', async () => {
    await made.ripple.start(A)
    await made.ripple.keep(A)
    await made.ripple.start(GHOST)
    await made.ripple.keep(TEMPORARY)
    expect(made.engine.posted.filter((m) => m.type === 'start' || m.type === 'set-temporary')).toEqual([
      { type: 'start', infoHash: GHOST }, { type: 'set-temporary', infoHash: TEMPORARY, temporary: false },
    ])
  })

  it('add trackers only to a torrent whose kept .torrent says it is public', async () => {
    expect(await refusal(made.ripple.addTrackers(A, ['https://t.example/announce']))).toBe('not-allowed')
    expect(made.engine.posted.some((m) => m.type === 'add-trackers')).toBe(false)
    memory.store.set(torrentKey(B), new Uint8Array(await (await fetch(SINTEL)).arrayBuffer()))
    const added = made.ripple.addTrackers(B, ['https://t.example/announce', 'gopher://x'])
    await vi.waitFor(() => expect(made.engine.posted.at(-1)).toMatchObject({ type: 'add-trackers', handle: 2 }))
    made.engine.say({ type: 'answer', id: made.engine.posted.at(-1)!.id, value: ['gopher://x'] })
    expect(await added, 'a public one (control)').toEqual(['gopher://x'])
  })

  it('stop hearing the torrent events once read is turned off, and hear them again once it is back on', async () => {
    const heard: unknown[] = []
    await made.ripple.on('changed', (torrents) => { heard.push(torrents) })
    const change = (rate: number) => made.engine.say({ type: 'state', torrents: [{ ...snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }), status: { state: 3, paused: false, progress: rate, totalDone: rate, totalWanted: 1, downloadRate: rate, uploadRate: 0, flags: 0, queuePosition: 0, numPeers: 1, numSeeds: 0 } }] })
    const pass = () => new Promise((resolve) => setTimeout(resolve, 1_500))
    change(0.1)
    await pass()
    await answer(URI, { read: false })
    change(0.2)
    await pass()
    expect(heard).toEqual([])
    await answer(URI, { read: true })
    change(0.3)
    await vi.waitFor(() => expect(heard.length, 'read on again (control)').toBe(1), { timeout: 3_000 })
  })

  it('edit the person\'s groups as Ripple\'s own screens do', async () => {
    const id = await made.ripple.createGroup('Week 3', [B])
    await made.ripple.putInGroup(groupId, [B])
    await vi.waitFor(async () => expect((await made.ripple.groups()).map((g) => [g.name, g.infoHashes])).toEqual([
      ['Week 2', [A, B]], ['Week 3', [B]],
    ]))
    expect(typeof id).toBe('string')
    expect(await refusal(made.ripple.renameGroup('no-such-group', 'x'))).toBe('not-found')
  })
})

describe('an add', () => {
  beforeEach(() => answer(URI, { read: true, add: true }))

  it('settles on the engine\'s answer to its own add id, and leaves the toast to the person\'s own adds', async () => {
    const toasts: string[] = []
    made.engine.client.onAddFailed((message) => toasts.push(message))
    const magnet = `magnet:?xt=urn:btih:${'f'.repeat(40)}`
    const settled = made.ripple.add({ magnet })
    await vi.waitFor(() => expect(made.engine.posted.at(-1)).toMatchObject({ type: 'add-magnet', magnet, addId: expect.any(String) }))
    const addId = made.engine.posted.at(-1)?.addId
    made.engine.say({ type: 'add-failed', addId: 'someone-else', message: 'That is not a valid magnet link' })
    made.engine.say({ type: 'added', addId, handle: 7, magnet })
    expect(await settled).toEqual({ infoHash: 'f'.repeat(40), outcome: 'added' })

    const refused = made.ripple.add({ magnet: `magnet:?xt=urn:btih:${'9'.repeat(40)}` })
    await vi.waitFor(() => expect(made.engine.posted.at(-1)?.magnet).toContain('9'.repeat(40)))
    made.engine.say({ type: 'add-failed', addId: made.engine.posted.at(-1)!.addId, message: 'That is not a valid magnet link' })
    expect((await refused).outcome).toBe('failed')
    expect(toasts).toEqual([])
    made.engine.say({ type: 'add-failed', message: 'That is not a valid magnet link' })
    expect(toasts, 'the person\'s own add (control)').toEqual(['That is not a valid magnet link'])
  })

  it('answers already for a torrent the library keeps, a temporary one aside, and sends nothing', async () => {
    const before = made.engine.posted.length
    expect(await made.ripple.add({ magnet: `magnet:?xt=urn:btih:${GHOST.toUpperCase()}&dn=x` })).toEqual({ infoHash: GHOST, outcome: 'already' })
    expect(made.engine.posted.length).toBe(before)
    const kept = made.ripple.add({ magnet: `magnet:?xt=urn:btih:${TEMPORARY}` })
    await vi.waitFor(() => expect(made.engine.posted.length).toBe(before + 1))
    made.engine.say({ type: 'added', addId: made.engine.posted.at(-1)!.addId, handle: 3, magnet: '' })
    expect((await kept).outcome).toBe('added')
  })

  it('answers already when the engine says the library kept it before, as for one torrent added twice at once', async () => {
    const magnet = `magnet:?xt=urn:btih:${'7'.repeat(40)}`
    const first = made.ripple.add({ magnet })
    const second = made.ripple.add({ magnet })
    const sent = () => made.engine.posted.filter((m) => m.type === 'add-magnet' && m.magnet === magnet)
    await vi.waitFor(() => expect(sent()).toHaveLength(2))
    made.engine.say({ type: 'added', addId: sent()[0]!.addId, handle: 7, magnet })
    made.engine.say({ type: 'added', addId: sent()[1]!.addId, handle: 7, magnet, already: true })
    expect([(await first).outcome, (await second).outcome]).toEqual(['added', 'already'])
  })

  it('adds a .torrent with its options and its own add id', async () => {
    const bytes = new Uint8Array(await (await fetch(SINTEL)).arrayBuffer())
    const settled = made.ripple.add({ torrentFile: bytes }, { files: [0], firstLast: true, sequential: true, paused: true, top: true, location: 'browser' })
    await vi.waitFor(() => expect(made.engine.posted.at(-1)?.type).toBe('add-torrent-file'))
    const sent = made.engine.posted.at(-1)!
    expect(sent).toMatchObject({ addId: expect.any(String), wanted: [0], firstLast: true, sequential: true, paused: true, top: true, saveTo: 'browser' })
    made.engine.say({ type: 'added', addId: sent.addId, handle: 8, magnet: '' })
    expect(await settled).toEqual({ infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10', outcome: 'added' })
    expect(await refusal(made.ripple.add({ torrentFile: bytes }, { files: [-1] }))).toBe('invalid')
  })

  it('fails a link that names no torrent, and one the engine never answers', async () => {
    expect(await made.ripple.add({ magnet: 'magnet:?dn=nothing' })).toEqual({ infoHash: null, outcome: 'failed' })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const unanswered = made.ripple.add({ magnet: `magnet:?xt=urn:btih:${'8'.repeat(40)}` })
      await vi.waitFor(() => expect(made.engine.posted.at(-1)?.type).toBe('add-magnet'))
      await vi.advanceTimersByTimeAsync(ADD_ANSWER_MS)
      expect((await unanswered).outcome).toBe('failed')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('the store', () => {
  it('keeps a plugin\'s strings under its uri alone, deletes one on null, and refuses past 256 KB keeping what it had', async () => {
    const { STORE_BYTES } = await import('../../src/plugins/store')
    const other = rippleFor('npm:@someone/another-plugin', { ...({} as PluginTab), feed: () => made.feed, locale: () => ({ locale: 'en', dir: 'ltr' }), vpn: () => true, owns: () => true }, async () => [])
    await made.ripple.store.set('feed', 'https://feed.example/rss')
    expect(await other.ripple.store.get('feed')).toBeNull()
    expect(await made.ripple.store.get('feed')).toBe('https://feed.example/rss')
    expect(await refusal(made.ripple.store.set('big', 'x'.repeat(STORE_BYTES)))).toBe('full')
    expect(await made.ripple.store.get('big')).toBeNull()
    expect(await made.ripple.store.get('feed')).toBe('https://feed.example/rss')
    await made.ripple.store.set('big', 'x'.repeat(STORE_BYTES - 64))
    await made.ripple.store.set('feed', null)
    expect(await made.ripple.store.get('feed')).toBeNull()
    expect(await refusal(made.ripple.store.set('n', 4 as never))).toBe('invalid')
  })
})
