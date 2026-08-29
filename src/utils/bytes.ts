/**
 * Clamped, because indexing PAST this list yields undefined and `Intl.NumberFormat` THROWS on it
 * with `Invalid unit argument`, taking out whatever was rendering.
 *
 * Anything from 1e18 up lands there, which used to be unreachable: every caller passed a number the
 * engine, the storage quota or the library had produced. A file list carried in a share link is the
 * first caller whose number comes from a query string, so the dead row became reachable from
 * outside. Clamping fixes it for all of them at once, which is the reason it is fixed HERE and not
 * only at the caller.
 */
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte', 'petabyte']

export const getHumanReadableByteString = (bytes, compact?: boolean) => {
  if (isNaN(bytes)) return 'NaN'
  if (bytes === 0 || bytes < 1) return `0 ${compact ? 'B' : 'bytes'}`
  const k = 1000
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), UNITS.length - 1)

  let result =
    new Intl.NumberFormat(
      'en-US',
      {
        unit: UNITS[i],
        notation: 'standard',
        style: 'unit',
        unitDisplay: 'short',
        maximumFractionDigits:
          i >= 3
            ? 2
            : 1
      }
    )
    .format(bytes / Math.pow(k, i))

  if (result.includes(' byte')) {
    result = result.replace(' byte', ' B')
  }

  if (compact) return i > 1000 ? `${Number(result.replaceAll('byte', '')) / 1000}kB` : result

  return result
}
