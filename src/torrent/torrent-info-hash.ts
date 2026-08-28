/**
 * The infohash of a `.torrent` file, without asking the engine.
 *
 * The share dialog needs it BEFORE the add, for the same reason the magnet path does: if the
 * torrent is already in the library then nothing new will be added, so a claim that waits for a new
 * torrent to appear waits forever. That is not hypothetical, it is the most likely way somebody uses
 * the dialog, since the file on their disk is usually the one they already opened.
 *
 * The infohash is the SHA-1 of the bencoded `info` VALUE exactly as it appears in the file, bytes
 * untouched. So this does not decode the torrent, it finds the byte range of that one value and
 * hashes it. Re-encoding would be wrong: bencode is canonical, and any normalisation on the way
 * through changes the hash.
 */

const DICT = 0x64 // d
const LIST = 0x6c // l
const INT = 0x69 // i
const END = 0x65 // e
const COLON = 0x3a // :
const ZERO = 0x30
const NINE = 0x39

/** The offset just past the bencode value starting at `i`. Throws on anything malformed. */
const skipValue = (b: Uint8Array, i: number): number => {
  if (i >= b.length) throw new Error('truncated')
  const kind = b[i]

  if (kind === INT) {
    const end = b.indexOf(END, i + 1)
    if (end < 0) throw new Error('unterminated integer')
    return end + 1
  }

  if (kind === LIST || kind === DICT) {
    let at = i + 1
    while (at < b.length && b[at] !== END) at = skipValue(b, at)
    if (at >= b.length) throw new Error('unterminated container')
    return at + 1
  }

  // a string, spelled `<length>:<bytes>`
  let at = i
  let length = 0
  let digits = 0
  while (at < b.length && b[at]! >= ZERO && b[at]! <= NINE) {
    length = length * 10 + (b[at]! - ZERO)
    at += 1
    digits += 1
    // a length field this long is not a torrent, and guards against a pathological loop
    if (digits > 12) throw new Error('absurd string length')
  }
  if (digits === 0 || b[at] !== COLON) throw new Error('not a bencode value')
  const end = at + 1 + length
  if (end > b.length) throw new Error('string runs past the end')
  return end
}

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/**
 * Null rather than a throw for anything that is not a torrent, because every caller's next move is
 * the same: hand the bytes to the engine and let IT produce the real error message.
 */
export const torrentInfoHash = async (bytes: Uint8Array): Promise<string | null> => {
  try {
    if (bytes[0] !== DICT) return null
    let at = 1
    while (at < bytes.length && bytes[at] !== END) {
      const keyEnd = skipValue(bytes, at)
      const valueEnd = skipValue(bytes, keyEnd)
      // the key is a bencode string; its text starts just past the colon
      const colon = bytes.indexOf(COLON, at)
      if (colon < 0 || colon >= keyEnd) return null
      const key = new TextDecoder().decode(bytes.subarray(colon + 1, keyEnd))
      if (key === 'info') {
        /*
         * Copied into a fresh buffer rather than passed as a subarray view. `subtle.digest` wants a
         * BufferSource, and a `Uint8Array` over a `SharedArrayBuffer` is not one; ripple is
         * cross-origin isolated, so that is a real possibility here rather than a typing pedantry.
         * The slice is the exact bytes either way, which is what makes this the same number the
         * engine computes.
         */
        const info = bytes.slice(keyEnd, valueEnd)
        const digest = await crypto.subtle.digest('SHA-1', new Uint8Array(info).buffer as ArrayBuffer)
        return hex(digest)
      }
      at = valueEnd
    }
    return null
  } catch {
    return null
  }
}
