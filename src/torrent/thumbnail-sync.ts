import { get, set } from 'idb-keyval'

import { cloud } from '@fkn/lib'

import { thumbnailKey } from './library'
import { loadCachedThumbnails, thumbnailFor } from './thumbnail-store'

/**
 * One picture per torrent, carried between a person's own devices.
 *
 * A thumbnail is made from bytes that are on disk, so a device that has never downloaded a torrent
 * can never make one for itself. It can be handed one, and that is the whole of this file: the
 * device that has the file uploads the picture, and the device that does not downloads it.
 *
 * SEPARATE FILES, deliberately, rather than fields on the library list. The list is one json
 * document rewritten on every change, three seconds after anything moves, and a base64 webp per
 * torrent would put roughly 8 kB of picture into every one of those writes for data that changes
 * once in a torrent's life. As their own objects they are written once and read once.
 *
 * A file's contents are sealed but its name is not, so a picture is named by an HMAC of its info
 * hash under a key that lives in a sealed file of its own.
 *
 * Nothing here is load bearing. Every failure leaves the local picture exactly as it was, because a
 * missing thumbnail is a smaller problem than anything worth risking to avoid it.
 */

/** The account's naming key: 32 random bytes, made by the first device that needs it. */
export const NAME_KEY_PATH = 'ripple/thumbnail-key'
/** Where pictures were stored under their info hash, before names were opaque. */
export const LEGACY_DIR = 'ripple/thumbs'

/** Where a picture lives in the account's storage, by its opaque name. */
export const thumbPath = (name: string) => `ripple/thumbnails/${name}.webp`

/** The names of pictures this device has uploaded, so a push is once rather than once per pass. */
const PUSHED_KEY = 'ripple:thumb-pushed'
/**
 * How many objects one pass may touch.
 *
 * A library restored on a fresh device wants every picture at once, and each is a separate round
 * trip through the broker. Bounded so a first sync is spread over several passes instead of firing
 * fifty requests into a connection the app also needs for everything else.
 */
const PER_PASS = 6
const KEY_BYTES = 32

/**
 * Hashes this device tried to pull and did not get.
 *
 * In memory on purpose. A torrent whose owner device has not uploaded yet should be retried on the
 * next run of the app, and remembering the failure across reloads would turn "not there yet" into
 * "never again".
 */
const missed = new Set<string>()
let nameKey: Promise<CryptoKey> | undefined
let legacyCleared = false

const bytesOf = (data: string | Uint8Array) =>
  typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const readNameKey = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
  try {
    const bytes = bytesOf(await cloud.fs.promises.readFile(NAME_KEY_PATH))
    return bytes.byteLength === KEY_BYTES ? bytes : null
  } catch (err) {
    if (cloud.fs.isNotFound(err)) return null
    throw err
  }
}

/**
 * Made only when the store says there is none, since replacing a key renames every picture out of
 * reach. Read back after the write, so two devices making one at once both end on whichever landed.
 */
const loadNameKey = async (): Promise<CryptoKey> => {
  let bytes = await readNameKey()
  if (!bytes) {
    const made = crypto.getRandomValues(new Uint8Array(KEY_BYTES))
    await cloud.fs.promises.writeFile(NAME_KEY_PATH, made, { contentType: 'application/octet-stream' })
    bytes = await readNameKey() ?? made
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

const keyFor = (): Promise<CryptoKey> => {
  nameKey ??= loadNameKey().catch((err) => { nameKey = undefined; throw err })
  return nameKey
}

const nameOf = async (key: CryptoKey, infoHash: string) =>
  hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(infoHash)))

const pushedSet = async (): Promise<Set<string>> =>
  new Set((await get<string[]>(PUSHED_KEY).catch(() => undefined)) ?? [])

const savePushed = (pushed: Set<string>) => set(PUSHED_KEY, [...pushed]).catch(() => {})

const rememberPushed = async (name: string) => {
  const pushed = await pushedSet()
  pushed.add(name)
  await savePushed(pushed)
}

const localBlob = async (infoHash: string): Promise<Blob | undefined> =>
  get<Blob>(thumbnailKey(infoHash)).catch(() => undefined)

/** Uploads this device's picture. Returns whether anything was sent. */
const push = async (infoHash: string, name: string): Promise<boolean> => {
  const blob = await localBlob(infoHash)
  if (!blob || !blob.size) return false
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await cloud.fs.promises.writeFile(thumbPath(name), bytes, { contentType: 'image/webp' })
  await rememberPushed(name)
  return true
}

/** Fetches a picture this device cannot make. Returns whether one arrived. */
const pull = async (infoHash: string, name: string): Promise<boolean> => {
  const bytes = bytesOf(await cloud.fs.promises.readFile(thumbPath(name)))
  if (!bytes.byteLength) return false
  // stored under the key the local store already reads, so the ordinary loader finds it
  await set(thumbnailKey(infoHash), new Blob([bytes], { type: 'image/webp' }))
  return true
}

/**
 * Pictures stored under their info hash move to their opaque name, and those of torrents no longer
 * in the library are deleted. Once a pass has been through all of them, this session stops listing.
 */
const clearLegacy = async (library: Set<string>) => {
  const files = await cloud.fs.promises.readdir(LEGACY_DIR)
  for (const file of files.slice(0, PER_PASS)) {
    const path = `${LEGACY_DIR}/${file}`
    const infoHash = file.replace(/\.webp$/, '')
    try {
      if (library.has(infoHash)) {
        const bytes = bytesOf(await cloud.fs.promises.readFile(path))
        const name = await nameOf(await keyFor(), infoHash)
        await cloud.fs.promises.writeFile(thumbPath(name), bytes, { contentType: 'image/webp' })
        await rememberPushed(name)
      }
      await cloud.fs.promises.unlink(path)
    } catch {}
  }
  if (files.length <= PER_PASS) legacyCleared = true
}

/**
 * Bring this device's pictures and the account's into line, a few at a time.
 *
 * Push and pull are the same question asked from two sides, so one pass does both: a hash with a
 * local picture that has not been uploaded goes up, and a hash with no local picture comes down.
 * A picture under its opaque name is deleted only with its torrent's removal
 * (`forgetSyncedThumbnails`), because "this device has no picture" is not evidence that nobody
 * should.
 */
export const syncThumbnails = async (infoHashes: string[]): Promise<void> => {
  if (!legacyCleared) await clearLegacy(new Set(infoHashes)).catch(() => {})
  if (!infoHashes.length) return
  const key = await keyFor().catch(() => null)
  if (!key) return
  const names = new Map(await Promise.all(infoHashes.map(async (h) => [h, await nameOf(key, h)] as const)))

  // a name whose torrent left the library is dropped, so adding it again uploads it again
  const current = new Set(names.values())
  const stored = await pushedSet()
  const pushed = new Set([...stored].filter((name) => current.has(name)))
  if (pushed.size !== stored.size) await savePushed(pushed)

  const toPush: [string, string][] = []
  const toPull: [string, string][] = []
  for (const [infoHash, name] of names) {
    if (thumbnailFor(infoHash)) {
      if (!pushed.has(name)) toPush.push([infoHash, name])
      continue
    }
    if (!missed.has(infoHash)) toPull.push([infoHash, name])
  }

  const pulled: string[] = []
  for (const [infoHash, name] of toPull.slice(0, PER_PASS)) {
    // a miss is the ordinary case for a torrent nobody has pictured yet, so it is remembered
    // rather than reported: this whole path is an improvement, never a requirement
    const ok = await pull(infoHash, name).catch(() => false)
    if (ok) pulled.push(infoHash)
    else missed.add(infoHash)
  }
  // one call rather than per hash: it is what turns the stored blobs into the urls rows render
  if (pulled.length) await loadCachedThumbnails(pulled).catch(() => {})

  for (const [infoHash, name] of toPush.slice(0, PER_PASS)) {
    await push(infoHash, name).catch(() => {})
  }
}

/** Deletes the account's pictures of torrents whose removal is being published. */
export const forgetSyncedThumbnails = async (infoHashes: string[]): Promise<void> => {
  if (!infoHashes.length) return
  const key = await keyFor()
  const pushed = await pushedSet()
  for (const infoHash of infoHashes) {
    const name = await nameOf(key, infoHash)
    await cloud.fs.promises.unlink(thumbPath(name)).catch(() => {})
    pushed.delete(name)
  }
  await savePushed(pushed)
}

/**
 * Forgets what this session learned about the account's pictures, after a restore says something
 * changed: misses are asked again, and the key and the old names are read again for the account
 * now signed in.
 */
export const resetThumbnailSync = () => {
  missed.clear()
  nameKey = undefined
  legacyCleared = false
}
