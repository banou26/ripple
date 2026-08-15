import { magnetInfoHash, magnetParam } from '../torrent/magnet'

/**
 * Reading what another site is asking Ripple to add.
 *
 * Separate from the page and with no DOM in it, because everything here is untrusted input arriving
 * from whoever wrote the link. The page's job is to render an answer; this file's job is to decide
 * whether there is one, and to refuse clearly rather than half-accept.
 *
 * The refusals are worded for the person looking at the screen, not for whoever built the link. They
 * are the one who has to decide whether to trust it, and "xt=urn:btih is missing" tells them nothing.
 */

export type AddRequest =
  | { ok: false, problem: string }
  | {
    ok: true
    magnet: string
    infoHash: string
    /** the display name from the link, or the info hash when it carried none */
    name: string
    trackers: number
    /** only when the link says so, and it is a claim by the linking site rather than a fact */
    sizeBytes?: number
  }

// A magnet's infohash is 40 hex characters for v1, or 64 for v2. Anything else is not one, and
// accepting it would mean handing the engine a string that can only fail later, somewhere less
// obvious than here.
const V1 = /^[0-9a-f]{40}$/
const V2 = /^[0-9a-f]{64}$/

const MAX_NAME = 300

/** Length is advisory: `xl` is whatever the linking site put there, so it is shown, never trusted. */
const readLength = (magnet: string): number | undefined => {
  const raw = magnetParam(magnet, 'xl')
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const countTrackers = (magnet: string): number =>
  (magnet.match(/[?&]tr=/g) ?? []).length

/**
 * A name to show, kept short and stripped of anything that is not text.
 *
 * It comes from a stranger and lands in a sentence asking someone to agree to something, so control
 * characters go (they can hide the rest of the line) and the length is capped (a name the height of
 * the screen pushes the buttons out of view, which is its own kind of pressure).
 */
const cleanName = (raw: string | undefined | null): string | undefined => {
  if (!raw) return undefined
  // control characters, bidi overrides and zero-width joiners: all of them can make the visible text
  // differ from the actual text, which is the one trick that matters on a page asking for consent
  const stripped = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').trim()
  if (!stripped) return undefined
  return stripped.length > MAX_NAME ? stripped.slice(0, MAX_NAME) + '…' : stripped
}

export const describeAddRequest = (
  { magnet, name }: { magnet: string | null | undefined, name?: string | null },
): AddRequest => {
  if (!magnet) return { ok: false, problem: 'This link carried no torrent. Ripple was asked to add nothing at all.' }
  if (!magnet.startsWith('magnet:')) {
    return { ok: false, problem: 'This link is not a magnet link, so there is nothing here Ripple can add.' }
  }
  const infoHash = magnetInfoHash(magnet)
  if (!infoHash) {
    return { ok: false, problem: 'This magnet link has no info hash, so it does not name a torrent.' }
  }
  if (!V1.test(infoHash) && !V2.test(infoHash)) {
    return { ok: false, problem: 'This magnet link\'s info hash is malformed, so it does not name a torrent.' }
  }
  return {
    ok: true,
    magnet,
    infoHash,
    // the link's own `dn` first, then a `name` the site passed alongside, then the hash. All three
    // are the linking site talking, which is why the page says who is talking.
    name: cleanName(magnetParam(magnet, 'dn')) ?? cleanName(name) ?? infoHash,
    trackers: countTrackers(magnet),
    sizeBytes: readLength(magnet),
  }
}
