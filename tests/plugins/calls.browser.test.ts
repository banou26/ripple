// Each call a plugin makes checks its switch in storage as it runs, and does what ripple's own screens do.
import type { PluginTab } from '../../src/plugins/calls'
import type { Switch } from '../../src/plugins/contract'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTorrentClient } from '../../src/torrent/client'
import { thumbnailKey, torrentKey } from '../../src/torrent/library'
import { engineDouble, entry, snapshot } from './engine-double'

const SINTEL = new URL('../../src/assets/sintel.torrent', import.meta.url)

const memory = vi.hoisted(() => ({ store: new Map<string, unknown>() }))
vi.mock('idb-keyval', async () => {
  const { memoryStore: make } = await import('./engine-double')
  const made = make()
  memory.store = made.store
  return made.module
})

const { rippleFor, ADD_ANSWER_MS, READ_MAX_BYTES } = await import('../../src/plugins/calls')
const { createFeed } = await import('../../src/plugins/feed')
const { answer, SWITCHES_KEY } = await import('../../src/plugins/switches')
const { createGroup, currentGroups, putInGroup, subscribeGroups } = await import('../../src/torrent/groups')

const URI = 'npm:@someone/ripple-plugin-test'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const GHOST = 'c'.repeat(40)
const TEMPORARY = 'e'.repeat(40)
const SOURCE_HASH = '4'.repeat(40)

const setup = () => {
  const engine = engineDouble({ createTorrentClient } as never)
  engine.start(
    [
      entry(A),
      entry(B),
      entry(GHOST, { started: false }),
      entry(TEMPORARY, { ephemeral: true }),
      entry(SOURCE_HASH, { saveTo: 'source', savePath: `/source/${SOURCE_HASH}` }),
    ],
    [
      { handle: 1, magnet: `magnet:?xt=urn:btih:${A}` },
      { handle: 2, magnet: `magnet:?xt=urn:btih:${B}` },
      { handle: 3, magnet: `magnet:?xt=urn:btih:${TEMPORARY}` },
      { handle: 4, magnet: `magnet:?xt=urn:btih:${SOURCE_HASH}` },
    ],
  )
  // populate files for A (with a leading pad file so index !== position), B, and TEMPORARY
  engine.say({
    type: 'state',
    torrents: [
      { ...snapshot({ handle: 1, magnet: `magnet:?xt=urn:btih:${A}` }), files: { files: [{ path: '.pad/64', size: 64, offset: 0, pad: true }, { path: 'clip.mp4', size: 1024, offset: 64, pad: false }] } },
      { ...snapshot({ handle: 2, magnet: `magnet:?xt=urn:btih:${B}` }), files: { files: [{ path: 'a.txt', size: 100, offset: 0, pad: false }, { path: 'b.txt', size: 200, offset: 100, pad: false }] } },
      { ...snapshot({ handle: 3, magnet: `magnet:?xt=urn:btih:${TEMPORARY}` }), files: { files: [{ path: 'temp.mp4', size: 512, offset: 0, pad: false }] } },
      { ...snapshot({ handle: 4, magnet: `magnet:?xt=urn:btih:${SOURCE_HASH}` }), savePath: `/source/${SOURCE_HASH}`, files: { files: [{ path: 'seed.bin', size: 256, offset: 0, pad: false }] } },
    ],
    transport: 'relay',
    reachable: { port: 41337, portOpen: true, inbound: 4, listenFailed: [], listeners: [] },
    inboundNow: { tcp: 2, utp: 1, webrtc: 0, total: 3 },
    dhtNodes: 120,
    rateLimits: { down: 500_000, up: 100_000 },
  })
  const feed = createFeed(engine.client)
  let gesture = false
  let folderState: { name: string, allowed: boolean } | null = { name: 'Downloads', allowed: true }
  const navigated: string[] = []
  const closedPages: string[] = []
  const tab: PluginTab = {
    client: () => engine.client,
    buttonsChanged: () => {},
    openPage: async () => {},
    beginClosePage: () => 1,
    closePage: (u) => { closedPages.push(u) },
    inGesture: () => gesture,
    takeSuggest: () => false,
    canSuggest: () => false,
    suggest: async () => ({ infoHash: null, outcome: 'failed' }),
    navigate: (to) => { navigated.push(to) },
    folder: async () => folderState,
    feed: () => feed,
    owns: () => engine.client.owns(),
    vpn: () => true,
    locale: () => ({ locale: 'en', dir: 'ltr' }),
    onActive: () => () => {},
    onVpn: () => () => {},
    onLocale: () => () => {},
  }
  const { ripple, close } = rippleFor(URI, tab, async () => ['read', 'add', 'change', 'remove', 'files', 'folder', 'peers', 'network'])
  return {
    engine, feed, ripple, close, navigated, closedPages,
    setGesture: (on: boolean) => { gesture = on },
    setFolder: (next: { name: string, allowed: boolean } | null) => { folderState = next },
  }
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
  ['remove', 'remove', () => made.ripple.remove(A)],
  ['remove', 'makeTemporary', () => made.ripple.makeTemporary(A)],
  ['files', 'read', () => made.ripple.read(A, 1, 0, 0)],
  ['files', 'play', () => made.ripple.play(A, 1)],
  ['files', 'save', () => made.ripple.save(A, 1)],
  ['folder', 'folder', () => made.ripple.folder()],
  ['folder', 'move', () => made.ripple.move(A, 'folder')],
  ['peers', 'peers', () => made.ripple.peers(A)],
  ['peers', 'trackers', () => made.ripple.trackers(A)],
  ['peers', 'setLimits', () => made.ripple.setLimits(A, { down: 1000 })],
  ['peers', 'sessionLimits', () => made.ripple.sessionLimits()],
  ['peers', 'setSessionLimits', () => made.ripple.setSessionLimits({ up: 2000 })],
  ['network', 'network', () => made.ripple.network()],
]

describe('a call while its switch is off', () => {
  it.each(CALLS)('%s: %s is refused, and nothing reaches the engine', async (_name, _call, call) => {
    await answer(URI, { read: false, add: false, change: false, remove: false, files: false, folder: false, peers: false, network: false })
    made.setGesture(true)
    const before = made.engine.posted.length
    expect(await refusal(call())).toBe('not-allowed')
    expect(made.engine.posted.length).toBe(before)
  })

  it.each(CALLS.filter(([name, label]) => name !== 'add' && label !== 'peers' && label !== 'trackers'))('%s: %s goes through once its switch is on (control)', async (name, _call, call) => {
    await answer(URI, { [name]: true })
    made.setGesture(true)
    expect(await refusal(call())).toBe('answered')
  })

  it('is read again on every call, so a switch turned off holds at once', async () => {
    await answer(URI, { read: true })
    expect((await made.ripple.torrents()).map((t) => t.infoHash)).toEqual([A, B, SOURCE_HASH, GHOST])
    await answer(URI, { read: false })
    expect(await refusal(made.ripple.torrents())).toBe('not-allowed')
  })

  // another tab's answer is in the shared storage before any message about it reaches this tab
  it('is read from storage, so a switch another tab turned off holds here at once', async () => {
    await answer(URI, { read: true })
    expect((await made.ripple.torrents()).length, 'on (control)').toBe(4)
    memory.store.set(SWITCHES_KEY, { [URI]: { read: false } })
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

  it('put only a torrent the library holds in a group, as Ripple\'s own screens do, and let one it no longer holds leave', async () => {
    const gone = 'd'.repeat(40)
    expect(await refusal(made.ripple.createGroup('Week 4', [A, gone]))).toBe('not-found')
    expect(await refusal(made.ripple.putInGroup(groupId, [gone]))).toBe('not-found')
    expect((await made.ripple.groups()).map((g) => [g.name, g.infoHashes])).toEqual([['Week 2', [A]]])
    // the person grouped it before removing it
    await putInGroup(groupId, [gone])
    await vi.waitFor(async () => expect((await made.ripple.groups())[0]!.infoHashes).toEqual([A, gone]))
    await made.ripple.takeOutOfGroup(groupId, [gone])
    await vi.waitFor(async () => expect((await made.ripple.groups())[0]!.infoHashes).toEqual([A]))
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

  it('answers a key the plugin never set with null, Object\'s own names included', async () => {
    await made.ripple.store.set('cursor', '12')
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) expect(await made.ripple.store.get(key), key).toBeNull()
    await made.ripple.store.set('constructor', 'kept')
    expect(await made.ripple.store.get('constructor'), 'one it set (control)').toBe('kept')
  })
})

describe('gesture-gated calls', () => {
  it('refuses ui.open, suggest, play and save outside the gesture window directly in calls.ts', async () => {
    await answer(URI, { files: true })
    expect(await refusal(made.ripple.ui.open({ id: 'search' }))).toBe('not-allowed')
    expect(await refusal(made.ripple.suggest({ magnet: `magnet:?xt=urn:btih:${'f'.repeat(40)}` }))).toBe('not-allowed')
    expect(await refusal(made.ripple.play(A, 1))).toBe('not-allowed')
    expect(await refusal(made.ripple.save(A, 1))).toBe('not-allowed')
    expect(made.ripple.page).toBeNull()
  })
})

describe('remove and makeTemporary', () => {
  beforeEach(() => answer(URI, { remove: true }))

  it('removes a running torrent with deleteFiles, forgets its thumbnail, and calls removeMissing for a missing row', async () => {
    memory.store.set(thumbnailKey(A), new Uint8Array([1, 2, 3]))
    await made.ripple.remove(A, { deleteFiles: true })
    await made.ripple.remove(B)
    await made.ripple.remove(GHOST)
    expect(memory.store.has(thumbnailKey(A))).toBe(false)
    expect(made.engine.posted.slice(-3)).toEqual([
      { type: 'remove', handle: 1, deleteFiles: true },
      { type: 'remove', handle: 2, deleteFiles: false },
      { type: 'remove-missing', infoHash: GHOST },
    ])
  })

  it('marks a running torrent temporary and refuses missing or source torrents', async () => {
    await made.ripple.makeTemporary(A)
    await made.ripple.makeTemporary(TEMPORARY)
    expect(made.engine.posted.filter((m) => m.type === 'set-temporary')).toEqual([
      { type: 'set-temporary', infoHash: A, temporary: true },
    ])
    expect(await refusal(made.ripple.makeTemporary(GHOST))).toBe('unavailable')
    expect(await refusal(made.ripple.makeTemporary(SOURCE_HASH))).toBe('unavailable')
  })
})

describe('files: read, play and save', () => {
  beforeEach(() => answer(URI, { files: true }))

  it('reads up to 4 MB without prioritizing by default, supports prioritize and AbortSignal, and reads temporary torrents', async () => {
    // default prioritize is false (must not default to client.read's true!)
    const n0 = made.engine.posted.length
    const quiet = made.ripple.read(A, 1, 10, 4)
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n0))
    const req1 = made.engine.posted.at(-1)!
    expect(req1).toMatchObject({ type: 'read', handle: 1, fileIndex: 1, offset: 10, len: 4, prioritize: false })
    made.engine.say({ type: 'read-result', id: req1.id, data: new Uint8Array([1, 2, 3, 4]) })
    expect(await quiet).toEqual(new Uint8Array([1, 2, 3, 4]))

    // prioritize: true and temporary torrent
    const n1 = made.engine.posted.length
    const prio = made.ripple.read(TEMPORARY, 0, 0, 8, { prioritize: true })
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n1))
    const req2 = made.engine.posted.at(-1)!
    expect(req2).toMatchObject({ type: 'read', handle: 3, fileIndex: 0, offset: 0, len: 8, prioritize: true })
    made.engine.say({ type: 'read-result', id: req2.id, data: new Uint8Array(8) })
    expect((await prio).byteLength).toBe(8)

    // clamps to remaining file bytes and returns empty on 0 length
    expect(await made.ripple.read(A, 1, 1024, 16)).toEqual(new Uint8Array(0))
    // rejects > 4 MB, negative, pad file, unknown file, offset past EOF, array options, non-AbortSignal signal
    expect(await refusal(made.ripple.read(A, 1, 0, READ_MAX_BYTES + 1))).toBe('invalid')
    expect(await refusal(made.ripple.read(A, 1, -1, 4))).toBe('invalid')
    expect(await refusal(made.ripple.read(A, 1, 2000, 4))).toBe('invalid')
    expect(await refusal(made.ripple.read(A, 1, 0, 4, [] as never))).toBe('invalid')
    expect(await refusal(made.ripple.read(A, 1, 0, 4, { signal: {} as never }))).toBe('invalid')
    expect(await refusal(made.ripple.read(A, 0, 0, 4))).toBe('not-found')
    expect(await refusal(made.ripple.read(A, 99, 0, 4))).toBe('not-found')

    // engine "not downloaded" maps to unavailable
    const n2 = made.engine.posted.length
    const miss = made.ripple.read(A, 1, 0, 4)
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n2))
    made.engine.say({ type: 'read-error', id: made.engine.posted.at(-1)!.id, error: 'not downloaded' })
    expect(await refusal(miss)).toBe('unavailable')

    // AbortSignal cancels the read
    const n3 = made.engine.posted.length
    const ac = new AbortController()
    const aborted = made.ripple.read(A, 1, 0, 4, { signal: ac.signal })
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n3))
    ac.abort()
    await expect(aborted).rejects.toThrow()
    expect(made.engine.posted.some((m) => m.type === 'cancel-read')).toBe(true)
  })

  it('play navigates to /watch for the chosen file (including temporary torrents) and closes the plugin page', async () => {
    made.setGesture(true)
    await made.ripple.play(TEMPORARY, 0)
    expect(made.closedPages).toEqual([URI])
    expect(made.navigated).toHaveLength(1)
    expect(made.navigated[0]).toContain('/watch')
    expect(made.navigated[0]).toContain('fileIndex=0')
    expect(await refusal(made.ripple.play(A, 0))).toBe('not-found')
  })

  it('save answers false when no service worker controls the page', async () => {
    made.setGesture(true)
    expect(await made.ripple.save(A, 1)).toBe(false)
    expect(await made.ripple.save(B)).toBe(false)
    expect(await refusal(made.ripple.save(A, 0))).toBe('not-found')
  })
})

describe('folder and move', () => {
  beforeEach(() => answer(URI, { folder: true }))

  it('reports { name, allowed } or null without leaking a handle, and records move intent via setLocation', async () => {
    expect(await made.ripple.folder()).toEqual({ name: 'Downloads', allowed: true })
    await made.ripple.move(A, 'folder')
    await made.ripple.move(A, 'browser')
    expect(made.engine.posted.slice(-2)).toEqual([
      { type: 'set-location', infoHash: A, to: 'folder' },
      { type: 'set-location', infoHash: A, to: 'browser' },
    ])
    expect(await refusal(made.ripple.move(A, 'source' as never))).toBe('invalid')
    expect(await refusal(made.ripple.move(SOURCE_HASH, 'browser'))).toBe('unavailable')
    made.setFolder(null)
    expect(await made.ripple.folder()).toBeNull()
    expect(await refusal(made.ripple.move(A, 'folder'))).toBe('unavailable')
  })
})

describe('peers, trackers and speed limits', () => {
  beforeEach(() => answer(URI, { peers: true }))

  it('returns projected peers (blinking WebRTC internal endpoints) and strips tracker passkeys and messages', async () => {
    const n1 = made.engine.posted.length
    const peersP = made.ripple.peers(A)
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n1))
    const ask1 = made.engine.posted.at(-1)!
    expect(ask1).toMatchObject({ type: 'torrent-detail', handle: 1 })
    made.engine.say({
      type: 'answer',
      id: ask1.id,
      value: {
        peers: [
          { endpoint: '198.51.100.7:6881', client: 'Transmission 4', downloadRate: 2048, uploadRate: 512, totalDownload: 9999, totalUpload: 1111, progress: 0.75, flags: 3, source: 1, transport: 'tcp', localConnection: false },
          { endpoint: 'webrtc-internal-42', client: 'WebTorrent', downloadRate: 100, uploadRate: 0, totalDownload: 0, totalUpload: 0, progress: 1, flags: 0, source: 0, transport: 'webrtc', localConnection: false },
        ],
        trackers: [],
      },
    })
    const peers = await peersP
    expect(peers).toEqual([
      { address: '198.51.100.7:6881', client: 'Transmission 4', down: 2048, up: 512, progress: 0.75 },
      { address: '', client: 'WebTorrent', down: 100, up: 0, progress: 1 },
    ])
    // fixed projection keys only
    expect(Object.keys(peers[0]!).sort()).toEqual(['address', 'client', 'down', 'progress', 'up'])

    const n2 = made.engine.posted.length
    const trackersP = made.ripple.trackers(A)
    await vi.waitFor(() => expect(made.engine.posted.length).toBeGreaterThan(n2))
    const ask2 = made.engine.posted.at(-1)!
    made.engine.say({
      type: 'answer',
      id: ask2.id,
      value: {
        peers: [],
        trackers: [
          { url: 'https://user:secret@tracker.example:8443/abc123passkey/announce?key=xyz', message: 'error at abc123passkey', tier: 0, fails: 0, updating: false, verified: true, nextAnnounceIn: 60, seeders: 2, leechers: 1, downloaded: 5 },
          { url: 'udp://uncontacted.example:6969/announce', message: '', tier: 1, fails: -1, updating: false, verified: false, nextAnnounceIn: -1, seeders: -1, leechers: -1, downloaded: -1 },
          { url: 'https://updating.example/announce', message: '', tier: 1, fails: 0, updating: true, verified: false, nextAnnounceIn: 0, seeders: 0, leechers: 0, downloaded: 0 },
          { url: 'https://failing.example/announce', message: 'timeout', tier: 1, fails: 3, updating: false, verified: false, nextAnnounceIn: 30, seeders: 0, leechers: 0, downloaded: 0 },
          { url: 'not a url', message: '', tier: 2, fails: 0, updating: false, verified: false, nextAnnounceIn: 0, seeders: 0, leechers: 0, downloaded: 0 },
        ],
      },
    })
    const trackers = await trackersP
    expect(trackers).toEqual([
      { origin: 'https://tracker.example:8443', working: true },
      { origin: 'udp://uncontacted.example:6969', working: false },
      { origin: 'https://updating.example', working: false },
      { origin: 'https://failing.example', working: false },
    ])
    const serialized = JSON.stringify(trackers)
    expect(serialized).not.toContain('abc123passkey')
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('timeout')
    // never sent `inspect`
    expect(made.engine.posted.some((m) => m.type === 'inspect')).toBe(false)
  })

  it('reads latched session limits and validates per-torrent and session limits', async () => {
    expect(await made.ripple.sessionLimits()).toEqual({ down: 500_000, up: 100_000 })
    await made.ripple.setLimits(A, { down: 250_000 })
    await made.ripple.setSessionLimits({ down: 0, up: 50_000 })
    expect(made.engine.posted.slice(-2)).toEqual([
      { type: 'set-limits', handle: 1, down: 250_000 },
      { type: 'set-session-limits', down: 0, up: 50_000 },
    ])
    expect(await refusal(made.ripple.setLimits(A, { down: -1 }))).toBe('invalid')
    expect(await refusal(made.ripple.setSessionLimits({ up: Number.NaN }))).toBe('invalid')
  })
})

describe('network', () => {
  beforeEach(() => answer(URI, { network: true }))

  it('reports relay reachability, inbound, dhtNodes and storageFull, and zeroes relay stats on direct transport', async () => {
    expect(await made.ripple.network()).toEqual({
      transport: 'relay',
      reachable: true,
      inbound: 3,
      dhtNodes: 120,
      storageFull: false,
    })

    made.engine.say({ type: 'storage-full', full: 'kept' })
    made.engine.say({
      type: 'state',
      torrents: [],
      transport: 'relay',
      reachable: { port: 41337, portOpen: false, inbound: 4, listenFailed: [], listeners: [] },
      inboundNow: { tcp: 0, utp: 0, webrtc: 0, total: 0 },
      dhtNodes: 80,
    })
    expect(await made.ripple.network()).toEqual({
      transport: 'relay',
      reachable: false,
      inbound: 0,
      dhtNodes: 80,
      storageFull: true,
    })

    made.engine.say({
      type: 'state',
      torrents: [],
      transport: 'direct',
      reachable: { port: 41337, portOpen: true, inbound: 4, listenFailed: [], listeners: [] },
      inboundNow: { tcp: 2, utp: 0, webrtc: 0, total: 2 },
      dhtNodes: 80,
    })
    expect(await made.ripple.network()).toEqual({
      transport: 'direct',
      reachable: false,
      inbound: 0,
      dhtNodes: 0,
      storageFull: true,
    })
  })

  it('waits for the first state broadcast after ready and after engine reset in sessionLimits and network', async () => {
    await answer(URI, { peers: true, network: true })
    const fresh = engineDouble({ createTorrentClient } as never)
    const feed = createFeed(fresh.client)
    const tab: PluginTab = {
      client: () => fresh.client,
      buttonsChanged: () => {},
      openPage: async () => {},
      beginClosePage: () => null,
      closePage: () => {},
      inGesture: () => false,
      takeSuggest: () => false,
      canSuggest: () => false,
      suggest: async () => ({ infoHash: null, outcome: 'failed' }),
      navigate: () => {},
      folder: async () => null,
      feed: () => feed,
      owns: () => true,
      vpn: () => true,
      locale: () => ({ locale: 'en', dir: 'ltr' }),
      onActive: () => () => {},
      onVpn: () => () => {},
      onLocale: () => () => {},
    }
    const { ripple, close } = rippleFor(URI, tab, async () => ['peers', 'network'])
    try {
      // attach transport without sending state yet, then emit ready BEFORE state arrives
      fresh.attach(true)
      fresh.say({ type: 'ready' })
      await fresh.client.ready

      let settledLimits = false
      let settledNet = false
      const limitsP = ripple.sessionLimits().then((v) => { settledLimits = true; return v })
      const netP = ripple.network().then((v) => { settledNet = true; return v })
      await new Promise((r) => setTimeout(r, 30))
      expect(settledLimits).toBe(false)
      expect(settledNet).toBe(false)

      fresh.say({
        type: 'state',
        torrents: [],
        transport: 'relay',
        reachable: { port: 51000, portOpen: true, inbound: 2, listenFailed: [], listeners: [] },
        inboundNow: { tcp: 1, utp: 1, webrtc: 0, total: 2 },
        dhtNodes: 64,
        rateLimits: { down: 123_000, up: 45_000 },
      })
      expect(await limitsP).toEqual({ down: 123_000, up: 45_000 })
      expect(await netP).toEqual({ transport: 'relay', reachable: true, inbound: 2, dhtNodes: 64, storageFull: false })

      // after a handover / VPN reset clears lastState, calls wait for the new engine's state
      fresh.say({ type: 'engine-reset' })
      let settledAfterReset = false
      const afterReset = ripple.network().then((v) => { settledAfterReset = true; return v })
      await new Promise((r) => setTimeout(r, 30))
      expect(settledAfterReset).toBe(false)
      fresh.say({
        type: 'state',
        torrents: [],
        transport: 'direct',
        reachable: { port: null, portOpen: false, inbound: 0, listenFailed: [], listeners: [] },
        inboundNow: { tcp: 0, utp: 0, webrtc: 0, total: 0 },
        dhtNodes: 0,
      })
      expect(await afterReset).toEqual({ transport: 'direct', reachable: false, inbound: 0, dhtNodes: 0, storageFull: false })
    } finally {
      close()
      feed.destroy()
      fresh.client.destroy()
    }
  })
})
