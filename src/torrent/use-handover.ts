import type { Persisted, TorrentClient } from './client'
import type { Chunk, Offer } from './handover'

import { useEffect, useRef } from 'react'
import { get } from 'idb-keyval'

import { hexInfoHash } from '../router/magnet-codec'
import { isFramed } from '../utils/framed'
import { getTorrentClient } from './client'
import { ACK, CHUNK, CREDIT, DONE, GIVE, STOP, TAKE, createPieceCheck, fits, layoutOf, resumeWith } from './handover'
import { LIST_KEY, cacheSavePathFor } from './library'
import { infoHashOf } from './make-torrent'
import { infoFromResume } from './torrent-export'

// how long the tab waits for the player's answer, and how long either side waits on the other after
const ANSWER_MS = 5_000
const SILENCE_MS = 30_000
// how often a wait looks at whether the other window has gone
const POLL_MS = 100

// what may arrive, which nothing checked yet
type Message = { type?: unknown, infoHash?: unknown, offer?: Offer | null, fileIndex?: unknown, chunk?: unknown, bytes?: unknown }

/** The messages one window sends this one, in order, each wait ending early once that window closes. */
const inbox = (from: Window, origin: string) => {
  const queue: Message[] = []
  let wake = () => {}
  const onMessage = (event: MessageEvent) => {
    if (event.source !== from || event.origin !== origin) return
    queue.push(event.data)
    wake()
  }
  window.addEventListener('message', onMessage)
  return {
    next: async (ms: number) => {
      const until = Date.now() + ms
      while (!queue.length && !from.closed && Date.now() < until) {
        await new Promise<void>((resolve) => { wake = resolve; setTimeout(resolve, POLL_MS) })
      }
      return queue.shift() ?? null
    },
    close: () => window.removeEventListener('message', onMessage),
  }
}

/** The player's half: answer a Ripple tab that asked for this torrent, then send it every chunk held. */
export const giveToRipple = async (
  { client, infoHash, tab, origin }: { client: TorrentClient, infoHash: string, tab: Window, origin: string },
) => {
  const replies = inbox(tab, origin)
  try {
    const offer = await client.exportStart(infoHash).catch(() => null)
    tab.postMessage({ type: GIVE, infoHash, offer }, origin)
    if (!offer) return
    let credit = CREDIT
    for (const chunk of offer.chunks) {
      while (!credit) {
        const reply = await replies.next(SILENCE_MS)
        if (!reply || reply.type === STOP) return
        if (reply.type === ACK) credit++
      }
      credit--
      const bytes = await client.exportChunk(infoHash, chunk)
      tab.postMessage({ type: CHUNK, ...chunk, bytes }, origin, [bytes.buffer])
    }
  } finally {
    tab.postMessage({ type: DONE }, origin)
    replies.close()
    client.exportEnd(infoHash)
  }
}

/**
 * The Ripple tab's half: ask the player that opened it for the torrent, keep each chunk as the same
 * chunk file a cache torrent uses, check every piece as it lands, and add the torrent claiming what
 * passed. However the copy ends, what landed is kept. False when nothing was taken: the player had
 * nothing to give, or this tab's engine never listed the torrent.
 */
export const takeFromPlayer = async (
  { client, infoHash, player, origin, root }:
  { client: TorrentClient, infoHash: string, player: Window, origin: string, root: FileSystemDirectoryHandle },
): Promise<boolean> => {
  const messages = inbox(player, origin)
  try {
    player.postMessage({ type: TAKE, infoHash }, origin)
    const answer = await messages.next(ANSWER_MS)
    const offer = answer?.type === GIVE && answer.infoHash === infoHash ? answer.offer : null
    const info = offer?.resume instanceof Uint8Array ? infoFromResume(offer.resume) : null
    // the player's blob has to describe the torrent this tab was opened for
    const layout = info && await infoHashOf(info) === hexInfoHash(infoHash) ? layoutOf(info) : null
    // listed before anything is written, and an engine that never answers takes nothing
    if (!offer || !layout || !Number.isInteger(offer.chunkBytes) || offer.chunkBytes <= 0
      || !await client.importStart(infoHash, offer.magnet).then(() => true, () => false)) {
      player.postMessage({ type: STOP }, origin)
      return false
    }

    let dir = root
    for (const name of [...cacheSavePathFor(infoHash).split('/').filter(Boolean), String(offer.chunkBytes)]) {
      dir = await dir.getDirectoryHandle(name, { create: true })
    }
    const name = ({ fileIndex, chunk }: Chunk) => `${fileIndex}-${chunk}`
    // the chunks being checked, read from memory rather than back off the disk
    const checking = new Map<string, Uint8Array<ArrayBuffer>>()
    const check = createPieceCheck(layout, offer.chunkBytes, async (chunk, at, len) => {
      const held = checking.get(name(chunk))
      if (held) return held.subarray(at, at + len)
      const file = await dir.getFileHandle(name(chunk)).then((handle) => handle.getFile(), () => null)
      return file ? new Uint8Array(await file.slice(at, at + len).arrayBuffer()) : new Uint8Array(0)
    })
    // MEASURED, 1 GiB of 64 MiB chunks written one after another (2026-10-23): hashing takes 1.4 s on
    // Firefox 157 against 1.1 s to write, and 0.5 s on Chromium 156 against 1.5 s, so a chunk is
    // checked while the next one is written, and never more than one behind
    let behind = Promise.resolve()
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      console.info('[handover] pieces kept', check.have.reduce((n, ok) => n + ok, 0), 'of', check.have.length)
      client.importTorrent(infoHash, offer.magnet, resumeWith(offer.resume, check.have))
    }
    window.addEventListener('pagehide', finish)
    try {
      for (let message = await messages.next(SILENCE_MS); message?.type === CHUNK; message = await messages.next(SILENCE_MS)) {
        const chunk = { fileIndex: message.fileIndex as number, chunk: message.chunk as number }
        // a buffer that came through postMessage is never shared memory
        const bytes = message.bytes instanceof Uint8Array ? message.bytes as Uint8Array<ArrayBuffer> : null
        if (bytes && fits(layout, offer.chunkBytes, chunk)) {
          const writable = await (await dir.getFileHandle(name(chunk), { create: true })).createWritable()
          await writable.write(bytes)
          await writable.close()
          await behind
          checking.set(name(chunk), bytes)
          behind = check.add(chunk).finally(() => checking.delete(name(chunk)))
        }
        player.postMessage({ type: ACK }, origin)
      }
    } catch {
      player.postMessage({ type: STOP }, origin)
    } finally {
      window.removeEventListener('pagehide', finish)
      await behind.catch(() => {})
      finish()
    }
    return true
  } finally {
    messages.close()
  }
}

/** The player's half, for as long as it plays `infoHash`. */
export const useGiveToRipple = (infoHash: string | null) => {
  useEffect(() => {
    if (!infoHash) return
    const giving = new Set<Window>()
    const onMessage = (event: MessageEvent) => {
      const tab = event.source as Window | null
      if (!tab || tab === window || event.origin !== location.origin || giving.has(tab)) return
      if (event.data?.type !== TAKE || event.data.infoHash !== infoHash) return
      giving.add(tab)
      void giveToRipple({ client: getTorrentClient(), infoHash, tab, origin: location.origin })
        .catch(() => {})
        .finally(() => giving.delete(tab))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [infoHash])
}

/**
 * The Ripple tab's half, for `?torrent=` naming a torrent this library has no entry for: taken from
 * the player that opened the tab, or else `fallback`, once per page.
 */
export const useTakeFromPlayer = (infoHash: string | null, fallback: () => void) => {
  const latest = useRef(fallback)
  useEffect(() => { latest.current = fallback })
  const tried = useRef(false)
  useEffect(() => {
    if (!infoHash || tried.current || isFramed()) return
    tried.current = true
    void (async () => {
      const list = await get<Persisted[]>(LIST_KEY).then((stored) => stored ?? [], () => null)
      if (!list || list.some((e) => e.infoHash === infoHash)) return
      const player = window.opener as Window | null
      const took = !!player && !player.closed && await navigator.storage.getDirectory()
        .then((root) => takeFromPlayer({ client: getTorrentClient(), infoHash, player, origin: location.origin, root }))
        .catch(() => false)
      if (!took) latest.current()
    })()
  }, [infoHash])
}
