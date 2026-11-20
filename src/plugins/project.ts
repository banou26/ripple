import type { PluginState, PluginTorrent } from './contract'
import type { TorrentGroup } from '../torrent/groups'
import type { Torrent, TorrentState } from '../torrent/types'

import { get } from 'idb-keyval'

import { heldShare } from '../torrent/downloaded-ranges'
import { torrentsIn } from '../torrent/groups'
import { torrentKey } from '../torrent/library'
import { hexInfoHash, magnetParams, sameInfoHash } from '../torrent/magnet'
import { currentLocation } from '../torrent/save-location'
import { readTorrentFile } from '../torrent/torrent-file'
import { contentFiles } from '../torrent/types'

/**
 * A tracker's address as its scheme, host and port alone. A private tracker puts the member's key in the path, the
 * query or the user part, so nothing past the host ever reaches a plugin. Null for anything that is no tracker url.
 */
export const trackerOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url)
    if (!/^(https?|udp|wss?):$/.test(parsed.protocol) || !parsed.hostname) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/** What the .torrent this device keeps says: whether it is private, and its trackers. Null when none is kept. */
export type Kept = { private: boolean, trackers: string[] } | null

const kept = new Map<string, Exclude<Kept, null>>()

/**
 * The kept .torrent's facts for `infoHash`. One kept for an info hash never changes, so a found one is remembered;
 * a miss is read again, since the metadata of a magnet add lands later.
 */
export const keptOf = async (infoHash: string): Promise<Kept> => {
  const known = kept.get(infoHash)
  if (known) return known
  const bytes = await get<Uint8Array>(torrentKey(infoHash)).catch(() => undefined)
  const subject = bytes?.byteLength ? await readTorrentFile(bytes) : null
  if (!subject) return null
  const facts = { private: subject.private, trackers: magnetParams(subject.magnet, 'tr') }
  kept.set(infoHash, facts)
  return facts
}

/** The kept .torrent itself, only when it says it is not private. */
export const publicTorrentFile = async (infoHash: string): Promise<Uint8Array | null> => {
  const facts = await keptOf(infoHash)
  if (facts?.private !== false) return null
  return (await get<Uint8Array>(torrentKey(infoHash)).catch(() => undefined)) ?? null
}

const STATE: Record<TorrentState, PluginState> = {
  downloading: 'downloading',
  seeding: 'seeding',
  completed: 'done',
  paused: 'paused',
  queued: 'waiting',
  starting: 'waiting',
  checking: 'waiting',
  retrying: 'waiting',
  error: 'error',
  missing: 'missing',
}

const unique = <T>(values: (T | null)[]) => [...new Set(values.filter((v): v is T => v !== null))]

/**
 * `t` as a plugin sees it: a fixed list of fields copied, never the row, so a field added to a row reaches no plugin
 * until it is named here. Trackers cross as origins, and whole only in the magnet of a torrent known not to be private.
 */
export const toPluginTorrent = (t: Torrent & { infoHash: string }, groups: readonly TorrentGroup[], facts: Kept): PluginTorrent => {
  const known = facts?.private ?? null
  const trackers = unique([...magnetParams(t.magnet ?? '', 'tr'), ...(facts?.trackers ?? [])])
  const params = new URLSearchParams()
  params.set('dn', t.name)
  if (known === false) for (const tracker of trackers) params.append('tr', tracker)
  const xt = magnetParams(t.magnet ?? '', 'xt').filter((urn) => /^urn:bt(ih|mh):[0-9a-z]+$/i.test(urn))
  const wanted = t.wantedFiles && new Set(t.wantedFiles)
  const bitfield = t.bitfield
  return {
    infoHash: hexInfoHash(t.infoHash),
    name: t.name,
    size: t.size,
    progress: t.progress,
    down: t.down,
    up: t.up,
    downloaded: t.downloaded,
    uploaded: t.stats?.allTimeUpload ?? 0,
    seedingSeconds: t.stats?.seedingSeconds ?? 0,
    addedAt: t.addedAt,
    state: STATE[t.state],
    groups: groups.filter((g) => [...torrentsIn(g)].some((h) => sameInfoHash(h, t.infoHash))).map((g) => g.id),
    private: known,
    temporary: t.ephemeral === true,
    location: t.stats ? currentLocation(t.stats.savePath) : (t.saveTo ?? 'browser'),
    magnet: `magnet:?${(xt.length ? xt : [`urn:btih:${t.infoHash}`]).map((urn) => `xt=${urn}`).join('&')}&${params.toString()}`,
    trackers: unique(trackers.map(trackerOrigin)),
    files: t.files && contentFiles(t.files).map((f) => ({
      index: f.index,
      name: f.name,
      size: f.size,
      wanted: !wanted || wanted.has(f.index),
      progress: bitfield && f.offset !== undefined ? heldShare(bitfield, { offset: f.offset, size: f.size }) : 0,
    })),
  }
}
