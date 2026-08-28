import { get, set } from 'idb-keyval'

import { cloud } from '@fkn/lib'

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
 * Nothing here is load bearing. Every failure leaves the local picture exactly as it was, because a
 * missing thumbnail is a smaller problem than anything worth risking to avoid it.
 */

/** Where a torrent's picture lives in the account's storage. */
export const thumbPath = (infoHash: string) => `ripple/thumbs/${infoHash}.webp`

/** Which hashes this device has already uploaded, so a push is once rather than once per pass. */
const PUSHED_KEY = 'ripple:thumb-pushed'
/**
 * How many objects one pass may touch.
 *
 * A library restored on a fresh device wants every picture at once, and each is a separate round
 * trip through the broker. Bounded so a first sync is spread over several passes instead of firing
 * fifty requests into a connection the app also needs for everything else.
 */
const PER_PASS = 6

/**
 * Hashes this device tried to pull and did not get.
 *
 * In memory on purpose. A torrent whose owner device has not uploaded yet should be retried on the
 * next run of the app, and remembering the failure across reloads would turn "not there yet" into
 * "never again".
 */
const missed = new Set<string>()

const pushedSet = async (): Promise<Set<string>> =>
  new Set((await get<string[]>(PUSHED_KEY).catch(() => undefined)) ?? [])

const rememberPushed = async (infoHash: string) => {
  const pushed = await pushedSet()
  pushed.add(infoHash)
  await set(PUSHED_KEY, [...pushed]).catch(() => {})
}

const localBlob = async (infoHash: string): Promise<Blob | undefined> =>
  get<Blob>('ripple:thumb:' + infoHash).catch(() => undefined)

/** Uploads this device's picture. Returns whether anything was sent. */
const push = async (infoHash: string): Promise<boolean> => {
  const blob = await localBlob(infoHash)
  if (!blob || !blob.size) return false
  const bytes = new Uint8Array(await blob.arrayBuffer())
  await cloud.fs.promises.writeFile(thumbPath(infoHash), bytes, { contentType: 'image/webp' })
  await rememberPushed(infoHash)
  return true
}

/** Fetches a picture this device cannot make. Returns whether one arrived. */
const pull = async (infoHash: string): Promise<boolean> => {
  const data = await cloud.fs.promises.readFile(thumbPath(infoHash))
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  if (!bytes.byteLength) return false
  // stored under the key the local store already reads, so the ordinary loader finds it
  await set('ripple:thumb:' + infoHash, new Blob([bytes], { type: 'image/webp' }))
  return true
}

/**
 * Bring this device's pictures and the account's into line, a few at a time.
 *
 * Push and pull are the same question asked from two sides, so one pass does both: a hash with a
 * local picture that has not been uploaded goes up, and a hash with no local picture comes down.
 * Nothing is ever deleted from either side here, because "this device has no picture" is not
 * evidence that nobody should.
 */
export const syncThumbnails = async (infoHashes: string[]): Promise<void> => {
  const pushed = await pushedSet()
  const toPush: string[] = []
  const toPull: string[] = []

  for (const infoHash of infoHashes) {
    if (thumbnailFor(infoHash)) {
      if (!pushed.has(infoHash)) toPush.push(infoHash)
      continue
    }
    if (!missed.has(infoHash)) toPull.push(infoHash)
  }

  const pulled: string[] = []
  for (const infoHash of toPull.slice(0, PER_PASS)) {
    // a miss is the ordinary case for a torrent nobody has pictured yet, so it is remembered
    // rather than reported: this whole path is an improvement, never a requirement
    const ok = await pull(infoHash).catch(() => false)
    if (ok) pulled.push(infoHash)
    else missed.add(infoHash)
  }
  // one call rather than per hash: it is what turns the stored blobs into the urls rows render
  if (pulled.length) await loadCachedThumbnails(pulled).catch(() => {})

  for (const infoHash of toPush.slice(0, PER_PASS)) {
    await push(infoHash).catch(() => {})
  }
}

/** Lets a device try again for pictures that were not there last time, after something changed. */
export const retryMissedThumbnails = () => { missed.clear() }
