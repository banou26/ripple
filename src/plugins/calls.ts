import type { AddResult, FileAddOptions, PluginEvents, PluginGroup, PluginTorrent, Ripple, Source, Switch } from './contract'
import type { Feed } from './feed'
import type { TorrentClient } from '../torrent/client'
import type { Torrent } from '../torrent/types'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { describeAddRequest } from '../router/add-request'
import { createGroup, deleteGroup, putInGroup, renameGroup, takeOutOfGroup, torrentsIn } from '../torrent/groups'
import { hexInfoHash, magnetInfoHash, sameInfoHash } from '../torrent/magnet'
import { readTorrentFile } from '../torrent/torrent-file'
import { keepSyncedTorrentFile } from '../torrent/torrent-file-sync'
import { holdWhileStored } from '../utils/page-work'
import { keptOf, publicTorrentFile } from './project'
import { storeGet, storeSet } from './store'
import { isOn } from './switches'

/** What a tab gives every plugin connected in it. */
export type PluginTab = {
  client: () => TorrentClient
  /** The plugin's `ui.buttonsChanged()`. */
  buttonsChanged: (uri: string) => void
  feed: () => Feed
  owns: () => boolean
  vpn: () => boolean
  locale: () => { locale: string, dir: 'ltr' | 'rtl' }
  onActive: (listener: (active: boolean) => void) => () => void
  onVpn: (listener: (on: boolean) => void) => () => void
  onLocale: (listener: (locale: { locale: string, dir: 'ltr' | 'rtl' }) => void) => () => void
}

/** How long an add waits for the engine's answer before it counts as failed. */
export const ADD_ANSWER_MS = 60_000

const QUEUE_MOVES = new Set(['top', 'up', 'down', 'bottom'])
const TORRENT_EVENTS = new Set<keyof PluginEvents>(['changed', 'added', 'finished', 'removed'])
const EVENTS = new Set<keyof PluginEvents>(['vpn', 'locale', 'active', ...TORRENT_EVENTS])

// a declaration, so a call to it ends the branch for the type checker
function fail (reason: string): never { throw new Error(reason) }

const isHashList = (value: unknown): value is string[] => Array.isArray(value) && value.every((h) => typeof h === 'string')

const kept = (t: Torrent): t is Torrent & { infoHash: string } => !!t.infoHash && t.ephemeral !== true

const answerOf = (client: TorrentClient, addId: string) => new Promise<AddResult['outcome']>((resolve) => {
  const timer = setTimeout(() => { off(); resolve('failed') }, ADD_ANSWER_MS)
  const off = client.onAddAnswer((answer) => {
    if (answer.addId !== addId) return
    clearTimeout(timer)
    off()
    resolve(answer.already ? 'already' : answer.added ? 'added' : 'failed')
  })
})

/**
 * The calls one plugin may make, each refused unless the plugin asks for its switch (`asks`, once connected) and the
 * person turned it on, read from storage as the call runs; and `close`, which drops what the plugin subscribed to once
 * its connection is gone.
 */
export const rippleFor = (uri: string, tab: PluginTab, asks: () => Promise<readonly Switch[]>): { ripple: Ripple, close: () => void } => {
  const need = async (name: Switch) => { if (!(await asks()).includes(name) || !(await isOn(uri, name))) fail('not-allowed') }
  const offs = new Set<() => void>()

  const rows = () => tab.feed().rows()
  const find = async (infoHash: unknown): Promise<Torrent & { infoHash: string }> => {
    if (typeof infoHash !== 'string') fail('invalid')
    const t = (await rows()).find((row) => sameInfoHash(row.infoHash, infoHash))
    return (t?.infoHash ? t : fail('not-found')) as Torrent & { infoHash: string }
  }
  // a row the engine runs, by the handle this engine gave it; a row it does not run has none to act on
  const running = async (infoHash: unknown, name: Switch = 'change') => {
    await need(name)
    const t = await find(infoHash)
    const handle = Number(t.id)
    return { t, handle: Number.isInteger(handle) ? handle : fail('unavailable') }
  }
  // each hash as the library writes it, so the person's own groups and a plugin's agree; only a torrent the library
  // holds joins a group, as on Ripple's own screens, while one it no longer holds can still leave
  const members = async (infoHashes: unknown, joining: boolean): Promise<string[]> => {
    if (!isHashList(infoHashes)) fail('invalid')
    const library = await rows()
    return infoHashes.map((h) => {
      const hex = hexInfoHash(h)
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(hex)) fail('invalid')
      return library.find((t) => sameInfoHash(t.infoHash, h))?.infoHash ?? (joining ? fail('not-found') : hex)
    })
  }
  const group = async (id: unknown) => {
    await need('change')
    const known = typeof id === 'string' && (await tab.feed().groups()).some((g) => g.id === id)
    return known ? id : fail('not-found')
  }

  const on = async <E extends keyof PluginEvents>(event: E, listener: (value: PluginEvents[E]) => void) => {
    if (!EVENTS.has(event) || typeof listener !== 'function') fail('invalid')
    // a listener in a frame that is gone rejects, and is dropped
    let off = () => {}
    const call = (value: unknown) => { Promise.resolve((listener as (v: unknown) => unknown)(value)).catch(() => off()) }
    if (TORRENT_EVENTS.has(event)) {
      await need('read')
      const unlisten = tab.feed().listen(async (events) => {
        if (!(await need('read').then(() => true, () => false))) return
        if (event === 'changed') { if (events.changed.length) call(events.changed) }
        else for (const value of events[event as 'added' | 'finished' | 'removed']) call(value)
      })
      off = () => { unlisten(); offs.delete(off) }
    } else {
      const unlisten = event === 'vpn' ? tab.onVpn(call) : event === 'locale' ? tab.onLocale(call) : tab.onActive(call)
      off = () => { unlisten(); offs.delete(off) }
    }
    offs.add(off)
    return off
  }

  const add = async (source: Source, options?: FileAddOptions): Promise<AddResult> => {
    await need('add')
    const magnet = typeof (source as { magnet?: unknown })?.magnet === 'string' ? (source as { magnet: string }).magnet : null
    const bytes = (source as { torrentFile?: unknown })?.torrentFile instanceof Uint8Array ? (source as { torrentFile: Uint8Array }).torrentFile : null
    const files = options?.files
    if ((!magnet && !bytes) || (files !== undefined && !(Array.isArray(files) && files.every((i) => Number.isInteger(i) && i >= 0)))) fail('invalid')
    const request = magnet ? describeAddRequest({ magnet }) : null
    const read = bytes ? await readTorrentFile(bytes) : null
    const infoHash = request?.ok ? request.infoHash : read ? magnetInfoHash(read.magnet) : null
    if (!infoHash) return { infoHash: null, outcome: 'failed' }
    const answer = { infoHash: hexInfoHash(infoHash) }
    if ((await rows()).some((t) => sameInfoHash(t.infoHash, infoHash) && t.ephemeral !== true)) return { ...answer, outcome: 'already' }
    const client = tab.client()
    const addId = crypto.randomUUID()
    const settled = answerOf(client, addId)
    holdWhileStored()
    if (request?.ok) client.addMagnet(request.magnet, { addId })
    else if (bytes) {
      const location = options?.location
      client.addTorrentFile(new Uint8Array(bytes), {
        addId,
        wanted: files,
        firstLast: options?.firstLast === true,
        sequential: options?.sequential === true,
        paused: options?.paused === true,
        top: options?.top === true,
        saveTo: location === 'browser' || location === 'folder' ? location : undefined,
      })
    }
    return { ...answer, outcome: await settled }
  }

  const ripple: Ripple = {
    version: 1,
    ...tab.locale(),
    vpn: tab.vpn(),
    active: tab.owns(),
    on,
    ui: {
      buttonsChanged: async () => { tab.buttonsChanged(uri) },
    },
    store: {
      get: (key) => storeGet(uri, key),
      set: (key, value) => storeSet(uri, key, value),
    },
    torrents: async () => {
      await need('read')
      return Promise.all((await rows()).filter(kept).map(tab.feed().project))
    },
    torrent: async (infoHash) => {
      await need('read')
      const t = (await rows()).find((row) => typeof infoHash === 'string' && sameInfoHash(row.infoHash, infoHash))
      return t?.infoHash ? tab.feed().project(t as Torrent & { infoHash: string }) : null
    },
    groups: async (): Promise<PluginGroup[]> => {
      await need('read')
      return (await tab.feed().groups()).map((g) => ({ id: g.id, name: g.name, infoHashes: [...torrentsIn(g)].map(hexInfoHash) }))
    },
    torrentFile: async (infoHash) => {
      await need('read')
      const t = (await rows()).find((row) => typeof infoHash === 'string' && sameInfoHash(row.infoHash, infoHash))
      return t?.infoHash ? publicTorrentFile(t.infoHash) : null
    },
    add,
    pause: async (infoHash) => { const { handle } = await running(infoHash); tab.client().pause(handle) },
    resume: async (infoHash) => { const { handle } = await running(infoHash); tab.client().resume(handle) },
    forceStart: async (infoHash) => { const { handle } = await running(infoHash); tab.client().forceStart(handle) },
    recheck: async (infoHash) => { const { handle } = await running(infoHash); tab.client().recheck(handle) },
    reannounce: async (infoHash) => { const { handle } = await running(infoHash); tab.client().reannounce(handle) },
    retry: async (infoHash) => { const { handle } = await running(infoHash); tab.client().retry(handle) },
    start: async (infoHash) => {
      await need('change')
      const t = await find(infoHash)
      if (t.state !== 'missing' || t.saveTo === 'source') return
      await keepSyncedTorrentFile(t.infoHash)
      tab.client().start(t.infoHash)
    },
    keep: async (infoHash) => {
      await need('change')
      const t = await find(infoHash)
      if (t.ephemeral === true) tab.client().setTemporary(t.infoHash, false)
    },
    setFiles: async (infoHash, wanted) => {
      const { t, handle } = await running(infoHash)
      const indices = new Set((t.files ?? []).filter((f) => !f.pad).map((f) => f.index))
      if (!Array.isArray(wanted) || !wanted.every((i) => indices.has(i))) fail('invalid')
      tab.client().setPlan(handle, { wanted: [...new Set(wanted)], firstLast: t.firstLast })
    },
    setFirstLast: async (infoHash, on) => {
      const { t, handle } = await running(infoHash)
      tab.client().setPlan(handle, { wanted: t.wantedFiles, firstLast: on === true })
    },
    setSequential: async (infoHash, on) => {
      const { handle } = await running(infoHash)
      tab.client().setFlags(handle, on === true ? TORRENT_FLAG.sequentialDownload : 0, TORRENT_FLAG.sequentialDownload)
    },
    moveInQueue: async (infoHash, where) => {
      const { handle } = await running(infoHash)
      if (!QUEUE_MOVES.has(where)) fail('invalid')
      tab.client().moveInQueue(handle, where)
    },
    addTrackers: async (infoHash, urls) => {
      const { t, handle } = await running(infoHash)
      if (!Array.isArray(urls) || !urls.every((url) => typeof url === 'string')) fail('invalid')
      // a tracker added to a private torrent is told about it, and the torrent may hold a key
      if ((await keptOf(t.infoHash))?.private !== false) fail('not-allowed')
      return tab.client().addTrackers(handle, urls)
    },
    createGroup: async (name, infoHashes = []) => {
      await need('change')
      if (typeof name !== 'string') fail('invalid')
      return (await createGroup(name, await members(infoHashes, true))) ?? fail('invalid')
    },
    renameGroup: async (id, name) => {
      const known = await group(id)
      if (typeof name !== 'string') fail('invalid')
      await renameGroup(known, name)
    },
    deleteGroup: async (id) => { await deleteGroup(await group(id)) },
    putInGroup: async (id, infoHashes) => { const known = await group(id); await putInGroup(known, await members(infoHashes, true)) },
    takeOutOfGroup: async (id, infoHashes) => { const known = await group(id); await takeOutOfGroup(known, await members(infoHashes, false)) },
  }

  return { ripple, close: () => { for (const off of [...offs]) off() } }
}

export type { PluginTorrent }
