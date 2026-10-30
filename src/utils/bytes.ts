import { unitLocale } from '../i18n/languages'

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

const sized = (bytes, compact: boolean | undefined, per = '') => {
  if (isNaN(bytes)) return 'NaN'
  const locale = unitLocale()
  const some = bytes >= 1
  const i = some ? Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), UNITS.length - 1) : 0
  return new Intl.NumberFormat(locale, {
    unit: `${UNITS[i]}${per}`,
    notation: 'standard',
    style: 'unit',
    unitDisplay: 'short',
    maximumFractionDigits: i >= 3 ? 2 : 1,
  })
    .format(some ? bytes / Math.pow(1000, i) : 0)
    // CLDR's short form spells the byte out in several languages: English `999 byte`, Portuguese `999 bytes`
    .replace(/bytes?/, some || compact || locale !== 'en-US' ? 'B' : 'bytes')
}

/** A size in the page's language: `1.5 MB`, `1,5 Mo`, `1,5 МБ`. `compact` shortens English's `0 bytes` to `0 B`. */
export const getHumanReadableByteString = (bytes, compact?: boolean) => sized(bytes, compact)

/** A speed in the page's language, in the units of a size: `10.4 MB/s`, `10,4 Mo/s`, `10.4 MB/秒`. */
export const getHumanReadableSpeed = (bytesPerSecond, compact?: boolean) => sized(bytesPerSecond, compact, '-per-second')

/** A speed its caller rounded, to a tenth at most, in the page's language: `1.5 MB/s`, `1,5 Mo/s`. Never grouped. */
export const writeSpeed = (count: number, unit: 'kilobyte' | 'megabyte' | 'gigabyte') =>
  new Intl.NumberFormat(unitLocale(), {
    unit: `${unit}-per-second`,
    style: 'unit',
    unitDisplay: 'short',
    useGrouping: false,
    maximumFractionDigits: 1,
  }).format(count)

/** A speed in whole units: `12 MB/s`, and `512 KB/s` with the capital ripple's English writes in this one place. */
export const getRoundedSpeed = (bytesPerSecond: number) => {
  const mbs = bytesPerSecond / 1_000_000
  if (mbs >= 1000) return writeSpeed(Math.round(mbs / 1000), 'gigabyte')
  if (mbs >= 1) return writeSpeed(Math.round(mbs), 'megabyte')
  return writeSpeed(Math.round(bytesPerSecond / 1000), 'kilobyte').replace('kB', 'KB')
}
