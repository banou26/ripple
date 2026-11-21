import type {
  AddResult, ClickContext, FileAddOptions, PageOpen, PluginEvents, PluginFolder, PluginGroup, PluginLimits,
  PluginNetwork, PluginPeer, PluginTorrent, PluginTracker, Ripple, Source, Switch,
} from './contract'
import type { Feed } from './feed'
import type { Reachability, TorrentClient } from '../torrent/client'
import type { StorageFull } from '../torrent/storage-budget'
import type { Torrent } from '../torrent/types'
import type { EngineTransport } from '../torrent/vpn-config'

import { TORRENT_FLAG } from 'libtorrent-wasm'

import { describeAddRequest } from '../router/add-request'
import { createGroup, deleteGroup, putInGroup, renameGroup, takeOutOfGroup, torrentsIn } from '../torrent/groups'
import { NO_INBOUND } from '../torrent/inbound'
import { hexInfoHash, magnetInfoHash, sameInfoHash } from '../torrent/magnet'
import { isLimit } from '../torrent/rate-limits'
import { isSaveCancelled, saveTorrentEntriesAsZipToDisk, saveTorrentFileToDisk } from '../torrent/save-file'
import { currentLocation } from '../torrent/save-location'
import { forgetThumbnail } from '../torrent/thumbnail-store'
import { readTorrentFile } from '../torrent/torrent-file'
import { keepSyncedTorrentFile } from '../torrent/torrent-file-sync'
import { contentFiles } from '../torrent/types'
import { watchHref } from '../torrent/watch'
import { holdWhileStored } from '../utils/page-work'
import { isPageSize } from './buttons'
import { keptOf, publicTorrentFile, trackerOrigin } from './project'
import { storeGet, storeSet } from './store'
import { isOn } from './switches'

/** A torrent a plugin proposed through `suggest`, ready for the library's add queue. */
export type SuggestedAdd = {
  magnet: string
  infoHash: string
  name: string
  from: string
  bytes?: Uint8Array
  files?: { name: string, size: number, index: number }[]
}

/** What a tab gives every plugin connected in it. */
export type PluginTab = {
  client: () => TorrentClient
  /** The plugin's `ui.buttonsChanged()`. */
  buttonsChanged: (uri: string) => void
  /** Opens a popup page for `uri` inside Ripple's dialog. */
  openPage: (uri: string, page: PageOpen) => Promise<void>
  /** Ends `uri`'s page gesture immediately and returns its page key so deferred unmount closes only that page. */
  beginClosePage: (uri: string) => number | null
  /** Closes `uri`'s open popup page (only matching `key` when given). */
  closePage: (uri: string, key?: number) => void
  /** Whether `uri` is inside its gesture window (within 10 s of a click on its button, or while its page is open). */
  inGesture: (uri: string) => boolean
  /** Claims one `suggest` slot in `uri`'s current gesture window; false once the window is spent or closed. */
  takeSuggest: (uri: string) => boolean
  /** Whether the library page is mounted in this tab and can show the add dialog. */
  canSuggest: () => boolean
  /** Hands a validated proposal to the library's add queue. */
  suggest: (uri: string, item: Omit<SuggestedAdd, 'from'>) => Promise<AddResult>
  /** Navigates this tab to a Ripple route (used by `play`). */
  navigate: (to: string) => void
  /** The chosen download folder's name and current permission without prompting, or null. */
  folder: () => Promise<PluginFolder | null>
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
/** Maximum byte length a single `read` call may request. */
export const READ_MAX_BYTES = 4 * 1024 * 1024

const QUEUE_MOVES = new Set(['top', 'up', 'down', 'bottom'])
const TORRENT_EVENTS = new Set<keyof PluginEvents>(['changed', 'added', 'finished', 'removed'])
const EVENTS = new Set<keyof PluginEvents>(['vpn', 'locale', 'active', ...TORRENT_EVENTS])

// a declaration, so a call to it ends the branch for the type checker
function fail (reason: string): never { throw new Error(reason) }

const isHashList = (value: unknown): value is string[] => Array.isArray(value) && value.every((h) => typeof h === 'string')

const kept = (t: Torrent): t is Torrent & { infoHash: string } => !!t.infoHash && t.ephemeral !== true

const peek = <T>(watch: (cb: (value: T) => void) => () => void, fallback: T): T => {
  let value = fallback
  watch((next) => { value = next })()
  return value
}

const STATE_WAIT_MS = 5_000

const waitForState = (client: TorrentClient): Promise<void> => new Promise((resolve) => {
  let done = false
  let offState: (() => void) | undefined
  let offError: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    timer = undefined
    offState?.()
    offState = undefined
    offError?.()
    offError = undefined
    resolve()
  }
  timer = setTimeout(finish, STATE_WAIT_MS)
  offError = client.onWorkerError(({ fatal }) => { if (fatal) finish() })
  if (!done) offState = client.onState(finish)
  if (done) { offState?.(); offState = undefined; offError?.(); offError = undefined }
})

const cleanLimits = (raw: unknown): { down?: number, up?: number } => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid')
  const { down, up } = raw as Record<string, unknown>
  if (down !== undefined && !isLimit(down)) fail('invalid')
  if (up !== undefined && !isLimit(up)) fail('invalid')
  return { ...(down !== undefined ? { down } : {}), ...(up !== undefined ? { up } : {}) }
}

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
export const rippleFor = (
  uri: string,
  tab: PluginTab,
  asks: () => Promise<readonly Switch[]>,
  page: { id: string, context: ClickContext } | null = null,
): { ripple: Ripple, close: () => void } => {
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

  const suggest = async (source: Source): Promise<AddResult> => {
    if (!tab.inGesture(uri)) fail('not-allowed')
    const magnet = typeof (source as { magnet?: unknown })?.magnet === 'string' ? (source as { magnet: string }).magnet : null
    const bytes = (source as { torrentFile?: unknown })?.torrentFile instanceof Uint8Array ? (source as { torrentFile: Uint8Array }).torrentFile : null
    if (!magnet && !bytes) fail('invalid')
    if (!tab.canSuggest()) fail('unavailable')
    if (!tab.takeSuggest(uri)) fail('not-allowed')
    const request = magnet ? describeAddRequest({ magnet }) : null
    const read = bytes ? await readTorrentFile(bytes) : null
    const infoHash = request?.ok ? request.infoHash : read ? magnetInfoHash(read.magnet) : null
    if (!infoHash) return { infoHash: null, outcome: 'failed' }
    const answer = { infoHash: hexInfoHash(infoHash) }
    if ((await rows()).some((t) => sameInfoHash(t.infoHash, infoHash) && t.ephemeral !== true)) return { ...answer, outcome: 'already' }
    if (!tab.canSuggest()) fail('unavailable')
    if (request?.ok) return tab.suggest(uri, { magnet: request.magnet, infoHash: answer.infoHash, name: request.name })
    if (!read?.files || !bytes) return { ...answer, outcome: 'failed' }
    return tab.suggest(uri, { magnet: read.magnet, infoHash: answer.infoHash, name: read.name, bytes: new Uint8Array(bytes), files: read.files })
  }

  const ripple: Ripple = {
    version: 1,
    ...tab.locale(),
    vpn: tab.vpn(),
    active: tab.owns(),
    page: page ? { id: page.id, context: { ...page.context } } : null,
    on,
    ui: {
      buttonsChanged: async () => { tab.buttonsChanged(uri) },
      open: async (arg) => {
        if (!arg || typeof arg !== 'object') fail('invalid')
        const { id, size, context } = arg as Record<string, unknown>
        const trimmed = typeof id === 'string' ? id.trim() : ''
        if (!trimmed) fail('invalid')
        if (size !== undefined && !isPageSize(size)) fail('invalid')
        if (context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context))) fail('invalid')
        if (!tab.inGesture(uri)) fail('not-allowed')
        await tab.openPage(uri, { id: trimmed, ...(size && { size }), context: context ? { ...(context as ClickContext) } : {} })
      },
      close: async () => {
        const key = tab.beginClosePage(uri)
        if (key === null) return
        // two posted-message hops guarantee osra's microtask reply is queued before hop 2 and delivered before unmount
        const hop = (next: () => void) => {
          const ch = new MessageChannel()
          ch.port1.onmessage = () => { ch.port1.close(); ch.port2.close(); next() }
          ch.port2.postMessage(null)
        }
        hop(() => hop(() => tab.closePage(uri, key)))
      },
    },
    store: {
      get: (key) => storeGet(uri, key),
      set: (key, value) => storeSet(uri, key, value),
    },
    suggest,
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
    remove: async (infoHash, options) => {
      await need('remove')
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) fail('invalid')
      const t = await find(infoHash)
      if (t.state === 'missing') { void forgetThumbnail(t.infoHash); tab.client().removeMissing(t.infoHash); return }
      const handle = Number(t.id)
      if (!Number.isInteger(handle)) fail('unavailable')
      void forgetThumbnail(t.infoHash)
      tab.client().remove(handle, options?.deleteFiles === true)
    },
    makeTemporary: async (infoHash) => {
      await need('remove')
      const t = await find(infoHash)
      if (t.state === 'missing' || t.saveTo === 'source' || currentLocation(t.stats?.savePath) === 'source') fail('unavailable')
      if (t.ephemeral !== true) tab.client().setTemporary(t.infoHash, true)
    },
    read: async (infoHash, file, offset, length, options) => {
      const { t, handle } = await running(infoHash, 'files')
      if (typeof file !== 'number' || !Number.isInteger(file) || file < 0) fail('invalid')
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) fail('invalid')
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > READ_MAX_BYTES) fail('invalid')
      if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) fail('invalid')
      if (options?.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('invalid')
      if (!t.files) fail('unavailable')
      const target = contentFiles(t.files).find((f) => f.index === file)
      if (!target) fail('not-found')
      if (offset > target.size) fail('invalid')
      const len = Math.min(length, target.size - offset)
      if (len === 0) return new Uint8Array(0)
      try {
        return await tab.client().read(handle, target.index, offset, len, options?.prioritize === true, undefined, options?.signal)
      } catch (err) {
        if (options?.signal?.aborted || (err as Error)?.name === 'AbortError') throw err
        fail('unavailable')
      }
    },
    play: async (infoHash, file) => {
      await need('files')
      if (typeof file !== 'number' || !Number.isInteger(file) || file < 0) fail('invalid')
      if (!tab.inGesture(uri)) fail('not-allowed')
      const t = await find(infoHash)
      if (!t.magnet || !t.files) fail('unavailable')
      const target = contentFiles(t.files).find((f) => f.index === file)
      if (!target) fail('not-found')
      const href = watchHref(t, target.index)
      if (!href) fail('unavailable')
      if (!tab.inGesture(uri)) fail('not-allowed')
      tab.closePage(uri)
      tab.navigate(href)
    },
    save: async (infoHash, file) => {
      await need('files')
      if (file !== undefined && (typeof file !== 'number' || !Number.isInteger(file) || file < 0)) fail('invalid')
      if (!tab.inGesture(uri)) fail('not-allowed')
      const { t, handle } = await running(infoHash, 'files')
      const files = contentFiles(t.files)
      if (!files.length) fail('unavailable')
      const one = file === undefined
        ? (files.length === 1 ? files[0] : null)
        : (files.find((f) => f.index === file) ?? fail('not-found'))
      if (!tab.inGesture(uri)) fail('not-allowed')
      const client = tab.client()
      const viewer = client.newViewerId()
      try {
        if (one) {
          await saveTorrentFileToDisk(client, handle, one.index, one.name, one.size, undefined, { viewer, streamOnly: true })
        } else {
          await saveTorrentEntriesAsZipToDisk(
            client, handle, t.name, files.map((f) => ({ index: f.index, path: f.name, size: f.size })),
            undefined, { viewer, streamOnly: true },
          )
        }
        return true
      } catch (err) {
        if (isSaveCancelled(err)) return false
        fail('unavailable')
      } finally {
        client.unwatch(viewer)
      }
    },
    folder: async () => {
      await need('folder')
      return tab.folder()
    },
    move: async (infoHash, location) => {
      await need('folder')
      if (location !== 'browser' && location !== 'folder') fail('invalid')
      const t = await find(infoHash)
      if (t.saveTo === 'source' || currentLocation(t.stats?.savePath) === 'source') fail('unavailable')
      if (location === 'folder' && !(await tab.folder())) fail('unavailable')
      tab.client().setLocation(t.infoHash, location)
    },
    peers: async (infoHash): Promise<PluginPeer[]> => {
      const { handle } = await running(infoHash, 'peers')
      const detail = await tab.client().torrentDetail(handle).catch(() => fail('unavailable'))
      if (!detail) fail('unavailable')
      return detail.peers.map((p) => ({
        address: p.transport === 'webrtc' ? '' : p.endpoint,
        client: p.client,
        down: p.downloadRate,
        up: p.uploadRate,
        progress: p.progress,
      }))
    },
    trackers: async (infoHash): Promise<PluginTracker[]> => {
      const { handle } = await running(infoHash, 'peers')
      const detail = await tab.client().torrentDetail(handle).catch(() => fail('unavailable'))
      if (!detail) fail('unavailable')
      return detail.trackers.flatMap((tr) => {
        const origin = trackerOrigin(tr.url)
        return origin ? [{ origin, working: !tr.updating && tr.fails === 0 }] : []
      })
    },
    setLimits: async (infoHash, limits) => {
      const { handle } = await running(infoHash, 'peers')
      tab.client().setLimits(handle, cleanLimits(limits))
    },
    sessionLimits: async (): Promise<PluginLimits> => {
      await need('peers')
      const client = tab.client()
      await client.ready
      await waitForState(client)
      const { down, up } = peek(client.onRateLimits, { down: 0, up: 0 })
      return { down, up }
    },
    setSessionLimits: async (limits) => {
      await need('peers')
      tab.client().setSessionLimits(cleanLimits(limits))
    },
    network: async (): Promise<PluginNetwork> => {
      await need('network')
      const client = tab.client()
      await client.ready
      await waitForState(client)
      const transport = peek<EngineTransport>(client.onTransport, tab.vpn() ? 'relay' : 'direct')
      const reach = peek<Reachability | null>(client.onReachable, null)
      const direct = transport === 'direct'
      const reachable = !direct && !!reach && reach.listenFailed.length === 0 && Boolean(reach.port) && (reach.portOpen ?? true)
      const inbound = direct ? 0 : peek(client.onInboundNow, NO_INBOUND).total
      const dhtNodes = direct ? 0 : peek(client.onDhtNodes, 0)
      const storageFull = Boolean(peek<StorageFull>(client.onStorageFull, false))
      return { transport, reachable, inbound, dhtNodes, storageFull }
    },
  }

  return { ripple, close: () => { for (const off of [...offs]) off() } }
}

export type { PluginTorrent }
