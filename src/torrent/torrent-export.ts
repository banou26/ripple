import { get } from 'idb-keyval'

import { infoRange } from './torrent-file'
import { magnetParams } from './magnet'
import { resumeKey } from './library'

/**
 * Handing back the `.torrent` for something that arrived as a magnet.
 *
 * There is no copy of the metadata to hand back: a magnet carries an infohash and the engine fetches
 * the rest from the swarm, so after that the info dictionary lives only inside libtorrent. The
 * wrapper exposes no way to read it out either, so this does not ask the engine at all.
 *
 * It reads the RESUME BLOB instead. `lt_torrent_save_resume_data` asks libtorrent with
 * `save_info_dict`, so every blob the worker writes carries the whole info dictionary, bencoded
 * exactly as the swarm sent it. That makes a byte-exact rebuild possible with no engine change, no
 * new wasm export and nothing to publish.
 */

/**
 * The info dictionary is SPLICED IN as raw bytes, never decoded and re-encoded.
 *
 * The infohash is the SHA-1 of those bytes exactly as they appear, so any trip through a decoder is
 * a chance to change the number: a normalised integer, a reordered key, a string round-tripped
 * through UTF-8. The result would still be a valid torrent, of a different torrent, which is the
 * kind of wrong that looks completely fine until nobody can find any peers for it.
 *
 * `torrent-file.ts` computes the infohash the same way, off `infoRange`, for the same reason.
 */
const encoder = new TextEncoder()

const bytesOf = (text: string): Uint8Array => {
  const body = encoder.encode(text)
  const head = encoder.encode(`${body.length}:`)
  const out = new Uint8Array(head.length + body.length)
  out.set(head)
  out.set(body, head.length)
  return out
}

const joined = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/**
 * The whole file, from the raw info dictionary and whatever the magnet knew.
 *
 * Keys are written in ASCII order because a bencoded dictionary is defined to be sorted, and a
 * reader is entitled to rely on it: announce, announce-list, info, url-list. Only `info` is required,
 * so a magnet with no trackers still produces a valid file rather than an empty announce.
 */
export const buildTorrentFile = (
  info: Uint8Array,
  { trackers = [], webSeeds = [] }: { trackers?: string[], webSeeds?: string[] } = {},
): Uint8Array => {
  const parts: Uint8Array[] = [encoder.encode('d')]

  if (trackers.length) {
    // `announce` is the single one every reader understands; the list carries the rest, one per tier
    parts.push(bytesOf('announce'), bytesOf(trackers[0]!))
    parts.push(bytesOf('announce-list'), encoder.encode('l'))
    for (const tracker of trackers) parts.push(encoder.encode('l'), bytesOf(tracker), encoder.encode('e'))
    parts.push(encoder.encode('e'))
  }

  parts.push(bytesOf('info'), info)

  if (webSeeds.length) {
    parts.push(bytesOf('url-list'), encoder.encode('l'))
    for (const seed of webSeeds) parts.push(bytesOf(seed))
    parts.push(encoder.encode('e'))
  }

  parts.push(encoder.encode('e'))
  return joined(parts)
}

/** Everything a magnet can contribute to the file around the info dictionary. */
export const magnetExtras = (magnet: string): { trackers: string[], webSeeds: string[] } => ({
  trackers: magnetParams(magnet, 'tr'),
  webSeeds: magnetParams(magnet, 'ws'),
})

/**
 * The info dictionary out of a resume blob, or null when the blob describes no metadata.
 *
 * A blob written before the swarm answered has no `info` key at all, which is an ordinary state
 * rather than a fault: it means this torrent is still only an infohash.
 */
export const infoFromResume = (resume: Uint8Array): Uint8Array | null => {
  const found = infoRange(resume)
  if (!found) return null
  const [start, end] = found
  // sliced into its own buffer rather than viewed: ripple is cross-origin isolated, so the source may
  // sit on a SharedArrayBuffer, and a view over one is not a BufferSource anything else will take
  return new Uint8Array(resume.slice(start, end))
}

/** How long to wait for the worker to write a blob after being asked, and how often to look. */
const FLUSH_TIMEOUT_MS = 5_000
const FLUSH_POLL_MS = 200

/**
 * The `.torrent` for a torrent this device is holding, or null if its metadata has not arrived.
 *
 * A held torrent may have no blob yet, because the worker writes one on its own schedule, so this
 * asks for a flush and waits rather than reporting a torrent with metadata on screen as having none.
 * The flush is cheap and idempotent, and writes to IndexedDB rather than to torrent storage, so it
 * does not disturb a download page that has deliberately written nothing.
 */
export const torrentFileFor = async (
  { infoHash, magnet, flush, now = () => Date.now(), wait = (ms: number) => new Promise((r) => setTimeout(r, ms)) }: {
    infoHash: string
    magnet: string
    flush: () => void
    now?: () => number
    wait?: (ms: number) => Promise<unknown>
  },
): Promise<Uint8Array | null> => {
  const read = async (): Promise<Uint8Array | null> => {
    const blob = await get<Uint8Array>(resumeKey(infoHash)).catch(() => undefined)
    return blob ? infoFromResume(blob) : null
  }

  let info = await read()
  if (!info) {
    flush()
    const until = now() + FLUSH_TIMEOUT_MS
    while (!info && now() < until) {
      await wait(FLUSH_POLL_MS)
      info = await read()
    }
  }
  return info ? buildTorrentFile(info, magnetExtras(magnet)) : null
}

/** What a save attempt did, so each caller can word it for its own surface. */
export type SaveResult = 'saved' | 'no-metadata' | 'failed'

/**
 * Build the file and hand it to the browser, in one place for every surface that offers it.
 *
 * The download page, the row's context menu and its settings all want exactly this, and the part
 * worth not writing three times is not the fetch but the handover: an anchor that has to be in the
 * document to be clickable, and an object URL that must outlive the click. Revoking it in the same
 * task races the navigation the click just started, which fails as a download that silently never
 * arrives.
 */
export const saveTorrentFile = async (
  { infoHash, magnet, name, flush }: { infoHash: string, magnet: string, name: string, flush: () => void },
): Promise<SaveResult> => {
  try {
    const bytes = await torrentFileFor({ infoHash, magnet, flush })
    if (!bytes) return 'no-metadata'

    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/x-bittorrent' }))
    const link = document.createElement('a')
    link.href = url
    // a torrent name is a filename already, but it came off a magnet somebody else wrote, so the
    // separators go: a `dn` of `../../x` would otherwise choose the directory this lands in
    link.download = `${name.replace(/[/\\]/g, '_')}.torrent`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    return 'saved'
  } catch {
    return 'failed'
  }
}
