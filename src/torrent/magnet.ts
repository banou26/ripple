/**
 * The torrent a magnet names, as ONE identity string.
 *
 * A magnet can carry two `xt` values: `btih` for the v1 SHA-1 infohash, and `btmh` for the v2
 * SHA-256 one. A hybrid torrent carries both, and they are two names for one torrent rather than
 * two torrents. Ripple keys save paths, library entries, resume blobs and stored source handles on
 * whatever comes back from here, so this has to answer the same string every time or the same
 * torrent gets two identities and neither can find the other's data.
 *
 * V1 WINS WHEREVER THERE IS ONE, regardless of which `xt` appears first. Every client understands
 * it, `savePathFor` already produces 40-character directories, and it is the half of a hybrid the
 * older swarm answers to. Only a v2-only torrent answers with 64 characters.
 */
export const magnetInfoHash = (magnet: string): string | null => {
  // base32 is legal here as well as hex, which is why this is not a hex-only pattern
  const v1 = magnet.match(/xt=urn:btih:([0-9a-z]+)/i)
  if (v1) return v1[1]!.toLowerCase()

  const v2 = magnet.match(/xt=urn:btmh:([0-9a-f]+)/i)
  if (!v2) return null
  const multihash = v2[1]!.toLowerCase()
  /*
   * `1220` IS NOT PART OF THE ID. It is the multihash prefix: 0x12 for sha2-256, 0x20 for the 32
   * bytes that follow. Keeping it produced a 68-character id, and that had a cost far past being
   * untidy: `opfs-sweep.ts` recognises a save directory by its name being 40 or 64 hex characters,
   * a 68-character one matches neither, and the sweep removed the torrent's whole directory about a
   * minute after the page loaded even though the library still listed it.
   */
  return multihash.startsWith('1220') && multihash.length === 68 ? multihash.slice(4) : multihash
}

/**
 * EVERY value of a repeated magnet key, decoded and in order.
 *
 * `tr` and `ws` are lists by design, so the single-value reader below answers with the first one and
 * quietly loses the rest. A .torrent rebuilt from a magnet that kept one tracker out of five is a
 * worse torrent than the magnet was.
 */
export const magnetParams = (magnet: string, key: string): string[] => {
  const out: string[] = []
  for (const m of magnet.matchAll(new RegExp('[?&]' + key + '=([^&]+)', 'g'))) {
    const raw = m[1]!
    try { out.push(decodeURIComponent(raw.replace(/\+/g, ' '))) } catch { out.push(raw) }
  }
  return [...new Set(out)]
}

/** One query key out of a magnet link, decoded. `dn` is the display name a tracker suggested. */
export const magnetParam = (magnet: string, key: string): string | undefined => {
  const m = magnet.match(new RegExp('[?&]' + key + '=([^&]+)'))
  if (!m) return undefined
  try { return decodeURIComponent(m[1]!.replace(/\+/g, ' ')) } catch { return m[1] }
}
