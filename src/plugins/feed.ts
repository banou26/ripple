import type { PluginTorrent } from './contract'
import type { Persisted, TorrentClient, TorrentSnapshot } from '../torrent/client'
import type { TorrentGroup } from '../torrent/groups'
import type { Torrent } from '../torrent/types'

import { intl } from '../i18n'
import { finishes } from '../router/finish-notice'
import { currentGroups, subscribeGroups } from '../torrent/groups'
import { hexInfoHash } from '../torrent/magnet'
import { libraryRows } from '../torrent/use-torrents'
import { keptOf, toPluginTorrent } from './project'

export type FeedEvents = { changed: PluginTorrent[], added: PluginTorrent[], finished: PluginTorrent[], removed: string[] }

export type Feed = {
  /** The library's rows, temporary ones included, once its first list is in (or 10 s have passed without one). */
  rows: () => Promise<Torrent[]>
  /** The groups, once read. */
  groups: () => Promise<TorrentGroup[]>
  project: (t: Torrent & { infoHash: string }) => Promise<PluginTorrent>
  /** Hears each second's events while anything listens. `added`, `finished` and `removed` only where the engine runs. */
  listen: (listener: (events: FeedEvents) => void) => () => void
  destroy: () => void
}

export const FEED_MS = 1_000
const FIRST_LIST_MS = 10_000

const kept = (t: Torrent): t is Torrent & { infoHash: string } => !!t.infoHash && t.ephemeral !== true

const keptHashes = (list: Persisted[]) =>
  new Set(list.filter((e) => e.ephemeral !== true).map((e) => hexInfoHash(e.infoHash)))

/**
 * The library as plugins see it, from `client`'s lists and states. The first list after a load, after the engine
 * behind this tab is replaced (which is also how this tab takes the engine or gives it up), and every list the
 * account's sync wrote, is a starting point for `added` and `removed` rather than a set of changes.
 */
export const createFeed = (client: TorrentClient): Feed => {
  let snaps: TorrentSnapshot[] = []
  let list: Persisted[] | null = null
  let baseline: Set<string> | null = null
  const added = new Set<string>()
  const removed = new Set<string>()
  let seen: ReadonlySet<string> = new Set()
  let sent: Map<string, string> | null = null
  const listeners = new Set<(events: FeedEvents) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let flushing = false
  let flushedAt = 0
  let firstList!: () => void
  const listed = new Promise<void>((resolve) => { firstList = resolve })

  // a row the engine does not run yet carries no `ephemeral` of its own, and its entry says it
  const rowsNow = () => {
    const temporary = new Set((list ?? []).filter((e) => e.ephemeral === true).map((e) => hexInfoHash(e.infoHash)))
    return libraryRows(snaps, list ?? [], intl)
      .map((t) => (t.infoHash && temporary.has(hexInfoHash(t.infoHash)) ? { ...t, ephemeral: true } : t))
  }

  const project = async (t: Torrent & { infoHash: string }) =>
    toPluginTorrent(t, currentGroups() ?? [], await keptOf(t.infoHash))

  const flush = async () => {
    timer = undefined
    if (flushing || !listeners.size) return
    flushing = true
    flushedAt = Date.now()
    try {
      const rows = rowsNow()
      const owner = client.owns()
      const look = finishes(seen, rows)
      seen = look.seen
      const projected = await Promise.all(rows.filter(kept).map(project))
      const byHash = new Map(projected.map((p) => [p.infoHash, p]))
      const texts = new Map(projected.map((p) => [p.infoHash, JSON.stringify(p)]))
      const was = sent
      const changed = was ? projected.filter((p) => was.get(p.infoHash) !== texts.get(p.infoHash)) : []
      sent = texts
      const events: FeedEvents = {
        changed,
        added: owner ? [...added].flatMap((h) => byHash.get(h) ?? []) : [],
        finished: owner ? look.done.flatMap((h) => byHash.get(hexInfoHash(h)) ?? []) : [],
        removed: owner ? [...removed] : [],
      }
      added.clear()
      removed.clear()
      if (events.changed.length || events.added.length || events.finished.length || events.removed.length) {
        for (const listener of listeners) listener(events)
      }
    } finally {
      flushing = false
    }
  }

  const schedule = () => {
    if (timer !== undefined || !listeners.size) return
    timer = setTimeout(() => { void flush() }, Math.max(0, flushedAt + FEED_MS - Date.now()))
  }

  const restart = () => {
    baseline = null
    added.clear()
    removed.clear()
  }

  const offs = [
    client.onState((s) => { snaps = s; schedule() }),
    client.onList((next, synced) => {
      list = next
      firstList()
      const now = keptHashes(next)
      if (baseline && !synced) {
        for (const h of now) if (!baseline.has(h)) { added.add(h); removed.delete(h) }
        for (const h of baseline) if (!now.has(h)) { removed.add(h); added.delete(h) }
      }
      baseline = now
      schedule()
    }),
    client.onEngineReset(() => { restart(); snaps = [] }),
    subscribeGroups(schedule),
  ]

  return {
    rows: async () => {
      await Promise.race([listed, new Promise((resolve) => setTimeout(resolve, FIRST_LIST_MS))])
      return rowsNow()
    },
    groups: async () => {
      for (let i = 0; i < 100 && !currentGroups(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
      return currentGroups() ?? []
    },
    project,
    listen: (listener) => {
      listeners.add(listener)
      schedule()
      return () => { listeners.delete(listener) }
    },
    destroy: () => {
      clearTimeout(timer)
      listeners.clear()
      for (const off of offs) off()
    },
  }
}
