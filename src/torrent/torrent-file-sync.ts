import { get, set, update } from 'idb-keyval'

import { cloud } from '@fkn/lib'

import type { SaveResult } from './torrent-export'

import { torrentKey } from './library'
import { opaqueName } from './thumbnail-sync'
import { saveTorrentFile } from './torrent-export'

/**
 * Each torrent's .torrent, carried between a person's own devices.
 *
 * A device that has a torrent only from the synced list knows its hash and nothing more, so its Download, a move into
 * the folder and Save .torrent waited for a peer to send the metadata, and never finished with no peer online. The
 * device that knows the metadata uploads the file, and a device that needs it downloads it.
 *
 * The thumbnail sync's shape: one sealed object per torrent, named by a keyed hash under the pictures' naming key (over
 * a prefix of its own, so a picture's name and its torrent's cannot be paired), uploaded once and deleted with the
 * torrent's removal. Unlike a picture it is downloaded only when a device needs it. A private torrent's file goes
 * whole, tracker addresses included: it is sealed in the browser, and only the person's own devices open it.
 *
 * Nothing here is load bearing. Every failure leaves this device's files as they were, and a device with no file
 * fetches the metadata from the swarm as before.
 */

const DIR = 'ripple/torrent-files'
/** Where a torrent's file lives in the account's storage, by its opaque name. */
export const torrentFilePath = (name: string) => `${DIR}/${name}.torrent`

/** The names this device uploaded or downloaded, so a file goes up once rather than once per pass. */
const PUSHED_KEY = 'ripple:torrent-file-pushed'
/** How many uploads one pass may send, as the pictures' sync bounds its own. */
const PER_PASS = 6
/** How long a Download, a move or Save .torrent waits for the account's file before going on without it. */
const PULL_TIMEOUT_MS = 10_000

let sameAccount: (() => boolean) | null = null

/**
 * Hands this module the library sync's test of whether the account whose backup it read is still the one signed in.
 * Nothing is read or written while the test answers false or there is none. It is asked right before each read and
 * write, and the storage layer pins a call's account in that same step, so a pass that outlives an account switch
 * stops there instead of carrying one account's files into the other.
 */
export const followAccount = (check: (() => boolean) | null) => { sameAccount = check }
const following = () => sameAccount?.() === true

const nameOf = (infoHash: string) => opaqueName('torrent:' + infoHash)

const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

const keptHere = async (infoHash: string): Promise<Uint8Array | null> => {
  const bytes = await get<Uint8Array>(torrentKey(infoHash)).catch(() => undefined)
  return bytes?.byteLength ? bytes : null
}

const pushedSet = async (): Promise<Set<string>> =>
  new Set((await get<string[]>(PUSHED_KEY).catch(() => undefined)) ?? [])

const savePushed = (pushed: Set<string>) => set(PUSHED_KEY, [...pushed]).catch(() => {})

/**
 * Uploads the files this device keeps and the account does not, a few per pass.
 *
 * The account's files are listed first and one it holds is never written over: it may be the file the torrent was
 * added from, uploaded by another device, where this device's copy was rebuilt from a magnet without the file's own
 * trackers. A failed listing sends nothing, and the next pass asks again.
 */
export const syncTorrentFiles = async (infoHashes: string[]): Promise<void> => {
  if (!infoHashes.length || !following()) return
  let names: Map<string, string>
  try {
    names = new Map(await Promise.all(infoHashes.map(async (h) => [h, await nameOf(h)] as const)))
  } catch {
    return
  }

  // a name whose torrent left the library is dropped, so adding it again uploads it again
  const current = new Set(names.values())
  const stored = await pushedSet()
  const pushed = new Set([...stored].filter((name) => current.has(name)))
  if (pushed.size !== stored.size) await savePushed(pushed)

  // only what this device keeps a file of, so a device holding rows synced from elsewhere asks the account nothing
  const unsent: [string, Uint8Array][] = []
  for (const [infoHash, name] of names) {
    if (unsent.length === PER_PASS) break
    const bytes = pushed.has(name) ? null : await keptHere(infoHash)
    if (bytes) unsent.push([name, bytes])
  }
  if (!unsent.length || !following()) return

  let listed: string[]
  try {
    listed = await cloud.fs.promises.readdir(DIR)
  } catch (err) {
    if (!cloud.fs.isNotFound(err)) return
    listed = []
  }
  const held = new Set(listed)
  for (const [name, bytes] of unsent) {
    if (held.has(`${name}.torrent`)) { pushed.add(name); continue }
    if (!following()) break
    try {
      await cloud.fs.promises.writeFile(torrentFilePath(name), bytes, { contentType: 'application/x-bittorrent' })
      pushed.add(name)
    } catch {}
  }
  await savePushed(pushed)
}

/**
 * Keeps the account's .torrent of `infoHash` on this device when it has none, never over a file kept meanwhile. Does
 * nothing when no account is being followed, when the account has none or when it does not answer in time, so the
 * caller then goes on as it would without one. Never rejects.
 */
export const keepSyncedTorrentFile = async (infoHash: string): Promise<void> => {
  if (!following()) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (await keptHere(infoHash)) return
    const name = await nameOf(infoHash)
    if (!following()) return
    const data = await Promise.race([
      cloud.fs.promises.readFile(torrentFilePath(name)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), PULL_TIMEOUT_MS) }),
    ])
    const bytes = bytesOf(data)
    if (!bytes.byteLength) return
    await update<Uint8Array>(torrentKey(infoHash), (prev) => (prev?.byteLength ? prev : bytes))
    // the account has it, so this device never uploads it
    const pushed = await pushedSet()
    pushed.add(name)
    await savePushed(pushed)
  } catch {} finally {
    clearTimeout(timer)
  }
}

/** Save .torrent, from the account's file when this device keeps none. */
export const saveSyncedTorrentFile = async (torrent: Parameters<typeof saveTorrentFile>[0]): Promise<SaveResult> => {
  await keepSyncedTorrentFile(torrent.infoHash)
  return saveTorrentFile(torrent)
}

/** Deletes the account's files of torrents whose removal is being published. */
export const forgetSyncedTorrentFiles = async (infoHashes: string[]): Promise<void> => {
  if (!infoHashes.length) return
  const pushed = await pushedSet()
  for (const infoHash of infoHashes) {
    const name = await nameOf(infoHash)
    await cloud.fs.promises.unlink(torrentFilePath(name)).catch(() => {})
    pushed.delete(name)
  }
  await savePushed(pushed)
}
