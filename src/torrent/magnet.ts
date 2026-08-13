export const magnetInfoHash = (magnet: string): string | null => {
  const m = magnet.match(/xt=urn:bt[im]h:([0-9a-z]+)/i)
  return m ? m[1]!.toLowerCase() : null
}

/** One query key out of a magnet link, decoded. `dn` is the display name a tracker suggested. */
export const magnetParam = (magnet: string, key: string): string | undefined => {
  const m = magnet.match(new RegExp('[?&]' + key + '=([^&]+)'))
  if (!m) return undefined
  try { return decodeURIComponent(m[1]!.replace(/\+/g, ' ')) } catch { return m[1] }
}
