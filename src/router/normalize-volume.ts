/**
 * The player's "Normalize volume" switch, saved per origin. Ripple inside stub is a torrent.fkn.app frame, same site
 * as stub, so it reads the same storage as a ripple tab and one switch covers both. On unless it was turned off.
 */
export const NORMALIZE_VOLUME_KEY = 'ripple:normalize-volume'

export const normalizeVolumeSaved = (read: (key: string) => string | null): boolean => {
  try { return read(NORMALIZE_VOLUME_KEY) !== '0' } catch { return true }
}
